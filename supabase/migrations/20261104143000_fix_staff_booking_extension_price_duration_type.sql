-- The authoritative pricing helper accepts duration minutes as an integer.
-- Preserve that contract when calculating a longer staff extension option.
create or replace function public.staff_booking_extension_options(
  p_source text,
  p_id bigint,
  p_staff_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_actor uuid := coalesce((select auth.uid()), p_staff_id);
  v_rule record;
  v_max_end timestamptz;
  v_minutes integer;
  v_max_minutes integer;
  v_amount numeric;
  v_base numeric;
  v_options jsonb := '[]'::jsonb;
  v_blocked boolean;
begin
  if v_actor is null or ((select auth.uid()) is null and (select auth.jwt()->>'role') is distinct from 'service_role')
    or not exists (select 1 from public.profiles p where p.id = v_actor
      and p.role = 'staff' and p.status = 'active') then
    raise exception 'Active staff access is required' using errcode = '42501';
  end if;
  if p_source not in ('booking', 'walkin') or p_id is null or p_id <= 0 then
    raise exception 'Invalid reservation' using errcode = '22023';
  end if;

  select * into r from internal.staff_extension_row(p_source, p_id);
  if not found or r.status <> 'confirmed' or r.checked_in_at is null or r.checked_out_at is not null
    or r.ends_at is null or r.ends_at <= now() or r.unit_id is null or r.rate_unit <> '/hr'
    or internal.authoritative_reservation_rate_unit(r.listing_id, r.unit_id) <> '/hr'
    or extract(minute from r.ends_at) <> 0 or extract(second from r.ends_at) <> 0 then
    return jsonb_build_object('options', '[]'::jsonb);
  end if;

  select * into v_rule
  from internal.booking_rule_for_date((r.ends_at at time zone 'Asia/Manila')::date);
  if not found or v_rule.is_closed then
    return jsonb_build_object('options', '[]'::jsonb);
  end if;
  v_max_end := ((r.ends_at at time zone 'Asia/Manila')::date + v_rule.closes_at) at time zone 'Asia/Manila';
  if v_rule.closes_at <= v_rule.opens_at then
    v_max_end := v_max_end + interval '1 day';
  end if;
  v_max_minutes := greatest(0, floor(extract(epoch from (v_max_end - r.ends_at)) / 3600)::integer * 60);

  v_base := internal.authoritative_reservation_amount(r.listing_id, r.unit_id, r.starts_at, r.ends_at,
    extract(epoch from (r.ends_at - r.starts_at))::integer / 60, 1);
  if v_base is null or v_base <= 0 then
    return jsonb_build_object('options', '[]'::jsonb);
  end if;

  if v_max_minutes >= 60 then
    for v_minutes in 60..v_max_minutes by 60 loop
      select exists (
        select 1
        from internal.reservation_resource_slots s
        join public.court_unit_resource_map m on m.resource_id = s.resource_id
        where m.court_unit_id = r.unit_id
          and s.during && pg_catalog.tstzrange(r.ends_at, r.ends_at + make_interval(mins => v_minutes), '[)')
          and not (p_source = 'booking' and s.booking_id = p_id)
          and not (p_source = 'walkin' and s.walkin_id = p_id)
      ) into v_blocked;
      exit when v_blocked;

      v_amount := internal.authoritative_reservation_amount(r.listing_id, r.unit_id, r.starts_at,
        r.ends_at + make_interval(mins => v_minutes),
        (extract(epoch from (r.ends_at - r.starts_at))::integer / 60) + v_minutes, 1) - v_base;
      if v_amount is null or v_amount <= 0 then
        exit;
      end if;
      v_options := v_options || jsonb_build_array(jsonb_build_object(
        'duration_minutes', v_minutes,
        'amount_minor', round(v_amount * 100)::bigint,
        'new_end_at', r.ends_at + make_interval(mins => v_minutes)
      ));
    end loop;
  end if;
  return jsonb_build_object('options', v_options);
end;
$$;

revoke all on function public.staff_booking_extension_options(text, bigint, uuid) from public, anon;
grant execute on function public.staff_booking_extension_options(text, bigint, uuid) to authenticated, service_role;
