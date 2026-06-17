import axios from "axios";
import { config } from "../config";
import { logger } from "../utils/logger";

const RETELL_API_BASE = "https://api.retellai.com";

export interface RegisterCallResponse {
  call_id: string;
  access_token: string;
}

export async function registerCall(
  fromNumber: string,
  toNumber: string,
  smartflowCallId: string,
): Promise<RegisterCallResponse> {
  const url = `${RETELL_API_BASE}/v2/register-phone-call`;

  const payload = {
    agent_id: config.retellAgentId,
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
  });

  return response.data;
}
