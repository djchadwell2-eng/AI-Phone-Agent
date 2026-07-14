import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireEnv } from "../src/lib/env.js";
import { buildDynamicVariables } from "../src/lib/dynamic-vars.js";
import { retellClient } from "../src/lib/retell.js";
import { clientBySlug, db } from "../src/lib/supabase.js";

/**
 * Creates or updates a client's Retell LLM + agent from the versioned template.
 * Agents are NEVER hand-clicked in the dashboard — rerunning this script is the
 * only sanctioned way to change them (it overwrites). Idempotent via the
 * retell_llm_id / retell_agent_id columns.
 *
 * Usage: npm run agent:push -- --slug summit-heating-air
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg("slug") ?? "summit-heating-air";
  const client = await clientBySlug(slug);
  if (!client) throw new Error(`No client with slug '${slug}' — run the seed / provision script first`);

  const baseUrl = requireEnv("PUBLIC_BASE_URL");
  const token = requireEnv("INTERNAL_WEBHOOK_TOKEN");
  const fnUrl = (fn: string) => `${baseUrl}/webhooks/retell/functions/${fn}?token=${token}`;

  const generalPrompt = readFileSync(join(__dirname, "..", "prompts", "voice-agent.md"), "utf8");

  // Custom tools: the ONLY places our code participates mid-call. Each endpoint
  // answers fast and degrades to "collect preferred windows" language on failure.
  const generalTools: any[] = [
    { type: "end_call", name: "end_call", description: "End the call after wrap-up." },
    {
      type: "custom",
      name: "check_availability",
      description:
        "Fetch a few real bookable appointment slots to offer the caller. Call before offering any times. If the caller doesn't like the offered times, call this again with time_of_day and/or days_ahead_min set to their preference — do not just repeat the same slots or invent new ones.",
      url: fnUrl("check_availability"),
      speak_during_execution: true,
      execution_message_description: "Let me check the schedule real quick.",
      parameters: {
        type: "object",
        properties: {
          time_of_day: {
            type: "string",
            enum: ["any", "morning", "afternoon", "evening"],
            description: "Only set this if the caller stated a preference or rejected earlier offered times.",
          },
          days_ahead_min: {
            type: "integer",
            description: "Skip at least this many days ahead of today. Use when the caller wants something later than what you already offered (e.g. 1 for 'not tomorrow', 7 for 'next week').",
          },
        },
        required: [],
      },
    },
    {
      type: "custom",
      name: "book_appointment",
      description: "Book the appointment after the caller accepts a specific offered slot.",
      url: fnUrl("book_appointment"),
      speak_during_execution: true,
      execution_message_description: "One second while I lock that in.",
      parameters: {
        type: "object",
        properties: {
          slot_iso: { type: "string", description: "The slot_iso value of the slot the caller accepted" },
          name: { type: "string", description: "Caller's name" },
          phone: { type: "string", description: "Callback number, E.164 if possible" },
          address: { type: "string", description: "Service address where the tech needs to go — always collect this before booking" },
          issue: { type: "string", description: "One-line description of the issue" },
        },
        required: ["slot_iso", "name", "address"],
      },
    },
    {
      type: "custom",
      name: "request_callback",
      description: "Save a callback/scheduling request when live booking is unavailable or failed. Include preferred days/times.",
      url: fnUrl("request_callback"),
      speak_during_execution: false,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          phone: { type: "string" },
          address: { type: "string", description: "Service address where the tech needs to go — always collect this" },
          issue: { type: "string" },
          preferred_windows: { type: "string", description: "Caller's preferred days/times, in their words" },
        },
        required: ["name", "address", "issue"],
      },
    },
    {
      type: "custom",
      name: "escalate_emergency",
      description: "Page the on-call tech by SMS and phone RIGHT NOW. Use when an emergency transfer failed/unavailable, after collecting name, phone, address, issue.",
      url: fnUrl("escalate_emergency"),
      speak_during_execution: true,
      execution_message_description: "I'm paging our on-call tech right now.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          phone: { type: "string" },
          address: { type: "string" },
          issue: { type: "string" },
        },
        required: ["issue"],
      },
    },
  ];

  // Layer 4 warm transfer. The destination references the {{transfer_number}}
  // dynamic variable, so the on-call target is per-tenant config, not baked in.
  if (client.features.layer4 !== false) {
    generalTools.push({
      type: "transfer_call",
      name: "transfer_call",
      description:
        "Warm-transfer the caller to the on-call tech for a confirmed emergency, after the caller agrees to be connected. If this fails, use escalate_emergency.",
      transfer_destination: { type: "predefined", number: "{{transfer_number}}" },
      transfer_option: { type: "warm_transfer", show_transferee_as_caller: false },
      speak_during_execution: true,
      execution_message_description: "Connecting you to our on-call tech now — stay with me.",
    });
  }

  // default_dynamic_variables = the fallback if our inbound webhook is ever
  // unreachable: the call still gets answered with the client's last-pushed config.
  const llmPayload = {
    model: "gpt-4.1" as const, // Retell-bundled OpenAI; see DECISIONS.md on bundled vs BYOK
    general_prompt: generalPrompt,
    begin_message: "{{greeting}}",
    general_tools: generalTools,
    default_dynamic_variables: buildDynamicVariables(client),
  };

  const retell = retellClient();
  let llmId = client.retell_llm_id;
  if (llmId) {
    await retell.llm.update(llmId, llmPayload as any);
    console.log(`Updated Retell LLM ${llmId}`);
  } else {
    const llm = await retell.llm.create(llmPayload as any);
    llmId = llm.llm_id;
    console.log(`Created Retell LLM ${llmId}`);
  }

  const agentPayload = {
    agent_name: `${client.business_name} receptionist (${client.slug})`,
    response_engine: { type: "retell-llm" as const, llm_id: llmId! },
    voice_id: process.env.RETELL_VOICE_ID ?? "11labs-Adrian",
    webhook_url: `${baseUrl}/webhooks/retell`,
    max_call_duration_ms: 270_000, // hard stop ~4.5 min; the prompt wraps up at ~4
    interruption_sensitivity: 0.9,
    normalize_for_speech: true,
    // Belt-and-suspenders for callers left unsure what to say (e.g. after a
    // greeting that lists two options): nudge instead of sitting in silence.
    reminder_trigger_ms: 7_000,
    reminder_max_count: 2,
  };

  let agentId = client.retell_agent_id;
  if (agentId) {
    await retell.agent.update(agentId, agentPayload as any);
    console.log(`Updated Retell agent ${agentId}`);
  } else {
    const agent = await retell.agent.create(agentPayload as any);
    agentId = agent.agent_id;
    console.log(`Created Retell agent ${agentId}`);
  }

  const { error } = await db().from("clients").update({ retell_llm_id: llmId, retell_agent_id: agentId }).eq("id", client.id);
  if (error) throw new Error(`clients update: ${error.message}`);
  console.log(`✓ ${slug}: llm=${llmId} agent=${agentId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
