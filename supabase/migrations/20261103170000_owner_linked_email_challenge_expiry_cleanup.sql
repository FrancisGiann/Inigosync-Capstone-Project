-- Enrollment challenges remain usable until their existing expires_at time.
-- This worker removes only already-expired rows, independently of sign-in or
-- email traffic, so stored addresses and proof hashes are not retained forever.
create extension if not exists pg_cron with schema pg_catalog;

create or replace function internal.cleanup_expired_owner_email_enrollment_challenges()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_rows bigint;
begin
  delete from internal.owner_email_enrollment_challenges
  where expires_at <= pg_catalog.now();
  get diagnostics deleted_rows = row_count;
  return deleted_rows;
end;
$$;

revoke all on function internal.cleanup_expired_owner_email_enrollment_challenges()
  from public, anon, authenticated;
grant execute on function internal.cleanup_expired_owner_email_enrollment_challenges()
  to service_role;

comment on function internal.cleanup_expired_owner_email_enrollment_challenges() is
  'Deletes only owner email enrollment challenge rows at or past expires_at. A five-minute pg_cron job targets cleanup within five minutes after expiry while the scheduler is healthy; unexpired/reusable challenge proofs remain intact.';

select cron.schedule(
  'inigosync-prune-owner-email-enrollment-challenges',
  '*/5 * * * *',
  'select internal.cleanup_expired_owner_email_enrollment_challenges()'
);
