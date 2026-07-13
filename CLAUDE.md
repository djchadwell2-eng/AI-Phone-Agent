# Agent Instructions — Layered Call Capture

Multi-tenant call-capture system for an AI automation agency. Stack is **locked**: TypeScript, Trigger.dev (all async/durable work), Hono webhook service (Railway), Retell (voice), Twilio (telephony/SMS), Supabase (data), Cal.com (booking), OpenAI (runtime LLM). No n8n. No Python tools.

## Ground rules
- **No custom code in the live voice path.** Twilio elastic SIP trunk → Retell answers directly. Our code only handles webhooks *about* calls. The narrow exceptions (inbound dynamic-variables webhook, mid-call booking functions) must stay fast and degrade gracefully — see DECISIONS.md.
- **Multi-tenant always:** onboarding = config JSON + `npm run provision`. If a change requires editing code per client, it's wrong.
- **Secrets from `.env` only** (`.env.example` is the contract). Validate Twilio/Retell signatures on every webhook; idempotency via `webhook_receipts`.
- **Boring, debuggable solutions over clever ones.** Comment the *why*.
- **Update `DECISIONS.md`** whenever an architectural choice is made or reversed.
- **Check current Retell / Trigger.dev / Cal.com docs** before assuming API shapes — they move fast.
- Retell agents are deployed ONLY via `npm run agent:push` (versioned template in `prompts/voice-agent.md`) — never hand-edited in the dashboard.
- The AI-disclosure line in greetings is non-negotiable. Gas-smell 911 handling is hardcoded for all tenants.

## Layout
```
src/lib/        shared logic (tenant resolution, hours, booking adapters, sms agent, costs)
src/webhooks/   Hono service — validate, claim idempotency, hand off to Trigger, respond fast
src/trigger/    all Trigger.dev tasks (post-call, text-back, sms-turn, follow-ups, digest, health...)
prompts/        versioned voice-agent template ({{vars}} = Retell dynamic variables)
scripts/        provisioning + reports + smoke test (tsx)
supabase/       migrations + client-zero seed
configs/        per-tenant config JSONs ($VARS resolve from .env)
docs/           SETUP runbook, deploy, client handout, demo script, provisioning SOP
```

## Verify before claiming done
`npm run typecheck && npm test`, then `npm run smoke` against a running `npm run dev:webhooks`. Phase tests involving real calls/SMS are run by the owner on their phone (docs/SETUP.md).
