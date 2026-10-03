-- Owner portal editor, scheduled court maintenance, guarded lifecycle and summaries.
-- Privileged writes explicitly check the active owner profile; live reservation
-- writes continue to use the shared physical-resource exclusion ledger.

alter table public.court add column if not exists editor_version integer not null default 1;
alter table public.court_unit_inventory add column if not exists photo_url text;
alter table public.profiles add column if not exists birthdate date;

-- A one-time, internal-only pre-cleanup snapshot is populated by the guarded
-- test-data cleanup transaction. It has no API grants and contains no accounts.
create table if not exists internal.owner_reservation_cleanup_snapshot (
    snapshot_id uuid not null,
    table_name text not null,
    row_key text not null,
    row_data jsonb not null,
    captured_at timestamptz not null default now(),
    primary key(snapshot_id,table_name,row_key)
);
revoke all on internal.owner_reservation_cleanup_snapshot from public,anon,authenticated;

-- Migrate legacy positional image arrays by stable label, not by order.
update public.court_unit_inventory u
set photo_url = nullif(btrim(item.value ->> 'image_url'), '')
from public.court c
cross join lateral jsonb_array_elements(coalesce(c.unit_images, '[]'::jsonb)) item(value)
where u.court_id=c.id and lower(btrim(u.label))=lower(btrim(coalesce(item.value->>'label','')))
  and nullif(btrim(item.value->>'image_url'),'') is not null and u.photo_url is null;

create table if not exists public.court_unit_maintenance (
    id uuid primary key default gen_random_uuid(),
    court_unit_id uuid not null references public.court_unit_inventory(id) on delete cascade,
    starts_at timestamptz not null,
    ends_at timestamptz not null,
    note text,
    created_by uuid references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(),
    constraint court_unit_maintenance_valid_period check(isfinite(starts_at) and isfinite(ends_at) and ends_at>starts_at)
);
create index if not exists court_unit_maintenance_unit_time_idx on public.court_unit_maintenance(court_unit_id,starts_at,ends_at);
alter table public.court_unit_maintenance enable row level security;
revoke all on public.court_unit_maintenance from public,anon,authenticated;
grant select,insert,update,delete on public.court_unit_maintenance to authenticated;
create policy court_unit_maintenance_admin_all on public.court_unit_maintenance for all to authenticated
    using(exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and coalesce(p.status,'active')<>'disabled'))
    with check(exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and coalesce(p.status,'active')<>'disabled'));

-- Configuration writes use the validated save transaction below; no direct
-- table DML can bypass the editor-version and occupancy checks.
revoke insert,update,delete on public.sport,public.court,public.court_unit_inventory,
    public.physical_court_resource,public.court_unit_resource_map,public.court_unit_maintenance
from public,anon,authenticated;

-- Put scheduled maintenance in the same exclusion ledger as online reservations
-- and staff walk-ins. All intervals are start-inclusive and end-exclusive.
alter table internal.reservation_resource_slots add column if not exists maintenance_id uuid
    references public.court_unit_maintenance(id) on update cascade on delete cascade;
alter table internal.reservation_resource_slots drop constraint if exists reservation_resource_slots_check;
alter table internal.reservation_resource_slots add constraint reservation_resource_slots_one_source
    check(num_nonnulls(booking_id,walkin_id,maintenance_id)=1);
create unique index if not exists reservation_resource_slots_maintenance_resource_uidx
    on internal.reservation_resource_slots(maintenance_id,resource_id) where maintenance_id is not null;

create or replace function internal.sync_maintenance_resource_slots()
returns trigger language plpgsql security definer set search_path = '' as $$
declare unit_id uuid; start_at timestamptz; end_at timestamptz; block_id uuid;
begin
    if tg_op='DELETE' then delete from internal.reservation_resource_slots where maintenance_id=old.id; return old; end if;
    unit_id:=new.court_unit_id; start_at:=new.starts_at; end_at:=new.ends_at; block_id:=new.id;
    delete from internal.reservation_resource_slots where maintenance_id=block_id;
    insert into internal.reservation_resource_slots(maintenance_id,resource_id,during)
    select block_id,m.resource_id,pg_catalog.tstzrange(start_at,end_at,'[)')
    from public.court_unit_resource_map m join public.physical_court_resource r on r.id=m.resource_id and r.is_active
    where m.court_unit_id=unit_id;
    if not exists(select 1 from internal.reservation_resource_slots where maintenance_id=block_id) then
        raise exception 'Maintenance unit must be connected to an active physical court' using errcode='23503';
    end if;
    return new;
exception when exclusion_violation then
    raise exception 'Maintenance overlaps an existing booking, payment hold, or maintenance period' using errcode='23P01';
end;
$$;
revoke all on function internal.sync_maintenance_resource_slots() from public,anon,authenticated;
create trigger court_unit_maintenance_sync_slots after insert or update or delete on public.court_unit_maintenance
    for each row execute function internal.sync_maintenance_resource_slots();
create trigger court_unit_maintenance_lock_resources before insert or update or delete on public.court_unit_maintenance
    for each statement execute function internal.lock_reservation_resource_config();

-- Existing resource-map refresh trigger now rebuilds reservations and
-- maintenance together, so mapping edits cannot erase scheduled blocks.
create or replace function internal.refresh_reservation_resource_slots()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    delete from internal.reservation_resource_slots;
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
    select mnt.id,map.resource_id,pg_catalog.tstzrange(mnt.starts_at,mnt.ends_at,'[)')
      from public.court_unit_maintenance mnt join public.court_unit_resource_map map on map.court_unit_id=mnt.court_unit_id
      join public.physical_court_resource r on r.id=map.resource_id and r.is_active;
    if exists(select 1 from internal.reservation_slots s where
       (s.booking_id is not null and not exists(select 1 from internal.reservation_resource_slots r where r.booking_id=s.booking_id)) or
       (s.walkin_id is not null and not exists(select 1 from internal.reservation_resource_slots r where r.walkin_id=s.walkin_id))) then
        raise exception 'Every active reservation must remain linked to a physical resource' using errcode='23503';
    end if;
    if exists(select 1 from public.court_unit_maintenance mnt where not exists(select 1 from internal.reservation_resource_slots rs where rs.maintenance_id=mnt.id)) then
        raise exception 'Every maintenance period must remain linked to a physical resource' using errcode='23503';
    end if;
    return null;
exception when exclusion_violation then
    raise exception 'The resource mapping conflicts with an active reservation or maintenance period' using errcode='23P01';
end;
$$;
revoke all on function internal.refresh_reservation_resource_slots() from public,anon,authenticated;

-- Maintenance reserves the exact same physical slots as bookings. Do not
-- allow removing a unit mapping while a maintenance period still depends on it.
create or replace function internal.guard_reservation_resource_mapping_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare affected_unit uuid;
begin
    if tg_op='INSERT' then return new; end if;
    if tg_op='DELETE' then affected_unit:=old.court_unit_id;
    else
        if new.court_unit_id is not distinct from old.court_unit_id and new.resource_id is not distinct from old.resource_id then return new; end if;
        affected_unit:=old.court_unit_id;
    end if;
    -- The owner save RPC stages new mappings and maintenance in one protected
    -- transaction; its final occupancy-ledger refresh validates the complete
    -- resulting set before commit. All other mapping edits remain guarded.
    if coalesce(current_setting('inigosync.admin_sport_save',true),'')='on' then
        if tg_op='DELETE' then return old; end if;
        return new;
    end if;
    if exists(select 1 from public.court_unit_maintenance m where m.court_unit_id=affected_unit) then
        raise exception 'A unit connection cannot change while scheduled maintenance exists; edit or remove maintenance first' using errcode='23503';
    end if;
    if exists(select 1 from public.court_unit_inventory u where u.id=affected_unit and (
       exists(select 1 from public.booking b where b.court_listing_id=u.court_id and b.status in ('pending','confirmed')
         and (b.court_unit_inventory_id=u.id or (b.court_unit_inventory_id is null and (nullif(btrim(b.court_unit),'') is null or lower(btrim(b.court_unit))=lower(btrim(u.label))))))
       or exists(select 1 from public.walk_in_booking w where w.court_listing_id=u.court_id and w.status in ('pending','confirmed')
         and (w.court_unit_inventory_id=u.id or (w.court_unit_inventory_id is null and (nullif(btrim(w.court_unit),'') is null or lower(btrim(w.court_unit))=lower(btrim(u.label)))))))) then
        raise exception 'A court resource mapping cannot change while that unit has active reservations' using errcode='23503';
    end if;
    if tg_op='DELETE' then return old; end if;
    return new;
end;
$$;
revoke all on function internal.guard_reservation_resource_mapping_change() from public,anon,authenticated;

-- The occupancy interface is privacy-limited and now includes maintenance
-- mirrored onto every sport/unit that shares the physical resource.
create or replace function public.court_occupancy(from_at timestamptz,to_at timestamptz)
returns table(source text,courts text,court_unit text,time_date timestamptz,end_at timestamptz,duration_minutes integer,status text)
language plpgsql stable security definer set search_path = '' as $$
begin
    if (select auth.uid()) is null then raise exception 'Sign in to check court availability' using errcode='42501'; end if;
    if from_at is null or to_at is null or not pg_catalog.isfinite(from_at) or not pg_catalog.isfinite(to_at)
       or to_at<=from_at or to_at-from_at>interval '31 days' then raise exception 'Availability range must be between 0 and 31 days' using errcode='22023'; end if;
    return query
    select distinct on(rs.resource_id,coalesce(rs.booking_id,-rs.walkin_id),rs.maintenance_id,c.id,u.id)
      case when rs.maintenance_id is not null then 'maintenance' when rs.booking_id is not null then 'online' else 'walkin' end,
      c.name,u.label,lower(rs.during),upper(rs.during),
      greatest(1,ceil(extract(epoch from (upper(rs.during)-lower(rs.during)))/60)::integer),coalesce(b.status,w.status,'maintenance')
    from internal.reservation_resource_slots rs join public.court_unit_resource_map tm on tm.resource_id=rs.resource_id
      join public.court_unit_inventory u on u.id=tm.court_unit_id and u.is_active
      join public.court c on c.id=u.court_id and c.is_active
      left join public.booking b on b.booking_id=rs.booking_id
      left join public.walk_in_booking w on w.walkin_id=rs.walkin_id
    where rs.during && pg_catalog.tstzrange(from_at,to_at,'[)')
    order by rs.resource_id,coalesce(rs.booking_id,-rs.walkin_id),rs.maintenance_id,c.id,u.id;
end;
$$;
revoke all on function public.court_occupancy(timestamptz,timestamptz) from public,anon;
grant execute on function public.court_occupancy(timestamptz,timestamptz) to authenticated;

-- Owner-only editor data API. Empty p_court_id loads the add form.
create or replace function public.admin_get_sport_editor(p_court_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
    if (select auth.uid()) is null or not exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and coalesce(p.status,'active')<>'disabled') then raise exception 'Active owner access is required' using errcode='42501'; end if;
    if p_court_id is null then
        select jsonb_build_object('version',0,'listing',null,'units','[]'::jsonb,'resources',coalesce((
            select jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'sport_names',coalesce((select jsonb_agg(distinct s.name order by s.name)
              from public.court_unit_resource_map mm join public.court_unit_inventory uu on uu.id=mm.court_unit_id
              join public.court cc on cc.id=uu.court_id join public.sport s on s.id=cc.sport_id where mm.resource_id=r.id),'[]'::jsonb)) order by r.name)
              from public.physical_court_resource r where r.is_active),'[]'::jsonb),'cutoff',(select night_rate_starts_at from public.app_settings where id=true)) into result;
        return result;
    end if;
    select jsonb_build_object(
      'version',c.editor_version,
      'listing',jsonb_build_object('id',c.id,'sport_id',s.id,'slug',c.slug,'name',c.name,'description',c.description,'unit',c.unit,'image_url',c.image_url,'is_active',c.is_active,'display_order',c.display_order),
      'units',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'label',u.label,'photo_url',u.photo_url,'rate_day',u.rate_day,'rate_night',u.rate_night,'rate_unit',u.rate_unit,
        'resource_ids',coalesce((select jsonb_agg(m.resource_id order by m.resource_id) from public.court_unit_resource_map m where m.court_unit_id=u.id),'[]'::jsonb),
        'maintenance',coalesce((select jsonb_agg(jsonb_build_object('id',mnt.id,'start_at',mnt.starts_at,'end_at',mnt.ends_at,'note',mnt.note) order by mnt.starts_at) from public.court_unit_maintenance mnt where mnt.court_unit_id=u.id),'[]'::jsonb)) order by u.created_at,u.id)
        from public.court_unit_inventory u where u.court_id=c.id),'[]'::jsonb),
      'resources',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'sport_names',coalesce((select jsonb_agg(distinct ss.name order by ss.name)
        from public.court_unit_resource_map mm join public.court_unit_inventory uu on uu.id=mm.court_unit_id
        join public.court cc on cc.id=uu.court_id join public.sport ss on ss.id=cc.sport_id where mm.resource_id=r.id),'[]'::jsonb)) order by r.name)
        from public.physical_court_resource r where r.is_active),'[]'::jsonb),
      'cutoff',(select night_rate_starts_at from public.app_settings where id=true))
    into result from public.court c left join public.sport s on s.id=c.sport_id where c.id=p_court_id;
    if result is null then raise exception 'Sport listing not found' using errcode='P0002'; end if;
    return result;
end;
$$;
revoke all on function public.admin_get_sport_editor(uuid) from public,anon;
grant execute on function public.admin_get_sport_editor(uuid) to authenticated;

-- Payload: {court_id,expected_version,slug,name,description,unit,image_url,
-- is_active,units:[{id,label,photo_url,rate_day,rate_night,rate_unit,
-- resource_ids:[uuid],maintenance:[{id,start_at,end_at,note}]}]}.
create or replace function public.admin_save_sport(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cid uuid; sid uuid; unit_id uuid; resource_id uuid; expected integer; next_version integer;
 listing_name text; listing_slug text; listing_unit text; listing_active boolean; item jsonb; mitem jsonb;
 label_value text; next_order integer; submitted uuid[]:=array[]::uuid[]; result_units jsonb:='[]'::jsonb;
begin
    if (select auth.uid()) is null or not exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and coalesce(p.status,'active')<>'disabled') then raise exception 'Active owner access is required' using errcode='42501'; end if;
    perform set_config('inigosync.admin_sport_save','on',true);
    if jsonb_typeof(p_payload)<>'object' or jsonb_typeof(p_payload->'units')<>'array' or jsonb_array_length(p_payload->'units') not between 1 and 50 then raise exception 'Sport details need between 1 and 50 units' using errcode='22023'; end if;
    cid:=nullif(p_payload->>'court_id','')::uuid; expected:=coalesce((p_payload->>'expected_version')::integer,0);
    listing_name:=nullif(btrim(p_payload->>'name'),'');
    listing_slug:=coalesce(nullif(regexp_replace(lower(btrim(coalesce(p_payload->>'slug',p_payload->>'name'))),'[^a-z0-9]+','-','g'),''),gen_random_uuid()::text);
    listing_unit:=p_payload->>'unit'; listing_active:=coalesce((p_payload->>'is_active')::boolean,true);
    if listing_name is null or listing_unit not in ('courts','lanes','tables') then raise exception 'Sport name or unit type is invalid' using errcode='22023'; end if;
    update internal.reservation_resource_config_lock set version=version+1 where id=true;
    if cid is null then
        if expected<>0 then raise exception 'New sports must use version 0' using errcode='40001'; end if;
        select coalesce(max(display_order),0)+1 into next_order from public.court;
        insert into public.sport(slug,name,display_order,is_active) values(listing_slug,listing_name,next_order,listing_active)
          returning id into sid;
        insert into public.court(sport_id,slug,name,quantity,unit,description,status,image_url,display_order,is_active,editor_version)
          values(sid,listing_slug,listing_name,jsonb_array_length(p_payload->'units'),listing_unit,nullif(btrim(p_payload->>'description'),''),'Available',nullif(btrim(p_payload->>'image_url'),''),next_order,listing_active,1)
          returning id,editor_version into cid,next_version;
    else
        select c.sport_id into sid from public.court c where c.id=cid and c.editor_version=expected for update;
        if not found then raise exception 'This sport changed in another session. Reload it and retry.' using errcode='40001'; end if;
        if not listing_active and (exists(select 1 from public.booking b where b.court_listing_id=cid and b.status in ('pending','confirmed') and b.end_at>now())
          or exists(select 1 from public.walk_in_booking w where w.court_listing_id=cid and w.status in ('pending','confirmed') and w.end_at>now())) then raise exception 'A sport with an active or upcoming reservation cannot be archived' using errcode='23503'; end if;
        update public.sport set slug=listing_slug,name=listing_name,is_active=listing_active where id=sid;
        update public.court set slug=listing_slug,name=listing_name,quantity=jsonb_array_length(p_payload->'units'),unit=listing_unit,
          description=nullif(btrim(p_payload->>'description'),''),image_url=nullif(btrim(p_payload->>'image_url'),''),is_active=listing_active,
          editor_version=editor_version+1 where id=cid returning editor_version into next_version;
    end if;
    for item in select value from jsonb_array_elements(p_payload->'units') loop
        unit_id:=nullif(item->>'id','')::uuid; label_value:=nullif(btrim(item->>'label'),'');
        if label_value is null then raise exception 'Every unit needs a name' using errcode='22023'; end if;
        if unit_id is null then
            insert into public.court_unit_inventory(court_id,label,photo_url,rate_day,rate_night,rate_unit,is_active,inventory_verified)
              values(cid,label_value,nullif(btrim(item->>'photo_url'),''),nullif(item->>'rate_day','')::numeric,nullif(item->>'rate_night','')::numeric,coalesce(item->>'rate_unit','/hr'),listing_active,true) returning id into unit_id;
            insert into public.physical_court_resource(name) values(listing_name||' · '||label_value) returning id into resource_id;
            insert into public.court_unit_resource_map(court_unit_id,resource_id) values(unit_id,resource_id);
        else
            if not exists(select 1 from public.court_unit_inventory where id=unit_id and court_id=cid) then raise exception 'A unit does not belong to this sport' using errcode='22023'; end if;
            update public.court_unit_inventory set label=label_value,photo_url=nullif(btrim(item->>'photo_url'),''),rate_day=nullif(item->>'rate_day','')::numeric,
              rate_night=nullif(item->>'rate_night','')::numeric,rate_unit=coalesce(item->>'rate_unit','/hr'),inventory_verified=true where id=unit_id;
        end if;
        if unit_id=any(submitted) then raise exception 'Duplicate unit ID' using errcode='22023'; end if;
        submitted:=array_append(submitted,unit_id);
        if jsonb_typeof(item->'resource_ids')<>'array' or jsonb_array_length(item->'resource_ids')=0 then raise exception 'Every unit must be connected to a physical court space' using errcode='22023'; end if;
        if jsonb_typeof(item->'resource_ids')='array' and jsonb_array_length(item->'resource_ids')>0 then
            -- Add first so refresh triggers never observe a disconnected unit.
            for resource_id in select value::uuid from jsonb_array_elements_text(item->'resource_ids') loop
                if not exists(select 1 from public.physical_court_resource where id=resource_id and is_active) then raise exception 'Unknown physical resource' using errcode='22023'; end if;
                insert into public.court_unit_resource_map(court_unit_id,resource_id) values(unit_id,resource_id) on conflict do nothing;
            end loop;
            delete from public.court_unit_resource_map existing where existing.court_unit_id=unit_id and not exists(
              select 1 from jsonb_array_elements_text(item->'resource_ids') wanted(value) where wanted.value::uuid=existing.resource_id);
        end if;
        delete from public.court_unit_maintenance where court_unit_id=unit_id and (item->'maintenance' is null or not exists(
          select 1 from jsonb_array_elements(item->'maintenance') mm where nullif(mm->>'id','')::uuid=court_unit_maintenance.id));
        for mitem in select value from jsonb_array_elements(coalesce(item->'maintenance','[]'::jsonb)) loop
            if nullif(mitem->>'start_at','') is null or nullif(mitem->>'end_at','') is null then raise exception 'Maintenance needs a start and end time' using errcode='22023'; end if;
            if nullif(mitem->>'id','') is null then
                insert into public.court_unit_maintenance(court_unit_id,starts_at,ends_at,note,created_by)
                  values(unit_id,(mitem->>'start_at')::timestamptz,(mitem->>'end_at')::timestamptz,nullif(btrim(mitem->>'note'),''),(select auth.uid()));
            else
                update public.court_unit_maintenance set starts_at=(mitem->>'start_at')::timestamptz,ends_at=(mitem->>'end_at')::timestamptz,note=nullif(btrim(mitem->>'note'),'')
                  where id=(mitem->>'id')::uuid and court_unit_id=unit_id;
                if not found then raise exception 'Maintenance period does not belong to this unit' using errcode='22023'; end if;
            end if;
        end loop;
        result_units:=result_units||jsonb_build_array(jsonb_build_object('id',unit_id,'label',label_value));
    end loop;
    for unit_id in select u.id from public.court_unit_inventory u where u.court_id=cid and not(u.id=any(submitted)) loop
        if exists(select 1 from public.booking b where b.court_listing_id=cid and (b.court_unit_inventory_id=unit_id or
          (b.court_unit_inventory_id is null and (nullif(btrim(b.court_unit),'') is null or lower(btrim(b.court_unit))=(select lower(btrim(label)) from public.court_unit_inventory where id=unit_id)))))
          or exists(select 1 from public.walk_in_booking w where w.court_listing_id=cid and (w.court_unit_inventory_id=unit_id or
          (w.court_unit_inventory_id is null and (nullif(btrim(w.court_unit),'') is null or lower(btrim(w.court_unit))=(select lower(btrim(label)) from public.court_unit_inventory where id=unit_id))))) then
            raise exception 'A unit referenced by booking history cannot be deleted' using errcode='23503';
        end if;
        delete from public.court_unit_inventory where id=unit_id;
    end loop;
    update public.court set quantity=cardinality(submitted) where id=cid;
    delete from public.physical_court_resource r where not exists(select 1 from public.court_unit_resource_map m where m.resource_id=r.id);
    return jsonb_build_object('court_id',cid,'sport_id',sid,'version',next_version,'units',result_units);
end;
$$;
revoke all on function public.admin_save_sport(jsonb) from public,anon;
grant execute on function public.admin_save_sport(jsonb) to authenticated;

create or replace function public.admin_delete_sport(p_court_id uuid,p_expected_version integer)
returns void language plpgsql security definer set search_path = '' as $$
declare sid uuid;
begin
    if (select auth.uid()) is null or not exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and coalesce(p.status,'active')<>'disabled') then raise exception 'Active owner access is required' using errcode='42501'; end if;
    update internal.reservation_resource_config_lock set version=version+1 where id=true;
    select c.sport_id into sid from public.court c where c.id=p_court_id and c.editor_version=p_expected_version and not c.is_active for update;
    if not found then raise exception 'Only an unchanged archived sport can be deleted' using errcode='40001'; end if;
    if exists(select 1 from public.booking b where b.court_listing_id=p_court_id and b.status in ('pending','confirmed') and b.end_at>now())
      or exists(select 1 from public.walk_in_booking w where w.court_listing_id=p_court_id and w.status in ('pending','confirmed') and w.end_at>now()) then raise exception 'A sport with an active or upcoming reservation cannot be deleted' using errcode='23503'; end if;
    if exists(select 1 from public.booking b where b.court_listing_id=p_court_id) or exists(select 1 from public.walk_in_booking w where w.court_listing_id=p_court_id)
      or exists(select 1 from public.booking b where lower(btrim(b.courts))=(select lower(btrim(name)) from public.court where id=p_court_id))
      or exists(select 1 from public.walk_in_booking w where lower(btrim(w.courts))=(select lower(btrim(name)) from public.court where id=p_court_id)) then raise exception 'A sport referenced by booking history cannot be deleted' using errcode='23503'; end if;
    delete from public.court where id=p_court_id;
    if sid is not null and not exists(select 1 from public.court where sport_id=sid) then delete from public.sport where id=sid; end if;
    delete from public.physical_court_resource r where not exists(select 1 from public.court_unit_resource_map m where m.resource_id=r.id);
end;
$$;
revoke all on function public.admin_delete_sport(uuid,integer) from public,anon;
grant execute on function public.admin_delete_sport(uuid,integer) to authenticated;

create or replace function public.admin_set_night_rate_cutoff(p_expected_cutoff time,p_cutoff time)
returns time language plpgsql security definer set search_path = '' as $$
declare v time; singleton boolean;
begin
    if (select auth.uid()) is null or not exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and coalesce(p.status,'active')<>'disabled') then raise exception 'Active owner access is required' using errcode='42501'; end if;
    select id,night_rate_starts_at into singleton,v from public.app_settings where id=true for update;
    if v is distinct from p_expected_cutoff then raise exception 'Pricing cutoff changed in another session' using errcode='40001'; end if;
    if singleton is null then insert into public.app_settings(id,night_rate_starts_at) values(true,p_cutoff) returning night_rate_starts_at into v;
    else update public.app_settings set night_rate_starts_at=p_cutoff where id=true returning night_rate_starts_at into v; end if;
    return v;
end;
$$;
revoke all on function public.admin_set_night_rate_cutoff(time,time) from public,anon;
grant execute on function public.admin_set_night_rate_cutoff(time,time) to authenticated;

-- Stale-safe full-order update. Insertions/edits/deletes continue using the
-- existing event table RLS; reordering itself is one serialized transaction.
create or replace function public.admin_reorder_slides(p_ids uuid[],p_expected_ids uuid[])
returns uuid[] language plpgsql security definer set search_path = '' as $$
declare actual uuid[]; total integer; bump integer;
begin
    if (select auth.uid()) is null or not exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and coalesce(p.status,'active')<>'disabled') then raise exception 'Active owner access is required' using errcode='42501'; end if;
    lock table public.event in share row exclusive mode;
    select coalesce(array_agg(id order by display_order,created_at,id),'{}'::uuid[]),count(*) into actual,total from public.event;
    if actual is distinct from p_expected_ids then raise exception 'Slides changed in another session; reload and retry' using errcode='40001'; end if;
    if p_ids is null or cardinality(p_ids)<>total or (select count(distinct ids.id) from unnest(p_ids) as ids(id))<>total or not(p_ids @> actual and p_ids <@ actual) then raise exception 'Slide order must contain every current slide exactly once' using errcode='22023'; end if;
    select coalesce(max(display_order),0)+cardinality(p_ids)+1 into bump from public.event;
    update public.event e set display_order=e.display_order+bump where e.id=any(p_ids);
    update public.event e set display_order=o.ordinality::integer from unnest(p_ids) with ordinality o(id,ordinality) where e.id=o.id;
    return p_ids;
end;
$$;
revoke all on function public.admin_reorder_slides(uuid[],uuid[]) from public,anon;
grant execute on function public.admin_reorder_slides(uuid[],uuid[]) to authenticated;

create or replace function public.admin_booking_overview(p_from_at timestamptz,p_to_at timestamptz)
returns table(source text,id text,time_date timestamptz,status text,amount_total numeric,amount_paid numeric,auto_cancelled_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
    if (select auth.uid()) is null or not exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and coalesce(p.status,'active')<>'disabled') then raise exception 'Active owner access is required' using errcode='42501'; end if;
    if p_from_at is null or p_to_at is null or p_to_at<=p_from_at or p_to_at-p_from_at>interval '366 days' then raise exception 'Overview date range is invalid' using errcode='22023'; end if;
    return query select 'online'::text,b.booking_id::text,b.time_date,b.status,b.amount_total,b.amount_paid,b.auto_cancelled_at from public.booking b where b.time_date>=p_from_at and b.time_date<p_to_at
      union all select 'walkin'::text,w.walkin_id::text,w.time_date,w.status,w.amount_total,w.amount_paid,w.auto_cancelled_at from public.walk_in_booking w where w.time_date>=p_from_at and w.time_date<p_to_at;
end;
$$;
revoke all on function public.admin_booking_overview(timestamptz,timestamptz) from public,anon;
grant execute on function public.admin_booking_overview(timestamptz,timestamptz) to authenticated;

create or replace function public.owner_review_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare n bigint; average numeric; stars jsonb;
begin
    if (select auth.uid()) is null or not exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and coalesce(p.status,'active')<>'disabled') then raise exception 'Active owner access is required' using errcode='42501'; end if;
    select count(*),round(avg(rating)::numeric,1),jsonb_build_object('1',count(*) filter(where rating=1),'2',count(*) filter(where rating=2),'3',count(*) filter(where rating=3),'4',count(*) filter(where rating=4),'5',count(*) filter(where rating=5)) into n,average,stars from public.booking_review;
    return jsonb_build_object('average_rating',coalesce(average,0.0),'total_count',n,'star_counts',stars);
end;
$$;
revoke all on function public.owner_review_summary() from public,anon;
grant execute on function public.owner_review_summary() to authenticated;

-- Called after local upload staging to check all app-owned references before
-- the client removes a replaced object from Storage.
create or replace function public.admin_is_media_url_referenced(p_url text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
    if (select auth.uid()) is null or not exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and coalesce(p.status,'active')<>'disabled') then raise exception 'Active owner access is required' using errcode='42501'; end if;
    return exists(select 1 from public.court where image_url=p_url)
      or exists(select 1 from public.court_unit_inventory where photo_url=p_url)
      or exists(select 1 from public.court c cross join lateral jsonb_array_elements(coalesce(c.unit_images,'[]'::jsonb)) legacy(value)
          where legacy.value->>'image_url'=p_url)
      or exists(select 1 from public.event where image_url=p_url)
      or exists(select 1 from public.testimonial where image_url=p_url);
end;
$$;
revoke all on function public.admin_is_media_url_referenced(text) from public,anon;
grant execute on function public.admin_is_media_url_referenced(text) to authenticated;

alter table public.owner_activity add column if not exists detail text;
alter table public.owner_activity add column if not exists target_id text;

-- New staff accounts require birthdate and one of the two supported titles.
-- Legacy NULL birthdays/old titles remain intact on unrelated edits.
create or replace function internal.validate_staff_profile_details()
returns trigger language plpgsql security definer set search_path = '' as $$
declare is_new_staff boolean; title_changed boolean;
begin
    if tg_op='INSERT' then is_new_staff:=new.role='staff'; title_changed:=true;
    else is_new_staff:=old.role is distinct from 'staff' and new.role='staff'; title_changed:=old.position is distinct from new.position; end if;
    if new.role='staff' and title_changed and coalesce(new.position,'') not in ('Secretary','Court Attendant') then raise exception 'Staff position must be Secretary or Court Attendant' using errcode='22023'; end if;
    if new.role='staff' and (is_new_staff or (tg_op='UPDATE' and old.birthdate is distinct from new.birthdate and new.birthdate is null)) then raise exception 'A staff birthdate is required' using errcode='22023'; end if;
    if new.role='staff' and new.birthdate is not null and (new.birthdate>(current_timestamp at time zone 'Asia/Manila')::date or new.birthdate<date '1900-01-01') then raise exception 'Staff birthdate is invalid' using errcode='22023'; end if;
    return new;
end;
$$;
revoke all on function internal.validate_staff_profile_details() from public,anon,authenticated;
update public.profiles set position='Secretary' where role='staff' and lower(btrim(position))='front desk';
update public.profiles set position='Court Attendant' where role='staff' and lower(btrim(position))='court staff';
create trigger profiles_validate_staff_details before insert or update of role,position,birthdate on public.profiles
    for each row execute function internal.validate_staff_profile_details();
