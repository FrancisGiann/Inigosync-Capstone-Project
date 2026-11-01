-- PayMongo balance settlement confirms money only for customer bookings.
-- The staff return flow owns attendance confirmation after the payment.
-- Keep late/no-show handling in record_paymongo_paid unchanged, and keep
-- automatic on-slot Time-In for paid walk-in orders.

create or replace function internal.keep_paymongo_balance_settlement_unchecked()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.jwt()->>'role')='service_role'
      and old.checked_in_at is null
      and new.checked_in_at is not null
      and new.balance_payment_id is distinct from old.balance_payment_id
      and new.balance_payment_id is not null
      and new.balance_payment_method='PayMongo'
      and new.amount_total is not null and new.amount_paid>=new.amount_total then
    new.checked_in_at:=old.checked_in_at;
  end if;
  return new;
end;
$$;
revoke all on function internal.keep_paymongo_balance_settlement_unchecked()
  from public,anon,authenticated,service_role;
drop trigger if exists zzzz_booking_keep_paymongo_balance_settlement_unchecked on public.booking;
create trigger zzzz_booking_keep_paymongo_balance_settlement_unchecked
  before update on public.booking
  for each row execute function internal.keep_paymongo_balance_settlement_unchecked();

create or replace function internal.mark_paymongo_balance_audit_payment_only()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.jwt()->>'role')='service_role'
      and new.action='collected_online_balance'
      and new.entity_type='booking'
      and new.details->>'time_in_recorded'='true'
      and exists (
        select 1 from public.booking b
        where b.booking_id::text=new.entity_id
          and b.balance_payment_id::text=(new.details->>'payment_id')
          and b.checked_in_at is null
      ) then
    new.details:=new.details||jsonb_build_object('time_in_recorded',false);
  end if;
  return new;
end;
$$;
revoke all on function internal.mark_paymongo_balance_audit_payment_only()
  from public,anon,authenticated,service_role;
drop trigger if exists zzzz_audit_paymongo_balance_payment_only on public.audit_log;
create trigger zzzz_audit_paymongo_balance_payment_only
  before insert on public.audit_log
  for each row execute function internal.mark_paymongo_balance_audit_payment_only();

-- Keep the existing walk-in protections, while allowing an active admin who
-- owns an authenticated staff walk-in order to receive the same trusted
-- automatic on-slot Time-In as an active staff owner.
create or replace function internal.auto_time_in_paid_staff_walkin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.walkin_order_id is not null
      and new.checked_in_at is not null
      and (tg_op='INSERT' or old.checked_in_at is distinct from new.checked_in_at)
      and (select auth.jwt()->>'role') is distinct from 'service_role'
      and not (
        coalesce(current_setting('inigosync.auto_walkin_start',true),'')='on'
        and (select auth.uid()) is null
        and new.status='confirmed'
        and new.time_date<=now() and new.end_at>now()
        and exists (
          select 1 from internal.staff_walkin_orders o
          where o.id=new.walkin_order_id and o.status='paid'
            and o.payment_id=new.payment_id
        )
      )
      and not (
        coalesce(current_setting('inigosync.staff_walkin_rpc',true),'')='on'
        and new.status='confirmed'
        and new.amount_total is not null
        and new.amount_paid>=new.amount_total
        and new.payment_id is not null
        and new.payment_method in ('Cash','PayMongo')
        and new.time_date<=now() and new.end_at>now()
        and exists (
          select 1 from internal.staff_walkin_orders o
          join public.profiles p on p.id=o.staff_id
          where o.id=new.walkin_order_id and o.status='paid'
            and o.staff_id=(select auth.uid())
            and p.role in ('staff','admin') and p.status='active'
        )
      ) then
    raise exception 'Order-backed walk-in attendance requires trusted scheduled settlement'
      using errcode='42501';
  end if;

  if new.walkin_order_id is not null and new.checked_in_at is null
      and new.status='confirmed'
      and (tg_op='INSERT' or (tg_op='UPDATE' and old.status='pending'))
      and new.amount_total is not null and new.amount_paid>=new.amount_total
      and new.payment_id is not null
      and new.payment_method in ('Cash','PayMongo')
      and new.time_date<=now() and new.end_at>now()
      and exists (
        select 1 from internal.staff_walkin_orders o
        where o.id=new.walkin_order_id and o.status='paid'
          and o.payment_id=new.payment_id
          and (
            (select auth.jwt()->>'role')='service_role'
            or (
              coalesce(current_setting('inigosync.staff_walkin_rpc',true),'')='on'
              and o.staff_id=(select auth.uid())
              and exists (
                select 1 from public.profiles p where p.id=o.staff_id
                  and p.role in ('staff','admin') and p.status='active'
              )
            )
          )
      ) then
    new.checked_in_at:=now();
  end if;
  return new;
end;
$$;
revoke all on function internal.auto_time_in_paid_staff_walkin()
  from public,anon,authenticated;
drop trigger if exists zzzzzz_walkin_auto_time_in_paid_order on public.walk_in_booking;
create trigger zzzzzz_walkin_auto_time_in_paid_order
  before insert or update on public.walk_in_booking
  for each row execute function internal.auto_time_in_paid_staff_walkin();

create or replace function internal.audit_auto_time_in_paid_staff_walkin()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_owner_id uuid;
  v_owner_role text;
begin
  if new.walkin_order_id is null
      or new.checked_in_at is null
      or (tg_op='UPDATE' and (old.checked_in_at is not null or old.status<>'pending'))
      or new.payment_id is null then
    return new;
  end if;

  select o.staff_id into v_owner_id
  from internal.staff_walkin_orders o
  where o.id=new.walkin_order_id and o.status='paid'
    and (
      (select auth.jwt()->>'role')='service_role'
      or (
        coalesce(current_setting('inigosync.staff_walkin_rpc',true),'')='on'
        and o.staff_id=(select auth.uid())
        and exists (
          select 1 from public.profiles p where p.id=o.staff_id
            and p.role in ('staff','admin') and p.status='active'
        )
      )
    );
  if v_owner_id is null then return new; end if;

  select p.role into v_owner_role from public.profiles p where p.id=v_owner_id;
  insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
  values (
    v_owner_id,coalesce(v_owner_role,'staff'),'timed_in','walkin',new.walkin_id::text,
    jsonb_build_object(
      'payment_id',new.payment_id,
      'cash_collected',case when new.payment_method='Cash' then new.amount_total else 0 end,
      'checked_in_at',new.checked_in_at,'automatic_time_in',true,
      'scheduled_end_at',new.end_at
    )
  );
  return new;
end;
$$;
revoke all on function internal.audit_auto_time_in_paid_staff_walkin()
  from public,anon,authenticated;
drop trigger if exists zzzzzzzz_walkin_audit_auto_time_in_paid_order on public.walk_in_booking;
create trigger zzzzzzzz_walkin_audit_auto_time_in_paid_order
  after insert or update on public.walk_in_booking
  for each row execute function internal.audit_auto_time_in_paid_staff_walkin();

-- The scheduled job also attributes automatic attendance to the actual order
-- owner role, including active admins, without changing its time-window rules.
create or replace function internal.auto_time_in_due_paid_walkins()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer:=0;
begin
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  perform set_config('inigosync.auto_walkin_start','on',true);
  with changed as (
    update public.walk_in_booking w set checked_in_at=now()
    from internal.staff_walkin_orders o
    where o.id=w.walkin_order_id and o.status='paid'
      and w.status='confirmed'
      and w.checked_in_at is null and w.checked_out_at is null
      and w.time_date<=now() and w.end_at>now()
      and w.amount_total is not null and w.amount_paid>=w.amount_total
      and w.payment_id is not null and w.payment_id=o.payment_id
    returning w.walkin_id,w.walkin_order_id,w.payment_id,w.checked_in_at,
      w.end_at,o.staff_id
  )
  insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
    select c.staff_id,coalesce(p.role,'staff'),'timed_in','walkin',c.walkin_id::text,
      jsonb_build_object('payment_id',c.payment_id,'cash_collected',0,
        'checked_in_at',c.checked_in_at,'automatic_time_in',true,
        'scheduled_end_at',c.end_at,'walkin_order_id',c.walkin_order_id)
    from changed c left join public.profiles p on p.id=c.staff_id;
  get diagnostics v_count=row_count;
  perform set_config('inigosync.auto_walkin_start','off',true);

  with elapsed as (
    update public.walk_in_booking w set status='completed'
    from internal.staff_walkin_orders o
    where o.id=w.walkin_order_id and o.status='paid'
      and w.status='confirmed' and w.checked_in_at is null
      and w.end_at<=now()
    returning w.walkin_id,w.walkin_order_id,w.end_at
  )
  insert into public.audit_log(actor_role,action,entity_type,entity_id,details)
    select 'system','walkin_slot_elapsed_without_time_in','walkin',e.walkin_id::text,
      jsonb_build_object('walkin_order_id',e.walkin_order_id,'scheduled_end_at',e.end_at)
    from elapsed e;
  return v_count;
end;
$$;
revoke all on function internal.auto_time_in_due_paid_walkins()
  from public,anon,authenticated;
