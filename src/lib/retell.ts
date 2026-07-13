import Retell from "retell-sdk";
import { requireEnv } from "./env.js";

let cached: Retell | null = null;

export function retellClient(): Retell {
  if (!cached) cached = new Retell({ apiKey: requireEnv("RETELL_API_KEY") });
  return cached;
}

/**
 * Verify the x-retell-signature header on Retell webhooks (post-call events,
 * inbound-call webhook). Uses the SDK's static verify per Retell docs.
 */
export function verifyRetellSignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  try {
    return Retell.verify(rawBody, requireEnv("RETELL_API_KEY"), signature);
  } catch {
    return false;
  }
}
