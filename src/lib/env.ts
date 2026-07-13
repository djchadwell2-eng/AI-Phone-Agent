import "dotenv/config";
import { z } from "zod";

// Every secret comes from env. Validated once, at first access, so scripts that
// only need a subset (e.g. report generator needs Supabase only) don't crash on
// unrelated missing keys — hence everything optional here plus require() below.
const schema = z.object({
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_SIP_USERNAME: z.string().optional(),
  TWILIO_SIP_PASSWORD: z.string().optional(),
  RETELL_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL_CHEAP: z.string().default("gpt-4.1-mini"),
  OPENAI_MODEL_SMART: z.string().default("gpt-4.1"),
  TRIGGER_SECRET_KEY: z.string().optional(),
  CALCOM_API_KEY: z.string().optional(),
  CALCOM_WEBHOOK_SECRET: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),
  INTERNAL_WEBHOOK_TOKEN: z.string().optional(),
  MY_CELL: z.string().optional(),
  PORT: z.coerce.number().default(8080),
});

export const env = schema.parse(process.env);

/** Fetch a required env var, failing loudly with the var name if missing. */
export function requireEnv<K extends keyof typeof env>(key: K): NonNullable<(typeof env)[K]> {
  const value = env[key];
  if (value === undefined || value === "") {
    throw new Error(`Missing required env var: ${String(key)} — see .env.example`);
  }
  return value as NonNullable<(typeof env)[K]>;
}
