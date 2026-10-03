-- Serialize reservations by court, then check both online and walk-in rows.
-- The existing booking_no_overlap exclusion constraint remains in place.
create or replace function internal.prevent_reservation_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  court_key text;
  unit_key text;
  finish_at timestamptz;
  proposed tstzrange;
  conflict_found boolean;
  own_id bigint;
begin
  if new.status not in ('pending', 'confirmed') then
    return new;
  end if;

  court_key := pg_catalog.lower(pg_catalog.btrim(new.courts));
  unit_key := pg_catalog.nullif(pg_catalog.lower(pg_catalog.btrim(new.court_unit)), '');
  finish_at := coalesce(new.end_at, new.time_date + pg_catalog.make_interval(mins => coalesce(new.duration_minutes, 60)));
  if court_key is null or court_key = '' or new.time_date is null or finish_at <= new.time_date then
    raise exception 'A valid court and time range are required' using errcode = '22023';
  end if;

  proposed := pg_catalog.tstzrange(new.time_date, finish_at, '[)');
  if tg_table_name = 'booking' then
    own_id := new.booking_id;
  else
    own_id := new.walkin_id;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(court_key, 0));

  select exists (
    select 1 from public.booking b
    where b.status in ('pending', 'confirmed')
      and pg_catalog.lower(pg_catalog.btrim(b.courts)) = court_key
      and (unit_key is null or pg_catalog.nullif(pg_catalog.lower(pg_catalog.btrim(b.court_unit)), '') is null
           or pg_catalog.nullif(pg_catalog.lower(pg_catalog.btrim(b.court_unit)), '') = unit_key)
      and pg_catalog.tstzrange(b.time_date, b.end_at, '[)') && proposed
      and (tg_table_name <> 'booking' or b.booking_id <> own_id)
    union all
    select 1 from public.walk_in_booking w
    where w.status in ('pending', 'confirmed')
      and pg_catalog.lower(pg_catalog.btrim(w.courts)) = court_key
      and (unit_key is null or pg_catalog.nullif(pg_catalog.lower(pg_catalog.btrim(w.court_unit)), '') is null
           or pg_catalog.nullif(pg_catalog.lower(pg_catalog.btrim(w.court_unit)), '') = unit_key)
      and pg_catalog.tstzrange(w.time_date, coalesce(w.end_at, w.time_date + pg_catalog.make_interval(mins => coalesce(w.duration_minutes, 60))), '[)') && proposed
      and (tg_table_name <> 'walk_in_booking' or w.walkin_id <> own_id)
    limit 1
  ) into conflict_found;

  if conflict_found then
    raise exception 'This court is already reserved during the selected time'
      using errcode = '23P01';
  end if;
  return new;
end;
$$;

revoke all on function internal.prevent_reservation_overlap() from public, anon, authenticated;

drop trigger if exists booking_prevent_cross_channel_overlap on public.booking;
create trigger booking_prevent_cross_channel_overlap
before insert or update of courts, court_unit, time_date, end_at, duration_minutes, status
on public.booking for each row execute function internal.prevent_reservation_overlap();

drop trigger if exists walkin_prevent_cross_channel_overlap on public.walk_in_booking;
create trigger walkin_prevent_cross_channel_overlap
before insert or update of courts, court_unit, time_date, end_at, duration_minutes, status
on public.walk_in_booking for each row execute function internal.prevent_reservation_overlap();
