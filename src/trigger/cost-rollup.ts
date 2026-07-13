import { DateTime } from "luxon";
import { schedules } from "@trigger.dev/sdk";
import { alertOwner } from "../lib/alerts.js";
import { env } from "../lib/env.js";
import { reportError } from "../lib/errors.js";
import { db, logEvent } from "../lib/supabase.js";
import { sendInternalSms } from "../lib/twilio.js";
import type { ClientRow } from "../lib/types.js";

/**
 * Daily cost/minute rollup vs each client's monthly_minute_cap.
 * Alerts once per threshold per month (events table is the memory).
 */
export const costRollup = schedules.task({
  id: "cost-rollup",
  cron: "30 12 * * *",
  run: async () => {
    const { data: clients } = await db().from("clients").select("*").eq("status", "active");
    for (const client of (clients ?? []) as ClientRow[]) {
      try {
        if (!client.monthly_minute_cap) continue;
        const monthStart = DateTime.now().setZone(client.timezone).startOf("month").toUTC().toISO()!;
        const { data: calls } = await db()
          .from("calls")
          .select("duration_seconds, total_cost_cents")
          .eq("client_id", client.id)
          .gte("created_at", monthStart);
        const minutes = Math.round((calls ?? []).reduce((s, c: any) => s + (c.duration_seconds ?? 0), 0) / 60);
        const costCents = (calls ?? []).reduce((s, c: any) => s + (c.total_cost_cents ?? 0), 0);
        const pct = Math.round((minutes / client.monthly_minute_cap) * 100);

        for (const threshold of [100, 80]) {
          if (pct < threshold) continue;
          const month = monthStart.slice(0, 7);
          const marker = { threshold, month };
          const { data: already } = await db()
            .from("events")
            .select("id")
            .eq("client_id", client.id)
            .eq("type", "cost_cap_warning")
            .contains("payload", marker)
            .limit(1);
          if ((already?.length ?? 0) > 0) break; // higher threshold implies lower one — one alert is enough

          const msg = `⏱️ ${client.business_name}: ${minutes}/${client.monthly_minute_cap} AI minutes used this month (${pct}%). Cost so far ~$${(costCents / 100).toFixed(2)}.`;
          await alertOwner({ client, body: msg, eventType: "cost_cap_warning_owner" });
          if (env.MY_CELL && client.twilio_number && env.MY_CELL !== client.owner_cell) {
            await sendInternalSms({ clientId: client.id, from: client.twilio_number, to: env.MY_CELL, body: msg, eventType: "cost_cap_warning_admin" });
          }
          await logEvent({ client_id: client.id, type: "cost_cap_warning", payload: marker });
          break;
        }
      } catch (error) {
        await reportError({ source: "task:cost-rollup", error, clientId: client.id });
      }
    }
  },
});
