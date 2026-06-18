import http from "http";
import path from "path";
import express, { Request, Response } from "express";
import { config } from "./config";
import { logger } from "./utils/logger";
import { startSessionCleanup, getSessionCount } from "./utils/sessionStore";
import voiceEndpointRouter from "./routes/voiceEndpoint";
import createWebCallRouter from "./routes/createWebCall";
import { attachWebSocketBridge } from "./ws/bridge";

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    activeSessions: getSessionCount(),
    timestamp: new Date().toISOString(),
  });
});

app.use("/", voiceEndpointRouter);
app.use("/", createWebCallRouter);

const server = http.createServer(app);

attachWebSocketBridge(server);

startSessionCleanup();

server.listen(config.port, () => {
  logger.info("RetallAI-Smartflow bridge server started (Web Protocol Fix - v1.0.1)", {
    port: config.port,
    serverWssHost: config.serverWssHost,
  });
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully");
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.info("SIGINT received, shutting down gracefully");
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
});
