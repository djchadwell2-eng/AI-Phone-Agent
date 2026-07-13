import { chatJson, MODEL_SMART } from "./openai.js";
import { db } from "./supabase.js";
import type { ClientRow } from "./types.js";

/**
 * Windowed metrics + markdown report for one client. Shared by the weekly
 * Trigger task and scripts/generate-report.ts (monthly / case-study runs).
 * Revenue is always "estimated" and the method is shown — conservative on purpose.
 */
export async function buildClientReport(input: {
  client: ClientRow;
  fromIso: string;
  toIso: string;
  title: string;
}): Promise<{ markdown: string; headline: string; metrics: Record<string, number> }> {
  const { client, fromIso, toIso } = input;
  const between = (q: any) => q.gte("created_at", fromIso).lt("created_at", toIso);

  const { data: calls } = await between(
    db().from("calls").select("status, is_after_hours, is_emergency, transfer_status, duration_seconds, total_cost_cents, summary").eq("client_id", client.id)
  );
  const { data: threads } = await between(db().from("sms_threads").select("id, status").eq("client_id", client.id));
  const { data: bookings } = await between(db().from("bookings").select("id, status").eq("client_id", client.id));

  const callRows = calls ?? [];
  const bookedCount = (bookings ?? []).filter((b: any) => b.status === "booked" || b.status === "confirmed").length;
  const metrics = {
    calls_received: callRows.length,
    ai_answered: callRows.filter((c: any) => c.status === "completed").length,
    after_hours_calls: callRows.filter((c: any) => c.is_after_hours).length,
    emergencies: callRows.filter((c: any) => c.is_emergency).length,
    transfers_connected: callRows.filter((c: any) => c.transfer_status === "connected").length,
    sms_conversations: (threads ?? []).length,
    bookings: bookedCount,
    est_revenue_cents: bookedCount * client.avg_ticket_cents,
    total_minutes: Math.round(callRows.reduce((s: number, c: any) => s + (c.duration_seconds ?? 0), 0) / 60),
    total_cost_cents: callRows.reduce((s: number, c: any) => s + (c.total_cost_cents ?? 0), 0),
  };

  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const headline = `${metrics.calls_received} calls, ${metrics.bookings} booked, ~${dollars(metrics.est_revenue_cents)} est. revenue captured`;

  // Narrative paragraph from the smart model; report still ships if it fails.
  let narrative = "";
  try {
    const { data } = await chatJson<{ text: string }>({
      model: MODEL_SMART,
      system: `You write one crisp paragraph (max 90 words) for a monthly/weekly report to the owner of ${client.business_name}, a ${client.trade} company, based on call-capture metrics and call summaries. Confident but factual; never invent numbers. Return JSON {"text": string}.`,
      messages: [{ role: "user", content: JSON.stringify({ metrics, sample_summaries: callRows.slice(0, 15).map((c: any) => c.summary) }) }],
    });
    narrative = data.text;
  } catch {
    narrative = "";
  }

  const markdown = `# ${input.title}
**${client.business_name}** · ${new Date(fromIso).toDateString()} → ${new Date(toIso).toDateString()}

${narrative ? narrative + "\n" : ""}
| Metric | Value |
| --- | --- |
| Calls received | ${metrics.calls_received} |
| AI-answered | ${metrics.ai_answered} |
| After-hours calls captured | ${metrics.after_hours_calls} |
| Emergencies handled | ${metrics.emergencies} |
| Warm transfers connected | ${metrics.transfers_connected} |
| SMS conversations | ${metrics.sms_conversations} |
| Appointments booked | ${metrics.bookings} |
| **Estimated revenue captured*** | **${dollars(metrics.est_revenue_cents)}** |
| AI minutes used | ${metrics.total_minutes} |
| Platform cost | ${dollars(metrics.total_cost_cents)} |

\\* Estimated conservatively as bookings × average ticket (${dollars(client.avg_ticket_cents)}). Actual invoiced revenue may differ.
`;
  return { markdown, headline, metrics };
}
