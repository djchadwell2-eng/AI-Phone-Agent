import { hoursText } from "./hours.js";
import { chatJson, MODEL_CHEAP } from "./openai.js";
import type { ClientRow, SmsThreadRow } from "./types.js";

export interface SmsAgentDecision {
  reply: string;
  collected: { name?: string | null; address?: string | null; issue?: string | null };
  // "book" when the customer has agreed to a concrete offered slot (slot_iso set)
  action: "continue" | "book" | "escalate" | "close";
  slot_iso?: string | null;
  escalate_reason?: string | null;
}

/**
 * One SMS agent turn: full thread history in, decision out. Deliberately a
 * single JSON-mode completion on the cheap model — an SMS turn doesn't need
 * an agent loop, and one call per inbound text keeps cost and latency flat.
 */
export async function smsAgentTurn(input: {
  client: ClientRow;
  thread: SmsThreadRow;
  history: { direction: "inbound" | "outbound"; body: string }[];
  offeredSlots: { startIso: string; label: string }[]; // fetched by the task when booking is in play
}): Promise<{ decision: SmsAgentDecision; costCents: number }> {
  const c = input.client;
  const slotsText = input.offeredSlots.length
    ? input.offeredSlots.map((s) => `${s.label} (slot_iso: ${s.startIso})`).join("; ")
    : "none fetched yet";

  const system = `You are the SMS assistant for ${c.business_name}, a ${c.trade} company. You are texting a customer who called and didn't reach the team. Goal: capture the lead and get them booked.

BUSINESS FACTS (answer only from these — never invent):
- Services: ${c.services.join(", ")}
- Hours: ${hoursText(c.hours, c.timezone)}
- Service area: ${c.service_area}
- Prices you may quote (ONLY these, as ranges): ${Object.entries(c.price_ranges).map(([k, v]) => `${k}: ${v}`).join("; ") || "none — never quote prices"}

ALREADY KNOWN about this customer: ${JSON.stringify(input.thread.context)}

BOOKABLE SLOTS you may offer (offer 2-3, never invent times): ${slotsText}

RULES:
- Texts under 300 characters, plain and friendly, no emojis. One question at a time.
- Collect: name, service address, what's going on. Then push gently toward booking.
- Never promise arrival times or prices beyond the list above.
- action "book" ONLY when the customer clearly accepts one specific offered slot — set slot_iso to that slot's slot_iso exactly.
- action "escalate" when: they're angry, it's an emergency, they ask for the owner, they ask something you can't answer from the facts, or they explicitly ask for a human.
- action "close" when the conversation is naturally done (booked and confirmed, or they said no thanks).
- If they mention a gas smell: tell them to leave the building and call 911 and their gas utility now, and escalate.

Return ONLY JSON: {"reply": string, "collected": {"name": string|null, "address": string|null, "issue": string|null}, "action": "continue"|"book"|"escalate"|"close", "slot_iso": string|null, "escalate_reason": string|null}`;

  const messages = input.history.slice(-20).map((m) => ({
    // inbound = customer speaking to us
    role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
    content: m.body,
  }));

  const { data, costCents } = await chatJson<SmsAgentDecision>({ model: MODEL_CHEAP, system, messages });
  return { decision: data, costCents };
}
