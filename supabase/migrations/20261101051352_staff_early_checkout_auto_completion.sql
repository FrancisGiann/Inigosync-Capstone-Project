-- Early staff Time-Outs remain in the reservation's scheduled slot until
-- end_at, then become completed without receiving a duplicate system timeout
-- audit event. Only rows without an existing checkout create auto-timeout
-- records and contribute to the returned count.
create or replace function internal.auto_time_out_reservations()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer:=0; v_changed integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);

  with changed as (
    update public.booking b set checked_out_at=b.end_at,status='completed'
      where b.status='confirmed' and b.checked_in_at is not null
        and b.checked_out_at is null and b.end_at<=now()
      returning b.booking_id,b.customer_id,b.checked_out_at,b.end_at
  ) insert into public.audit_log(actor_role,action,entity_type,entity_id,details)
    select 'system','auto_timed_out','booking',booking_id::text,
      jsonb_build_object('customer_id',customer_id,'checked_out_at',checked_out_at,'scheduled_end_at',end_at)
    from changed;
  get diagnostics v_changed=row_count; v_count:=v_count+v_changed;

  with changed as (
    update public.walk_in_booking w set checked_out_at=w.end_at,status='completed'
      where w.status='confirmed' and w.checked_in_at is not null
        and w.checked_out_at is null and w.end_at<=now()
      returning w.walkin_id,w.customer_id,w.walkin_order_id,w.checked_out_at,w.end_at
  ) insert into public.audit_log(actor_role,action,entity_type,entity_id,details)
    select 'system','auto_timed_out','walkin',walkin_id::text,
      jsonb_build_object('customer_id',customer_id,'walkin_order_id',walkin_order_id,
        'checked_out_at',checked_out_at,'scheduled_end_at',end_at)
    from changed;
  get diagnostics v_changed=row_count; v_count:=v_count+v_changed;

  -- Staff may have checked out early. Keep the row occupying its slot through
  -- end_at, then close its status without generating a second timeout event.
  update public.booking b set status='completed'
    where b.status='confirmed' and b.checked_in_at is not null
      and b.checked_out_at is not null and b.end_at<=now();
  update public.walk_in_booking w set status='completed'
    where w.status='confirmed' and w.checked_in_at is not null
      and w.checked_out_at is not null and w.end_at<=now();

  return v_count;
end;
$$;
revoke all on function internal.auto_time_out_reservations() from public,anon,authenticated;
