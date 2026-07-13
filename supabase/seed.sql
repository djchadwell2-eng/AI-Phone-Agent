-- Client zero: the demo line. Fictional HVAC brand — prospects hear what their
-- own receptionist would sound like. twilio_number stays NULL until you have a
-- number; scripts/connect-twilio-number.ts fills it in.
-- on_call_number / owner_cell already point at MY_CELL from .env.

insert into clients (
  slug, business_name, trade, timezone, hours,
  greeting_day, greeting_night, persona_notes,
  services, service_area, price_ranges,
  booking_method, emergency_keywords,
  on_call_number, owner_cell,
  features, avg_ticket_cents, recording_enabled, monthly_minute_cap, status
) values (
  'summit-heating-air',
  'Summit Heating & Air',
  'hvac',
  'America/New_York',
  '{"mon":{"open":"08:00","close":"17:00"},"tue":{"open":"08:00","close":"17:00"},"wed":{"open":"08:00","close":"17:00"},"thu":{"open":"08:00","close":"17:00"},"fri":{"open":"08:00","close":"17:00"},"sat":null,"sun":null}',
  'Thanks for calling Summit Heating and Air! This is Sunny, the AI assistant — everyone on the team is helping other customers right now, but I can get you taken care of.',
  'Thanks for calling Summit Heating and Air! This is Sunny, the AI assistant. The office is closed right now, but I can help you book for tomorrow — and if this is an emergency, I can get you to our on-call tech.',
  'Family-owned HVAC company, 20 years serving the area. Warm, unhurried, plain-spoken.',
  '["AC repair","AC installation","furnace repair","furnace installation","heat pump service","duct cleaning","seasonal tune-ups","thermostat installation"]',
  'the greater metro area, roughly a 30-mile radius of downtown',
  '{"diagnostic visit":"$89 to $129 depending on distance","seasonal tune-up":"$119"}',
  'calcom',
  '["no heat","no air conditioning","burst pipe","water leaking","water through ceiling","carbon monoxide","co alarm","smoke"]',
  '+15139668491',
  '+15139668491',
  '{"layer1":true,"layer2":true,"layer3":true,"layer4":true,"sms_agent":true,"follow_ups":true}',
  45000,
  true,      -- recording ON for client zero (demo/case-study material)
  1000,      -- alert past 800 minutes/month
  'active'
)
on conflict (slug) do nothing;
