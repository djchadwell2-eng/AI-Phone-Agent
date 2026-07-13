import { DateTime } from "luxon";
import { schedules } from "@trigger.dev/sdk";
import { alertOwner } from "../lib/alerts.js";
import { reportError } from "../lib/errors.js";
import { chatJson, MODEL_SMART } from "../lib/openai.js";
import { db } from "../lib/supabase.js";
import type { ClientRow } from "../lib/types.js";

/**
 * 6pm daily digest of daytime calls. Runs hourly and fires for tenants whose
 * LOCAL clock reads 18:xx — the boring way to do "6pm in every timezone"
 * with one schedule. Emergencies/after-hours were already sent in real time
 * (digest_sent=true), so this only batches the routine daytime traffic.
 */
export const dailyDigest = schedules.task({
  id: "daily-digest",
  cron: "0 * * * *",
  run: async () => {
    const { data: clients } = await db().from("clients").select("*").eq("status", "active");
    for (const client of (clients ?? []) as ClientRow[]) {
      try {
        const localNow = DateTime.now().setZone(client.timezone);
        if (localNow.hour !== 18) continue;

        const dayStartUtc = localNow.startOf("day").toUTC().toISO()!;
        const { data: calls } = await db()
          .from("calls")
          .select("id, from_number, summary, extracted, is_emergency, status, duration_seconds")
          .eq("client_id", client.id)
          .eq("digest_sent", false)
          .gte("created_at", dayStartUtc);
        if (!calls || calls.length === 0) continue;

        // Smart model writes the narrative — this text goes straight to a business owner.
        const { data: digest } = await chatJson<{ text: string }>({
          model: MODEL_SMART,
          system: `You write a short end-of-day SMS digest for the owner of ${client.business_name} (${client.trade}). Summarize today's calls in under 500 characters total: lead count, who needs a callback (name + number), anything unusual. Plain text, no markdown. Return JSON {"text": string}.`,
          messages: [{ role: "user", content: JSON.stringify(calls.map((c) => ({ summary: c.summary, from: c.from_number, status: c.status, extracted: c.extracted }))) }],
        });

        await alertOwner({
          client,
          body: `📋 ${client.business_name} — today's calls (${calls.length}):\n${digest.text}`,
          eventType: "digest_sent",
        });
        await db()
          .from("calls")
          .update({ digest_sent: true })
          .in("id", calls.map((c) => c.id));
      } catch (error) {
        await reportError({ source: "task:daily-digest", error, clientId: client.id });
        // continue with the other tenants — one bad tenant must not block digests for all
      }
    }
  },
});
