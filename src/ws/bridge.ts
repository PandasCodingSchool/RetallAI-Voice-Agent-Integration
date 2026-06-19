import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import url from "url";
import { v4 as uuidv4 } from "uuid";
import {
  Room,
  RoomEvent,
  AudioSource,
  LocalAudioTrack,
  AudioStream,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  ConnectionState,
} from "@livekit/rtc-node";
import { getSession, deleteSession } from "../utils/sessionStore";
import { registerCall } from "../services/retellService";
import { logger } from "../utils/logger";
import { getAdapter } from "../adapters";
import { AudioFrame } from "@livekit/rtc-node";

// Retell AI's LiveKit server — discovered from retell-client-js-sdk source
const RETELL_LIVEKIT_URL = "wss://retell-ai-4ihahnq7.livekit.cloud";

// Smartflow sends µ-law 8 kHz mono
const SAMPLE_RATE = 8000;
const NUM_CHANNELS = 1;
// 20 ms frames — 160 samples @ 8 kHz
const FRAME_SAMPLES = 160;

/** Decode µ-law byte → 16-bit PCM sample (ITU-T G.711) */
function mulawToPcm16(mulaw: number): number {
  mulaw = ~mulaw & 0xff;
  const sign = mulaw & 0x80 ? -1 : 1;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  const sample = sign * ((mantissa << (exponent + 3)) + (0x84 << exponent) - 0x84);
  return Math.max(-32768, Math.min(32767, sample));
}

/** Encode 16-bit PCM sample → µ-law byte */
function pcm16ToMulaw(sample: number): number {
  const BIAS = 0x84;
  const sign = sample < 0 ? 0x80 : 0x00;
  let s = Math.abs(sample);
  if (s > 32767) s = 32767;
  s += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function mulawBufToPcm16(buf: Buffer): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = mulawToPcm16(buf[i]);
  return out;
}

function pcm16BufToMulaw(samples: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = pcm16ToMulaw(samples[i]);
  return out;
}

/**
 * Core bridge logic — shared by both token mode and static mode.
 * Connects to Retell via LiveKit using the given access_token,
 * and relays audio between the Smartflow WS and the LiveKit room.
 */
function runBridge(
  smartflowWs: WebSocket,
  retellCallId: string,
  retellAccessToken: string,
  vendor: string,
  smartflowCallId: string,
  initialStreamSid: string,
  onCleanup?: () => void,
): void {
  const adapter = getAdapter(vendor);
  let streamSid = initialStreamSid;
  let chunkCounter = 0;
  let cleanupCalled = false;

  const room = new Room();
  let audioSource: AudioSource | null = null;
  let localTrack: LocalAudioTrack | null = null;
  let publishedTrackSid: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mulawAccum: any = Buffer.alloc(0);

  // ── Cleanup ──────────────────────────────────────────────────────────────
  const cleanup = async (source: string) => {
    if (cleanupCalled) return;
    cleanupCalled = true;

    logger.info("[bridge] Call session ending", {
      source,
      vendor,
      smartflowCallId,
      retellCallId,
      chunksSentToVendor: chunkCounter,
    });

    try {
      if (publishedTrackSid) await room.localParticipant?.unpublishTrack(publishedTrackSid);
      await room.disconnect();
    } catch { /* best-effort */ }

    if (smartflowWs.readyState === WebSocket.OPEN || smartflowWs.readyState === WebSocket.CONNECTING) {
      smartflowWs.close(1000, "call ended");
    }

    onCleanup?.();
  };

  // ── Helper: push µ-law buffer to Retell as 20ms PCM frames ──────────────
  let isFlushing = false;
  const processAudioQueue = async () => {
    if (isFlushing || !audioSource || room.connectionState !== ConnectionState.CONN_CONNECTED) return;
    isFlushing = true;
    try {
      while (mulawAccum.length >= FRAME_SAMPLES) {
        if (smartflowWs.readyState !== WebSocket.OPEN) break;
        
        const chunk = mulawAccum.slice(0, FRAME_SAMPLES);
        // Remove processed chunk from accumulator
        mulawAccum = Buffer.from(mulawAccum.buffer, mulawAccum.byteOffset + FRAME_SAMPLES, mulawAccum.byteLength - FRAME_SAMPLES);
        
        // Linear Interpolation: smoothly upsample 8000Hz to 24000Hz (3x)
        // This avoids metallic/ZOH aliasing while satisfying Retell's 24kHz expectation.
        const pcm24k = new Int16Array(FRAME_SAMPLES * 3);
        for (let i = 0; i < FRAME_SAMPLES; i++) {
          const sample1 = mulawToPcm16(chunk[i]);
          const sample2 = i + 1 < FRAME_SAMPLES ? mulawToPcm16(chunk[i + 1]) : sample1;
          
          pcm24k[i * 3] = sample1;
          pcm24k[i * 3 + 1] = Math.floor(sample1 + (sample2 - sample1) * 0.3333);
          pcm24k[i * 3 + 2] = Math.floor(sample1 + (sample2 - sample1) * 0.6667);
        }
        
        const frame = new AudioFrame(pcm24k, 24000, NUM_CHANNELS, FRAME_SAMPLES * 3);
        await audioSource.captureFrame(frame);
      }
    } catch (err) {
      logger.error("[bridge] Audio queue error", { error: (err as Error).message });
    } finally {
      isFlushing = false;
    }
  };

  // ── Connect to Retell via LiveKit ────────────────────────────────────────
  (async () => {
    try {
      audioSource = new AudioSource(24000, NUM_CHANNELS);
      localTrack = LocalAudioTrack.createAudioTrack("user_audio", audioSource);

      const publishOpts = new TrackPublishOptions();
      publishOpts.source = TrackSource.SOURCE_MICROPHONE;
      publishOpts.dtx = false; // Disable Discontinuous Transmission to prevent aggressive WebRTC VAD dropping

      room.on(RoomEvent.Connected, async () => {
        logger.info("[bridge] LiveKit room connected", { retellCallId, roomName: room.name });

        const pub = await room.localParticipant?.publishTrack(localTrack!, publishOpts);
        publishedTrackSid = pub?.sid;
        logger.info("[bridge] Published user audio track to Retell LiveKit room");

        // Flush buffered audio that arrived before LiveKit connected
        if (mulawAccum.length > 0) {
          processAudioQueue();
        }

        if (adapter.onOpen) {
          adapter.onOpen(smartflowWs, { streamSid, chunkCounter });
        }
      });

      room.on(RoomEvent.Disconnected, () => {
        logger.info("[bridge] LiveKit room disconnected", { retellCallId });
        cleanup("retell-livekit-disconnect");
      });

      // Subscribe to agent audio (Retell → Smartflow)
      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind !== TrackKind.KIND_AUDIO) return;
        logger.info("[bridge] Subscribed to Retell agent audio track", {
          trackName: publication.name,
          participantIdentity: participant.identity,
        });

        const audioStream = new AudioStream(track, SAMPLE_RATE, NUM_CHANNELS);
        (async () => {
          let outboundAccum = Buffer.alloc(0);
          for await (const frame of audioStream) {
            if (smartflowWs.readyState !== WebSocket.OPEN) break;
            const mulaw = pcm16BufToMulaw(frame.data as Int16Array);
            outboundAccum = Buffer.concat([outboundAccum, mulaw]);
            
            // Send in 20ms (160 bytes) chunks to prevent WebSocket lag
            while (outboundAccum.length >= 160) {
              const chunk = outboundAccum.slice(0, 160);
              outboundAccum = Buffer.from(outboundAccum.buffer, outboundAccum.byteOffset + 160, outboundAccum.byteLength - 160);
              
              chunkCounter++;
              const encodedFrame = adapter.encodeAudio(chunk, { streamSid, chunkCounter });
              smartflowWs.send(encodedFrame);
              
              if (chunkCounter === 1) {
                logger.info("[bridge] First agent audio frame sent to vendor", {
                  vendor,
                  retellCallId,
                  bytes: chunk.length,
                });
              }
            }
          }
        })().catch((err) => {
          logger.error("[bridge] Error reading agent audio stream", { error: (err as Error).message });
        });
      });

      await room.connect(RETELL_LIVEKIT_URL, retellAccessToken, {
        autoSubscribe: true,
        dynacast: false,
      });

    } catch (err) {
      logger.error("[bridge] Failed to connect to Retell LiveKit room", {
        retellCallId,
        error: (err as Error).message,
      });
      cleanup("retell-connect-error");
    }
  })();

  // ── Smartflow → Retell (inbound user audio) ──────────────────────────────
  smartflowWs.on("message", (raw: WebSocket.RawData) => {
    const event = adapter.decode(raw);
    if (!event) return;

    switch (event.type) {
      case "connected":
        logger.info("[bridge] Vendor stream connected handshake", { vendor, smartflowCallId });
        break;

      case "start":
        streamSid = event.streamSid;
        logger.info("[bridge] Vendor stream started", { vendor, streamSid, from: event.from, to: event.to });
        break;

      case "audio": {
        const incomingBuf: Buffer = Buffer.isBuffer(event.payload)
          ? (event.payload as Buffer)
          : Buffer.from(event.payload as string, "base64");

        mulawAccum = Buffer.concat([mulawAccum, incomingBuf]);
        processAudioQueue();
        break;
      }

      case "stop":
        logger.info("[bridge] Vendor stream stop event", { vendor, streamSid });
        cleanup("vendor-stop");
        break;
    }
  });

  smartflowWs.on("close", (code: number, reason: Buffer) => {
    logger.info("[bridge] Smartflow WebSocket closed", { code, reason: reason.toString(), smartflowCallId });
    cleanup("smartflow");
  });

  smartflowWs.on("error", (err: Error) => {
    logger.error("[bridge] Smartflow WebSocket error", { smartflowCallId, error: err.message });
    cleanup("smartflow-error");
  });
}

export function attachWebSocketBridge(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/stream" });

  wss.on("connection", (smartflowWs: WebSocket, req: http.IncomingMessage) => {
    const parsedUrl = url.parse(req.url ?? "", true);
    const token = parsedUrl.query["token"] as string | undefined;

    // ── Token mode: pre-registered via HTTP POST /voice/endpoint ─────────
    if (token) {
      const session = getSession(token);
      if (!session) {
        logger.warn("[bridge] WebSocket connection rejected: invalid or expired token", { token });
        smartflowWs.close(4002, "Invalid or expired token");
        return;
      }
      session.smartflowWs = smartflowWs;
      logger.info("[bridge] Token-mode WebSocket connected", {
        token,
        vendor: session.vendor,
        smartflowCallId: session.smartflowCallId,
        retellCallId: session.retellCallId,
      });
      runBridge(
        smartflowWs,
        session.retellCallId,
        session.retellAccessToken,
        session.vendor,
        session.smartflowCallId,
        "",
        () => deleteSession(token),
      );
      return;
    }

    // ── Static mode: Smartflow connects directly with no prior HTTP POST ──
    // Wait for the "start" event to learn call metadata, then create a call.
    logger.info("[bridge] Static-mode WebSocket connected (no token)", {
      remoteIp: req.socket.remoteAddress,
      url: req.url,
    });

    const adapter = getAdapter("smartflow");
    let bridgeStarted = false;
    let mulawBuffer: Buffer[] = []; // Buffer audio that arrives before bridge is up

    const staticHandler = async (raw: WebSocket.RawData) => {
      const event = adapter.decode(raw);
      if (!event) return;

      if (event.type === "connected") {
        logger.info("[bridge] Static-mode: connected handshake received");
        return;
      }

      if (event.type === "start" && !bridgeStarted) {
        bridgeStarted = true;
        const streamSid = event.streamSid;
        const fromNumber = event.from ?? "unknown";
        const toNumber = event.to ?? "unknown";
        const callId = `sf-static-${uuidv4()}`;

        logger.info("[bridge] Static-mode: start event — registering Retell call", {
          callId,
          fromNumber,
          toNumber,
          streamSid,
        });

        try {
          const retellCall = await registerCall(fromNumber, toNumber, callId);

          // Remove this provisional handler; runBridge attaches its own
          smartflowWs.removeAllListeners("message");

          runBridge(
            smartflowWs,
            retellCall.call_id,
            retellCall.access_token,
            "smartflow",
            callId,
            streamSid,
          );

          // Replay any buffered audio events into the new bridge
          for (const buf of mulawBuffer) {
            smartflowWs.emit("message", buf, false);
          }
          mulawBuffer = [];

        } catch (err) {
          logger.error("[bridge] Static-mode: failed to register Retell call", {
            callId,
            error: (err as Error).message,
          });
          smartflowWs.close(1011, "Retell registration failed");
        }
        return;
      }

      // Buffer audio that arrives while we're registering
      if (event.type === "audio") {
        const incomingBuf: Buffer = Buffer.isBuffer(event.payload)
          ? (event.payload as Buffer)
          : Buffer.from(event.payload as string, "base64");
        mulawBuffer.push(incomingBuf);
        if (mulawBuffer.length % 50 === 0) {
          logger.debug("[bridge] Static-mode: buffered audio frames", { count: mulawBuffer.length });
        }
      }
    };

    smartflowWs.on("message", staticHandler);

    smartflowWs.on("close", (code: number, reason: Buffer) => {
      if (!bridgeStarted) {
        logger.info("[bridge] Static-mode: WS closed before bridge started", {
          code,
          reason: reason.toString(),
        });
      }
    });
  });

  logger.info("[bridge] WebSocket bridge attached at /stream (LiveKit mode — static+token)");
  return wss;
}
