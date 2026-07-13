# SETUP.md — from zero to a live demo line

The build order matches the five phases; **each phase ends with a test you run on your own phone.** Do them in order — later phases assume earlier ones passed. Estimated total hands-on time: ~2–3 hours plus A2P registration wait.

You already have: Supabase account, OpenAI key. You still need accounts at: Twilio, Retell, Trigger.dev, Cal.com, Railway (all steps below).

---

## Phase 0 — Accounts & keys (one-time)

### Supabase
1. Create a **new project** (any name, e.g. `call-capture`). Region: US East.
2. SQL Editor → paste and run `supabase/migrations/0001_init.sql`, then `supabase/seed.sql`.
3. Project Settings → API: copy **URL** and **service_role key** into `.env`.

### Twilio
1. Sign up at twilio.com, upgrade to paid (required to own numbers / text real phones).
2. Console → Account Info: copy **Account SID** + **Auth Token** into `.env`.
3. Buy (or port in) your demo number when ready — **local number in your area code** looks best on caller ID. You said you'll get the number yourself; nothing in Phase 1 needs it.
4. **§3b — A2P 10DLC (do this early; approval takes days):** Messaging → Regulatory Compliance → register a Brand (your agency) and a Campaign (use case: "customer care / account notifications"; sample messages: the missed-call text-back and booking confirmation from this repo). Add the demo number to the campaign once you have it. Until this is approved, SMS to US numbers may be silently filtered — calls work regardless.
5. Invent a SIP username/password pair for `.env` (`TWILIO_SIP_USERNAME/PASSWORD`) — the connect script creates the credential list from these.

### Retell
1. Sign up at retellai.com → Dashboard → API Keys → copy into `.env` (`RETELL_API_KEY`). Add billing.

### Trigger.dev
1. Sign up at trigger.dev (cloud) → create org + project (e.g. `call-capture`).
2. Copy the **project ref** (`proj_...`) into `.env` as `TRIGGER_PROJECT_REF`, and the **dev secret key** as `TRIGGER_SECRET_KEY`.
3. `npx trigger.dev@latest login` once on this machine.

### Cal.com
1. Sign up (free tier) → connect **your Google Calendar** (Settings → Apps). This is what makes voice bookings appear in the calendar you already check.
2. Create an event type, e.g. **"Service Visit — Summit Heating & Air"**, 60 min, availability = business hours. Note its numeric ID (it's in the URL when editing).
3. Settings → Developer → API Keys → create → `.env` `CALCOM_API_KEY`.
4. Put the event type ID on the client row (SQL Editor):
   `update clients set calcom_event_type_id = <ID> where slug = 'summit-heating-air';`
5. (Phase 2+) Settings → Developer → Webhooks → add `https://<railway-app>/webhooks/calcom`, subscribe BOOKING_CREATED + BOOKING_CANCELLED, set a secret → `.env` `CALCOM_WEBHOOK_SECRET`.

### Railway (webhook host — see DECISIONS.md for why Railway)
1. Sign up at railway.app → New Project → **Deploy from GitHub repo** (push this repo to a private GitHub repo first) — Railway auto-detects the Dockerfile.
2. Service → Settings → Networking → Generate Domain → that URL is your `PUBLIC_BASE_URL` (no trailing slash).
3. Service → Variables → paste every var from your `.env` (use the **prod** Trigger.dev key here).
4. Settings → Health check path: `/health`.

### Local `.env`
`copy .env.example .env` and fill everything. Generate `INTERNAL_WEBHOOK_TOKEN` with any long random string. Set `MY_CELL=+1XXXXXXXXXX` (your cell, E.164).

---

## Phase 1 — Foundation. TEST: webhooks land, rows write

```powershell
npm install
npm run typecheck ; npm test          # should be green
npm run dev:webhooks                  # terminal A — local service on :8080
npm run dev:trigger                   # terminal B — Trigger.dev dev worker
```

**Local test** (PUBLIC_BASE_URL must equal the URL you post to — for local runs set `PUBLIC_BASE_URL=http://localhost:8080` temporarily):
```powershell
npm run smoke
```
Expect `PHASE 1 SMOKE: ALL GREEN` — proves signature validation, idempotency receipts, opt-out writes, client-zero row.

**Deployed test:** push to GitHub → Railway deploys → restore the real `PUBLIC_BASE_URL` in both `.env` and Railway → `npm run smoke -- --base https://<railway-app>`.

Then deploy the task suite to Trigger.dev cloud: `npm run deploy:trigger`.

✅ **Phase 1 done when:** smoke test green against the Railway URL, and the Trigger.dev dashboard shows the deployed tasks.

---

## Phase 2 — Voice (Layers 1+2) + live calendar booking. TEST: on your phone

Prereqs: demo number purchased in Twilio; A2P at least submitted; Cal.com event type wired (Phase 0).

```powershell
npm run provision -- configs/summit-heating-air.json --number +1YOURDEMONUMBER
```
This upserts client zero (resolving `$MY_CELL` from .env), pushes the Retell LLM + agent from `prompts/voice-agent.md`, builds the SIP trunk, imports the number into Retell, and points SMS + DR webhooks at Railway.

**Test 2a — day mode:** Call the demo line. Sunny answers with the *day* greeting and **discloses it's an AI**. Hold a real conversation: give a fake AC problem, your name, an address. Ask "is this a real person?" — graceful honest answer. Ask for a price not in config — it declines to guess.

**Test 2b — booking (the money shot):** Say you'd like an appointment. It offers 2–3 real slots, you accept one, **watch it appear in your Google Calendar within seconds** of the confirmation sentence.

**Test 2c — night mode (fake clock):**
```sql
update clients set fake_now = '2026-07-15T02:00:00Z' where slug='summit-heating-air';
```
Call again → *night* greeting, next-day booking offer, emergency logic armed. Then clear it:
```sql
update clients set fake_now = null where slug='summit-heating-air';
```
(While fake_now was set, the call is logged as after-hours → you get the real-time owner SMS summary.)

**Verify data:** Supabase → `calls` row with transcript + extracted JSON + costs; `bookings` row; owner-summary SMS for the night call on your cell.

✅ **Phase 2 done when:** both greetings heard, booking landed on Google Calendar, structured rows exist, night-call SMS summary arrived.

---

## Phase 3 — Missed-call text-back + SMS agent. TEST: on your phone

Nothing to deploy — it shipped in Phases 1–2. (Requires A2P approval for reliable SMS.)

**Test 3a:** Call the demo line and **hang up after ~2 rings** (under 5 seconds of connected time). Within seconds: *"Sorry we missed you — this is Summit Heating & Air…"*

**Test 3b:** Text back a problem ("my AC died"). The SMS agent answers from config, collects name/address, offers real slots, and drives to a booking-ish outcome. Check `sms_threads` / `sms_messages` rows.

**Test 3c:** Reply **STOP** → silence, forever, across every tenant (`opt_outs` row appears). Reply **START** if you want to undo it for further testing.

✅ **Phase 3 done when:** text-back arrives fast, conversation books or escalates sensibly, STOP is honored instantly.

---

## Phase 4 — Emergency warm transfer. TEST: on your phone

`on_call_number` is already your cell (from `$MY_CELL`).

**Test 4a:** Set night mode (fake_now as in 2c). Call: *"my furnace is out and it's freezing in my house."* Agent treats it as an emergency, collects name/number/address FIRST, offers to connect you → **your cell rings** (warm transfer).

**Test 4b:** Reject the transfer on your cell. The agent tells the caller the on-call tech is being paged → **your cell gets the 🚨 SMS and a voice page call** within seconds (escalate_emergency → emergency-escalation task).

**Test 4c:** Say you smell gas → agent instructs 911/gas utility and ends the call. No booking, no transfer.

Verify: `calls.is_emergency = true`, `events` rows `emergency` + `emergency_escalation`, `transfer_status`.

✅ **Phase 4 done when:** transfer rings your cell; rejection produces SMS + voice page; gas rule fires.

---

## Phase 5 — Multi-tenant proof + polish. TEST: second tenant end-to-end

1. Buy a second (cheap local) Twilio number for the fictional tenant.
2. Optionally create a second Cal.com event type ("Acme Test Plumbing") and set its ID in `configs/acme-test-plumbing.json` via SQL after provisioning.
3. ```powershell
   npm run provision -- configs/acme-test-plumbing.json --number +1SECONDNUMBER
   ```
4. Repeat tests 2–4 against the Acme number — different greeting, trade, hours, emergencies, all from the config row. **Zero code changes** is the acceptance criterion.
5. Reports & metrics:
   ```powershell
   npm run report -- --slug summit-heating-air --month 2026-07
   ```
   plus `select * from client_metrics_monthly;` in Supabase.
6. Health check + digests are already scheduled (Trigger.dev dashboard → daily-digest hourly, health-check 12:00 UTC, cost-rollup 12:30 UTC, weekly-report Mondays 8am local).

✅ **Phase 5 done when:** Acme passes tests 2–4 untouched, report generator prints case-study markdown, health check shows green in Trigger.dev.

---

## Day-2 operations
- **Pause a tenant:** `update clients set status='paused' where slug='...';` (agent still answers via Retell; SMS/tasks stop. To fully stop, also unassign the number in Retell.)
- **Change agent behavior:** edit `prompts/voice-agent.md` (bump the version comment) → `npm run agent:push -- --slug <slug>` per tenant.
- **Rotate the internal token:** change `INTERNAL_WEBHOOK_TOKEN` in Railway + rerun `agent:push` and `number:connect` per tenant (URLs embed the token).
- **Watch:** Trigger.dev dashboard (task runs/failures), Railway logs (webhook traffic), Supabase `errors` table (everything alerts your cell too).
