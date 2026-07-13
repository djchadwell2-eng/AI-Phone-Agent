-- Cal.com rejects attendee emails on non-deliverable domains
-- (email_domain_cannot_receive_mail), so the synthetic @callers.invalid
-- placeholder failed live booking. Phone callers don't give emails; instead
-- each client configures a real inbox that receives the Cal.com confirmations
-- for phone bookings (naturally the owner's/office email).
alter table clients add column booking_email text;

-- client zero: confirmations go to the owner's gmail
update clients set booking_email = 'djchadwell2@gmail.com' where slug = 'summit-heating-air';
