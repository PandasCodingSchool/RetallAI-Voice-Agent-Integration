import { Router, Request, Response } from 'express';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

const router = Router();

interface CreateWebCallResponse {
  call_id: string;
  access_token: string;
}

router.post('/create-web-call', async (_req: Request, res: Response): Promise<void> => {
  try {
    const resp = await axios.post<CreateWebCallResponse>(
      'https://api.retellai.com/v2/create-web-call',
      { agent_id: config.retellAgentId },
      {
        headers: {
          Authorization: `Bearer ${config.retellApiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      },
    );

    logger.info('Web call created for browser tester', { callId: resp.data.call_id });
    res.json({ call_id: resp.data.call_id, access_token: resp.data.access_token });
  } catch (err) {
    logger.error('Failed to create web call', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to create web call' });
  }
});

export default router;
