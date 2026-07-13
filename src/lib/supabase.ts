import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env.js";
import type { ClientRow } from "./types.js";

let cached: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!cached) {
    cached = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
    });
  }
  return cached;
}

/**
 * Tenant resolution: every webhook identifies its client by the Twilio number
 * involved (the number the caller dialed / the number that received the SMS).
 */
export async function clientByTwilioNumber(number: string): Promise<ClientRow | null> {
  const { data, error } = await db().from("clients").select("*").eq("twilio_number", number).maybeSingle();
  if (error) throw new Error(`clientByTwilioNumber(${number}): ${error.message}`);
  return (data as ClientRow) ?? null;
}

export async function clientById(id: string): Promise<ClientRow> {
  const { data, error } = await db().from("clients").select("*").eq("id", id).single();
  if (error) throw new Error(`clientById(${id}): ${error.message}`);
  return data as ClientRow;
}

export async function clientBySlug(slug: string): Promise<ClientRow | null> {
  const { data, error } = await db().from("clients").select("*").eq("slug", slug).maybeSingle();
  if (error) throw new Error(`clientBySlug(${slug}): ${error.message}`);
  return (data as ClientRow) ?? null;
}

export async function isOptedOut(phoneNumber: string): Promise<boolean> {
  const { data, error } = await db().from("opt_outs").select("phone_number").eq("phone_number", phoneNumber).maybeSingle();
  if (error) throw new Error(`isOptedOut: ${error.message}`);
  return data !== null;
}

/** Log a customer-facing send or notable system moment. Never throws — logging must not break flows. */
export async function logEvent(input: {
  client_id?: string | null;
  type: string;
  call_id?: string | null;
  thread_id?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await db().from("events").insert({
    client_id: input.client_id ?? null,
    type: input.type,
    call_id: input.call_id ?? null,
    thread_id: input.thread_id ?? null,
    payload: input.payload ?? {},
  });
  if (error) console.error(`logEvent(${input.type}) failed: ${error.message}`);
}
