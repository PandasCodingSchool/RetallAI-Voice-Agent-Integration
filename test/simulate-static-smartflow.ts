import WebSocket from "ws";

const SERVER_WS = process.env["SERVER_WS"] ?? "ws://localhost:8080/stream";
const CALL_DURATION_MS = parseInt(
  process.env["CALL_DURATION_MS"] ?? "10000",
  10,
);
const AUDIO_CHUNK_BYTES = parseInt(
  process.env["AUDIO_CHUNK_BYTES"] ?? "160",
  10,
);
const AUDIO_SEND_INTERVAL_MS = parseInt(
  process.env["AUDIO_SEND_INTERVAL_MS"] ?? "20",
  10,
);

const STREAM_SID = `sim-stream-${Date.now()}`;
const CALL_SID = `sim-call-${Date.now()}`;
const FROM_NUMBER = process.env["FROM_NUMBER"] ?? "+918065063946";
const TO_NUMBER = process.env["TO_NUMBER"] ?? "+918069879865";

function makeMulawSilenceChunk(): string {
  return Buffer.alloc(AUDIO_CHUNK_BYTES, 0xff).toString("base64");
}

function send(ws: WebSocket, message: unknown): void {
  ws.send(JSON.stringify(message));
}

function run(): void {
  console.log("=== Static Smartflow WebSocket Simulator ===");
  console.log(`WebSocket URL : ${SERVER_WS}`);
  console.log(`Stream SID    : ${STREAM_SID}`);
  console.log(`Call SID      : ${CALL_SID}`);
  console.log(`From          : ${FROM_NUMBER}`);
  console.log(`To            : ${TO_NUMBER}`);
  console.log(`Duration      : ${CALL_DURATION_MS}ms`);
  console.log(`Chunk         : ${AUDIO_CHUNK_BYTES} bytes every ${AUDIO_SEND_INTERVAL_MS}ms`);
  console.log("");

  const ws = new WebSocket(SERVER_WS);
  let audioInterval: ReturnType<typeof setInterval> | null = null;
  let chunksSent = 0;
  let chunksReceived = 0;
  let bytesReceived = 0;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;

  ws.on("open", () => {
    console.log("[open] Connected to bridge");

    send(ws, { event: "connected" });
    console.log("  -> connected");

    send(ws, {
      event: "start",
      sequenceNumber: 1,
      start: {
        accountSid: "777841",
        streamSid: STREAM_SID,
        callSid: CALL_SID,
        from: FROM_NUMBER,
        to: TO_NUMBER,
        direction: "inbound",
        mediaFormat: {
          encoding: "audio/x-mulaw",
          sampleRate: 8000,
          bitRate: 64,
          bitDepth: 8,
        },
        customParameters: null,
      },
      streamSid: STREAM_SID,
    });
    console.log("  -> start");

    let sequenceNumber = 2;
    audioInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      chunksSent++;
      send(ws, {
        event: "media",
        sequenceNumber: sequenceNumber++,
        media: {
          chunk: chunksSent,
          timestamp: chunksSent * AUDIO_SEND_INTERVAL_MS,
          payload: makeMulawSilenceChunk(),
        },
        streamSid: STREAM_SID,
      });
      if (chunksSent === 1 || chunksSent % 50 === 0) {
        console.log(`  -> media chunks sent: ${chunksSent}`);
      }
    }, AUDIO_SEND_INTERVAL_MS);

    stopTimer = setTimeout(() => {
      if (audioInterval) clearInterval(audioInterval);
      if (ws.readyState !== WebSocket.OPEN) return;
      send(ws, {
        event: "stop",
        sequenceNumber: sequenceNumber++,
        stop: {
          accountSid: "777841",
          callSid: CALL_SID,
          reason: "local simulator ended call",
        },
        streamSid: STREAM_SID,
      });
      console.log("  -> stop");
      ws.close(1000, "local simulator ended call");
    }, CALL_DURATION_MS);
  });

  ws.on("message", (data: WebSocket.RawData) => {
    const text = data.toString();
    try {
      const message = JSON.parse(text) as {
        event?: string;
        media?: { payload?: string };
      };
      if (message.event === "media" && message.media?.payload) {
        const audio = Buffer.from(message.media.payload, "base64");
        chunksReceived++;
        bytesReceived += audio.length;
        if (chunksReceived === 1 || chunksReceived % 25 === 0) {
          console.log(
            `  <- agent media chunks received: ${chunksReceived}, bytes: ${bytesReceived}`,
          );
        }
        return;
      }
      console.log(`  <- event: ${message.event ?? "unknown"}`);
    } catch {
      console.log(`  <- non-json: ${text.slice(0, 120)}`);
    }
  });

  ws.on("close", (code, reason) => {
    if (audioInterval) clearInterval(audioInterval);
    if (stopTimer) clearTimeout(stopTimer);
    console.log("");
    console.log("=== Simulator finished ===");
    console.log(`Close code       : ${code}`);
    console.log(`Close reason     : ${reason.toString() || "(none)"}`);
    console.log(`Chunks sent      : ${chunksSent}`);
    console.log(`Agent chunks     : ${chunksReceived}`);
    console.log(`Agent bytes      : ${bytesReceived}`);
    if (chunksReceived === 0) {
      console.log("No agent audio received. Check server Retell registration/audio logs.");
    }
  });

  ws.on("error", (error: Error) => {
    if (audioInterval) clearInterval(audioInterval);
    if (stopTimer) clearTimeout(stopTimer);
    console.error("[error]", error.message);
    process.exitCode = 1;
  });
}

run();
