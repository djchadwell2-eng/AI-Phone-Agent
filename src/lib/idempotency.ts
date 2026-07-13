import { db } from "./supabase.js";

/**
 * At-most-once gate for webhook handlers. Twilio and Retell both retry on
 * non-2xx / timeout; first insert of the key wins, duplicates return false.
 * Key convention: "{provider}:{stable event id}" e.g. "twilio-sms:SMxxxx".
 */
export async function claimReceipt(key: string): Promise<boolean> {
  const { data, error } = await db()
    .from("webhook_receipts")
    .upsert({ id: key }, { onConflict: "id", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(`claimReceipt(${key}): ${error.message}`);
  return (data?.length ?? 0) > 0; // empty array = key already existed = duplicate
}
