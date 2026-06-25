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
  AudioFrame,
  AudioResampler,
  AudioResamplerQuality,
} from "@livekit/rtc-node";
import { getSession, deleteSession } from "../utils/sessionStore";
import { registerCall } from "../services/retellService";
import { logger } from "../utils/logger";
import { getAdapter } from "../adapters";
import { alaw, mulaw } from "alawmulaw";


// Retell AI's LiveKit server — discovered from retell-client-js-sdk source
const RETELL_LIVEKIT_URL = "wss://retell-ai-4ihahnq7.livekit.cloud";

// Smartflow sends µ-law or A-law 8 kHz mono
const SAMPLE_RATE = 8000;
const NUM_CHANNELS = 1;
// 20 ms frames — 160 samples @ 8 kHz
const FRAME_SAMPLES = 160;

function getCodecFromMediaFormat(mediaFormat?: { encoding?: string }): "mulaw" | "alaw" {
  if (mediaFormat && typeof mediaFormat.encoding === "string") {
    const enc = mediaFormat.encoding.toLowerCase();
    if (enc.includes("alaw") || enc.includes("pcma") || enc.includes("a-law")) {
      return "alaw";
    }
  }
  return "mulaw";
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
  initialCodec?: "mulaw" | "alaw",
  onCleanup?: () => void,
): void {
  const adapter = getAdapter(vendor);
  let streamSid = initialStreamSid;
  let chunkCounter = 0;
  let cleanupCalled = false;
  let codec: "mulaw" | "alaw" = initialCodec || "mulaw";

  const room = new Room();
  let audioSource: AudioSource | null = null;
  let localTrack: LocalAudioTrack | null = null;
  let publishedTrackSid: string | undefined;
  let audioResampler: AudioResampler | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mulawAccum: any = Buffer.alloc(0);
  let resampledAccum: any = new Int16Array(0);

  const appendToInt16Array = (arr1: any, arr2: any): Int16Array => {
    const res = new Int16Array(arr1.length + arr2.length);
    res.set(arr1, 0);
    res.set(arr2, arr1.length);
    return res;
  };

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

    if (audioResampler) {
      try {
        audioResampler.close();
      } catch { /* best-effort */ }
      audioResampler = null;
    }

    if (smartflowWs.readyState === WebSocket.OPEN || smartflowWs.readyState === WebSocket.CONNECTING) {
      smartflowWs.close(1000, "call ended");
    }

    onCleanup?.();
  };

  // ── Audio gain: telephony codecs use low signal levels.
  // Retell's WebRTC VAD/STT requires proper amplitude to detect speech.
  // We make the gain configurable via process.env.AUDIO_GAIN.
  // Default is 1.0 (no gain) which is correct for properly decoded PCM, but can be overridden.
  const GAIN = process.env.AUDIO_GAIN ? parseFloat(process.env.AUDIO_GAIN) : 1.0;

  // ── Helper: push buffer to Retell as 20ms PCM frames ─────────────────────
  let isFlushing = false;
  let debugFrameCount = 0;
  const processAudioQueue = async () => {
    if (isFlushing || !audioSource || room.connectionState !== ConnectionState.CONN_CONNECTED) return;
    isFlushing = true;
    try {
      while (mulawAccum.length >= FRAME_SAMPLES) {
        if (smartflowWs.readyState !== WebSocket.OPEN) break;
        
        const chunk = mulawAccum.subarray(0, FRAME_SAMPLES);
        // Remove processed chunk from accumulator
        mulawAccum = mulawAccum.subarray(FRAME_SAMPLES);
        
        let pcm8k: Int16Array;
        if (codec === "alaw") {
          pcm8k = alaw.decode(chunk);
        } else {
          pcm8k = mulaw.decode(chunk);
        }
        
        let rmsSum = 0;
        for (let i = 0; i < FRAME_SAMPLES; i++) {
          const s = Math.max(-32768, Math.min(32767, pcm8k[i] * GAIN));
          rmsSum += s * s;
          pcm8k[i] = s;
        }

        const rms = Math.sqrt(rmsSum / FRAME_SAMPLES);
        // Always log the first non-silent frame to confirm caller audio arrives
        if (debugFrameCount === 0 && rms > 0) {
          logger.info("[bridge] First non-silent inbound audio frame from caller", {
            frame: debugFrameCount,
            rms: Math.round(rms),
            codec: codec,
          });
        }
        // Log first 20 frames for baseline diagnostics
        if (debugFrameCount < 20) {
          logger.debug("[bridge] Inbound audio frame RMS (after gain)", {
            frame: debugFrameCount,
            rms: Math.round(rms),
            gain: GAIN,
            sampleRate: 8000,
            codec: codec,
          });
        }
        debugFrameCount++;
        
        if (audioResampler) {
          const frame8k = new AudioFrame(pcm8k, 8000, NUM_CHANNELS, FRAME_SAMPLES);
          const resampledFrames = audioResampler.push(frame8k);
          for (const outFrame of resampledFrames) {
            resampledAccum = appendToInt16Array(resampledAccum, outFrame.data as Int16Array);
          }

          const TARGET_SAMPLES = 960; // 20ms @ 48000Hz
          while (resampledAccum.length >= TARGET_SAMPLES) {
            const pcmChunk = resampledAccum.subarray(0, TARGET_SAMPLES);
            const framePcm = new Int16Array(pcmChunk); // copy to fresh memory
            resampledAccum = resampledAccum.subarray(TARGET_SAMPLES);

            const frame48k = new AudioFrame(framePcm, 48000, NUM_CHANNELS, TARGET_SAMPLES);
            await audioSource.captureFrame(frame48k);
          }
        }
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
      audioResampler = new AudioResampler(8000, 48000, NUM_CHANNELS, AudioResamplerQuality.HIGH);
      logger.info("[bridge] AudioResampler initialized (8000Hz -> 48000Hz)");
      audioSource = new AudioSource(48000, NUM_CHANNELS);
      localTrack = LocalAudioTrack.createAudioTrack("microphone", audioSource);

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
            
            let encoded: Uint8Array;
            if (codec === "alaw") {
              encoded = alaw.encode(frame.data as Int16Array);
            } else {
              encoded = mulaw.encode(frame.data as Int16Array);
            }
            const encodedBuf = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
            outboundAccum = Buffer.concat([outboundAccum, encodedBuf]);
            
            // Send in 20ms (160 bytes) chunks to prevent WebSocket lag
            while (outboundAccum.length >= 160) {
              const chunk = outboundAccum.subarray(0, 160);
              outboundAccum = outboundAccum.subarray(160);
              
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

      // ── Listen for Retell data channel events (transcripts, node transitions) ──
      room.on(RoomEvent.DataReceived, (payload, participant, kind, topic) => {
        try {
          const str = new TextDecoder().decode(payload);
          const data = JSON.parse(str);
          if (data.event_type === "update" || data.event_type === "node_transition") {
            logger.info("[Retell LiveKit Data]", { event_type: data.event_type, data: data });
          }
        } catch (e) {
          logger.debug("Could not parse LiveKit data payload");
        }
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
        logger.info("[bridge] Vendor stream started", {
          vendor,
          streamSid,
          from: event.from,
          to: event.to,
          mediaFormat: event.mediaFormat,
        });
        if (event.mediaFormat) {
          codec = getCodecFromMediaFormat(event.mediaFormat);
          logger.info(`[bridge] Switched codec to ${codec} based on start event mediaFormat`);
        }
        break;

      case "audio": {
        const incomingBuf: Buffer = Buffer.isBuffer(event.payload)
          ? (event.payload as Buffer)
          : Buffer.from(event.payload as string, "base64");

        if (debugFrameCount < 20) {
          logger.debug("[bridge] Incoming Smartflow audio buffer snippet", {
            inboundFramesSeen: debugFrameCount,
            length: incomingBuf.length,
            hex: incomingBuf.toString("hex").substring(0, 32)
          });
        }

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
        undefined,
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
    // Store original raw WebSocket messages so the bridge adapter can decode them as JSON
    let rawBuffer: WebSocket.RawData[] = [];

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

          const initialCodec = getCodecFromMediaFormat(event.mediaFormat);
          runBridge(
            smartflowWs,
            retellCall.call_id,
            retellCall.access_token,
            "smartflow",
            callId,
            streamSid,
            initialCodec,
          );

          // Replay buffered raw messages through the new bridge handler
          for (const bufferedRaw of rawBuffer) {
            smartflowWs.emit("message", bufferedRaw, false);
          }
          rawBuffer = [];

        } catch (err) {
          logger.error("[bridge] Static-mode: failed to register Retell call", {
            callId,
            error: (err as Error).message,
          });
          smartflowWs.close(1011, "Retell registration failed");
        }
        return;
      }

      // Buffer raw messages that arrive while we're awaiting Retell registration
      if (event.type === "audio") {
        rawBuffer.push(raw);
        if (rawBuffer.length % 50 === 0) {
          logger.debug("[bridge] Static-mode: buffered audio frames", { count: rawBuffer.length });
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
