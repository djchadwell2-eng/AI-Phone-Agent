import OpenAI from "openai";
import { env, requireEnv } from "./env.js";

let cached: OpenAI | null = null;

export function openai(): OpenAI {
  if (!cached) cached = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });
  return cached;
}

export const MODEL_CHEAP = env.OPENAI_MODEL_CHEAP; // SMS turns, extraction, classification
export const MODEL_SMART = env.OPENAI_MODEL_SMART; // digests, weekly reports

// Rough public per-1M-token prices used ONLY for cost logging (cents rounded up).
// Update alongside model env vars if you change models. Being ~exactly right
// matters less than trending the number per call.
const PRICES_PER_1M: Record<string, { in: number; out: number }> = {
  "gpt-4.1": { in: 200, out: 800 },
  "gpt-4.1-mini": { in: 40, out: 160 },
  "gpt-4.1-nano": { in: 10, out: 40 },
};

export function estimateOpenAiCents(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICES_PER_1M[model] ?? PRICES_PER_1M["gpt-4.1-mini"]!;
  return Math.ceil((promptTokens * p.in + completionTokens * p.out) / 1_000_000);
}

/**
 * One-shot JSON completion. All our LLM calls are "return exactly this JSON
 * shape" — a single helper keeps parsing/usage-tracking in one place.
 */
export async function chatJson<T>(input: {
  model: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
}): Promise<{ data: T; costCents: number }> {
  const res = await openai().chat.completions.create({
    model: input.model,
    response_format: { type: "json_object" },
    max_tokens: input.maxTokens ?? 700,
    messages: [{ role: "system" as const, content: input.system }, ...input.messages],
  });
  const raw = res.choices[0]?.message?.content;
  if (!raw) throw new Error("OpenAI returned empty completion");
  const usage = res.usage;
  const costCents = usage ? estimateOpenAiCents(input.model, usage.prompt_tokens, usage.completion_tokens) : 0;
  return { data: JSON.parse(raw) as T, costCents };
}
