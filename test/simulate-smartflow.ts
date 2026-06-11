import axios from "axios";
import WebSocket from "ws";

const SERVER_HTTP = process.env["SERVER_HTTP"] ?? "http://localhost:3000";
const SERVER_WSS = process.env["SERVER_WSS"] ?? "ws://localhost:3000";

const MOCK_CALL = {
  callId: `sim-${Date.now()}`,
  fromNumber: "+919000000001",
  toNumber: "+918000000001",
  status: "ringing",
};

const AUDIO_FRAME_BYTES = 320;
const AUDIO_SEND_INTERVAL_MS = 20;
const CALL_DURATION_MS = parseInt(
  process.env["CALL_DURATION_MS"] ?? "10000",
  10,
);

function makeSilenceFrame(): Buffer {
  return Buffer.alloc(AUDIO_FRAME_BYTES, 0xff);
}

async function run(): Promise<void> {
  console.log("=== Smartflow Simulator ===");
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
  let framesReceived = 0;
  let framesSent = 0;

  ws.on("open", () => {
    console.log("[2/3] WebSocket connected — streaming synthetic audio ...");
    console.log(
      `      Will run for ${CALL_DURATION_MS / 1000}s then hang up.\n`,
    );

    audioInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(makeSilenceFrame());
        framesSent++;
      }
    }, AUDIO_SEND_INTERVAL_MS);

    setTimeout(() => {
      console.log("\n[3/3] Simulating hang-up ...");
      if (audioInterval) clearInterval(audioInterval);
      ws.close(1000, "call ended");
    }, CALL_DURATION_MS);
  });

  ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) {
      framesReceived++;
      if (framesReceived === 1) {
        console.log(
          "      ✅ First audio frame received from Retell AI agent!",
        );
      }
      if (framesReceived % 50 === 0) {
        const buf = data as Buffer;
        console.log(
          `      ← agent audio: ${framesReceived} frames received (last frame ${buf.length} bytes)`,
        );
      }
    } else {
      console.log(`      ← text frame: ${data.toString()}`);
    }
  });

  ws.on("close", (code, reason) => {
    if (audioInterval) clearInterval(audioInterval);
    console.log(`\n=== Call ended ===`);
    console.log(`  Close code   : ${code}`);
    console.log(`  Reason       : ${reason.toString() || "(none)"}`);
    console.log(
      `  Frames sent  : ${framesSent}  (~${((framesSent * AUDIO_FRAME_BYTES) / 1024).toFixed(1)} KB)`,
    );
    console.log(`  Frames recv  : ${framesReceived}`);
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
