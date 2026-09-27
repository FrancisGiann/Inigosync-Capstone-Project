-- A sport save updates its units, which refreshes the reservation resource slots.
-- The project rejects DELETE statements without a WHERE clause. Every row has
-- exactly one of these four source IDs (reservation_resource_slots_one_source),
-- so this predicate preserves the existing complete refresh behavior.
create or replace function internal.refresh_reservation_resource_slots()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from internal.reservation_resource_slots
   where booking_id is not null or walkin_id is not null
      or maintenance_id is not null or hold_item_id is not null;
  insert into internal.reservation_resource_slots(booking_id,walkin_id,resource_id,during)
  select s.booking_id,null::bigint,m.resource_id,s.during
    from internal.reservation_slots s join public.booking b on b.booking_id=s.booking_id and b.status in ('pending','confirmed')
    join public.court_unit_inventory u on u.court_id=b.court_listing_id and u.is_active and u.inventory_verified
    join public.court_unit_resource_map m on m.court_unit_id=u.id
    join public.physical_court_resource r on r.id=m.resource_id and r.is_active
   where (b.court_unit_inventory_id is not null and u.id=b.court_unit_inventory_id)
      or (b.court_unit_inventory_id is null and (nullif(btrim(b.court_unit),'') is null or lower(btrim(u.label))=lower(btrim(b.court_unit))))
  union all
  select null::bigint,s.walkin_id,m.resource_id,s.during
    from internal.reservation_slots s join public.walk_in_booking w on w.walkin_id=s.walkin_id and w.status in ('pending','confirmed')
    join public.court_unit_inventory u on u.court_id=w.court_listing_id and u.is_active and u.inventory_verified
    join public.court_unit_resource_map m on m.court_unit_id=u.id
    join public.physical_court_resource r on r.id=m.resource_id and r.is_active
   where (w.court_unit_inventory_id is not null and u.id=w.court_unit_inventory_id)
      or (w.court_unit_inventory_id is null and (nullif(btrim(w.court_unit),'') is null or lower(btrim(u.label))=lower(btrim(w.court_unit))));
  insert into internal.reservation_resource_slots(maintenance_id,resource_id,during)
    select x.id,m.resource_id,tstzrange(x.starts_at,x.ends_at,'[)') from public.court_unit_maintenance x
    join public.court_unit_resource_map m on m.court_unit_id=x.court_unit_id
    join public.physical_court_resource r on r.id=m.resource_id and r.is_active;
  insert into internal.reservation_resource_slots(hold_item_id,resource_id,during)
    select x.id,m.resource_id,tstzrange(x.starts_at,x.ends_at,'[)') from internal.checkout_intent_items x
    join internal.checkout_intents i on i.id=x.intent_id and i.status in ('creating','ready','review')
    join public.court_unit_resource_map m on m.court_unit_id=x.unit_id
    join public.physical_court_resource r on r.id=m.resource_id and r.is_active;
  if exists(select 1 from internal.reservation_slots s where
    (s.booking_id is not null and not exists(select 1 from internal.reservation_resource_slots r where r.booking_id=s.booking_id)) or
    (s.walkin_id is not null and not exists(select 1 from internal.reservation_resource_slots r where r.walkin_id=s.walkin_id)))
    or exists(select 1 from public.court_unit_maintenance x where not exists(select 1 from internal.reservation_resource_slots r where r.maintenance_id=x.id))
    or exists(select 1 from internal.checkout_intent_items x join internal.checkout_intents i on i.id=x.intent_id and i.status in ('creating','ready','review')
      where not exists(select 1 from internal.reservation_resource_slots r where r.hold_item_id=x.id)) then
    raise exception 'Every active reservation, maintenance period and payment hold needs a physical resource' using errcode='23503';
  end if;
  return null;
exception when exclusion_violation then
  raise exception 'The resource mapping conflicts with an active reservation, hold or maintenance period' using errcode='23P01';
end;
$$;
revoke all on function internal.refresh_reservation_resource_slots() from public, anon, authenticated;

-- Testimonials have no image_url column. Its stale reference check caused
-- cleanup of newly uploaded photos to fail after an unsuccessful sport save.
create or replace function public.admin_is_media_url_referenced(p_url text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not exists(
    select 1 from public.profiles p
     where p.id=(select auth.uid()) and p.role='admin'
       and coalesce(p.status,'active')<>'disabled'
  ) then
    raise exception 'Active owner access is required' using errcode='42501';
  end if;
  return exists(select 1 from public.court where image_url=p_url)
      or exists(select 1 from public.court_unit_inventory where photo_url=p_url)
      or exists(select 1 from public.court c
        cross join lateral jsonb_array_elements(coalesce(c.unit_images,'[]'::jsonb)) legacy(value)
          where legacy.value->>'image_url'=p_url)
      or exists(select 1 from public.event where image_url=p_url);
end;
$$;
revoke all on function public.admin_is_media_url_referenced(text) from public, anon;
grant execute on function public.admin_is_media_url_referenced(text) to authenticated;
