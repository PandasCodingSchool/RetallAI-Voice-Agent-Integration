# RetallAI Voice Agent + Tata Smartflow Bridge

Node.js (TypeScript) middleware running on AWS ECS Fargate that bridges Tata Smartflow's bidirectional audio WebSocket stream to Retell AI in real-time.

## Architecture

```
Tata Smartflow
    │
    │  POST /voice/endpoint  →  registers call with Retell AI, returns wss_url
    │
    │  WS /stream?token=<uuid>
    │  JSON+base64 µ-law protocol (Twilio-compatible)
    │
    ▼
Node.js Bridge  (ECS Fargate / Cloudflare Tunnel)
    │
    │  Decodes:  { event:"media", media:{ payload:<base64 µ-law> } }  →  raw Buffer
    │  Encodes:  raw Buffer  →  { event:"media", media:{ payload:<base64 µ-law> } }
    │
    ▼
wss://api.retellai.com/audio-websocket/{call_id}
    (raw binary µ-law 8kHz frames, bidirectional)
```

**Smartflow WebSocket protocol (Twilio-compatible):**

| Direction          | Format                                                                       |
| ------------------ | ---------------------------------------------------------------------------- |
| Smartflow → Bridge | JSON text: `connected` → `start` → `media` (base64 payload) → `stop`         |
| Bridge → Smartflow | JSON text: `{ event:"media", streamSid, media:{ payload:<base64>, chunk } }` |
| Barge-in           | Bridge forwards Retell `clear` signal as `{ event:"clear", streamSid }`      |

## Project Structure

```
src/
  server.ts                 # Express + HTTP server, static files
  config.ts                 # Env var loader (strips protocol prefix from SERVER_WSS_HOST)
  routes/
    voiceEndpoint.ts        # POST /voice/endpoint  — Dynamic Endpoint for Smartflow
    createWebCall.ts        # POST /create-web-call — issues Retell access_token for browser test
  ws/
    bridge.ts               # JSON↔binary protocol translation + bidirectional audio proxy
  services/
    retellService.ts        # Retell AI REST API (register call)
  utils/
    sessionStore.ts         # In-memory Map with TTL cleanup
    logger.ts               # Structured JSON logger (CloudWatch-ready)
public/
  test-call.html            # Browser-based live call tester (uses official Retell SDK)
test/
  simulate-smartflow.ts     # CLI simulator — speaks full Smartflow JSON protocol
Dockerfile                  # Multi-stage build, non-root user
ecs-task-definition.json    # ECS Fargate task definition template
.env.example                # Required environment variables
```

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in RETELL_API_KEY and RETELL_AGENT_ID
# SERVER_WSS_HOST: hostname only — no https:// prefix
```

### 3. Expose local server via Cloudflare Tunnel

```bash
# Install once (macOS)
brew install cloudflare/cloudflare/cloudflared

# Start a quick tunnel — no login required
cloudflared tunnel --url http://localhost:3000
# → https://random-name.trycloudflare.com
# Set: SERVER_WSS_HOST=random-name.trycloudflare.com  (no https://)
```

> **Note:** Cloudflare Tunnel supports WebSocket upgrades natively — no extra config needed.

### 4. Start dev server

```bash
npm run dev
```

### 5. Health check

```bash
curl http://localhost:3000/health
# → {"status":"ok","activeSessions":0,...}
```

### 6. Test the Dynamic Endpoint

```bash
curl -X POST http://localhost:3000/voice/endpoint \
  -H "Content-Type: application/json" \
  -d '{"callId":"test-001","fromNumber":"+919999999999","toNumber":"+918888888888","status":"ringing"}'
```

Expected:

```json
{
  "success": true,
  "wss_url": "wss://random-name.trycloudflare.com/stream?token=<uuid>"
}
```

## Testing

### Option A — Browser live call (real mic + speaker)

Open in a browser (**must be HTTPS** for mic access):

```
https://random-name.trycloudflare.com/test-call.html
```

Uses the official Retell Web SDK — click **Start Call**, speak, hear the agent respond. Live transcript shown on screen.

### Option B — CLI Smartflow protocol simulator

Sends the full Smartflow JSON+base64 WebSocket protocol (connected → start → media → stop):

```bash
# Local
npm run simulate

# Against Cloudflare tunnel
SERVER_HTTP=https://random-name.trycloudflare.com \
SERVER_WSS=wss://random-name.trycloudflare.com \
npm run simulate

# Longer call
CALL_DURATION_MS=30000 npm run simulate
```

**What to look for in the output:**

- `→ sent: connected` / `→ sent: start` — handshake sent
- `✅ First agent audio chunk received!` — full round-trip working
- `← agent audio: N chunks  X KB total` — sustained audio flowing back
- `⚠️  No agent audio received` — check API key / agent config / server logs

## Build

```bash
npm run build     # compiles TypeScript → dist/
npm start         # runs compiled output
npm run lint      # type-check only
```

## AWS ECS Fargate Deployment

### Prerequisites

- AWS CLI configured
- ECR repository created: `retallai-smartflow-bridge`
- ECS cluster created
- ALB with HTTPS listener (ACM cert) and WebSocket support enabled
- Secrets in AWS Secrets Manager:
  - `retallai/api-key` → `RETELL_API_KEY`
  - `retallai/agent-id` → `RETELL_AGENT_ID`
  - `retallai/server-wss-host` → `SERVER_WSS_HOST` (ALB hostname only, no `https://`)

### Steps

```bash
# 1. Build & push Docker image
aws ecr get-login-password --region <REGION> | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com

docker build -t retallai-smartflow-bridge .
docker tag retallai-smartflow-bridge:latest \
  <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/retallai-smartflow-bridge:latest
docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/retallai-smartflow-bridge:latest

# 2. Register task definition
aws ecs register-task-definition \
  --cli-input-json file://ecs-task-definition.json

# 3. Create ECS service (single task for POC)
aws ecs create-service \
  --cluster <CLUSTER_NAME> \
  --service-name retallai-smartflow-bridge \
  --task-definition retallai-smartflow-bridge \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<SUBNET_ID>],securityGroups=[<SG_ID>],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=<TG_ARN>,containerName=retallai-smartflow-bridge,containerPort=3000"
```

### Security Groups

| Resource | Inbound               | Outbound                            |
| -------- | --------------------- | ----------------------------------- |
| ALB      | 443 from `0.0.0.0/0`  | ECS task SG on port 3000            |
| ECS Task | Port 3000 from ALB SG | `0.0.0.0/0` (outbound to Retell AI) |

## Configure Smartflow

In Smartflow → Voice Streaming → Dynamic Endpoint:

| Field          | Value                                      |
| -------------- | ------------------------------------------ |
| Endpoint type  | Dynamic                                    |
| Method         | POST                                       |
| URL            | `https://<your-alb-domain>/voice/endpoint` |
| Response field | `wss_url`                                  |

Smartflow will POST `callId`, `fromNumber`, `toNumber`, `status` and use the returned `wss_url` to open the audio stream.

## Environment Variables

| Variable              | Required | Description                                 |
| --------------------- | -------- | ------------------------------------------- |
| `RETELL_API_KEY`      | Yes      | Retell AI API key from dashboard            |
| `RETELL_AGENT_ID`     | Yes      | Retell AI agent ID to handle calls          |
| `SERVER_WSS_HOST`     | Yes      | Public hostname only — no `https://` prefix |
| `PORT`                | No       | Server port (default: `3000`)               |
| `SESSION_TTL_MINUTES` | No       | Session expiry in minutes (default: `60`)   |
