-- Layered Call Capture — initial schema.
-- Access model: server-side only via the service-role key. RLS is enabled on every
-- table with NO policies, so the anon key can read nothing; the service key bypasses RLS.

create extension if not exists pgcrypto;

-- ── Tenants ─────────────────────────────────────────────────────────────────
create table clients (
  id                   uuid primary key default gen_random_uuid(),
  slug                 text not null unique,
  business_name        text not null,
  trade                text not null,                       -- 'hvac', 'plumbing', ...
  timezone             text not null default 'America/New_York',
  -- {"mon":{"open":"08:00","close":"17:00"}, ... "sun":null} — null day = closed
  hours                jsonb not null default '{}',
  greeting_day         text not null default '',
  greeting_night       text not null default '',
  persona_notes        text not null default '',            -- extra flavor injected into the agent prompt
  services             jsonb not null default '[]',         -- ["AC repair","furnace install",...]
  service_area         text not null default '',
  price_ranges         jsonb not null default '{}',         -- {"diagnostic visit":"$89-$129"} — agent may quote ONLY these
  booking_method       text not null default 'calcom',      -- adapter key: 'calcom' now; 'servicetitan' etc. later
  calcom_event_type_id integer,
  calcom_api_key       text,                                 -- null → fall back to env CALCOM_API_KEY
  emergency_keywords   jsonb not null default '[]',          -- ["no heat","burst pipe",...] (gas smell is hardcoded in the prompt template)
  on_call_number       text,                                 -- E.164; warm-transfer target
  owner_cell           text,                                 -- E.164; alerts + digests
  twilio_number        text unique,                          -- E.164; how every webhook resolves its tenant
  twilio_number_sid    text,
  retell_agent_id      text,
  retell_llm_id        text,
  -- per-layer feature flags; flipping one off disables that behavior for the tenant only
  features             jsonb not null default '{"layer1":true,"layer2":true,"layer3":true,"layer4":true,"sms_agent":true,"follow_ups":true}',
  avg_ticket_cents     integer not null default 45000,       -- conservative revenue estimate basis
  recording_enabled    boolean not null default false,
  monthly_minute_cap   integer,                              -- null = uncapped; alert at 80% and 100%
  -- Testing hook for Layer 2: when set, business-hours logic uses this instant
  -- instead of now(), so "night mode" is testable at 2pm. Clear after testing.
  fake_now             timestamptz,
  status               text not null default 'active' check (status in ('active','paused')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ── Calls ───────────────────────────────────────────────────────────────────
create table calls (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references clients(id),
  retell_call_id     text unique,
  twilio_call_sid    text unique,
  from_number        text not null,
  to_number          text not null,
  direction          text not null default 'inbound',
  started_at         timestamptz,
  ended_at           timestamptz,
  duration_seconds   integer,
  status             text,                                   -- 'completed','missed','failed','voice_path_down'
  disconnect_reason  text,
  is_after_hours     boolean not null default false,
  is_emergency       boolean not null default false,
  transfer_status    text,                                   -- null | 'attempted' | 'connected' | 'failed'
  transcript         text,
  recording_url      text,
  extracted          jsonb,                                  -- structured extraction (name, callback, address, intent, urgency, booked, sentiment, summary)
  sentiment          text,
  summary            text,
  retell_cost_cents  integer,
  twilio_cost_cents  integer,
  openai_cost_cents  integer,
  total_cost_cents   integer,
  digest_sent        boolean not null default false,         -- daytime calls batch into the 6pm digest
  created_at         timestamptz not null default now()
);
create index calls_client_created_idx on calls (client_id, created_at desc);

-- ── SMS ─────────────────────────────────────────────────────────────────────
create table sms_threads (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references clients(id),
  customer_number  text not null,
  status           text not null default 'active' check (status in ('active','escalated','closed','opted_out')),
  -- rolling agent memory: collected name/address/issue, origin call, booking state
  context          jsonb not null default '{}',
  origin_call_id   uuid references calls(id),
  last_message_at  timestamptz not null default now(),
  created_at       timestamptz not null default now()
);
-- one open conversation per customer per tenant; closed threads keep history
create unique index sms_threads_one_active_idx
  on sms_threads (client_id, customer_number) where (status in ('active','escalated'));

create table sms_messages (
  id                  uuid primary key default gen_random_uuid(),
  thread_id           uuid not null references sms_threads(id),
  direction           text not null check (direction in ('inbound','outbound')),
  body                text not null,
  twilio_message_sid  text unique,
  meta                jsonb not null default '{}',
  created_at          timestamptz not null default now()
);
create index sms_messages_thread_idx on sms_messages (thread_id, created_at);

-- ── Bookings (adapter-agnostic record; Cal.com uid when booked there) ──────
create table bookings (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references clients(id),
  call_id            uuid references calls(id),
  thread_id          uuid references sms_threads(id),
  status             text not null check (status in ('booked','needs_scheduling','confirmed','cancelled')),
  provider           text not null default 'calcom',
  provider_booking_uid text,
  start_at           timestamptz,
  customer_name      text,
  customer_phone     text,
  issue              text,
  preferred_windows  text,                                   -- free text when real-time booking degraded
  created_at         timestamptz not null default now()
);
create index bookings_client_idx on bookings (client_id, created_at desc);

-- ── Events: every customer-facing send + notable system moments ────────────
create table events (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid references clients(id),
  -- 'missed_call_textback','sms_agent_reply','owner_alert','emergency','emergency_escalation',
  -- 'transfer_attempted','transfer_connected','booking_created','follow_up_sent','digest_sent',
  -- 'weekly_report','voice_path_failure','cost_cap_warning', ...
  type        text not null,
  call_id     uuid references calls(id),
  thread_id   uuid references sms_threads(id),
  payload     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index events_client_type_idx on events (client_id, type, created_at desc);

-- ── Errors: every failure branch lands here (and alerts MY_CELL) ───────────
create table errors (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid references clients(id),
  source      text not null,                                 -- task/route name
  message     text not null,
  detail      jsonb not null default '{}',
  alerted     boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ── Opt-outs: GLOBAL across all tenants, keyed by phone number ─────────────
create table opt_outs (
  phone_number  text primary key,                            -- E.164
  opted_out_at  timestamptz not null default now(),
  source        text not null default 'sms',                 -- 'sms' | 'manual'
  last_keyword  text
);

-- ── Follow-up sequences (day 1/3/7) — task re-checks status before each send ─
create table follow_up_sequences (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references clients(id),
  customer_number  text not null,
  call_id          uuid references calls(id),
  status           text not null default 'active' check (status in ('active','completed','cancelled')),
  stage            integer not null default 0,               -- last stage sent (0 = none yet)
  created_at       timestamptz not null default now()
);
create unique index follow_up_one_active_idx
  on follow_up_sequences (client_id, customer_number) where (status = 'active');

-- ── Webhook idempotency: first insert wins, duplicates are dropped ──────────
create table webhook_receipts (
  id           text primary key,                             -- '{provider}:{unique event key}'
  received_at  timestamptz not null default now()
);

-- ── Generated reports (weekly/monthly markdown for case studies) ───────────
create table reports (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id),
  kind        text not null,                                 -- 'weekly' | 'monthly'
  period      text not null,                                 -- '2026-W28' | '2026-07'
  markdown    text not null,
  created_at  timestamptz not null default now()
);

-- ── Metrics view: the case-study numbers, per client per month ─────────────
-- Built as per-table monthly aggregates (CTEs) rather than correlated
-- subqueries against an outer grouped column — Postgres rejects the latter
-- ("subquery uses ungrouped column"), and the CTE form also correctly shows
-- months with bookings/SMS but zero calls, which the old form silently dropped.
create view client_metrics_monthly as
with call_agg as (
  select
    client_id,
    date_trunc('month', created_at) as month,
    count(*)                                                 as calls_received,
    count(*) filter (where status = 'completed')             as ai_answered,
    count(*) filter (where is_after_hours)                   as after_hours_calls,
    count(*) filter (where is_emergency)                     as emergencies,
    count(*) filter (where transfer_status = 'connected')    as transfers_connected,
    coalesce(sum(total_cost_cents), 0)                       as total_cost_cents,
    coalesce(sum(duration_seconds), 0) / 60                  as total_minutes
  from calls
  group by client_id, date_trunc('month', created_at)
),
thread_agg as (
  select client_id, date_trunc('month', created_at) as month, count(distinct id) as sms_conversations
  from sms_threads
  group by client_id, date_trunc('month', created_at)
),
booking_agg as (
  -- conservative: bookings × avg ticket; labeled "estimated" everywhere it is shown
  select client_id, date_trunc('month', created_at) as month, count(*) as bookings
  from bookings
  where status in ('booked', 'confirmed')
  group by client_id, date_trunc('month', created_at)
),
-- every (client, month) that has ANY activity in any of the three sources,
-- so a month with bookings/SMS but zero calls still shows up.
months as (
  select client_id, month from call_agg
  union
  select client_id, month from thread_agg
  union
  select client_id, month from booking_agg
)
select
  c.id                                            as client_id,
  c.slug,
  to_char(m.month, 'YYYY-MM')                     as month,
  coalesce(ca.calls_received, 0)                  as calls_received,
  coalesce(ca.ai_answered, 0)                     as ai_answered,
  coalesce(ca.after_hours_calls, 0)               as after_hours_calls,
  coalesce(ca.emergencies, 0)                     as emergencies,
  coalesce(ca.transfers_connected, 0)             as transfers_connected,
  coalesce(t.sms_conversations, 0)                as sms_conversations,
  coalesce(b.bookings, 0)                         as bookings,
  coalesce(b.bookings, 0) * c.avg_ticket_cents    as est_revenue_captured_cents,
  coalesce(ca.total_cost_cents, 0)                as total_cost_cents,
  coalesce(ca.total_minutes, 0)                   as total_minutes
from months m
join clients c on c.id = m.client_id
left join call_agg ca on ca.client_id = m.client_id and ca.month = m.month
left join thread_agg t on t.client_id = m.client_id and t.month = m.month
left join booking_agg b on b.client_id = m.client_id and b.month = m.month;

-- ── Lock everything down: RLS on, no policies (service-role only access) ───
alter table clients              enable row level security;
alter table calls                enable row level security;
alter table sms_threads          enable row level security;
alter table sms_messages         enable row level security;
alter table bookings             enable row level security;
alter table events               enable row level security;
alter table errors               enable row level security;
alter table opt_outs             enable row level security;
alter table follow_up_sequences  enable row level security;
alter table webhook_receipts     enable row level security;
alter table reports              enable row level security;
