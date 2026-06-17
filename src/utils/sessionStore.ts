import WebSocket from "ws";
import { logger } from "./logger";
import { config } from "../config";
import { VendorName } from "../adapters";

export interface Session {
  smartflowCallId: string;
  retellCallId: string;
  retellAccessToken?: string;
  vendor: VendorName;
  createdAt: Date;
  smartflowWs?: WebSocket;
  retellWs?: WebSocket;
}

const sessions = new Map<string, Session>();

export function createSession(
  token: string,
  session: Omit<Session, "createdAt">,
): void {
  sessions.set(token, { ...session, createdAt: new Date() });
  logger.info("Session created", {
    token,
    smartflowCallId: session.smartflowCallId,
    retellCallId: session.retellCallId,
  });
}

export function getSession(token: string): Session | undefined {
  return sessions.get(token);
}

export function deleteSession(token: string): void {
  const session = sessions.get(token);
  if (session) {
    sessions.delete(token);
    logger.info("Session deleted", {
      token,
      smartflowCallId: session.smartflowCallId,
    });
  }
}

export function getSessionCount(): number {
  return sessions.size;
}

export function startSessionCleanup(): void {
  const intervalMs = 5 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    const ttlMs = config.sessionTtlMinutes * 60 * 1000;
    for (const [token, session] of sessions.entries()) {
      if (now - session.createdAt.getTime() > ttlMs) {
        logger.warn("Session TTL expired, cleaning up", {
          token,
          smartflowCallId: session.smartflowCallId,
          ageMinutes: Math.round((now - session.createdAt.getTime()) / 60000),
        });
        try {
          session.smartflowWs?.terminate();
          session.retellWs?.terminate();
        } catch {}
        sessions.delete(token);
      }
    }
  }, intervalMs);
}
