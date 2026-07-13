import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../src/lib/env.js";
import { db } from "../src/lib/supabase.js";

/**
 * THE onboarding entrypoint: new client = config JSON + this script. Zero code changes.
 *
 *   npm run provision -- configs/summit-heating-air.json [--number +1555...]
 *
 * 1. Upserts the client row from the JSON (env placeholders like $MY_CELL resolved)
 * 2. Pushes the Retell LLM + agent (create-retell-agent.ts)
 * 3. If --number given (or json.twilio_number set): wires Twilio↔Retell (connect-twilio-number.ts)
 * 4. Prints the remaining manual checklist (Cal.com event type, A2P, forwarding handout)
 *
 * Full walkthrough: docs/provision-client.md
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath || configPath.startsWith("--")) {
    throw new Error("Usage: npm run provision -- configs/<client>.json [--number +1...]");
  }
  // $VARS in the JSON resolve from env, so personal numbers stay out of the repo.
  const rawJson = readFileSync(resolve(configPath), "utf8").replace(/"\$([A-Z_]+)"/g, (_, name) => {
    const v = process.env[name];
    if (!v) throw new Error(`Config references $${name} but it's not set in .env`);
    return JSON.stringify(v);
  });
  const cfg = JSON.parse(rawJson);
  if (!cfg.slug) throw new Error("Config must include a slug");

  const number: string | undefined = arg("number") ?? cfg.twilio_number ?? undefined;
  delete cfg.twilio_number; // connect script owns this column

  const { error } = await db().from("clients").upsert(cfg, { onConflict: "slug" });
  if (error) throw new Error(`clients upsert: ${error.message}`);
  console.log(`✓ client row upserted: ${cfg.slug}`);

  const tsx = process.platform === "win32" ? "npx.cmd" : "npx";
  execFileSync(tsx, ["tsx", "scripts/create-retell-agent.ts", "--slug", cfg.slug], { stdio: "inherit", shell: process.platform === "win32" });

  if (number) {
    execFileSync(tsx, ["tsx", "scripts/connect-twilio-number.ts", "--slug", cfg.slug, "--number", number], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  } else {
    console.log("→ no number passed; run later:  npm run number:connect -- --slug " + cfg.slug + " --number +1...");
  }

  console.log(`
──────────────────────────── remaining manual checklist ────────────────────────────
[ ] Cal.com: event type created + its id in clients.calcom_event_type_id
            (and calcom_api_key on the row if the client uses their own account)
[ ] Cal.com webhook → ${env.PUBLIC_BASE_URL ?? "$PUBLIC_BASE_URL"}/webhooks/calcom (secret = CALCOM_WEBHOOK_SECRET)
[ ] A2P 10DLC campaign includes this number (US SMS deliverability) — SETUP.md §3b
[ ] Send owner docs/forwarding-handout.md (conditional call forwarding — Layer 1)
[ ] Test call the number end-to-end (SETUP.md phase tests 2-4)
─────────────────────────────────────────────────────────────────────────────────────`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
