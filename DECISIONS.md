# DECISIONS.md

Running log of architecture decisions and the reasoning. Newest at the bottom of each section stays current; superseded entries get struck through, not deleted.

## 2026-07 — Initial build

### Twilio ↔ Retell connection: elastic SIP trunking (Retell's recommended method)
Per [docs.retellai.com/deploy/twilio](https://docs.retellai.com/deploy/twilio): per-client Twilio elastic SIP trunk, origination `sip:sip.retellai.com`, credential-list auth, then Retell's import-phone-number API binds the number to the agent. **No custom code in the voice path** — Twilio hands the call straight to Retell.

**Consequence:** trunk-routed numbers don't emit classic per-call TwiML status callbacks. Layer 3 missed-call detection therefore uses:
1. **Retell `call_ended` events** — Retell answers instantly, so a "missed" call is one where the caller hung up in under ~5s (or the call errored). Detected in the post-call task.
2. **Trunk Disaster Recovery URL** → `/webhooks/twilio/voice-dr` — fires only when Twilio cannot reach Retell at all (voice path down). The handler tells the caller we'll text, fires the text-back task, and pages MY_CELL. The failure mode itself captures the lead.

### Layer 2 config injection: Retell inbound-call webhook
Configured per phone number; Retell POSTs at call start and we return `dynamic_variables` built from the Supabase client row (greeting, mode open/closed, services, prices, transfer number...). 10s timeout, 3 retries; if our service is down Retell falls back to the agent's `default_dynamic_variables`, which `agent:push` keeps stocked with the client's last-pushed config — degraded but the call is still answered and correct-ish. This webhook is technically in the call-setup path, but it's Retell's sanctioned mechanism, it's one DB read (<500ms), and the fallback makes it non-fatal.

### Voice LLM: Retell-bundled OpenAI `gpt-4.1`, not BYOK
Bundled per-minute LLM pricing wins at our volume: no minimums, no extra key plumbing, Retell handles model failover. BYOK/enterprise only makes sense past roughly $3k/mo Retell spend (their enterprise gate). Revisit when total minutes across tenants approach that. `gpt-4.1` is Retell's default OpenAI model — good latency/quality for voice; model is a one-line change in `scripts/create-retell-agent.ts`.

### Our own OpenAI calls: `gpt-4.1-mini` cheap path, `gpt-4.1` smart path
Extraction, SMS turns, classification → mini (cheap, JSON-mode). Nightly digest + weekly/monthly report narrative → full model (this text goes in front of business owners). Both env-overridable (`OPENAI_MODEL_CHEAP/SMART`).

### Webhook host: Railway
Always-on Node process: no cold starts, trivial raw-body access (Twilio/Retell signature validation needs the exact raw body), Dockerfile deploy, ~$5/mo. Fly.io has no real free tier anymore + more ops surface; Vercel's serverless model fights raw-body handling and always-on health semantics for zero benefit here.

### Idempotency: `webhook_receipts` table, first-insert-wins
Every handler claims `{provider}:{event id}` before doing work; Twilio/Retell retries become no-ops. Task triggering additionally uses Trigger.dev `idempotencyKey` (e.g. `post-call:{call_id}` dedupes the call_ended/call_analyzed double-fire). On handoff failure the receipt is released so the provider's retry is processed rather than swallowed.

### Missed-call threshold: < 5 seconds
Retell answers instantly, so sub-5s calls = caller gave up / accidental dial / carrier hiccup. Constant `MISSED_CALL_MAX_SECONDS` in `src/trigger/post-call.ts`.

### Per-tenant "6pm local" scheduling: hourly cron + local-hour gate
One `0 * * * *` schedule; each run fires only for tenants whose local clock reads 18:xx (digest) / Mon 08:xx (weekly report). Boring, correct across timezones and DST, no per-tenant schedule management.

### Opt-outs: global table + single send choke point
`opt_outs` is keyed by phone number only (no tenant column) — STOP to any tenant silences ALL tenants, per spec and TCPA good sense. `sendCustomerSms()` is the only function that texts customers and it checks the table on every send; suppressed sends are logged as events. Twilio's own carrier-level STOP handling runs in addition (belt + suspenders). Internal sends (owner alerts) use `sendInternalSms` and are exempt.

### Bookings: adapter interface, Cal.com first
`bookingAdapterFor(client)` keyed by `clients.booking_method`. Voice books mid-call via Retell custom functions → our webhook → Cal.com v2 (`/v2/slots`, `/v2/bookings`); on any failure the agent degrades to collecting preferred windows + a `needs_scheduling` record the SMS agent confirms. Cal.com API version headers are pinned constants in `src/lib/booking/calcom.ts` — first suspect if Cal.com calls start failing. Attendee email is a synthetic `<digits>@callers.invalid` because phone callers don't have emails handy and confirmations travel by SMS.

### Emergency escalation timing: mid-call, not post-call
The agent calls the `escalate_emergency` custom function the moment a transfer fails, so the SMS+voice page to on-call fires while the caller is still on the line — "someone is being paged right now" is literally true. Post-call also marks the call as emergency from the event trail. Gas smell handling is hardcoded in the prompt template for all tenants and instructs 911/utility first — never book, never transfer.

### Recording: stored only when `clients.recording_enabled`
Post-call simply doesn't persist `recording_url` when the flag is off. Consent notes (incl. two-party-consent states) live in the client handout.

### Costs in `calls`
Retell: `call_cost.combined_cost` from the API (cents). OpenAI: computed from token usage at pinned prices in `src/lib/openai.ts`. Twilio trunk minutes: estimated at ~1¢/min — good enough to trend; labeled as estimate in reports.

### Twilio trunk phone-number assignment: use IncomingPhoneNumber.trunkSid, not Trunks/{sid}/PhoneNumbers
Twilio's documented sub-resource `POST /v1/Trunks/{TrunkSid}/PhoneNumbers` (and the Node SDK's `trunks(sid).phoneNumbers.create()`) returned a bare 404 on this account when tested directly against the raw API — not an SDK issue. The working equivalent, confirmed live: `PUT /IncomingPhoneNumbers/{Sid}` with a `TrunkSid` param (Node: `incomingPhoneNumbers(sid).update({ trunkSid })`), which sets the same `trunk_sid` field and produces an identical result. `scripts/connect-twilio-number.ts` uses this method. If Twilio re-enables the sub-resource for this account later, both approaches should remain equivalent — no need to revert.

### Replaced the original WAT-framework CLAUDE.md
The repo's original CLAUDE.md prescribed Python `tools/` + `workflows/`; the locked architecture is TypeScript + Trigger.dev. New CLAUDE.md keeps the spirit (deterministic scripts, documented SOPs, env-only secrets) with this stack's layout.
