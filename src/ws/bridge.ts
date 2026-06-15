import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import url from "url";
import { getSession, deleteSession } from "../utils/sessionStore";
import { logger } from "../utils/logger";
import { getAdapter } from "../adapters";

const RETELL_WS_BASE = "wss://api.retellai.com/audio-websocket";

export function attachWebSocketBridge(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/stream" });

  wss.on("connection", (smartflowWs: WebSocket, req: http.IncomingMessage) => {
    const parsedUrl = url.parse(req.url ?? "", true);
    const token = parsedUrl.query["token"] as string | undefined;

    if (!token) {
      logger.warn("WebSocket connection rejected: missing token");
      smartflowWs.close(4001, "Missing token");
      return;
    }

    const session = getSession(token);
    if (!session) {
      logger.warn("WebSocket connection rejected: invalid or expired token", {
        token,
      });
      smartflowWs.close(4002, "Invalid or expired token");
      return;
    }

    session.smartflowWs = smartflowWs;
    const adapter = getAdapter(session.vendor);
    let streamSid = "";
    let chunkCounter = 0;
    let cleanupCalled = false;

    logger.info("Vendor WebSocket connected", {
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
      logger.info("Retell WebSocket connected", {
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
          logger.info("Vendor stream connected handshake", {
            token,
            vendor: session.vendor,
          });
          break;

        case "start":
          streamSid = event.streamSid;
          logger.info("Vendor stream started", {
            vendor: session.vendor,
            streamSid,
            from: event.from,
            to: event.to,
          });
          break;

        case "audio":
          if (retellWs.readyState === WebSocket.OPEN) {
            retellWs.send(event.payload, { binary: true });
          }
          break;

        case "stop":
          logger.info("Vendor stream stop event", {
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
          logger.info("First agent audio frame sent to vendor", {
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
            logger.info("Retell barge-in clear — forwarding to vendor", {
              vendor: session.vendor,
              retellCallId: session.retellCallId,
            });
            const clearFrame = adapter.encodeClear({ streamSid, chunkCounter });
            if (
              clearFrame !== null &&
              smartflowWs.readyState === WebSocket.OPEN
            ) {
              smartflowWs.send(clearFrame);
            }
          }
        } catch {
          logger.debug("Retell text frame (non-JSON)", { text });
        }
      }
    });

    const cleanup = (source: string) => {
      if (cleanupCalled) return;
      cleanupCalled = true;

      logger.info("Call session ending", {
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
      logger.info("Smartflow WebSocket closed", {
        code,
        reason: reason.toString(),
        smartflowCallId: session.smartflowCallId,
      });
      cleanup("smartflow");
    });

    retellWs.on("close", (code: number, reason: Buffer) => {
      logger.info("Retell WebSocket closed", {
        code,
        reason: reason.toString(),
        retellCallId: session.retellCallId,
      });
      cleanup("retell");
    });

    smartflowWs.on("error", (err: Error) => {
      logger.error("Smartflow WebSocket error", {
        smartflowCallId: session.smartflowCallId,
        error: err.message,
      });
      cleanup("smartflow-error");
    });

    retellWs.on("error", (err: Error) => {
      logger.error("Retell WebSocket error", {
        retellCallId: session.retellCallId,
        error: err.message,
      });
      cleanup("retell-error");
    });
  });

  logger.info("WebSocket bridge attached at /stream");
  return wss;
}
