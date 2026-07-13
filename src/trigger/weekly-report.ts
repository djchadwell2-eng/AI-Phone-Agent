import { DateTime } from "luxon";
import { schedules } from "@trigger.dev/sdk";
import { alertOwner } from "../lib/alerts.js";
import { reportError } from "../lib/errors.js";
import { buildClientReport } from "../lib/report.js";
import { db } from "../lib/supabase.js";
import type { ClientRow } from "../lib/types.js";

/**
 * Weekly owner report: Monday 8am LOCAL per tenant (hourly gate, same pattern
 * as the digest). Full markdown lands in `reports` (case-study raw material);
 * the owner gets an SMS with the headline numbers.
 */
export const weeklyReport = schedules.task({
  id: "weekly-report",
  cron: "0 * * * *",
  run: async () => {
    const { data: clients } = await db().from("clients").select("*").eq("status", "active");
    for (const client of (clients ?? []) as ClientRow[]) {
      try {
        const localNow = DateTime.now().setZone(client.timezone);
        if (localNow.weekday !== 1 || localNow.hour !== 8) continue; // Monday 8am local

        const period = `${localNow.year}-W${String(localNow.weekNumber).padStart(2, "0")}`;
        const { data: already } = await db()
          .from("reports")
          .select("id")
          .eq("client_id", client.id)
          .eq("kind", "weekly")
          .eq("period", period)
          .maybeSingle();
        if (already) continue;

        const report = await buildClientReport({
          client,
          fromIso: localNow.minus({ weeks: 1 }).startOf("day").toUTC().toISO()!,
          toIso: localNow.startOf("day").toUTC().toISO()!,
          title: `Weekly report — week ending ${localNow.minus({ days: 1 }).toFormat("LLLL d, yyyy")}`,
        });

        await db().from("reports").insert({ client_id: client.id, kind: "weekly", period, markdown: report.markdown });
        await alertOwner({
          client,
          body: `📈 ${client.business_name} weekly: ${report.headline}`,
          eventType: "weekly_report",
        });
      } catch (error) {
        await reportError({ source: "task:weekly-report", error, clientId: client.id });
      }
    }
  },
});
