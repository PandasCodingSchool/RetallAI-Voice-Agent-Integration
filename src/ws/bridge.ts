import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import url from "url";
import { v4 as uuidv4 } from "uuid";
import { getSession, deleteSession } from "../utils/sessionStore";
import { logger } from "../utils/logger";
import { getAdapter } from "../adapters";
import { registerCall } from "../services/retellService";

const RETELL_WS_BASE = "wss://api.retellai.com/audio-websocket";

/**
 * Handles Smartflow "static" endpoint mode:
 * Smartflow upgrades the endpoint URL itself to a WebSocket and sends
 * a JSON `connection` event with rtpIp/rtpPort instead of doing an HTTP POST.
 * This function registers the call with Retell, then runs the same bridge logic.
 */
function handleSmartflowStaticWs(
  smartflowWs: WebSocket,
  req: http.IncomingMessage,
): void {
  const remoteIp = req.socket.remoteAddress ?? "unknown";
  logger.info("[static-ws] Smartflow static WS connection received", {
    remoteIp,
    url: req.url,
    headers: req.headers,
  });

  const adapter = getAdapter("smartflow");

  // Retell WS is created asynchronously on first message.
  // Frames that arrive before it opens are buffered here.
  let retellWs: WebSocket | null = null;
  let initialising = false; // registerCall in-flight guard
  let retellReady = false; // true once retellWs "open" fires
  const audioBuffer: Buffer[] = []; // frames buffered before Retell opens

  let streamSid = "";
  let chunkCounter = 0;
  let cleanupCalled = false;
  let callId = "";

  const cleanup = (source: string, retellCallId?: string) => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    logger.info("[static-ws] Call session ending", {
      source,
      callId,
      retellCallId,
      chunksSentToVendor: chunkCounter,
    });
    if (
      smartflowWs.readyState === WebSocket.OPEN ||
      smartflowWs.readyState === WebSocket.CONNECTING
    ) {
      smartflowWs.close();
    }
    if (
      retellWs &&
      (retellWs.readyState === WebSocket.OPEN ||
        retellWs.readyState === WebSocket.CONNECTING)
    ) {
      retellWs.close();
    }
  };

  // ── Initialise Retell connection (called once on first message) ────────────
  async function initialise(
    firstFrame: Record<string, unknown>,
  ): Promise<void> {
    if (initialising) return;
    initialising = true;

    // Extract metadata from the first frame where available
    const event = firstFrame["event"] as string | undefined;
    const rtpIp = firstFrame["rtpIp"] as string | undefined;
    const rtpHostName = firstFrame["rtpHostName"] as string | undefined;
    const rtpPort = firstFrame["rtpPort"] as string | undefined;

    // Grab streamSid early if it's already in this frame
    const frameSid =
      (firstFrame["streamSid"] as string | undefined) ??
      ((firstFrame["start"] as Record<string, unknown> | undefined)?.[
        "streamSid"
      ] as string | undefined);
    if (frameSid) streamSid = frameSid;

    callId = `sf-static-${uuidv4()}`;
    const fromNumber = rtpIp ?? "static";
    const toNumber = rtpHostName ?? "static";

    logger.info("[static-ws] First message received — initialising Retell", {
      event,
      rtpIp,
      rtpPort,
      rtpHostName,
      streamSid,
      callId,
    });

    try {
      const retellCall = await registerCall(fromNumber, toNumber, callId);
      logger.info("[static-ws] Retell call registered", {
        callId,
        retellCallId: retellCall.call_id,
      });

      const retellWsUrl = `${RETELL_WS_BASE}/${retellCall.call_id}`;
      logger.info("[static-ws] Connecting to Retell WebSocket", {
        retellWsUrl,
      });
      retellWs = new WebSocket(retellWsUrl, {
        headers: { Authorization: `Bearer ${retellCall.access_token}` },
      });

      retellWs.on("open", () => {
        retellReady = true;
        logger.info("[static-ws] Retell WebSocket connected", {
          retellCallId: retellCall.call_id,
          bufferedFrames: audioBuffer.length,
        });
        // Flush any audio frames that arrived while we were connecting
        for (const buf of audioBuffer) {
          retellWs!.send(buf, { binary: true });
        }
        if (audioBuffer.length > 0) {
          logger.info("[static-ws] Flushed buffered audio frames to Retell", {
            count: audioBuffer.length,
          });
        }
        audioBuffer.length = 0;
      });

      retellWs.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) {
          if (smartflowWs.readyState !== WebSocket.OPEN) return;
          const audioBuf =
            data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
          chunkCounter++;
          const outFrame = adapter.encodeAudio(audioBuf, {
            streamSid,
            chunkCounter,
          });
          smartflowWs.send(outFrame);
          if (chunkCounter === 1) {
            logger.info(
              "[static-ws] First agent audio frame sent to Smartflow",
              {
                retellCallId: retellCall.call_id,
                bytes: audioBuf.length,
              },
            );
          }
        } else {
          const text = data.toString();
          logger.debug("[static-ws] Retell text frame", { text });
          try {
            const parsed = JSON.parse(text) as { content?: string };
            if (parsed.content === "clear") {
              logger.info("[static-ws] Retell barge-in clear — forwarding");
              const clearFrame = adapter.encodeClear({
                streamSid,
                chunkCounter,
              });
              if (
                clearFrame !== null &&
                smartflowWs.readyState === WebSocket.OPEN
              ) {
                smartflowWs.send(clearFrame);
              }
            }
          } catch {
            logger.debug("[static-ws] Retell non-JSON text frame", { text });
          }
        }
      });

      retellWs.on("close", (code, reason) => {
        logger.info("[static-ws] Retell WebSocket closed", {
          code,
          reason: reason.toString(),
          retellCallId: retellCall.call_id,
        });
        cleanup("retell", retellCall.call_id);
      });

      retellWs.on("error", (err) => {
        logger.error("[static-ws] Retell WebSocket error", {
          retellCallId: retellCall.call_id,
          error: err.message,
        });
        cleanup("retell-error", retellCall.call_id);
      });
    } catch (err) {
      logger.error("[static-ws] Failed to register call with Retell AI", {
        callId,
        error: err instanceof Error ? err.message : String(err),
      });
      smartflowWs.close(4003, "Retell registration failed");
    }
  }

  // ── Incoming messages from Smartflow ──────────────────────────────────────
  smartflowWs.on("message", async (raw: WebSocket.RawData) => {
    const rawStr = raw.toString();
    logger.debug("[static-ws] Raw message from Smartflow", { raw: rawStr });

    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(rawStr) as Record<string, unknown>;
    } catch {
      logger.warn("[static-ws] Non-JSON message from Smartflow", {
        raw: rawStr,
      });
      return;
    }

    const event = frame["event"] as string | undefined;
    logger.debug("[static-ws] Parsed event", { event });

    // ── Trigger initialisation on the very first frame ─────────────────────
    if (!initialising) {
      await initialise(frame);
      // If the first frame itself carries audio, fall through to handle it below
    }

    // ── Route frame through the adapter ───────────────────────────────────
    const normEvent = adapter.decode(raw);
    if (!normEvent) return;

    switch (normEvent.type) {
      case "connected":
        logger.info("[static-ws] Smartflow connected handshake");
        break;

      case "start":
        if (!streamSid) streamSid = normEvent.streamSid;
        logger.info("[static-ws] Smartflow stream started", {
          streamSid,
          from: normEvent.from,
          to: normEvent.to,
        });
        break;

      case "audio":
        // Update streamSid from media frame if not yet set
        if (!streamSid) {
          const mediaSid = frame["streamSid"] as string | undefined;
          if (mediaSid) {
            streamSid = mediaSid;
            logger.info("[static-ws] streamSid set from media frame", {
              streamSid,
            });
          }
        }
        if (!retellWs || !retellReady) {
          // Buffer until Retell WS opens
          audioBuffer.push(normEvent.payload);
          logger.debug("[static-ws] Buffered audio frame (Retell not ready)", {
            bufferedCount: audioBuffer.length,
          });
        } else {
          retellWs.send(normEvent.payload, { binary: true });
        }
        break;

      case "stop":
        logger.info("[static-ws] Smartflow stop event");
        cleanup("vendor-stop");
        break;
    }
  });

  smartflowWs.on("close", (code, reason) => {
    logger.info("[static-ws] Smartflow WebSocket closed", {
      code,
      reason: reason.toString(),
    });
    cleanup("smartflow");
  });

  smartflowWs.on("error", (err) => {
    logger.error("[static-ws] Smartflow WebSocket error", {
      error: err.message,
    });
    cleanup("smartflow-error");
  });
}

export function attachWebSocketBridge(server: http.Server): WebSocketServer {
  // Single WS server handles both /stream and /voice/endpoint upgrades
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: http.IncomingMessage, socket, head) => {
    const parsedUrl = url.parse(req.url ?? "", true);
    const pathname = parsedUrl.pathname ?? "";

    logger.info("[upgrade] WebSocket upgrade request", {
      pathname,
      remoteAddress: (socket as import("net").Socket).remoteAddress,
      headers: req.headers,
    });

    if (pathname === "/stream" || pathname === "/voice/endpoint") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      logger.warn(
        "[upgrade] Unhandled WebSocket upgrade path — destroying socket",
        { pathname },
      );
      socket.destroy();
    }
  });

  wss.on("connection", (smartflowWs: WebSocket, req: http.IncomingMessage) => {
    const parsedUrl = url.parse(req.url ?? "", true);
    const token = parsedUrl.query["token"] as string | undefined;

    logger.info("[bridge] WebSocket connection", {
      path: parsedUrl.pathname,
      token: token ?? "(none — static mode)",
      remoteAddress: req.socket.remoteAddress,
      url: req.url,
    });

    // No token → static mode: Smartflow connects directly to /stream or /voice/endpoint
    // without a prior HTTP POST, and sends the connection event itself.
    if (!token) {
      logger.info("[bridge] No token — switching to static mode handler");
      handleSmartflowStaticWs(smartflowWs, req);
      return;
    }

    const session = getSession(token);
    if (!session) {
      logger.warn(
        "[bridge] WebSocket connection rejected: invalid or expired token",
        {
          token,
        },
      );
      smartflowWs.close(4002, "Invalid or expired token");
      return;
    }

    session.smartflowWs = smartflowWs;
    const adapter = getAdapter(session.vendor);
    let streamSid = "";
    let chunkCounter = 0;
    let cleanupCalled = false;

    logger.info("[bridge] Vendor WebSocket connected", {
      token,
      vendor: session.vendor,
      smartflowCallId: session.smartflowCallId,
      retellCallId: session.retellCallId,
    });

    const retellWsUrl = `${RETELL_WS_BASE}/${session.retellCallId}`;
    const retellWs = new WebSocket(retellWsUrl, {
      headers: { Authorization: `Bearer ${session.retellAccessToken}` },
    });
    session.retellWs = retellWs;

    retellWs.on("open", () => {
      logger.info("[bridge] Retell WebSocket connected", {
        retellCallId: session.retellCallId,
      });
      if (adapter.onOpen) {
        adapter.onOpen(smartflowWs, { streamSid, chunkCounter });
      }
    });

    smartflowWs.on("message", (raw: WebSocket.RawData) => {
      const event = adapter.decode(raw);
      if (!event) return;

      switch (event.type) {
        case "connected":
          logger.info("[bridge] Vendor stream connected handshake", {
            token,
            vendor: session.vendor,
          });
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

        case "audio":
          if (retellWs.readyState === WebSocket.OPEN) {
            retellWs.send(event.payload, { binary: true });
          } else {
            logger.warn("[bridge] Retell WS not open, dropping audio frame", {
              retellWsState: retellWs.readyState,
              vendor: session.vendor,
            });
          }
          break;

        case "stop":
          logger.info("[bridge] Vendor stream stop event", {
            vendor: session.vendor,
            streamSid,
          });
          cleanup("vendor-stop");
          break;
      }
    });

    retellWs.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        if (smartflowWs.readyState !== WebSocket.OPEN) return;

        const audioBuf =
          data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
        chunkCounter++;

        const frame = adapter.encodeAudio(audioBuf, {
          streamSid,
          chunkCounter,
        });
        smartflowWs.send(frame);

        if (chunkCounter === 1) {
          logger.info("[bridge] First agent audio frame sent to vendor", {
            vendor: session.vendor,
            retellCallId: session.retellCallId,
            bytes: audioBuf.length,
          });
        }
      } else {
        const text = data.toString();
        try {
          const parsed = JSON.parse(text) as { content?: string };
          if (parsed.content === "clear") {
            logger.info(
              "[bridge] Retell barge-in clear — forwarding to vendor",
              {
                vendor: session.vendor,
                retellCallId: session.retellCallId,
              },
            );
            const clearFrame = adapter.encodeClear({ streamSid, chunkCounter });
            if (
              clearFrame !== null &&
              smartflowWs.readyState === WebSocket.OPEN
            ) {
              smartflowWs.send(clearFrame);
            }
          }
        } catch {
          logger.debug("[bridge] Retell non-JSON text frame", { text });
        }
      }
    });

    const cleanup = (source: string) => {
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

      if (
        smartflowWs.readyState === WebSocket.OPEN ||
        smartflowWs.readyState === WebSocket.CONNECTING
      ) {
        smartflowWs.close();
      }
      if (
        retellWs.readyState === WebSocket.OPEN ||
        retellWs.readyState === WebSocket.CONNECTING
      ) {
        retellWs.close();
      }

      deleteSession(token);
    };

    smartflowWs.on("close", (code: number, reason: Buffer) => {
      logger.info("[bridge] Smartflow WebSocket closed", {
        code,
        reason: reason.toString(),
        smartflowCallId: session.smartflowCallId,
      });
      cleanup("smartflow");
    });

    retellWs.on("close", (code: number, reason: Buffer) => {
      logger.info("[bridge] Retell WebSocket closed", {
        code,
        reason: reason.toString(),
        retellCallId: session.retellCallId,
      });
      cleanup("retell");
    });

    smartflowWs.on("error", (err: Error) => {
      logger.error("[bridge] Smartflow WebSocket error", {
        smartflowCallId: session.smartflowCallId,
        error: err.message,
      });
      cleanup("smartflow-error");
    });

    retellWs.on("error", (err: Error) => {
      logger.error("[bridge] Retell WebSocket error", {
        retellCallId: session.retellCallId,
        error: err.message,
      });
      cleanup("retell-error");
    });
  });

  logger.info("WebSocket bridge attached", {
    paths: ["/stream", "/voice/endpoint (static)"],
  });
  return wss;
}
