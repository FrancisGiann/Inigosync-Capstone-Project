-- Fully paid staff walk-ins are timed in under the current business rule.
-- Restore only receipt-backed historical rows whose payment predates checkout.
with restored as (
  update public.walk_in_booking w
  set checked_in_at = p.created_at,
      checked_out_at = w.end_at,
      status = 'completed'
  from internal.staff_walkin_orders o
  join public.payment p on p.payment_id = o.payment_id
  join internal.payment_acknowledgments ack on ack.payment_id = p.payment_id
  where o.id = w.walkin_order_id
    and o.status = 'paid'
    and w.status = 'unattended'
    and w.checked_in_at is null
    and w.checked_out_at is null
    and w.payment_id = o.payment_id
    and w.payment_method in ('Cash', 'PayMongo')
    and w.amount_total is not null and w.amount_total > 0
    and w.amount_paid >= w.amount_total
    and p.paid >= p.cost and p.paid > 0
    and p.created_at <= w.end_at
    and w.end_at <= now()
    and exists (
      select 1 from public.audit_log a
      where a.entity_type = 'walkin' and a.entity_id = w.walkin_id::text
        and a.action = 'recorded_walk_in' and a.actor_id = o.staff_id
    )
    and exists (
      select 1 from public.audit_log a
      where a.entity_type = 'walkin' and a.entity_id = w.walkin_id::text
        and a.action = 'marked_unattended' and a.actor_id is null
    )
  returning w.walkin_id, w.payment_id, w.checked_in_at, w.checked_out_at
)
insert into public.audit_log(actor_role, action, entity_type, entity_id, details)
select 'system', 'auto_time_in_backfill_restored', 'walkin', walkin_id::text,
  jsonb_build_object('payment_id', payment_id, 'checked_in_at', checked_in_at,
    'checked_out_at', checked_out_at,
    'reason', 'Paid staff walk-ins are time-ins under the current attendance rule.')
from restored;

do $$
begin
  if exists (select 1 from public.walk_in_booking where status = 'unattended') then
    raise exception 'Cannot enforce walk-in unattended status invariant: unresolved rows remain';
  end if;
  if exists (
    select 1 from public.walk_in_booking
    where checked_in_at is not null
      and checked_out_at is not null
      and checked_out_at < checked_in_at
  ) then
    raise exception 'Cannot enforce walk-in attendance timestamps: checkout precedes time-in';
  end if;
end;
$$;

alter table public.walk_in_booking
  drop constraint if exists walk_in_booking_status_check;

alter table public.walk_in_booking
  add constraint walk_in_booking_status_check
  check (status = any (array['pending', 'confirmed', 'cancelled', 'completed']::text[]));

-- Keep the trusted staff/service-role time-in gate as the final trigger definition.

-- Reapply the authorization gate after 20261101110000: that migration's
-- original trigger functions allow any matching confirmed row to synthesize
-- a time-in. Fresh migration replay must finish with the trusted-path guard.
create or replace function internal.auto_time_in_paid_staff_walkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
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
