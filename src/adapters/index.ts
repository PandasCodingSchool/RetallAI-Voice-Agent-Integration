import { IVendorAdapter, VendorName } from "./types";
import { SmartflowAdapter } from "./smartflow";
import { TwilioAdapter } from "./twilio";
import { GenericAdapter } from "./generic";

export { IVendorAdapter, VendorName } from "./types";
export type { NormalisedEvent, AdapterContext } from "./types";

const registry: Record<VendorName, () => IVendorAdapter> = {
  smartflow: () => new SmartflowAdapter(),
  twilio:    () => new TwilioAdapter(),
  generic:   () => new GenericAdapter(),
};

export function getAdapter(vendor: string): IVendorAdapter {
  const factory = registry[vendor as VendorName];
  if (!factory) {
    throw new Error(`Unknown vendor: "${vendor}". Supported: ${Object.keys(registry).join(", ")}`);
  }
  return factory();
}
