# Layered Call Capture

Multi-tenant phone-lead capture for trades businesses: a Retell voice agent answers instantly on a Twilio number, books real appointments into Cal.com/Google Calendar mid-call, texts back missed calls, runs a two-way SMS agent, warm-transfers emergencies to on-call, and reports revenue captured — all config-per-tenant, zero code per client.

**Stack (locked):** TypeScript · Trigger.dev (all async/durable work) · Hono webhook service on Railway · Retell (voice) · Twilio (telephony/SMS) · Supabase (data) · Cal.com (booking) · OpenAI (extraction/SMS/reports).

## The four layers
1. **Overflow capture** — client's carrier forwards no-answer/busy calls to their capture number; Retell answers instantly (no custom code in the voice path).
2. **After-hours shift** — same number/agent, behavior flips via per-call dynamic variables from Supabase config (greetings, booking mode, emergency arming).
3. **Missed-call text-back** — sub-5s hangups and voice-path failures get an SMS within seconds; a cheap-model SMS agent converses, collects, books, escalates; STOP honored globally.
4. **Emergency warm transfer** — config-defined emergencies transfer to on-call; failures page on-call by SMS + voice while the caller is still on the line. Gas smell → 911 first, hardcoded for everyone.

## Quick start
See **[docs/SETUP.md](docs/SETUP.md)** — five phases, each ending with a test you run on your own phone. Other docs: [DECISIONS.md](DECISIONS.md) (why everything is the way it is) · [docs/provision-client.md](docs/provision-client.md) (new-client SOP) · [docs/forwarding-handout.md](docs/forwarding-handout.md) (client-facing) · [docs/demo-script.md](docs/demo-script.md) (sales demo).

```powershell
npm install
npm run typecheck ; npm test    # verify
npm run dev:webhooks            # local webhook service
npm run dev:trigger             # Trigger.dev dev worker
npm run smoke                   # phase 1 acceptance
npm run provision -- configs/summit-heating-air.json --number +1...   # go live
```

## Repo map
```
src/webhooks/   Hono service: validate signatures → claim idempotency → hand to Trigger → respond
src/trigger/    tasks: post-call, missed-call-textback, sms-turn, follow-ups (durable waits),
                emergency-escalation, daily-digest, weekly-report, health-check, cost-rollup
src/lib/        tenants, hours (fake_now test clock), booking adapters, sms agent, extraction, costs
prompts/        versioned voice-agent template — deployed only via `npm run agent:push`
scripts/        provision-client, connect-twilio-number, create-retell-agent, generate-report, smoke-test
supabase/       migrations (schema + metrics view) and client-zero seed
configs/        one JSON per tenant ($VARS resolve from .env)
```
