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
  const url = `${RETELL_API_BASE}/v2/create-web-call`;

  const payload = {
    agent_id: config.retellAgentId,
    metadata: {
      smartflow_call_id: smartflowCallId,
      from_number: fromNumber,
      to_number: toNumber,
    },
  };

  logger.info("Registering call with Retell AI", {
    smartflowCallId,
    fromNumber,
    toNumber,
    url,
    registrationMode: "web_call",
  });

  let response;
  try {
    response = await axios.post<RegisterCallResponse>(url, payload, {
      headers: {
        Authorization: `Bearer ${config.retellApiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 5000,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      logger.error("Retell call registration failed", {
        smartflowCallId,
        url,
        status: error.response?.status,
        statusText: error.response?.statusText,
        responseData: error.response?.data,
      });
    }
    throw error;
  }

  logger.info("Retell call registered", {
    smartflowCallId,
    retellCallId: response.data.call_id,
    hasAccessToken: !!response.data.access_token,
  });

  return response.data;
}
