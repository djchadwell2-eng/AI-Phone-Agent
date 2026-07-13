# Provisioning a new client (SOP)

Onboarding = **one config file + one script run + a short manual checklist.** No code changes, ever. Budget ~30 minutes of your time plus the client's 10.

## 1. Intake (from the sales call)
Collect: business name · trade · timezone · hours · services list · service area · the 2–3 prices they're comfortable quoting as ranges · their emergency list ("what should wake your on-call tech?") · on-call number · owner's cell · **booking email** (real inbox — receives Cal.com confirmations for phone bookings; Cal.com rejects fake domains) · average ticket · recording yes/no (check consent-state note in the handout).

## 2. Buy their Twilio number
Twilio Console → Buy a Number → local to the client's area code, voice + SMS. Add it to your A2P campaign (Messaging → your campaign → add number).

## 3. Create the config
```powershell
copy configs\acme-test-plumbing.json configs\<their-slug>.json
```
Fill it from intake. Literal phone numbers are fine, or `$VARNAME` to pull from `.env`. Set `avg_ticket_cents` conservatively — it drives the revenue-captured number you'll report.

## 4. Cal.com
Their account (preferred — bookings land on THEIR Google Calendar):
1. Client signs up free at cal.com, connects Google Calendar (2-minute screen-share).
2. Create event type "Service Visit — <Business>", duration + availability per their hours.
3. They create an API key (Settings → Developer) → put it in `calcom_api_key` in the config, event type ID in `calcom_event_type_id`.

Or run it under your agency Cal.com account (event type per client, leave `calcom_api_key` null → env key used).

## 5. Provision
```powershell
npm run provision -- configs/<their-slug>.json --number +1THEIRNUMBER
```
Prints the remaining checklist. Rerunnable any time (idempotent) — also how you push config changes later.

## 6. Verify before handoff (15 min, your phone)
Run the client's versions of SETUP.md tests 2–4 against their number: day greeting, booking→calendar, hang-up→text-back, STOP/START, emergency transfer to their on-call number (warn them first!). Use `fake_now` for night mode, then **clear it**.

## 7. Client does their one manual step
Send `docs/forwarding-handout.md` with their capture number filled in. They dial the conditional-forwarding code for their carrier (or set "no answer → forward" in their VoIP portal). Have them test-call their own line and not answer.

## 8. Go-live hygiene
- [ ] `fake_now` is null
- [ ] Owner got the "you'll receive a 6pm digest" heads-up text
- [ ] First real captured call reviewed in `calls` the next morning
- [ ] Calendar sanity: a test booking visible in their Google Calendar
- [ ] Add a recurring reminder to send the monthly report (`npm run report -- --slug <slug> --month YYYY-MM`)
