-- The login UI and guarded Edge Functions must be released before the global
-- request gate is enabled. Keep the proof tables/RPCs from the preceding
-- migration ready, while preserving access for the currently deployed client.
-- A later activation migration must restore the restrictive policies and hook
-- only after the email-mfa function and updated frontend are live.

alter role authenticator reset pgrst.db_pre_request;

do $$
declare p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where (schemaname = 'public' and policyname in (
      'profiles_email_mfa_select', 'profiles_email_mfa_update',
      'email_mfa_required', 'email_mfa_required_insert',
      'email_mfa_required_update', 'email_mfa_required_delete',
      'email_mfa_required_write'
    ))
    or (schemaname = 'storage' and policyname in (
      'email_mfa_required_storage_write', 'email_mfa_required_storage_insert',
      'email_mfa_required_storage_update', 'email_mfa_required_storage_delete'
    ))
  loop
    execute format('drop policy if exists %I on %I.%I',
      p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

notify pgrst, 'reload config';

-- This migration runs before the staged flag table exists. Its guarded update
-- also provides the flag-off step if this rollback script is rerun manually
-- after the activation migration has enabled the Edge Function check.
do $$
begin
  if to_regclass('internal.email_mfa_enforcement') is not null then
    execute 'update internal.email_mfa_enforcement set enabled = false, updated_at = now() where singleton';
  end if;
end $$;
