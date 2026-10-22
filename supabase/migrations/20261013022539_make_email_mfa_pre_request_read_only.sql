-- Historical version retained because it is recorded in the remote Supabase migration ledger.
-- Its behavior is replayed by 20261013090000_make_email_mfa_pre_request_read_only.sql after its prerequisites are available.
-- This no-op marker prevents duplicate or premature database changes on fresh replay.
select 1;
