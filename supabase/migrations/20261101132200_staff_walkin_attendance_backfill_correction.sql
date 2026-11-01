-- The historical paid-walk-in conversion used an old system no-show status
-- as attendance evidence. Restore those elapsed terminal rows to their
-- previous unattended state; retain only paid, acknowledged staff walk-ins
-- that remain confirmed and inside their scheduled window.
with candidates as materialized (
  select w.walkin_id,w.end_at,w.checked_in_at,a.id as auto_time_in_audit_id
  from public.walk_in_booking w
  join internal.staff_walkin_orders o on o.id=w.walkin_order_id and o.status='paid'
  join public.payment p on p.payment_id=o.payment_id
  join internal.payment_acknowledgments ack on ack.payment_id=p.payment_id
  join public.audit_log a on a.entity_type='walkin'
    and a.entity_id=w.walkin_id::text
    and a.action='timed_in'
    and a.details->>'automatic_time_in'='true'
    and a.details->>'payment_id'=p.payment_id::text
  where w.status='completed'
    and w.checked_in_at=p.created_at
    and w.checked_out_at=w.end_at
    and w.end_at<=now()
    and w.payment_id=o.payment_id
    and w.payment_method in ('Cash','PayMongo')
    and w.amount_total is not null and w.amount_total>0
    and w.amount_paid>=w.amount_total
    and p.paid>=p.cost and p.paid>0
    and exists (
      select 1 from public.audit_log created
      where created.entity_type='walkin'
        and created.entity_id=w.walkin_id::text
        and created.action='recorded_walk_in'
        and created.actor_id=o.staff_id
    )
    and exists (
      select 1 from public.audit_log no_show
      where no_show.entity_type='walkin'
        and no_show.entity_id=w.walkin_id::text
        and no_show.action='marked_unattended'
        and no_show.actor_id is null
    )
), reverted as (
  update public.walk_in_booking w
  set status='unattended',checked_in_at=null,checked_out_at=null
  from candidates c
  where w.walkin_id=c.walkin_id
  returning w.walkin_id,c.end_at,c.checked_in_at,c.auto_time_in_audit_id
)
insert into public.audit_log(actor_role,action,entity_type,entity_id,details)
select 'system','auto_time_in_backfill_reverted','walkin',walkin_id::text,
  jsonb_build_object(
    'reason','The source system no-show event is not reliable arrival evidence for an elapsed historical visit.',
    'reverted_time_in_audit_id',auto_time_in_audit_id,
    'previous_checked_in_at',checked_in_at,
    'scheduled_end_at',end_at
  )
from reverted;

-- Only a new reservation or verified settlement of a pending reservation may
-- produce an automatic time-in. In particular, a service-role update cannot
-- turn an old unattended/terminal row into a new arrival.
create or replace function internal.auto_time_in_paid_staff_walkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
      (select auth.role()) = 'service_role'
      or (
        coalesce(current_setting('inigosync.staff_walkin_rpc', true), '') = 'on'
        and exists (
          select 1 from internal.staff_walkin_orders owner_order
          join public.profiles owner_profile on owner_profile.id = owner_order.staff_id
          where owner_order.id = new.walkin_order_id
            and owner_order.staff_id = (select auth.uid())
            and owner_profile.role = 'staff'
            and owner_profile.status = 'active'
        )
      )
    )
      and (tg_op='INSERT' or (tg_op='UPDATE' and old.status='pending'))
      and new.walkin_order_id is not null
      and new.checked_in_at is null
      and new.status = 'confirmed'
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
  if not (
      (select auth.role()) = 'service_role'
      or (
        coalesce(current_setting('inigosync.staff_walkin_rpc', true), '') = 'on'
        and exists (
          select 1 from internal.staff_walkin_orders owner_order
          join public.profiles owner_profile on owner_profile.id = owner_order.staff_id
          where owner_order.id = new.walkin_order_id
            and owner_order.staff_id = (select auth.uid())
            and owner_profile.role = 'staff'
            and owner_profile.status = 'active'
        )
      )
    )
      or (tg_op='UPDATE' and old.status<>'pending')
      or new.walkin_order_id is null
      or new.checked_in_at is null
      or (tg_op='UPDATE' and old.checked_in_at is not null)
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
