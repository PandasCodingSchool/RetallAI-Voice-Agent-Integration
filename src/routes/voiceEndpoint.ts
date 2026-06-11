import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { registerCall } from '../services/retellService';
import { createSession } from '../utils/sessionStore';
import { config } from '../config';
import { logger } from '../utils/logger';

const router = Router();

interface SmartflowCallPayload {
  callId: string;
  fromNumber: string;
  toNumber: string;
  status: string;
}

router.post('/voice/endpoint', async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();

  const { callId, fromNumber, toNumber, status } = req.body as SmartflowCallPayload;

  if (!callId || !fromNumber || !toNumber) {
    logger.warn('Missing required fields in /voice/endpoint request', { body: req.body });
    res.status(400).json({ success: false, error: 'Missing required fields: callId, fromNumber, toNumber' });
    return;
  }

  logger.info('Incoming call from Smartflow', { callId, fromNumber, toNumber, status });

  try {
    const retellCall = await registerCall(fromNumber, toNumber, callId);

    const token = uuidv4();

    createSession(token, {
      smartflowCallId: callId,
      retellCallId: retellCall.call_id,
      retellAccessToken: retellCall.access_token,
    });

    const wssUrl = `wss://${config.serverWssHost}/stream?token=${token}`;

    const elapsed = Date.now() - startTime;
    logger.info('Dynamic endpoint responding', { callId, retellCallId: retellCall.call_id, wssUrl, elapsedMs: elapsed });

    res.status(200).json({ success: true, wss_url: wssUrl });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.error('Failed to register call with Retell AI', {
      callId,
      elapsedMs: elapsed,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ success: false, error: 'Failed to register call with Retell AI' });
  }
});

export default router;
