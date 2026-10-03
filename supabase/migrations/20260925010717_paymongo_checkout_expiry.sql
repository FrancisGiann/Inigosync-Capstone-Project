create extension if not exists pg_net with schema extensions;

create or replace function public.list_paymongo_checkouts_due_for_expiry()
returns table (attempt_id uuid, session_id text)
language sql security definer set search_path = '' as $$
  select a.id, a.paymongo_session_id
  from internal.paymongo_checkout_attempts a
  join public.booking b on b.booking_id = a.booking_id
  where a.status = 'ready' and a.paymongo_session_id is not null
    and b.time_date <= now()
  order by b.time_date asc
  limit 50
$$;
revoke all on function public.list_paymongo_checkouts_due_for_expiry() from public, anon, authenticated;
grant execute on function public.list_paymongo_checkouts_due_for_expiry() to service_role;

create or replace function public.mark_paymongo_checkout_expired(p_attempt_id uuid, p_session_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update internal.paymongo_checkout_attempts
  set status = 'expired', updated_at = now()
  where id = p_attempt_id and paymongo_session_id = p_session_id and status = 'ready';
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;
revoke all on function public.mark_paymongo_checkout_expired(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_paymongo_checkout_expired(uuid, text) to service_role;

-- pg_cron invokes the narrowly scoped expiry worker. It stays inert until a
-- random worker token is placed in Vault and PAYMONGO_EXPIRY_CRON_SECRET is
-- added to this function's Edge secrets; no service-role key is stored in
-- Vault or passed through a scheduled request.
create or replace function internal.invoke_paymongo_expiry_worker()
returns void language plpgsql security definer set search_path = '' as $$
declare
  worker_secret text;
begin
  select v.decrypted_secret into worker_secret
  from vault.decrypted_secrets v where v.name = 'paymongo_expiry_cron_secret' limit 1;
  if worker_secret is null then return; end if;
  perform net.http_post(
    url := 'https://xrlwtnwamboucihsamrr.supabase.co/functions/v1/paymongo-expire-checkouts',
    headers := pg_catalog.jsonb_build_object(
      'Content-Type', 'application/json',
      'x-paymongo-cron-secret', worker_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
end;
$$;
revoke all on function internal.invoke_paymongo_expiry_worker() from public, anon, authenticated;

select cron.schedule(
  'paymongo-expire-past-checkouts',
  '* * * * *',
  'select internal.invoke_paymongo_expiry_worker()'
);
