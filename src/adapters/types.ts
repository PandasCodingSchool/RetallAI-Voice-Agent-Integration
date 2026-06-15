import WebSocket from "ws";

export type VendorName = "smartflow" | "twilio" | "generic";

export type NormalisedEvent =
  | { type: "connected" }
  | { type: "start"; streamSid: string; from: string; to: string }
  | { type: "audio"; payload: Buffer }
  | { type: "stop"; reason?: string };

export interface AdapterContext {
  streamSid: string;
  chunkCounter: number;
}

export interface IVendorAdapter {
  readonly vendor: VendorName;

  /** Parse a raw WebSocket frame from the vendor → normalised event (null = ignore frame) */
  decode(raw: WebSocket.RawData): NormalisedEvent | null;

  /** Encode a normalised event → frame to send back to the vendor */
  encodeAudio(payload: Buffer, ctx: AdapterContext): string | Buffer;

  /** Encode a clear/barge-in signal to the vendor */
  encodeClear(ctx: AdapterContext): string | Buffer | null;

  /** Called once immediately after WS open — send vendor handshake if required */
  onOpen?(ws: WebSocket, ctx: AdapterContext): void;
}
