import { schedules } from "@trigger.dev/sdk";
import { requireEnv } from "../lib/env.js";
import { reportError } from "../lib/errors.js";
import { retellClient } from "../lib/retell.js";
import { db } from "../lib/supabase.js";
import { twilioClient } from "../lib/twilio.js";
import type { ClientRow } from "../lib/types.js";

/**
 * Daily end-to-end config check: webhook service up, and per active tenant —
 * Retell agent exists, Twilio number alive, number registered with Retell.
 * Any failure pages MY_CELL via reportError. Runs at 12:00 UTC (morning US).
 */
export const healthCheck = schedules.task({
  id: "health-check",
  cron: "0 12 * * *",
  run: async () => {
    const failures: string[] = [];

    // 1. Webhook service reachable + DB behind it healthy.
    try {
      const res = await fetch(`${requireEnv("PUBLIC_BASE_URL")}/health`, { signal: AbortSignal.timeout(10000) });
      const body: any = await res.json();
      if (!res.ok || !body.ok) throw new Error(`/health returned ${res.status}: ${JSON.stringify(body)}`);
    } catch (e) {
      failures.push(`webhook service: ${e instanceof Error ? e.message : e}`);
    }

    // 2. Per-tenant plumbing.
    const { data: clients } = await db().from("clients").select("*").eq("status", "active");
    for (const client of (clients ?? []) as ClientRow[]) {
      if (client.retell_agent_id) {
        try {
          await retellClient().agent.retrieve(client.retell_agent_id);
        } catch (e) {
          failures.push(`${client.slug}: Retell agent ${client.retell_agent_id} — ${e instanceof Error ? e.message : e}`);
        }
      } else {
        failures.push(`${client.slug}: no retell_agent_id configured`);
      }
      if (client.twilio_number_sid) {
        try {
          const num = await twilioClient().incomingPhoneNumbers(client.twilio_number_sid).fetch();
          if (num.status && num.status !== "in-use") failures.push(`${client.slug}: Twilio number status '${num.status}'`);
        } catch (e) {
          failures.push(`${client.slug}: Twilio number ${client.twilio_number_sid} — ${e instanceof Error ? e.message : e}`);
        }
      }
      if (client.twilio_number) {
        try {
          await retellClient().phoneNumber.retrieve(client.twilio_number);
        } catch (e) {
          failures.push(`${client.slug}: number not registered with Retell — ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    if (failures.length > 0) {
      await reportError({
        source: "task:health-check",
        error: new Error(`${failures.length} health failure(s):\n${failures.join("\n")}`),
      });
    }
    return { failures };
  },
});
