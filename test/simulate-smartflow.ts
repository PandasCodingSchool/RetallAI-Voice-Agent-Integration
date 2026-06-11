import axios from "axios";
import WebSocket from "ws";

const SERVER_HTTP = process.env["SERVER_HTTP"] ?? "http://localhost:3000";
const SERVER_WSS = process.env["SERVER_WSS"] ?? "ws://localhost:3000";
const CALL_DURATION_MS = parseInt(
  process.env["CALL_DURATION_MS"] ?? "10000",
  10,
);

const MOCK_CALL = {
  callId: `sim-${Date.now()}`,
  fromNumber: "+919000000001",
  toNumber: "+918000000001",
  status: "ringing",
};

const STREAM_SID = "MZsimulated000000000000000000000001";
const ACCOUNT_SID = "ACsimulated000000000000000000000001";
const CALL_SID = `CA${MOCK_CALL.callId}`;

const AUDIO_CHUNK_BYTES = 800;
const AUDIO_SEND_INTERVAL = 100;

function makeSilenceChunk(): string {
  return Buffer.alloc(AUDIO_CHUNK_BYTES, 0xff).toString("base64");
}

function send(ws: WebSocket, obj: unknown): void {
  ws.send(JSON.stringify(obj));
}

async function run(): Promise<void> {
  console.log("=== Smartflow Protocol Simulator ===");
  console.log(`Server:  ${SERVER_HTTP}`);
  console.log(`Call ID: ${MOCK_CALL.callId}`);
  console.log("");

  console.log("[1/3] Calling POST /voice/endpoint ...");
  let wssUrl: string;
  try {
    const resp = await axios.post<{ success: boolean; wss_url: string }>(
      `${SERVER_HTTP}/voice/endpoint`,
      MOCK_CALL,
      { headers: { "Content-Type": "application/json" }, timeout: 3000 },
    );

    if (!resp.data.success || !resp.data.wss_url) {
      console.error("Unexpected response:", resp.data);
      process.exit(1);
    }

    const cleanWssHost = SERVER_WSS.replace(/^https?:\/\//, "").replace(
      /^wss?:\/\//,
      "",
    );
    const pathPart = resp.data.wss_url.replace(/^wss?:\/\/[^/]+/, "");
    wssUrl = `wss://${cleanWssHost}${pathPart}`;
    console.log(`[1/3] Got wss_url: ${wssUrl}`);
  } catch (err) {
    console.error("[1/3] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  console.log("[2/3] Opening WebSocket to bridge ...");
  const ws = new WebSocket(wssUrl);

  let audioInterval: ReturnType<typeof setInterval> | null = null;
  let chunksSent = 0;
  let chunksReceived = 0;
  let bytesReceived = 0;

  ws.on("open", () => {
    console.log("[2/3] WebSocket connected\n");

    // Step 1: Send Smartflow handshake — "connected"
    send(ws, { event: "connected" });
    console.log("      → sent: connected");

    // Step 2: Send "start" with stream metadata
    send(ws, {
      event: "start",
      sequenceNumber: "1",
      streamSid: STREAM_SID,
      start: {
        streamSid: STREAM_SID,
        accountSid: ACCOUNT_SID,
        callSid: CALL_SID,
        from: MOCK_CALL.fromNumber,
        to: MOCK_CALL.toNumber,
        direction: "inbound",
        mediaFormat: {
          encoding: "audio/x-mulaw",
          sampleRate: 8000,
          bitRate: 64,
          bitDepth: 8,
        },
      },
    });
    console.log("      → sent: start (stream metadata)");
    console.log(
      `      Will stream audio for ${CALL_DURATION_MS / 1000}s then hang up.\n`,
    );

    // Step 3: Stream audio media events every 100ms (800-byte chunks = 100ms of 8kHz µ-law)
    let seq = 2;
    audioInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        send(ws, {
          event: "media",
          sequenceNumber: String(seq++),
          streamSid: STREAM_SID,
          media: {
            chunk: String(chunksSent + 1),
            timestamp: String(chunksSent * 100),
            payload: makeSilenceChunk(),
          },
        });
        chunksSent++;
      }
    }, AUDIO_SEND_INTERVAL);

    // Step 4: After CALL_DURATION_MS send "stop"
    setTimeout(() => {
      console.log("\n[3/3] Simulating hang-up (stop event) ...");
      if (audioInterval) clearInterval(audioInterval);
      if (ws.readyState === WebSocket.OPEN) {
        send(ws, {
          event: "stop",
          sequenceNumber: String(chunksSent + 2),
          streamSid: STREAM_SID,
          stop: {
            accountSid: ACCOUNT_SID,
            callSid: CALL_SID,
            reason: "The caller disconnected the call",
          },
        });
        ws.close(1000, "call ended");
      }
    }, CALL_DURATION_MS);
  });

  ws.on("message", (data: WebSocket.RawData) => {
    const text = data.toString();
    try {
      const msg = JSON.parse(text) as {
        event: string;
        media?: { payload: string };
        streamSid?: string;
      };

      if (msg.event === "media" && msg.media?.payload) {
        const audioBuf = Buffer.from(msg.media.payload, "base64");
        chunksReceived++;
        bytesReceived += audioBuf.length;

        if (chunksReceived === 1) {
          console.log(
            `      ✅ First agent audio chunk received! (${audioBuf.length} bytes decoded)`,
          );
        }
        if (chunksReceived % 10 === 0) {
          console.log(
            `      ← agent audio: ${chunksReceived} chunks  ${(bytesReceived / 1024).toFixed(1)} KB total`,
          );
        }
      } else if (msg.event === "clear") {
        console.log("      ← clear (barge-in from agent)");
      } else {
        console.log(`      ← event: ${msg.event}`);
      }
    } catch {
      console.log(`      ← non-JSON frame: ${text.slice(0, 80)}`);
    }
  });

  ws.on("close", (code, reason) => {
    if (audioInterval) clearInterval(audioInterval);
    console.log("\n=== Call ended ===");
    console.log(`  Close code      : ${code}`);
    console.log(`  Reason          : ${reason.toString() || "(none)"}`);
    console.log(
      `  Chunks sent     : ${chunksSent}  (~${((chunksSent * AUDIO_CHUNK_BYTES) / 1024).toFixed(1)} KB)`,
    );
    console.log(
      `  Chunks received : ${chunksReceived}  (~${(bytesReceived / 1024).toFixed(1)} KB)`,
    );
    if (chunksReceived === 0) {
      console.log(
        "\n  ⚠️  No agent audio received — check Retell API key/agent config and server logs",
      );
    }
  });

  ws.on("error", (err: Error) => {
    if (audioInterval) clearInterval(audioInterval);
    console.error("[WS ERROR]", err.message);
    process.exit(1);
  });
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
