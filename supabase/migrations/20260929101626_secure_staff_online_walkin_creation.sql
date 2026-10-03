-- Browser staff may collect cash directly, but an online order must pass
-- through the authenticated Edge checkout path before any slot is held.
create or replace function internal.guard_online_walkin_service()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.walkin_order_id is not null
      and exists(select 1 from internal.staff_walkin_orders o
        where o.id=new.walkin_order_id and o.status='awaiting_payment')
      and (select auth.role()) is distinct from 'service_role' then
    raise exception 'Create online walk-ins through the verified checkout service' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_online_walkin_service() from public,anon,authenticated;
drop trigger if exists zzzzz_walkin_online_service_guard on public.walk_in_booking;
create trigger zzzzz_walkin_online_service_guard before insert on public.walk_in_booking
  for each row execute function internal.guard_online_walkin_service();

create or replace function public.staff_create_walkin_order_service(
  p_staff_id uuid,p_customer_id uuid,p_guest_name text,p_guest_mobile text,
  p_items jsonb,p_payment_method text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_prior_sub text:=current_setting('request.jwt.claim.sub',true); v_result jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' or p_staff_id is null then
    raise exception 'Service access is required' using errcode='42501';
  end if;
  perform set_config('request.jwt.claim.sub',p_staff_id::text,true);
  v_result:=public.staff_create_walkin_order(
    p_customer_id,p_guest_name,p_guest_mobile,p_items,p_payment_method);
  perform set_config('request.jwt.claim.sub',coalesce(v_prior_sub,''),true);
  return v_result;
end;
$$;
revoke all on function public.staff_create_walkin_order_service(uuid,uuid,text,text,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.staff_create_walkin_order_service(uuid,uuid,text,text,jsonb,text)
  to service_role;
