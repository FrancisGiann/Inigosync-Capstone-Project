-- Archived courts may be removed after a checkout is fully expired. Keep the
-- checkout item and its copied labels/prices/times for audit; only its live
-- inventory foreign keys are detached when the court is physically deleted.
alter table internal.checkout_intent_items
  alter column listing_id drop not null,
  alter column unit_id drop not null;

alter table internal.checkout_intent_items
  drop constraint if exists checkout_intent_items_listing_id_fkey;
alter table internal.checkout_intent_items
  add constraint checkout_intent_items_listing_id_fkey
  foreign key (listing_id) references public.court(id) on delete set null;

-- Keep unit references RESTRICT so a direct inventory delete cannot bypass the
-- status checks below. admin_delete_sport clears unit_id only after verifying
-- that every related intent and attempt has expired.
alter table internal.checkout_intent_items
  drop constraint if exists checkout_intent_items_unit_id_fkey;
alter table internal.checkout_intent_items
  add constraint checkout_intent_items_unit_id_fkey
  foreign key (unit_id) references public.court_unit_inventory(id) on delete restrict;

create or replace function public.admin_delete_sport(p_court_id uuid,p_expected_version integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  sid uuid;
  v_row_id uuid;
begin
  if (select auth.uid()) is null or not exists(
    select 1 from public.profiles p
    where p.id=(select auth.uid()) and p.role='admin' and p.status='active'
  ) then
    raise exception 'Active owner access is required' using errcode='42501';
  end if;

  -- Serialize checkout preparation and sport edits. Lock checkout rows before
  -- the court row, matching record_paymongo_paid's attempt -> intent -> court
  -- order and preventing a late webhook from racing an expired-history delete.
  update internal.reservation_resource_config_lock set version=version+1 where id=true;
  for v_row_id in
    select distinct a.id
    from internal.paymongo_checkout_attempts a
    join internal.checkout_intent_items x on x.intent_id=a.intent_id
    where x.listing_id=p_court_id
    order by a.id
  loop
    perform 1 from internal.paymongo_checkout_attempts a where a.id=v_row_id for update;
  end loop;
  for v_row_id in
    select distinct i.id
    from internal.checkout_intents i
    join internal.checkout_intent_items x on x.intent_id=i.id
    where x.listing_id=p_court_id
    order by i.id
  loop
    perform 1 from internal.checkout_intents i where i.id=v_row_id for update;
  end loop;

  select c.sport_id into sid
  from public.court c
  where c.id=p_court_id and c.editor_version=p_expected_version and not c.is_active
  for update;
  if not found then
    raise exception 'Only an unchanged archived sport can be deleted' using errcode='40001';
  end if;

  if exists(
    select 1 from public.booking b
    where b.court_listing_id=p_court_id and b.status in ('pending','confirmed') and b.end_at>now()
  ) or exists(
    select 1 from public.walk_in_booking w
    where w.court_listing_id=p_court_id and w.status in ('pending','confirmed') and w.end_at>now()
  ) then
    raise exception 'A sport with an active or upcoming reservation cannot be deleted' using errcode='23503';
  end if;

  if exists(
    select 1
    from internal.checkout_intent_items x
    left join internal.checkout_intents i on i.id=x.intent_id
    left join internal.paymongo_checkout_attempts a on a.intent_id=i.id
    where x.listing_id=p_court_id
      and (x.booking_id is not null
        or i.status is distinct from 'expired'
        or a.status is distinct from 'expired')
  ) then
    raise exception 'A sport with an active or unsettled checkout cannot be deleted' using errcode='23503';
  end if;

  if exists(select 1 from public.booking b where b.court_listing_id=p_court_id)
    or exists(select 1 from public.walk_in_booking w where w.court_listing_id=p_court_id)
    or exists(select 1 from public.booking b
      where lower(btrim(b.courts))=(select lower(btrim(name)) from public.court where id=p_court_id))
    or exists(select 1 from public.walk_in_booking w
      where lower(btrim(w.courts))=(select lower(btrim(name)) from public.court where id=p_court_id)) then
    raise exception 'A sport referenced by booking history cannot be deleted' using errcode='23503';
  end if;

  -- Preserve checkout_intents, attempts, item snapshots and provider history.
  -- Expired attempts return `review` without settlement if a late paid webhook
  -- arrives, so detached rows can never be turned into a booking afterwards.
  update internal.checkout_intent_items x
  set unit_id=null
  where x.listing_id=p_court_id;

  delete from public.court where id=p_court_id;
  if sid is not null and not exists(select 1 from public.court where sport_id=sid) then
    delete from public.sport where id=sid;
  end if;
  delete from public.physical_court_resource r
  where not exists(select 1 from public.court_unit_resource_map m where m.resource_id=r.id);
end;
$$;
revoke all on function public.admin_delete_sport(uuid,integer) from public,anon;
grant execute on function public.admin_delete_sport(uuid,integer) to authenticated;
