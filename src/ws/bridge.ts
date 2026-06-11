import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import url from "url";
import { getSession, deleteSession } from "../utils/sessionStore";
import { logger } from "../utils/logger";

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

    logger.info("Smartflow WebSocket connected", {
      token,
      smartflowCallId: session.smartflowCallId,
      retellCallId: session.retellCallId,
    });

    const retellWsUrl = `${RETELL_WS_BASE}/${session.retellCallId}`;
    const retellWs = new WebSocket(retellWsUrl, {
      headers: {
        Authorization: `Bearer ${session.retellAccessToken}`,
      },
    });
    session.retellWs = retellWs;

    retellWs.on("open", () => {
      logger.info("Retell WebSocket connected", {
        retellCallId: session.retellCallId,
      });
    });

    smartflowWs.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (retellWs.readyState === WebSocket.OPEN) {
        retellWs.send(data, { binary: isBinary });
      }
    });

    retellWs.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        if (smartflowWs.readyState === WebSocket.OPEN) {
          smartflowWs.send(data, { binary: true });
        }
      } else {
        const text = data.toString();
        try {
          const parsed = JSON.parse(text) as { content?: string };
          if (parsed.content === "clear") {
            logger.debug("Retell barge-in/clear signal received", {
              retellCallId: session.retellCallId,
            });
          }
        } catch {
          logger.debug("Retell text frame (non-JSON)", {
            retellCallId: session.retellCallId,
            text,
          });
        }
      }
    });

    const cleanup = (source: string) => {
      logger.info("Call session ending", {
        source,
        token,
        smartflowCallId: session.smartflowCallId,
        retellCallId: session.retellCallId,
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
