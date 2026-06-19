import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import url from "url";
import {
  Room,
  RoomEvent,
  AudioSource,
  LocalAudioTrack,
  AudioStream,
  AudioFrame,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  ConnectionState,
} from "@livekit/rtc-node";
import { getSession, deleteSession } from "../utils/sessionStore";
import { logger } from "../utils/logger";
import { getAdapter } from "../adapters";

// Retell AI's LiveKit server — discovered from retell-client-js-sdk source
const RETELL_LIVEKIT_URL = "wss://retell-ai-4ihahnq7.livekit.cloud";

// Smartflow sends µ-law 8 kHz mono — same as Twilio
const SAMPLE_RATE = 8000;
const NUM_CHANNELS = 1;
// 20 ms frames — standard for VoIP (160 samples @ 8 kHz)
const FRAME_SAMPLES = 160;

/**
 * Decode µ-law byte to 16-bit PCM sample.
 * Reference: ITU-T G.711
 */
function mulawToPcm16(mulaw: number): number {
  mulaw = ~mulaw & 0xff;
  const sign = mulaw & 0x80 ? -1 : 1;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  const sample = sign * ((mantissa << (exponent + 3)) + (0x84 << exponent) - 0x84);
  return Math.max(-32768, Math.min(32767, sample));
}

/**
 * Encode 16-bit PCM sample to µ-law byte.
 */
function pcm16ToMulaw(sample: number): number {
  const MAX = 32767;
  const BIAS = 0x84;
  const sign = sample < 0 ? 0x80 : 0x00;
  let s = Math.abs(sample);
  if (s > MAX) s = MAX;
  s += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/**
 * Convert a Buffer of µ-law bytes to an Int16Array of PCM samples.
 */
function mulawBufToPcm16(buf: Buffer): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = mulawToPcm16(buf[i]);
  }
  return out;
}

/**
 * Convert an Int16Array of PCM samples to a Buffer of µ-law bytes.
 */
function pcm16BufToMulaw(samples: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = pcm16ToMulaw(samples[i]);
  }
  return out;
}

export function attachWebSocketBridge(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/stream" });

  wss.on("connection", (smartflowWs: WebSocket, req: http.IncomingMessage) => {
    const parsedUrl = url.parse(req.url ?? "", true);
    const token = parsedUrl.query["token"] as string | undefined;

    if (!token) {
      logger.warn("[bridge] WebSocket connection rejected: missing token");
      smartflowWs.close(4001, "Missing token");
      return;
    }

    const session = getSession(token);
    if (!session) {
      logger.warn("[bridge] WebSocket connection rejected: invalid or expired token", { token });
      smartflowWs.close(4002, "Invalid or expired token");
      return;
    }

    session.smartflowWs = smartflowWs;
    const adapter = getAdapter(session.vendor);
    let streamSid = "";
    let chunkCounter = 0;
    let cleanupCalled = false;

    // LiveKit room & audio objects
    const room = new Room();
    let audioSource: AudioSource | null = null;
    let localTrack: LocalAudioTrack | null = null;
    let publishedTrackSid: string | undefined;
    // Accumulate µ-law bytes until we have a full 20ms frame
    let mulawAccum = Buffer.alloc(0);

    logger.info("[bridge] Vendor WebSocket connected", {
      token,
      vendor: session.vendor,
      smartflowCallId: session.smartflowCallId,
      retellCallId: session.retellCallId,
    });

    // ── Cleanup ────────────────────────────────────────────────────────────
    const cleanup = async (source: string) => {
      if (cleanupCalled) return;
      cleanupCalled = true;

      logger.info("[bridge] Call session ending", {
        source,
        vendor: session.vendor,
        token,
        smartflowCallId: session.smartflowCallId,
        retellCallId: session.retellCallId,
        chunksSentToVendor: chunkCounter,
      });

      try {
        if (publishedTrackSid) await room.localParticipant?.unpublishTrack(publishedTrackSid);
        await room.disconnect();
      } catch { /* best-effort */ }

      if (smartflowWs.readyState === WebSocket.OPEN || smartflowWs.readyState === WebSocket.CONNECTING) {
        smartflowWs.close();
      }

      deleteSession(token);
    };

    // ── Connect to Retell via LiveKit ──────────────────────────────────────
    (async () => {
      try {
        // Create an AudioSource and local track for pushing user audio into Retell
        audioSource = new AudioSource(SAMPLE_RATE, NUM_CHANNELS);
        localTrack = LocalAudioTrack.createAudioTrack("user_audio", audioSource);

        const publishOpts = new TrackPublishOptions();
        publishOpts.source = TrackSource.SOURCE_MICROPHONE;

        // Wire up LiveKit events before connecting
        room.on(RoomEvent.Connected, async () => {
          logger.info("[bridge] LiveKit room connected", {
            retellCallId: session.retellCallId,
            roomName: room.name,
          });

          // Publish our audio track so Retell can receive user speech
          const pub = await room.localParticipant?.publishTrack(localTrack!, publishOpts);
          logger.debug("[bridge] Published track sid", { sid: pub?.sid });
          logger.info("[bridge] Published user audio track to Retell LiveKit room");

          // Flush any µ-law that arrived before we connected
          if (mulawAccum.length > 0) {
            flushMulawToRetell(mulawAccum);
            mulawAccum = Buffer.alloc(0);
          }

          if (adapter.onOpen) {
            adapter.onOpen(smartflowWs, { streamSid, chunkCounter });
          }
        });

        room.on(RoomEvent.Disconnected, () => {
          logger.info("[bridge] LiveKit room disconnected", {
            retellCallId: session.retellCallId,
          });
          cleanup("retell-livekit-disconnect");
        });

        // Subscribe to agent audio track (Retell → Smartflow)
        room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
          if (track.kind !== TrackKind.KIND_AUDIO) return;
          logger.info("[bridge] Subscribed to Retell agent audio track", {
            trackName: publication.name,
            participantIdentity: participant.identity,
          });

          // AudioStream lets us pull PCM frames from the remote track
          const audioStream = new AudioStream(track, SAMPLE_RATE, NUM_CHANNELS);

          (async () => {
            for await (const frame of audioStream) {
              if (smartflowWs.readyState !== WebSocket.OPEN) break;

              // frame.data is Int16Array of PCM samples
              const mulaw = pcm16BufToMulaw(frame.data as Int16Array);
              chunkCounter++;

              const encodedFrame = adapter.encodeAudio(mulaw, { streamSid, chunkCounter });
              smartflowWs.send(encodedFrame);

              if (chunkCounter === 1) {
                logger.info("[bridge] First agent audio frame sent to vendor", {
                  vendor: session.vendor,
                  retellCallId: session.retellCallId,
                  bytes: mulaw.length,
                });
              }
            }
          })().catch((err) => {
            logger.error("[bridge] Error reading agent audio stream", { error: (err as Error).message });
          });
        });

        // Connect to Retell's LiveKit server
        await room.connect(RETELL_LIVEKIT_URL, session.retellAccessToken, {
          autoSubscribe: true,
          dynacast: false,
        });

      } catch (err) {
        logger.error("[bridge] Failed to connect to Retell LiveKit room", {
          retellCallId: session.retellCallId,
          error: (err as Error).message,
        });
        cleanup("retell-connect-error");
      }
    })();

    // ── Helper: push accumulated µ-law buffer to Retell as PCM frames ─────
    const flushMulawToRetell = (buf: Buffer) => {
      if (!audioSource) return;
      let offset = 0;
      while (offset + FRAME_SAMPLES <= buf.length) {
        const chunk = buf.slice(offset, offset + FRAME_SAMPLES);
        const pcm = mulawBufToPcm16(chunk);
        const frame = new AudioFrame(pcm, SAMPLE_RATE, NUM_CHANNELS, FRAME_SAMPLES);
        // captureFrame is synchronous in @livekit/rtc-node
        audioSource.captureFrame(frame);
        offset += FRAME_SAMPLES;
      }
      // Return leftover bytes
      return buf.slice(offset);
    };

    // ── Smartflow → Retell (inbound user audio) ────────────────────────────
    smartflowWs.on("message", (raw: WebSocket.RawData) => {
      const event = adapter.decode(raw);
      if (!event) return;

      switch (event.type) {
        case "connected":
          logger.info("[bridge] Vendor stream connected handshake", { token, vendor: session.vendor });
          break;

        case "start":
          streamSid = event.streamSid;
          logger.info("[bridge] Vendor stream started", {
            vendor: session.vendor,
            streamSid,
            from: event.from,
            to: event.to,
          });
          break;

        case "audio": {
          const incomingBuf = Buffer.isBuffer(event.payload)
            ? event.payload
            : Buffer.from(event.payload as string, "base64");

          if (!audioSource || room.connectionState !== ConnectionState.CONN_CONNECTED) {
            // Buffer until LiveKit room is ready
            mulawAccum = Buffer.concat([mulawAccum, incomingBuf]);
          } else {
            // Prepend any buffered bytes and flush
            const combined = mulawAccum.length > 0
              ? Buffer.concat([mulawAccum, incomingBuf])
              : incomingBuf;
            const leftover = flushMulawToRetell(combined);
            mulawAccum = leftover ?? Buffer.alloc(0);
          }
          break;
        }

        case "stop":
          logger.info("[bridge] Vendor stream stop event", { vendor: session.vendor, streamSid });
          cleanup("vendor-stop");
          break;
      }
    });

    // ── Socket lifecycle ───────────────────────────────────────────────────
    smartflowWs.on("close", (code: number, reason: Buffer) => {
      logger.info("[bridge] Smartflow WebSocket closed", {
        code,
        reason: reason.toString(),
        smartflowCallId: session.smartflowCallId,
      });
      cleanup("smartflow");
    });

    smartflowWs.on("error", (err: Error) => {
      logger.error("[bridge] Smartflow WebSocket error", {
        smartflowCallId: session.smartflowCallId,
        error: err.message,
      });
      cleanup("smartflow-error");
    });
  });

  logger.info("[bridge] WebSocket bridge attached at /stream (LiveKit mode)");
  return wss;
}
