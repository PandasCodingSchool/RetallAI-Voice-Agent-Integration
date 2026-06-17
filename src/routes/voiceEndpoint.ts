import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { registerCall } from "../services/retellService";
import { createSession } from "../utils/sessionStore";
import { config } from "../config";
import { logger } from "../utils/logger";
import { getAdapter, VendorName } from "../adapters";

const router = Router();

interface SmartflowCallPayload {
  callId: string;
  fromNumber: string;
  toNumber: string;
  status: string;
}

router.post(
  "/voice/endpoint",
  async (req: Request, res: Response): Promise<void> => {
    const startTime = Date.now();

    logger.info("[voice/endpoint] Incoming HTTP POST request", {
      headers: req.headers,
      query: req.query,
      body: req.body,
      ip: req.ip ?? req.socket.remoteAddress,
    });

    const { callId, fromNumber, toNumber, status } =
      req.body as SmartflowCallPayload;

    if (!callId || !fromNumber || !toNumber) {
      logger.warn("[voice/endpoint] Missing required fields in request", {
        body: req.body,
        receivedKeys: Object.keys(req.body ?? {}),
      });
      res.status(400).json({
        success: false,
        error: "Missing required fields: callId, fromNumber, toNumber",
      });
      return;
    }

    const vendorParam =
      (req.query["vendor"] as string | undefined) ?? "smartflow";
    let vendor: VendorName;
    try {
      vendor = getAdapter(vendorParam).vendor;
      logger.info("[voice/endpoint] Vendor resolved", { vendorParam, vendor });
    } catch {
      logger.warn("[voice/endpoint] Unsupported vendor", { vendorParam });
      res.status(400).json({
        success: false,
        error: `Unsupported vendor: "${vendorParam}". Supported: smartflow, twilio, generic`,
      });
      return;
    }

    logger.info("[voice/endpoint] Incoming call validated", {
      callId,
      fromNumber,
      toNumber,
      status,
      vendor,
    });

    try {
      logger.info("[voice/endpoint] Calling Retell AI registerCall", {
        callId,
        fromNumber,
        toNumber,
      });
      const retellCall = await registerCall(fromNumber, toNumber, callId);
      logger.info("[voice/endpoint] Retell call registered successfully", {
        callId,
        retellCallId: retellCall.call_id,
        hasAccessToken: !!retellCall.access_token,
      });

      const token = uuidv4();

      createSession(token, {
        smartflowCallId: callId,
        retellCallId: retellCall.call_id,
        retellAccessToken: retellCall.access_token,
        vendor,
      });

      const wssUrl = `wss://${config.serverWssHost}/stream?token=${token}`;

      const elapsed = Date.now() - startTime;
      logger.info("[voice/endpoint] Responding with wss_url", {
        callId,
        retellCallId: retellCall.call_id,
        wssUrl,
        serverWssHost: config.serverWssHost,
        elapsedMs: elapsed,
      });

      res.status(200).json({ success: true, wss_url: wssUrl });
    } catch (err) {
      const elapsed = Date.now() - startTime;
      logger.error("[voice/endpoint] Failed to register call with Retell AI", {
        callId,
        elapsedMs: elapsed,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      res.status(500).json({
        success: false,
        error: "Failed to register call with Retell AI",
      });
    }
  },
);

export default router;
