import WebSocket from "ws";

const SERVER_WSS = process.env["SERVER_WSS"] ?? "ws://localhost:3000";
const CALL_DURATION_MS = parseInt(process.env["CALL_DURATION_MS"] ?? "15000", 10);

const STREAM_SID = "MZsimulatedSTATIC00000000000000001";
const AUDIO_CHUNK_BYTES = 800; // 100ms at 8kHz
const AUDIO_SEND_INTERVAL = 100;

let phase = 0;
function makeVoiceChunk(): string {
  const buf = Buffer.alloc(AUDIO_CHUNK_BYTES);
  for (let i = 0; i < AUDIO_CHUNK_BYTES; i++) {
    const sample = Math.floor(Math.sin(phase) * 8000);
    phase += (440 * 2 * Math.PI) / 8000;
    
    let pcm = sample;
    const MAX = 32635; const BIAS = 0x84;
    const sign = pcm < 0 ? 0x80 : 0x00;
    if (pcm < 0) pcm = -pcm;
    if (pcm > MAX) pcm = MAX;
    pcm += BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    const mantissa = (pcm >> (exponent + 3)) & 0x0f;
    buf[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return buf.toString("base64");
}

async function run() {
  const wssUrl = `${SERVER_WSS}/stream`; // Static mode (no token)
  console.log(`[1/2] Connecting to static bridge URL: ${wssUrl}`);
  
  const ws = new WebSocket(wssUrl);
  let audioInterval: ReturnType<typeof setInterval> | null = null;
  
  ws.on("open", () => {
    console.log("[2/2] WebSocket connected (static mode)");
    
    ws.send(JSON.stringify({ event: "connected" }));
    ws.send(JSON.stringify({
      event: "start",
      streamSid: STREAM_SID,
      start: { streamSid: STREAM_SID, mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000 } }
    }));
    
    audioInterval = setInterval(() => {
      ws.send(JSON.stringify({
        event: "media", streamSid: STREAM_SID, media: { payload: makeVoiceChunk() }
      }));
    }, AUDIO_SEND_INTERVAL);
    
    setTimeout(() => ws.close(1000, "call ended"), CALL_DURATION_MS);
  });
  
  ws.on("message", (msg) => {
    // console.log("Received msg");
  });
  
  ws.on("close", (code, reason) => {
    console.log(`\n=== Call ended ===\n  Close code      : ${code}\n  Reason          : ${reason}`);
    if (audioInterval) clearInterval(audioInterval);
  });
}

run().catch(console.error);
