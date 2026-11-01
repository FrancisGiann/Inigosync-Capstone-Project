-- Paid walk-ins are reserved at payment and arrive automatically at their
-- scheduled start, not at payment time. Existing attendance is preserved.
-- Online bookings may be checked in by staff from 30 minutes before start.
-- Keep the established payment RPC bodies behind narrow, server-side guards.

alter function public.staff_collect_cash_and_check_in(text,bigint) set schema internal;
revoke all on function internal.staff_collect_cash_and_check_in(text,bigint)
  from public,anon,authenticated,service_role;

create function public.staff_collect_cash_and_check_in(p_source text,p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_start timestamptz;
begin
  if v_actor is null or not exists (
    select 1 from public.profiles p where p.id=v_actor
      and p.role in ('staff','admin') and p.status='active'
  ) then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  if p_source <> 'booking' or p_source is null then
    raise exception 'Walk-ins time in automatically when their slot starts'
      using errcode='55000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  select b.time_date into v_start from public.booking b
    where b.booking_id=p_id and b.status='confirmed'
      and b.checked_in_at is null for update;
  if v_start is not null and now()<v_start-interval '30 minutes' then
    raise exception 'Time-In opens 30 minutes before the scheduled start'
      using errcode='55000';
  end if;
  return internal.staff_collect_cash_and_check_in(p_source,p_id);
end;
$$;
revoke all on function public.staff_collect_cash_and_check_in(text,bigint)
  from public,anon,authenticated;
grant execute on function public.staff_collect_cash_and_check_in(text,bigint)
  to authenticated;

alter function public.prepare_paymongo_balance_checkout(text,bigint,uuid)
  set schema internal;
revoke all on function internal.prepare_paymongo_balance_checkout(text,bigint,uuid)
  from public,anon,authenticated,service_role;

create function public.prepare_paymongo_balance_checkout(
  p_source text,p_id bigint,p_staff_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_start timestamptz;
begin
  if p_source <> 'booking' or p_source is null then
    raise exception 'Walk-in payment is handled by its order checkout'
      using errcode='55000';
  end if;
  if p_staff_id is null or not exists (
    select 1 from public.profiles p where p.id=p_staff_id
      and p.role in ('staff','admin') and p.status='active'
  ) then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  select b.time_date into v_start from public.booking b
    where b.booking_id=p_id and b.status='confirmed'
      and b.checked_in_at is null for update;
  if v_start is not null and now()<v_start-interval '30 minutes' then
    raise exception 'Time-In opens 30 minutes before the scheduled start'
      using errcode='55000';
  end if;
  return internal.prepare_paymongo_balance_checkout(p_source,p_id,p_staff_id);
end;
$$;
revoke all on function public.prepare_paymongo_balance_checkout(text,bigint,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.prepare_paymongo_balance_checkout(text,bigint,uuid)
  to service_role;

alter function public.staff_record_time_out(text,bigint) set schema internal;
revoke all on function internal.staff_record_time_out(text,bigint)
  from public,anon,authenticated,service_role;

create function public.staff_record_time_out(p_source text,p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_start timestamptz;
begin
  if v_actor is null or not exists (
    select 1 from public.profiles p where p.id=v_actor
      and p.role in ('staff','admin') and p.status='active'
  ) then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  if p_source not in ('booking','walkin') or p_source is null then
    raise exception 'Invalid reservation source' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  if p_source='booking' then
    select b.time_date into v_start from public.booking b
      where b.booking_id=p_id for update;
  else
    select w.time_date into v_start from public.walk_in_booking w
      where w.walkin_id=p_id for update;
  end if;
  if v_start is not null and now()<v_start then
    raise exception 'Time-Out is available only after the scheduled start'
      using errcode='55000';
  end if;
  return internal.staff_record_time_out(p_source,p_id);
end;
$$;
revoke all on function public.staff_record_time_out(text,bigint)
  from public,anon,authenticated;
grant execute on function public.staff_record_time_out(text,bigint)
  to authenticated;

-- Preserve the direct timestamp-write authorization gate. Only the trusted
-- paid-order settlement may time in immediately, and only during its slot.
-- The attendance job gets a separate transaction-local marker.
create or replace function internal.auto_time_in_paid_staff_walkin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.walkin_order_id is not null
      and new.checked_in_at is not null
      and (tg_op='INSERT' or old.checked_in_at is distinct from new.checked_in_at)
      and (select auth.role()) is distinct from 'service_role'
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
            and p.role='staff' and p.status='active'
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
            (select auth.role())='service_role'
            or (
              coalesce(current_setting('inigosync.staff_walkin_rpc',true),'')='on'
              and o.staff_id=(select auth.uid())
              and exists (
                select 1 from public.profiles p where p.id=o.staff_id
                  and p.role='staff' and p.status='active'
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

-- The existing AFTER trigger audits immediate on-slot settlement. This job
-- emits the corresponding audit event for previously paid future visits.
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
    select c.staff_id,'staff','timed_in','walkin',c.walkin_id::text,
      jsonb_build_object('payment_id',c.payment_id,'cash_collected',0,
        'checked_in_at',c.checked_in_at,'automatic_time_in',true,
        'scheduled_end_at',c.end_at,'walkin_order_id',c.walkin_order_id)
    from changed c;
  get diagnostics v_count=row_count;
  perform set_config('inigosync.auto_walkin_start','off',true);

  -- A missed attendance-job window does not fabricate play or classify a
  -- paid walk-in as Unattended. Close only the elapsed reservation state.
  with elapsed as (
    update public.walk_in_booking w set status='completed'
    from internal.staff_walkin_orders o
    where o.id=w.walkin_order_id and o.status='paid'
      and w.status='confirmed' and w.checked_in_at is null
      and w.end_at<=now()
    returning w.walkin_id,w.walkin_order_id,w.end_at
  )
  insert into public.audit_log(actor_role,action,entity_type,entity_id,details)
    select 'system','walkin_slot_elapsed_without_time_in','walkin',
      e.walkin_id::text,
      jsonb_build_object('walkin_order_id',e.walkin_order_id,
        'scheduled_end_at',e.end_at)
    from elapsed e;
  return v_count;
end;
$$;
revoke all on function internal.auto_time_in_due_paid_walkins()
  from public,anon,authenticated;

create or replace function public.process_due_attendance()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_unattended integer; v_timed_in integer; v_timed_out integer;
begin
  v_timed_in:=internal.auto_time_in_due_paid_walkins();
  v_timed_out:=internal.auto_time_out_reservations();
  v_unattended:=internal.cancel_no_show_bookings();
  return jsonb_build_object('timed_in',v_timed_in,'timed_out',v_timed_out,
    'unattended',v_unattended,'processed_at',now());
end;
$$;
revoke all on function public.process_due_attendance()
  from public,anon,authenticated;
grant execute on function public.process_due_attendance() to service_role;
