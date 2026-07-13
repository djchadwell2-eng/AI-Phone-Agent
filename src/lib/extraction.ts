import { chatJson, MODEL_CHEAP } from "./openai.js";
import type { CallExtraction, ClientRow } from "./types.js";

const SYSTEM = `You extract structured data from phone call transcripts for a home-services business.
Return ONLY a JSON object with exactly these keys:
- caller_name: string or null (as stated by the caller)
- callback_number: string or null (E.164 if possible; null if only caller ID was available and they gave nothing)
- address: string or null
- intent: short phrase, e.g. "AC not cooling", "schedule tune-up", "billing question", "wrong number", "spam"
- urgency: one of "emergency" | "urgent" | "routine" | "unknown"
- wants_booking: boolean — did they want an appointment/visit?
- booked: boolean — was an appointment actually confirmed with a specific time during the call?
- sentiment: one of "positive" | "neutral" | "negative"
- summary: ONE sentence, plain English, written for the business owner.
Be conservative: if unsure, use null/false/"unknown". Never invent contact details.`;

export async function extractFromTranscript(input: {
  client: ClientRow;
  transcript: string;
  fromNumber: string;
}): Promise<{ extraction: CallExtraction; costCents: number }> {
  const { data, costCents } = await chatJson<CallExtraction>({
    model: MODEL_CHEAP,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Business: ${input.client.business_name} (${input.client.trade}). Caller ID: ${input.fromNumber}.\n\nTranscript:\n${input.transcript.slice(0, 24000)}`,
      },
    ],
  });
  // Caller ID is the fallback callback number — the whole point of capture.
  if (!data.callback_number) data.callback_number = input.fromNumber;
  return { extraction: data, costCents };
}
