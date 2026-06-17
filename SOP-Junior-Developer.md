# SOP: RetallAI Voice Agent Integration
## Standard Operating Procedure for Junior Developers

**Version:** 1.0  
**Last Updated:** June 2026  
**Project:** RetallAI-Smartflow Bridge (Node.js TypeScript WebSocket Middleware)

---

## Table of Contents
1. [Project Overview](#1-project-overview)
2. [Prerequisites & Learning Resources](#2-prerequisites--learning-resources)
3. [Architecture Deep Dive](#3-architecture-deep-dive)
4. [Local Development Setup](#4-local-development-setup)
5. [Codebase Walkthrough](#5-codebase-walkthrough)
6. [Adding a New Vendor Adapter](#6-adding-a-new-vendor-adapter)
7. [Testing Procedures](#7-testing-procedures)
8. [Deployment Guide](#8-deployment-guide)
9. [Troubleshooting](#9-troubleshooting)
10. [Key Concepts Reference](#10-key-concepts-reference)

---

## 1. Project Overview

### 1.1 What This Project Does

This is a **middleware bridge** that connects telephony systems (like Tata Smartflow, Twilio) to Retell AI's voice agents. It enables real-time bidirectional audio streaming between:
- **Upstream:** Telephony providers (Smartflow, Twilio)
- **Downstream:** Retell AI voice agents

### 1.2 The Problem It Solves

Telephony systems send audio in different formats/protocols. Retell AI expects raw binary µ-law audio over WebSocket. This bridge:
1. Normalizes different vendor protocols to a common format
2. Handles audio encoding/decoding (base64 ↔ raw binary)
3. Manages session state and authentication
4. Proxies bidirectional audio streams in real-time

### 1.3 High-Level Flow

```
[Customer Phone] → [Smartflow/Twilio] → [This Bridge] → [Retell AI Voice Agent]
                        ↓                      ↓              ↓
                   JSON+base64          Raw binary µ-law  AI Response
                   WebSocket            WebSocket         (speech)
```

---

## 2. Prerequisites & Learning Resources

### 2.1 Required Knowledge

Before starting, you should understand:

| Topic | Resources |
|-------|-----------|
| **Node.js & TypeScript** | [TypeScript Handbook](https://www.typescriptlang.org/docs/) |
| **Express.js** | [Express Getting Started](https://expressjs.com/en/starter/installing.html) |
| **WebSocket Protocol** | [MDN WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) |
| **Docker Basics** | [Docker Getting Started](https://docs.docker.com/get-started/) |
| **AWS ECS Fargate** | [AWS ECS Tutorial](https://docs.aws.amazon.com/ecs/latest/developerguide/Welcome.html) |
| **µ-law Audio Encoding** | [G.711 µ-law](https://en.wikipedia.org/wiki/G.711) |

### 2.2 Tools You Need Installed

```bash
# macOS (use Homebrew)
brew install node@20
brew install cloudflare/cloudflare/cloudflared  # For local tunneling
brew install awscli                               # For deployment

# Verify installations
node --version    # v20.x or higher
npm --version     # v10.x or higher
docker --version  # Latest stable
```

### 2.3 Accounts Required

- **Retell AI Account:** https://dashboard.retellai.com (get API key)
- **AWS Account:** For ECS deployment
- **Cloudflare Account:** Optional, for tunneling during local dev

---

## 3. Architecture Deep Dive

### 3.1 System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           CLIENT REQUEST                            │
│  POST /voice/endpoint (HTTP) - Register new call                    │
│  Body: { callId, fromNumber, toNumber, status }                     │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    EXPRESS HTTP SERVER (server.ts)                  │
│  • Routes incoming HTTP requests                                    │
│  • Serves static files (test UI)                                    │
│  • Health check endpoint                                            │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
              ▼                 ▼                 ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ /voice/endpoint │  │ /create-web-call│  │    /health      │
│   (POST)        │  │    (POST)       │  │    (GET)        │
└────────┬────────┘  └─────────────────┘  └─────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│              VOICE ENDPOINT HANDLER (voiceEndpoint.ts)              │
│  1. Validate request body                                           │
│  2. Register call with Retell AI API                                 │
│  3. Create session with UUID token                                   │
│  4. Return WebSocket URL to client                                   │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    WEBSOCKET BRIDGE (bridge.ts)                     │
│  Path: /stream?token=<uuid>                                         │
│                                                                     │
│  ┌─────────────────┐              ┌─────────────────┐              │
│  │  Vendor WS      │◄────────────►│  Retell AI WS   │              │
│  │ (Smartflow/     │   Bidirectional   (AI Agent)    │              │
│  │  Twilio)        │    Audio Stream                   │              │
│  └─────────────────┘              └─────────────────┘              │
│                                                                     │
│  Adapter Pattern:                                                   │
│  • Decodes vendor JSON+base64 → Raw Buffer                          │
│  • Encodes raw Buffer → vendor format                               │
│  • Handles barge-in (clear) signals                                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 Data Flow Explained

**Step 1: Call Registration (HTTP)**
```
Smartflow → POST /voice/endpoint
               ↓
           Create Retell call via API
               ↓
           Return { wss_url: "wss://.../stream?token=abc123" }
```

**Step 2: WebSocket Connection**
```
Smartflow → WS /stream?token=abc123
               ↓
           Validate token → Get session
               ↓
           Connect to Retell WS
               ↓
           Start bidirectional proxy
```

**Step 3: Audio Streaming (Bidirectional)**
```
┌──────────────┐           ┌──────────────┐           ┌──────────────┐
│  Smartflow   │◄─────────►│    Bridge    │◄─────────►│  Retell AI   │
│  (Customer)  │  JSON+    │   (Adapter)  │  Raw µ   │  (AI Agent)  │
│              │  base64   │              │  -law    │              │
└──────────────┘           └──────────────┘           └──────────────┘
      │                          │                          │
      │  {event:"media",          │  Buffer (raw)            │  Audio chunks
      │   media:{payload}}        │                          │  (binary)
      │                          │                          │
      │◄──────────── Adapter normalizes ──────────────────────│
```

### 3.3 The Adapter Pattern

The core design pattern that makes this bridge vendor-agnostic:

```typescript
// All vendors implement this interface
interface IVendorAdapter {
  readonly vendor: VendorName;
  
  // Parse vendor-specific format → common format
  decode(raw: WebSocket.RawData): NormalisedEvent | null;
  
  // Encode common format → vendor-specific format
  encodeAudio(payload: Buffer, ctx: AdapterContext): string | Buffer;
  
  // Handle barge-in (clear) signals
  encodeClear(ctx: AdapterContext): string | Buffer | null;
}
```

**Supported Vendors:**
| Vendor | Protocol | Format |
|--------|----------|--------|
| `smartflow` | JSON text frames | base64 µ-law 8kHz |
| `twilio` | JSON text frames | base64 µ-law 8kHz |
| `generic` | Raw binary | Raw µ-law 8kHz |

---

## 4. Local Development Setup

### Step 4.1: Clone and Install

```bash
# Clone the repository
git clone <repository-url>
cd RetallAI-Voice-Agent-Integration

# Install dependencies
npm install
```

### Step 4.2: Configure Environment

```bash
# Copy example environment file
cp .env.example .env

# Edit .env with your credentials
nano .env
```

**Required environment variables:**
```
RETELL_API_KEY=your_retell_api_key_here
RETELL_AGENT_ID=your_agent_id_here
SERVER_WSS_HOST=your-tunnel-host.trycloudflare.com
```

**Getting Retell credentials:**
1. Go to https://dashboard.retellai.com
2. Create an agent or use existing one
3. Copy Agent ID from agent settings
4. Generate API key from API Keys section

### Step 4.3: Start Cloudflare Tunnel (Local Dev)

The server needs to be publicly accessible for WebSocket connections.

```bash
# Terminal 1: Start the tunnel
cloudflared tunnel --url http://localhost:3000

# You'll see output like:
# 2026-06-16T11:20:00Z INF |  https://random-name.trycloudflare.com
```

**Copy the HTTPS URL (without https://) and update your `.env`:**
```
SERVER_WSS_HOST=random-name.trycloudflare.com
```

### Step 4.4: Start Development Server

```bash
# Terminal 2: Start the dev server
npm run dev

# You should see:
# {"level":"info","message":"RetallAI-Smartflow bridge server started",...}
```

### Step 4.5: Verify Setup

```bash
# Health check
curl http://localhost:3000/health

# Expected response:
# {"status":"ok","activeSessions":0,"timestamp":"2026-06-16T..."}
```

---

## 5. Codebase Walkthrough

### 5.1 Directory Structure

```
src/
├── server.ts              # Entry point: Express + HTTP server
├── config.ts              # Environment variable loader
├── adapters/              # Vendor protocol adapters
│   ├── types.ts           # Interface definitions
│   ├── index.ts           # Adapter registry/factory
│   ├── smartflow.ts       # Tata Smartflow adapter
│   ├── twilio.ts          # Twilio adapter
│   └── generic.ts         # Raw binary adapter
├── routes/                # HTTP route handlers
│   ├── voiceEndpoint.ts   # POST /voice/endpoint
│   └── createWebCall.ts   # POST /create-web-call
├── ws/                    # WebSocket handlers
│   └── bridge.ts          # Bidirectional audio proxy
├── services/              # External API clients
│   └── retellService.ts   # Retell AI REST API
└── utils/                 # Utilities
    ├── sessionStore.ts    # In-memory session management
    └── logger.ts          # Structured JSON logging

public/
└── test-call.html         # Browser-based test UI

test/
└── simulate-smartflow.ts  # CLI protocol simulator
```

### 5.2 Key Files Explained

#### `src/server.ts` - Application Entry Point

**Purpose:** Sets up Express HTTP server and attaches WebSocket bridge.

**Key Components:**
- Express app with JSON middleware
- Static file serving for test UI
- Health check endpoint
- Graceful shutdown handlers (SIGTERM/SIGINT)

```typescript
// The main flow:
const app = express();
const server = http.createServer(app);
attachWebSocketBridge(server);  // Attaches WS handler at /stream
server.listen(config.port, ...);
```

#### `src/config.ts` - Configuration Loader

**Purpose:** Loads and validates environment variables.

**Important:** Strips protocol prefixes from `SERVER_WSS_HOST`:
```typescript
serverWssHost: requireEnv("SERVER_WSS_HOST")
  .replace(/^https?:\/\//, "")   // Remove http:// or https://
  .replace(/^wss?:\/\//, "");    // Remove ws:// or wss://
```

#### `src/adapters/smartflow.ts` - Protocol Adapter

**Purpose:** Handles Smartflow's JSON+base64 protocol.

**Decode Flow (Smartflow → Bridge):**
```typescript
decode(rawData) {
  // 1. Parse JSON frame
  frame = JSON.parse(raw.toString())
  
  // 2. Handle different event types
  switch (frame.event) {
    case "connected": return { type: "connected" }
    case "start": return { type: "start", streamSid, from, to }
    case "media": return { 
      type: "audio", 
      payload: Buffer.from(frame.media.payload, "base64")  // Decode base64
    }
    case "stop": return { type: "stop" }
  }
}
```

**Encode Flow (Bridge → Smartflow):**
```typescript
encodeAudio(payload, ctx) {
  // Convert raw buffer to base64 JSON
  return JSON.stringify({
    event: "media",
    streamSid: ctx.streamSid,
    media: {
      payload: payload.toString("base64"),  // Encode to base64
      chunk: ctx.chunkCounter
    }
  })
}
```

#### `src/ws/bridge.ts` - WebSocket Bridge

**Purpose:** Manages bidirectional WebSocket connections.

**Architecture:**
```
┌─────────────────────────────────────────────────────────────┐
│                    WebSocketServer                          │
│                    (path: /stream)                          │
│                                                             │
│  ┌─────────────────┐    Session Map    ┌─────────────────┐   │
│  │  Vendor WS      │◄────(token)──────►│  Retell AI WS   │   │
│  │  (Incoming)     │                   │  (Outgoing)     │   │
│  └────────┬────────┘                   └────────┬────────┘   │
│           │                                      │           │
│           │  Vendor messages                       │           │
│           │  1. Decode via adapter                 │           │
│           │  2. Send to Retell (raw binary)        │           │
│           │                                      │           │
│           │                                      │ Retell messages
│           │                                      │ 1. Encode via adapter
│           │◄─────────────────────────────────────│ 2. Send to vendor
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Key Logic:**
1. Validates `token` query parameter
2. Looks up session in `sessionStore`
3. Connects to Retell AI WebSocket
4. Sets up message handlers for both directions
5. Handles cleanup on disconnect

#### `src/utils/sessionStore.ts` - Session Management

**Purpose:** In-memory storage for active call sessions.

**Session Lifecycle:**
```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   CREATE     │────►│   ACTIVE     │────►│   DELETE     │
│  (on /voice/ │     │ (during WS   │     │ (on WS close │
│   endpoint)  │     │  connection) │     │  or timeout) │
└──────────────┘     └──────────────┘     └──────────────┘
```

**TTL Cleanup:**
- Sessions expire after `SESSION_TTL_MINUTES` (default: 60)
- Cleanup runs every 5 minutes
- Orphaned sessions are auto-terminated

---

## 6. Adding a New Vendor Adapter

This is a common task. Follow these exact steps:

### Step 6.1: Understand the Vendor's Protocol

You need to know:
1. **Transport:** WebSocket or HTTP?
2. **Frame format:** JSON text or binary?
3. **Audio encoding:** base64 µ-law? Raw? Other codec?
4. **Event types:** How are start/stop/media signaled?
5. **Barge-in:** Does the vendor support clear/interrupt signals?

### Step 6.2: Create the Adapter File

Create `src/adapters/myvendor.ts`:

```typescript
import WebSocket from "ws";
import { IVendorAdapter, NormalisedEvent, AdapterContext } from "./types";

// Define the vendor's frame structure
interface MyVendorFrame {
  event: string;
  callId?: string;
  audioData?: string;  // base64 encoded
  // ... other fields
}

export class MyVendorAdapter implements IVendorAdapter {
  readonly vendor = "myvendor" as const;

  decode(raw: WebSocket.RawData): NormalisedEvent | null {
    let frame: MyVendorFrame;
    
    try {
      frame = JSON.parse(raw.toString()) as MyVendorFrame;
    } catch {
      return null;  // Invalid JSON, ignore
    }

    switch (frame.event) {
      case "call.started":
        return {
          type: "start",
          streamSid: frame.callId ?? "",
          from: "",  // Extract from frame if available
          to: "",    // Extract from frame if available
        };

      case "audio.chunk":
        if (!frame.audioData) return null;
        return {
          type: "audio",
          payload: Buffer.from(frame.audioData, "base64"),
        };

      case "call.ended":
        return { type: "stop", reason: "ended" };

      default:
        return null;  // Unknown event type
    }
  }

  encodeAudio(payload: Buffer, ctx: AdapterContext): string {
    // Wrap raw audio in vendor's format
    return JSON.stringify({
      event: "audio.response",
      callId: ctx.streamSid,
      audioData: payload.toString("base64"),
      sequence: ctx.chunkCounter,
    });
  }

  encodeClear(ctx: AdapterContext): string | null {
    // If vendor supports barge-in/clear
    return JSON.stringify({
      event: "audio.clear",
      callId: ctx.streamSid,
    });
    // Or return null if not supported
  }
}
```

### Step 6.3: Register the Adapter

Edit `src/adapters/index.ts`:

```typescript
import { MyVendorAdapter } from "./myvendor";

const adapterRegistry = {
  smartflow: () => new SmartflowAdapter(),
  twilio: () => new TwilioAdapter(),
  generic: () => new GenericAdapter(),
  myvendor: () => new MyVendorAdapter(),  // <-- ADD THIS
};
```

### Step 6.4: Update the Vendor Name Type

Edit `src/adapters/types.ts`:

```typescript
export type VendorName = "smartflow" | "twilio" | "generic" | "myvendor";
//                                                          ^^^^^^^^^^^^^^^ ADD
```

### Step 6.5: Test the Adapter

```bash
# Use the new vendor
curl -X POST "http://localhost:3000/voice/endpoint?vendor=myvendor" \
  -H "Content-Type: application/json" \
  -d '{"callId":"test-001","fromNumber":"+919999999999","toNumber":"+918888888888"}'
```

---

## 7. Testing Procedures

### 7.1 Unit Testing Approach

Run the linter to catch TypeScript errors:
```bash
npm run lint
```

### 7.2 Local Integration Test

**Test 1: Health Check**
```bash
curl http://localhost:3000/health
# Expected: {"status":"ok","activeSessions":0,...}
```

**Test 2: Dynamic Endpoint**
```bash
curl -X POST http://localhost:3000/voice/endpoint \
  -H "Content-Type: application/json" \
  -d '{"callId":"local-test-001","fromNumber":"+919999999999","toNumber":"+918888888888","status":"ringing"}'

# Expected:
# {
#   "success": true,
#   "wss_url": "wss://your-host.trycloudflare.com/stream?token=<uuid>"
# }
```

**Test 3: Browser Live Call**
1. Open `https://your-host.trycloudflare.com/test-call.html`
2. Allow microphone access
3. Click "Start Call"
4. Speak and verify the agent responds

### 7.3 CLI Protocol Simulator

```bash
# Basic test
npm run simulate

# Against production URL
SERVER_HTTP=https://your-domain.com \
SERVER_WSS=wss://your-domain.com \
npm run simulate

# Longer duration test
CALL_DURATION_MS=30000 npm run simulate
```

**Expected output:**
```
→ sent: connected
→ sent: start
← received: media frame
✅ First agent audio chunk received!
← agent audio: 50 chunks  12 KB total
```

### 7.4 Manual WebSocket Test (using wscat)

```bash
# Install wscat
npm install -g wscat

# Get a token first
curl -X POST http://localhost:3000/voice/endpoint ...

# Connect to WebSocket
wscat -c "wss://your-host.trycloudflare.com/stream?token=<TOKEN>"

# Send test messages
> {"event":"connected"}
> {"event":"start","streamSid":"test-123","start":{"from":"+123","to":"+456"}}
```

---

## 8. Deployment Guide

### 8.1 AWS ECS Fargate Deployment

**Prerequisites:**
- AWS CLI configured with credentials
- ECR repository created: `retallai-smartflow-bridge`
- ECS cluster created
- Application Load Balancer with HTTPS listener
- Secrets in AWS Secrets Manager

**Step 1: Build and Push Docker Image**

```bash
# Login to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com

# Build image
docker build -t retallai-smartflow-bridge .

# Tag image
docker tag retallai-smartflow-bridge:latest \
  <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/retallai-smartflow-bridge:latest

# Push to ECR
docker push <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/retallai-smartflow-bridge:latest
```

**Step 2: Configure ECS Task Definition**

Edit `ecs-task-definition.json` and replace placeholders:
- `<ACCOUNT_ID>` → Your AWS account ID
- `<REGION>` → Your AWS region (e.g., us-east-1)

**Step 3: Register Task Definition**

```bash
aws ecs register-task-definition \
  --cli-input-json file://ecs-task-definition.json
```

**Step 4: Create ECS Service**

```bash
aws ecs create-service \
  --cluster <CLUSTER_NAME> \
  --service-name retallai-smartflow-bridge \
  --task-definition retallai-smartflow-bridge \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<SUBNET_ID>],securityGroups=[<SG_ID>],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=<TG_ARN>,containerName=retallai-smartflow-bridge,containerPort=3000"
```

### 8.2 Required AWS Resources

| Resource | Purpose | Configuration |
|----------|---------|---------------|
| **ECR Repository** | Store Docker images | `retallai-smartflow-bridge` |
| **ECS Cluster** | Run containers | Fargate enabled |
| **ALB** | HTTP/HTTPS entry point | HTTPS listener, WebSocket support |
| **Target Group** | Route to containers | Port 3000, health check `/health` |
| **Security Groups** | Network access | ALB: 443 inbound, ECS: 3000 from ALB |
| **Secrets Manager** | Store credentials | `/retallai/api-key`, `/retallai/agent-id` |

### 8.3 Security Group Rules

**ALB Security Group:**
| Direction | Protocol | Port | Source |
|-----------|----------|------|--------|
| Inbound | TCP | 443 | 0.0.0.0/0 |
| Outbound | TCP | 3000 | ECS Task SG |

**ECS Task Security Group:**
| Direction | Protocol | Port | Source |
|-----------|----------|------|--------|
| Inbound | TCP | 3000 | ALB SG |
| Outbound | All | All | 0.0.0.0/0 |

---

## 9. Troubleshooting

### 9.1 Common Issues

#### Issue: "Missing required environment variable"
**Symptom:** Server crashes on startup  
**Solution:** 
- Check `.env` file exists
- Verify all required variables are set: `RETELL_API_KEY`, `RETELL_AGENT_ID`, `SERVER_WSS_HOST`

#### Issue: "Invalid or expired token" in logs
**Symptom:** WebSocket connections rejected  
**Solution:**
- Token is valid for 60 minutes (SESSION_TTL_MINUTES)
- Ensure Smartflow connects within TTL window
- Check that session was created by `/voice/endpoint` call

#### Issue: No audio from agent
**Symptom:** Call connects but agent is silent  
**Solution:**
1. Check Retell API key and agent ID
2. Verify agent is active in Retell dashboard
3. Check `SERVER_WSS_HOST` is correct (no protocol prefix)
4. Look for "First agent audio frame sent" in logs
5. Verify µ-law encoding (8kHz, not PCM)

#### Issue: "ECONNREFUSED" to Retell
**Symptom:** Can't connect to `wss://api.retellai.com`  
**Solution:**
- Check outbound internet access from container
- Verify no firewall blocking port 443
- Check Retell service status

#### Issue: WebSocket disconnects immediately
**Symptom:** Connection drops after handshake  
**Solution:**
- Verify adapter is handling all event types
- Check for protocol mismatches (JSON vs binary)
- Enable debug logging to see raw messages

### 9.2 Debug Logging

Add temporary debug output in `src/ws/bridge.ts`:

```typescript
// Log all incoming messages
smartflowWs.on("message", (raw) => {
  console.log("RAW FROM VENDOR:", raw.toString());
  // ...
});

retellWs.on("message", (data, isBinary) => {
  console.log("RAW FROM RETELL:", isBinary ? "binary" : data.toString());
  // ...
});
```

### 9.3 Log Analysis

Check CloudWatch Logs for ECS deployment:
```bash
aws logs tail /ecs/retallai-smartflow-bridge --follow
```

**Key log messages to look for:**
```
✅ Good signs:
- "RetallAI-Smartflow bridge server started"
- "Session created"
- "Vendor WebSocket connected"
- "Retell WebSocket connected"
- "First agent audio frame sent to vendor"

⚠️ Warning signs:
- "Missing token"
- "Invalid or expired token"
- "Failed to register call with Retell AI"
- "Session TTL expired"
- "WebSocket error"
```

---

## 10. Key Concepts Reference

### 10.1 µ-law Audio Encoding

**What is µ-law?**
- A companding algorithm used in telephony
- Reduces dynamic range of audio for transmission
- Standard for North American phone systems (G.711)

**Key Specs:**
| Property | Value |
|----------|-------|
| Sample Rate | 8000 Hz (8kHz) |
| Bit Depth | 8-bit |
| Compression | Logarithmic (µ-law) |
| Frame Size | 20ms = 160 samples = 160 bytes |

**Why it matters:**
- Telephony systems use µ-law
- Retell AI expects raw µ-law
- Converting from other formats requires transcoding

### 10.2 WebSocket Protocol

**HTTP Upgrade Process:**
```
Client                    Server
  │                        │
  │  GET /stream HTTP/1.1  │
  │  Connection: Upgrade   │
  │  Upgrade: websocket  │
  │───────────────────────►│
  │                        │
  │  HTTP/1.1 101 Switching│
  │  Upgrade: websocket    │
  │◄───────────────────────│
  │                        │
  │  WebSocket established │
```

**Frame Types:**
- **Text frames:** JSON strings (Smartflow protocol)
- **Binary frames:** Raw audio data (Retell protocol)

### 10.3 Session Management

**Token-based Authentication:**
1. Client calls `/voice/endpoint` → gets `wss_url` with token
2. Client connects to WS with `?token=<uuid>`
3. Server validates token against session store
4. Session contains: Retell call ID, access token, vendor type

**Why tokens?**
- Stateless authentication
- Prevents unauthorized WS connections
- Enables session expiry/cleanup

### 10.4 The Barge-in Problem

**What is barge-in?**
When the user interrupts the AI while it's speaking.

**How it's handled:**
1. Retell detects user speech during AI playback
2. Retell sends `{content: "clear"}` message
3. Bridge forwards to vendor via `encodeClear()`
4. Vendor stops playing audio, ready for new response

**Vendor Support:**
- Smartflow: ✅ Supported (`{event:"clear"}`)
- Twilio: ✅ Supported
- Generic: ❌ Not applicable

---

## Quick Reference Commands

```bash
# Development
npm run dev          # Start dev server with hot reload
npm run build        # Compile TypeScript to dist/
npm run start        # Run compiled output
npm run lint         # Type-check only

# Testing
npm run simulate     # Run CLI protocol simulator
curl http://localhost:3000/health

# Docker
docker build -t retallai-smartflow-bridge .
docker run -p 3000:3000 --env-file .env retallai-smartflow-bridge

# Tunneling
cloudflared tunnel --url http://localhost:3000
```

---

## Resources

- **Retell AI Docs:** https://docs.retellai.com
- **Smartflow Docs:** Contact Tata Telecommunications team
- **Twilio Media Streams:** https://www.twilio.com/docs/voice/twiml/stream
- **WebSocket RFC:** https://tools.ietf.org/html/rfc6455
- **G.711 Spec:** https://www.itu.int/rec/T-REC-G.711

---

## Support

For issues or questions:
1. Check this SOP document
2. Review logs in CloudWatch
3. Check Retell AI dashboard
4. Contact senior team member

---

**END OF SOP DOCUMENT**
