# RetallAI Voice Agent + Tata Smartflow Bridge

Node.js (TypeScript) middleware running on AWS ECS Fargate that bridges Tata Smartflow's two-way audio WebSocket stream to Retell AI in real-time.

## Architecture

```
Tata Smartflow
    │
    │ POST /voice/endpoint  (callId, fromNumber, toNumber, status)
    ▼
Node.js Middleware  (ECS Fargate)
    │  In-memory session Map: token → { retellCallId, sockets }
    │  WS /stream  ←──────────────────── Smartflow audio stream
    │
    └──► wss://api.retellai.com/audio-websocket/{call_id}
              (bidirectional raw audio proxy)
```

**Audio flow:**

- Smartflow → Bridge → Retell AI (caller's voice)
- Retell AI → Bridge → Smartflow (AI agent voice response)

## Project Structure

```
src/
  server.ts                 # Express + HTTP server entry point
  config.ts                 # Env var loader & validation
  routes/
    voiceEndpoint.ts        # POST /voice/endpoint
  ws/
    bridge.ts               # Bidirectional WebSocket audio proxy
  services/
    retellService.ts        # Retell AI REST API (register call)
  utils/
    sessionStore.ts         # In-memory Map with TTL cleanup
    logger.ts               # Structured JSON logger (CloudWatch-ready)
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
# Fill in RETELL_API_KEY, RETELL_AGENT_ID
```

### 3. Expose local server via Cloudflare Tunnel (so Smartflow can reach it)

```bash
# Install once (macOS)
brew install cloudflare/cloudflare/cloudflared

# Start a quick tunnel — no login required
cloudflared tunnel --url http://localhost:3000
# Output example:
#   https://random-name.trycloudflare.com
# ⚠️  Set SERVER_WSS_HOST to the hostname ONLY — no https:// prefix
# Example: SERVER_WSS_HOST=random-name.trycloudflare.com
```

> **Note:** Cloudflare Tunnel supports WebSocket upgrades natively — no extra config needed.

### 4. Start dev server

```bash
npm run dev
```

### 5. Test the Dynamic Endpoint

```bash
curl -X POST http://localhost:3000/voice/endpoint \
  -H "Content-Type: application/json" \
  -d '{"callId":"test-001","fromNumber":"+919999999999","toNumber":"+918888888888","status":"ringing"}'
```

Expected response:

```json
{ "success": true, "wss_url": "wss://<your-ngrok-host>/stream?token=<uuid>" }
```

### 6. Health check

```bash
curl http://localhost:3000/health
```

## Build

```bash
npm run build     # compiles TypeScript → dist/
npm start         # runs compiled output
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
  - `retallai/server-wss-host` → `SERVER_WSS_HOST` (your ALB domain)

### Steps

```bash
# 1. Build & push Docker image
aws ecr get-login-password --region <REGION> | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com

docker build -t retallai-smartflow-bridge .
docker tag retallai-smartflow-bridge:latest \
  <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/retallai-smartflow-bridge:latest
docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/retallai-smartflow-bridge:latest

# 2. Update placeholders in ecs-task-definition.json, then register
aws ecs register-task-definition \
  --cli-input-json file://ecs-task-definition.json

# 3. Create / update ECS service (single task for POC)
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

| Resource | Inbound               | Outbound                                 |
| -------- | --------------------- | ---------------------------------------- |
| ALB      | 443 from `0.0.0.0/0`  | ECS task SG on port 3000                 |
| ECS Task | Port 3000 from ALB SG | `18.98.16.120/30` (Retell) + `0.0.0.0/0` |

## Configure Smartflow

In Smartflow Voice Streaming settings:

- **Endpoint type:** Dynamic
- **Method:** POST
- **URL:** `https://<your-alb-domain>/voice/endpoint`
- **Body mapping:** `callId=$callId`, `fromNumber=$fromNumber`, `toNumber=$toNumber`, `status=$status`

## Environment Variables

| Variable              | Required | Description                          |
| --------------------- | -------- | ------------------------------------ |
| `RETELL_API_KEY`      | Yes      | Retell AI API key from dashboard     |
| `RETELL_AGENT_ID`     | Yes      | Retell AI agent ID to handle calls   |
| `SERVER_WSS_HOST`     | Yes      | Public hostname (no `wss://` prefix) |
| `PORT`                | No       | Server port (default: `3000`)        |
| `SESSION_TTL_MINUTES` | No       | Session expiry (default: `60`)       |
