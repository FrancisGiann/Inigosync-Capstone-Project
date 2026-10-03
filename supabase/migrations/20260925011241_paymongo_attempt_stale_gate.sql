-- The customer retry path applies the idempotency-window cutoff even if the
-- scheduled expiry worker has not yet been configured or run.
create or replace function public.review_stale_paymongo_checkout(p_attempt_id uuid, p_customer_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update internal.paymongo_checkout_attempts
  set status = 'review', updated_at = now()
  where id = p_attempt_id and customer_id = p_customer_id
    and status = 'creating' and paymongo_session_id is null
    and created_at <= now() - interval '23 hours';
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;
revoke all on function public.review_stale_paymongo_checkout(uuid, uuid) from public, anon, authenticated;
grant execute on function public.review_stale_paymongo_checkout(uuid, uuid) to service_role;
