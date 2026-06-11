import WebSocket from "ws";
import { IVendorAdapter, NormalisedEvent, AdapterContext } from "./types";

interface SmartflowFrame {
  event: string;
  streamSid?: string;
  sequenceNumber?: string;
  start?: {
    streamSid?: string;
    from?: string;
    to?: string;
    mediaFormat?: { encoding: string; sampleRate: number };
  };
  media?: { chunk?: string; timestamp?: string; payload: string };
  stop?: { reason?: string };
}

export class SmartflowAdapter implements IVendorAdapter {
  readonly vendor = "smartflow" as const;

  decode(raw: WebSocket.RawData): NormalisedEvent | null {
    let frame: SmartflowFrame;
    try {
      frame = JSON.parse(raw.toString()) as SmartflowFrame;
    } catch {
      return null;
    }

    switch (frame.event) {
      case "connected":
        return { type: "connected" };

      case "start":
        return {
          type: "start",
          streamSid: frame.streamSid ?? frame.start?.streamSid ?? "",
          from: frame.start?.from ?? "",
          to: frame.start?.to ?? "",
        };

      case "media": {
        if (!frame.media?.payload) return null;
        return {
          type: "audio",
          payload: Buffer.from(frame.media.payload, "base64"),
        };
      }

      case "stop":
        return { type: "stop", reason: frame.stop?.reason };

      default:
        return null;
    }
  }

  encodeAudio(payload: Buffer, ctx: AdapterContext): string {
    return JSON.stringify({
      event: "media",
      streamSid: ctx.streamSid,
      media: {
        payload: payload.toString("base64"),
        chunk: ctx.chunkCounter,
      },
    });
  }

  encodeClear(ctx: AdapterContext): string {
    return JSON.stringify({ event: "clear", streamSid: ctx.streamSid });
  }
}
