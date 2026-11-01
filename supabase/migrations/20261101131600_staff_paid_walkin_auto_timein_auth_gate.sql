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
      and (tg_op = 'INSERT' or old.status is distinct from 'confirmed')
      and new.amount_total is not null
      and new.amount_paid >= new.amount_total
      and new.payment_id is not null
      and new.payment_method in ('Cash', 'PayMongo')
      and exists (
        select 1 from internal.staff_walkin_orders o
        where o.id = new.walkin_order_id and o.status = 'paid'
          and (
            (select auth.role()) = 'service_role'
            or (
              coalesce(current_setting('inigosync.staff_walkin_rpc', true), '') = 'on'
              and o.staff_id = (select auth.uid())
              and exists (
                select 1 from public.profiles p
                where p.id = o.staff_id and p.role = 'staff' and p.status = 'active'
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
      or (tg_op = 'UPDATE' and (old.checked_in_at is not null or old.status = 'confirmed'))
      or new.payment_id is null then
    return new;
  end if;

  select o.staff_id into v_staff_id
    from internal.staff_walkin_orders o
    where o.id = new.walkin_order_id and o.status = 'paid'
      and (
        (select auth.role()) = 'service_role'
        or (
          coalesce(current_setting('inigosync.staff_walkin_rpc', true), '') = 'on'
          and o.staff_id = (select auth.uid())
          and exists (
            select 1 from public.profiles p
            where p.id = o.staff_id and p.role = 'staff' and p.status = 'active'
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
