import WebSocket from "ws";
import { IVendorAdapter, NormalisedEvent, AdapterContext } from "./types";

interface TwilioFrame {
  event: string;
  sequenceNumber?: string;
  streamSid?: string;
  start?: {
    streamSid?: string;
    callSid?: string;
    customParameters?: Record<string, string>;
    tracks?: string[];
    mediaFormat?: { encoding: string; sampleRate: number; channels: number };
  };
  media?: { track?: string; chunk?: string; timestamp?: string; payload: string };
  stop?: { accountSid?: string; callSid?: string };
  mark?: { name?: string };
}

export class TwilioAdapter implements IVendorAdapter {
  readonly vendor = "twilio" as const;

  decode(raw: WebSocket.RawData): NormalisedEvent | null {
    let frame: TwilioFrame;
    try {
      frame = JSON.parse(raw.toString()) as TwilioFrame;
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
          from: frame.start?.customParameters?.["from"] ?? "",
          to: frame.start?.customParameters?.["to"] ?? "",
          mediaFormat: frame.start?.mediaFormat,
        };

      case "media": {
        if (!frame.media?.payload) return null;
        if (frame.media.track === "outbound") return null;
        return {
          type: "audio",
          payload: Buffer.from(frame.media.payload, "base64"),
        };
      }

      case "stop":
        return { type: "stop" };

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
      },
    });
  }

  encodeClear(ctx: AdapterContext): string {
    return JSON.stringify({ event: "clear", streamSid: ctx.streamSid });
  }
}
