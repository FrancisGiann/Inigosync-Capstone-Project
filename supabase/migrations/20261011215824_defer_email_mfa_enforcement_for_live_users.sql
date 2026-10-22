-- Historical version retained because it is recorded in the remote Supabase migration ledger.
-- Its behavior is replayed by 20261012091000_defer_email_mfa_enforcement_for_live_users.sql after its prerequisites are available.
-- This no-op marker prevents duplicate or premature database changes on fresh replay.
select 1;
