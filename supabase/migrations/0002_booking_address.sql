-- bookings had no address column at all — a real gap, not just a Cal.com UI
-- question: for a mobile/dispatch business the service address is essential
-- data on every booking, voice or SMS, live or degraded.
alter table bookings add column address text;
