-- A staff QR checkout has no acknowledgment until PayMongo confirms payment.
-- Return a minimal status for an authorized order instead of raising P0002 on
-- every pending poll. Missing/unauthorized orders remain indistinguishable.
create or replace function public.get_walkin_order_acknowledgment(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_role text;
  v_customer uuid;
  v_payment_id bigint;
  v_status text;
  v_result jsonb;
begin
  select p.role into v_role
    from public.profiles p
    where p.id = v_actor and p.role in ('customer','staff','admin') and p.status = 'active';
  if v_role is null then
    raise exception 'Active account access is required' using errcode = '42501';
  end if;

  select o.customer_id, o.payment_id, o.status
    into v_customer, v_payment_id, v_status
    from internal.staff_walkin_orders o where o.id = p_order_id;
  if not found or not (coalesce(v_customer = v_actor, false) or v_role in ('staff','admin')) then
    raise exception 'Receipt not found' using errcode = 'P0002';
  end if;

  if v_status <> 'paid' then
    return jsonb_build_object('payment_status', v_status);
  end if;
  if v_payment_id is null then
    raise exception 'Receipt not found' using errcode = 'P0002';
  end if;
  if not exists(select 1 from internal.payment_acknowledgments a where a.payment_id = v_payment_id) then
    perform internal.persist_payment_acknowledgment(v_payment_id, 'walkin_order', null, p_order_id);
  end if;
  select a.payload into v_result from internal.payment_acknowledgments a where a.payment_id = v_payment_id;
  return v_result;
end;
$$;
revoke all on function public.get_walkin_order_acknowledgment(uuid) from public, anon;
grant execute on function public.get_walkin_order_acknowledgment(uuid) to authenticated;
