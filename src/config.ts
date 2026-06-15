import dotenv from "dotenv";

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  port: parseInt(process.env["PORT"] ?? "3000", 10),
  retellApiKey: requireEnv("RETELL_API_KEY"),
  retellAgentId: requireEnv("RETELL_AGENT_ID"),
  sessionTtlMinutes: parseInt(process.env["SESSION_TTL_MINUTES"] ?? "60", 10),
};
