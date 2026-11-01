-- Forward-only replacement for the deployed paid walk-in attendance trigger definitions.
-- This migration is intentionally limited to trigger functions; it does not backfill or clean data.

create or replace function internal.auto_time_in_paid_staff_walkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- RLS permits active staff to update walk-in rows directly. Do not let a
  -- direct UPDATE forge or rewrite attendance on an order-backed walk-in;
  -- only the owning staff RPC or the verified service-role settlement may do so.
  if new.walkin_order_id is not null
      and new.checked_in_at is not null
      and (tg_op = 'INSERT' or old.checked_in_at is distinct from new.checked_in_at)
      and (select auth.role()) is distinct from 'service_role'
      and not (
        coalesce(current_setting('inigosync.staff_walkin_rpc', true), '') = 'on'
        and new.status = 'confirmed'
        and new.amount_total is not null
        and new.amount_paid >= new.amount_total
        and new.payment_id is not null
        and new.payment_method in ('Cash', 'PayMongo')
        and exists (
          select 1
          from internal.staff_walkin_orders owner_order
          join public.profiles owner_profile on owner_profile.id = owner_order.staff_id
          where owner_order.id = new.walkin_order_id
            and owner_order.status = 'paid'
            and owner_order.staff_id = (select auth.uid())
            and owner_profile.role = 'staff'
            and owner_profile.status = 'active'
        )
      ) then
    raise exception 'Order-backed walk-in attendance must be recorded through a trusted settlement path'
      using errcode = '42501';
  end if;

  if new.walkin_order_id is not null
      and new.checked_in_at is null
      and new.status = 'confirmed'
      and (tg_op = 'INSERT' or (tg_op = 'UPDATE' and old.status = 'pending'))
      and new.amount_total is not null
      and new.amount_paid >= new.amount_total
      and new.payment_id is not null
      and new.payment_method in ('Cash', 'PayMongo')
      and exists (
        select 1 from internal.staff_walkin_orders owner_order
        where owner_order.id = new.walkin_order_id and owner_order.status = 'paid'
          and (
            (select auth.role()) = 'service_role'
            or (
              coalesce(current_setting('inigosync.staff_walkin_rpc', true), '') = 'on'
              and owner_order.staff_id = (select auth.uid())
              and exists (
                select 1 from public.profiles owner_profile
                where owner_profile.id = owner_order.staff_id
                  and owner_profile.role = 'staff' and owner_profile.status = 'active'
              )
            )
          )
      ) then
    new.checked_in_at := now();
  end if;
  return new;
end;
$$;

revoke all on function internal.auto_time_in_paid_staff_walkin() from public, anon, authenticated;
drop trigger if exists zzzzzz_walkin_auto_time_in_paid_order on public.walk_in_booking;
create trigger zzzzzz_walkin_auto_time_in_paid_order
  before insert or update on public.walk_in_booking
  for each row execute function internal.auto_time_in_paid_staff_walkin();

create or replace function internal.audit_auto_time_in_paid_staff_walkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff_id uuid;
  v_staff_role text;
begin
  if new.walkin_order_id is null
      or new.checked_in_at is null
      or (tg_op = 'UPDATE' and (old.checked_in_at is not null or old.status <> 'pending'))
      or new.payment_id is null then
    return new;
  end if;

    select owner_order.staff_id into v_staff_id
    from internal.staff_walkin_orders owner_order
    where owner_order.id = new.walkin_order_id and owner_order.status = 'paid'
      and (
        (select auth.role()) = 'service_role'
        or (
          coalesce(current_setting('inigosync.staff_walkin_rpc', true), '') = 'on'
          and owner_order.staff_id = (select auth.uid())
          and exists (
            select 1 from public.profiles owner_profile
            where owner_profile.id = owner_order.staff_id
              and owner_profile.role = 'staff' and owner_profile.status = 'active'
          )
        )
      );
  if v_staff_id is null then return new; end if;

  select p.role into v_staff_role from public.profiles p where p.id = v_staff_id;
  insert into public.audit_log(actor_id, actor_role, action, entity_type, entity_id, details)
  values (
    v_staff_id,
    coalesce(v_staff_role, 'staff'),
    'timed_in',
    'walkin',
    new.walkin_id::text,
    jsonb_build_object(
      'payment_id', new.payment_id,
      'cash_collected', case when new.payment_method = 'Cash' then new.amount_total else 0 end,
      'checked_in_at', new.checked_in_at,
      'automatic_time_in', true,
      'scheduled_end_at', new.end_at
    )
  );
  return new;
end;
$$;

revoke all on function internal.audit_auto_time_in_paid_staff_walkin() from public, anon, authenticated;
drop trigger if exists zzzzzzzz_walkin_audit_auto_time_in_paid_order on public.walk_in_booking;
create trigger zzzzzzzz_walkin_audit_auto_time_in_paid_order
  after insert or update on public.walk_in_booking
  for each row execute function internal.audit_auto_time_in_paid_staff_walkin();
