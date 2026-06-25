# RetallAI Voice Agent + Tata Smartflow Bridge

Node.js (TypeScript) middleware running on Railway that bridges Tata Smartflow's bidirectional audio WebSocket stream to Retell AI in real-time.

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
Node.js Bridge  (Railway / Cloudflare Tunnel)
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
  adapters/
    types.ts                # IVendorAdapter interface + NormalisedEvent union type
    index.ts                # getAdapter(vendor) registry
    smartflow.ts            # Tata Smartflow — JSON+base64 µ-law 8kHz
    twilio.ts               # Twilio Media Streams — JSON+base64 µ-law 8kHz
    generic.ts              # Raw binary µ-law — for custom/direct integrations
  routes/
    voiceEndpoint.ts        # POST /voice/endpoint?vendor=  — Dynamic Endpoint
    createWebCall.ts        # POST /create-web-call — Retell access_token for browser test
  ws/
    bridge.ts               # Adapter-driven bidirectional audio proxy
  services/
    retellService.ts        # Retell AI REST API (register call)
  utils/
    sessionStore.ts         # In-memory Map with TTL cleanup (stores vendor per session)
    logger.ts               # Structured JSON logger (Railway-compatible)
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

## Railway Deployment

Railway auto-deploys from GitHub and provisions HTTPS + WebSocket support out of the box — no ALB, certificates, or container registry setup required.

### Prerequisites

- [Railway account](https://railway.app) and the Railway CLI installed (`npm i -g @railway/cli`)
- GitHub repository connected to Railway (or deploy via CLI)

### Steps

**1. Create a new Railway project**

```bash
railway login
railway init
```

Or connect your GitHub repo from the Railway dashboard — Railway will detect the `Dockerfile` and build automatically.

**2. Set environment variables**

In the Railway dashboard → your service → **Variables**, add:

| Variable              | Value                                              |
| --------------------- | -------------------------------------------------- |
| `RETELL_API_KEY`      | Your Retell AI API key                             |
| `RETELL_AGENT_ID`     | Your Retell AI agent ID                            |
| `SERVER_WSS_HOST`     | Your Railway public domain (e.g. `your-app.up.railway.app`) — no `https://` prefix |
| `PORT`                | `3000` (Railway injects `PORT` automatically too)  |

Or set them via CLI:

```bash
railway variables set RETELL_API_KEY=<key>
railway variables set RETELL_AGENT_ID=<agent_id>
railway variables set SERVER_WSS_HOST=<your-app>.up.railway.app
```

**3. Deploy**

```bash
railway up
```

Railway builds the Docker image, deploys it, and assigns a public HTTPS domain. WebSocket (`wss://`) is supported on the same domain automatically.

**4. Get your public domain**

```bash
railway domain
# → your-app.up.railway.app
```

Set this as `SERVER_WSS_HOST` (without `https://`).

### Health check

```bash
curl https://your-app.up.railway.app/health
# → {"status":"ok","activeSessions":0,...}
```

## Configure Smartflow

In Smartflow → Voice Streaming → Dynamic Endpoint:

| Field          | Value                                                  |
| -------------- | ------------------------------------------------------ |
| Endpoint type  | Dynamic                                                |
| Method         | POST                                                   |
| URL            | `https://<your-app>.up.railway.app/voice/endpoint`     |
| Response field | `wss_url`                                              |

Smartflow will POST `callId`, `fromNumber`, `toNumber`, `status` and use the returned `wss_url` to open the audio stream.

## Multi-Vendor Support

The bridge is vendor-agnostic. Each vendor has a thin adapter in `src/adapters/` that normalises its protocol to a common internal format. The Retell AI connection is identical for all vendors.

### Using a different vendor

Pass `?vendor=<name>` on the Dynamic Endpoint call:

```bash
# Twilio
POST /voice/endpoint?vendor=twilio

# Tata Smartflow (default — no param needed)
POST /voice/endpoint?vendor=smartflow

# Raw binary µ-law stream
POST /voice/endpoint?vendor=generic
```

### Supported vendors

| Vendor               | `?vendor=`            | Audio format      | Protocol                             |
| -------------------- | --------------------- | ----------------- | ------------------------------------ |
| Tata Smartflow       | `smartflow` (default) | µ-law 8kHz base64 | JSON text frames (Twilio-compatible) |
| Twilio Media Streams | `twilio`              | µ-law 8kHz base64 | JSON text frames                     |
| Generic / custom     | `generic`             | µ-law 8kHz raw    | Raw binary WebSocket frames          |

### Adding a new vendor

1. Create `src/adapters/<vendor>.ts` implementing `IVendorAdapter`:

```ts
import { IVendorAdapter, NormalisedEvent, AdapterContext } from "./types";

export class MyVendorAdapter implements IVendorAdapter {
  readonly vendor = "myvendor" as const;

  decode(raw: WebSocket.RawData): NormalisedEvent | null {
    /* parse vendor frames */
  }
  encodeAudio(payload: Buffer, ctx: AdapterContext): string | Buffer {
    /* wrap for vendor */
  }
  encodeClear(ctx: AdapterContext): string | Buffer | null {
    /* barge-in signal or null */
  }
}
```

2. Register it in `src/adapters/index.ts`:

```ts
myvendor: () => new MyVendorAdapter(),
```

3. Add `"myvendor"` to the `VendorName` union in `src/adapters/types.ts`.

That's it — no changes to the bridge, session store, or routes.

## Environment Variables

| Variable              | Required | Description                                 |
| --------------------- | -------- | ------------------------------------------- |
| `RETELL_API_KEY`      | Yes      | Retell AI API key from dashboard            |
| `RETELL_AGENT_ID`     | Yes      | Retell AI agent ID to handle calls          |
| `SERVER_WSS_HOST`     | Yes      | Public hostname only — no `https://` prefix |
| `PORT`                | No       | Server port (default: `3000`)               |
| `SESSION_TTL_MINUTES` | No       | Session expiry in minutes (default: `60`)   |
