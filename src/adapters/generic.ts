import WebSocket from "ws";
import { IVendorAdapter, NormalisedEvent, AdapterContext } from "./types";

export class GenericAdapter implements IVendorAdapter {
  readonly vendor = "generic" as const;

  decode(raw: WebSocket.RawData): NormalisedEvent | null {
    const buf = raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer);
    if (buf.length === 0) return null;
    return { type: "audio", payload: buf };
  }

  encodeAudio(payload: Buffer, _ctx: AdapterContext): Buffer {
    return payload;
  }

  encodeClear(_ctx: AdapterContext): null {
    return null;
  }
}
