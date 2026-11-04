-- A trigger's NEW record only exposes the columns of its own table. Keep the
-- booking and walk-in identifiers in separate PL/pgSQL branches so a walk-in
-- update never resolves NEW.booking_id.
create or replace function internal.guard_open_booking_extension()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_source text; v_id bigint;
begin
  if coalesce(current_setting('inigosync.staff_extension_rpc',true),'')='on' then return new; end if;
  if new.end_at is not distinct from old.end_at and new.checked_out_at is not distinct from old.checked_out_at then return new; end if;

  if tg_table_name='booking' then
    v_source:='booking';
    v_id:=new.booking_id;
  elsif tg_table_name='walk_in_booking' then
    v_source:='walkin';
    v_id:=new.walkin_id;
  else
    raise exception 'Unsupported reservation table for extension guard' using errcode='22023';
  end if;

  if exists(select 1 from internal.staff_booking_extension_checkouts x
    join internal.paymongo_checkout_attempts a on a.intent_id=x.intent_id
    where x.source=v_source and x.reservation_id=v_id and x.status in ('creating','ready')
      and a.status in ('creating','ready','review')) then
    raise exception 'An online extension is open; finish or expire that checkout before changing this reservation' using errcode='55000';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_open_booking_extension() from public,anon,authenticated,service_role;
