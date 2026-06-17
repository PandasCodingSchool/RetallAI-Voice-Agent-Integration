import axios from "axios";
import { config } from "../config";
import { logger } from "../utils/logger";

const RETELL_API_BASE = "https://api.retellai.com";

export interface RegisterCallResponse {
  call_id: string;
  access_token?: string;
  call_status?: string;
  audio_websocket_protocol?: string;
  audio_encoding?: string;
  sample_rate?: number;
}

export async function registerCall(
  fromNumber: string,
  toNumber: string,
  smartflowCallId: string,
): Promise<RegisterCallResponse> {
  const url = `${RETELL_API_BASE}/register-call`;

  const payload = {
    agent_id: config.retellAgentId,
    audio_websocket_protocol: "twilio",
    audio_encoding: "mulaw",
    sample_rate: 8000,
    from_number: fromNumber,
    to_number: toNumber,
    metadata: {
      smartflow_call_id: smartflowCallId,
    },
  };

  logger.info("Registering call with Retell AI", {
    smartflowCallId,
    fromNumber,
    toNumber,
    url,
    audioWebsocketProtocol: payload.audio_websocket_protocol,
    audioEncoding: payload.audio_encoding,
    sampleRate: payload.sample_rate,
  });

  const response = await axios.post<RegisterCallResponse>(url, payload, {
    headers: {
      Authorization: `Bearer ${config.retellApiKey}`,
      "Content-Type": "application/json",
    },
    timeout: 5000,
  });

  logger.info("Retell call registered", {
    smartflowCallId,
    retellCallId: response.data.call_id,
    callStatus: response.data.call_status,
    audioWebsocketProtocol: response.data.audio_websocket_protocol,
    audioEncoding: response.data.audio_encoding,
    sampleRate: response.data.sample_rate,
    hasAccessToken: !!response.data.access_token,
  });

  return response.data;
}
