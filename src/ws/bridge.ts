import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import url from "url";
import { getSession, deleteSession } from "../utils/sessionStore";
import { logger } from "../utils/logger";

const RETELL_WS_BASE = "wss://api.retellai.com/audio-websocket";

interface SmartflowConnectedEvent {
  event: "connected";
}

interface SmartflowStartEvent {
  event: "start";
  streamSid: string;
  start: {
    streamSid: string;
    callSid: string;
    accountSid: string;
    from: string;
    to: string;
    direction: string;
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      bitRate: number;
      bitDepth: number;
    };
    customParameters?: Record<string, string>;
  };
}

interface SmartflowMediaEvent {
  event: "media";
  sequenceNumber: string;
  streamSid: string;
  media: { chunk: string; timestamp: string; payload: string };
}

interface SmartflowStopEvent {
  event: "stop";
  streamSid: string;
  stop: { accountSid: string; callSid: string; reason: string };
}

type SmartflowEvent =
  | SmartflowConnectedEvent
  | SmartflowStartEvent
  | SmartflowMediaEvent
  | SmartflowStopEvent;

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
    let streamSid = "";
    let chunkCounter = 0;
    let cleanupCalled = false;

    logger.info("Smartflow WebSocket connected", {
      token,
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
    });

    smartflowWs.on("message", (raw: WebSocket.RawData) => {
      let msg: SmartflowEvent;
      try {
        msg = JSON.parse(raw.toString()) as SmartflowEvent;
      } catch {
        logger.warn("Smartflow: non-JSON frame received, ignoring");
        return;
      }

      switch (msg.event) {
        case "connected":
          logger.info("Smartflow stream connected handshake", { token });
          break;

        case "start":
          streamSid = msg.streamSid ?? msg.start?.streamSid ?? "";
          logger.info("Smartflow stream started", {
            streamSid,
            mediaFormat: msg.start?.mediaFormat,
            from: msg.start?.from,
            to: msg.start?.to,
          });
          break;

        case "media": {
          if (retellWs.readyState !== WebSocket.OPEN) return;
          const rawAudio = Buffer.from(msg.media.payload, "base64");
          retellWs.send(rawAudio, { binary: true });
          break;
        }

        case "stop":
          logger.info("Smartflow stream stop event received", {
            streamSid,
            reason: msg.stop?.reason,
          });
          cleanup("smartflow-stop");
          break;

        default:
          logger.debug("Smartflow: unknown event", {
            event: (msg as SmartflowEvent & { event: string }).event,
          });
      }
    });

    retellWs.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        if (smartflowWs.readyState !== WebSocket.OPEN) return;

        const audioBuf =
          data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
        chunkCounter++;

        const mediaMsg = JSON.stringify({
          event: "media",
          streamSid,
          media: {
            payload: audioBuf.toString("base64"),
            chunk: chunkCounter,
          },
        });

        smartflowWs.send(mediaMsg);

        if (chunkCounter === 1) {
          logger.info("First agent audio frame sent to Smartflow", {
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
              "Retell barge-in clear signal — forwarding clear to Smartflow",
              {
                retellCallId: session.retellCallId,
              },
            );
            if (smartflowWs.readyState === WebSocket.OPEN) {
              smartflowWs.send(JSON.stringify({ event: "clear", streamSid }));
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
        token,
        smartflowCallId: session.smartflowCallId,
        retellCallId: session.retellCallId,
        chunksSentToSmartflow: chunkCounter,
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
