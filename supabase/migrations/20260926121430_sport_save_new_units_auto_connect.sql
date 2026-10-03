-- Let new units receive their own physical resource in the same atomic sport save.
create or replace function public.admin_save_sport(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cid uuid; sid uuid; unit_id uuid; resource_id uuid; expected integer; next_version integer; is_new_unit boolean;
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
        unit_id:=nullif(item->>'id','')::uuid; is_new_unit:=unit_id is null; label_value:=nullif(btrim(item->>'label'),'');
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
        if jsonb_typeof(item->'resource_ids') is distinct from 'array' then raise exception 'Physical court connections must be a list' using errcode='22023'; end if;
        if jsonb_array_length(item->'resource_ids')=0 and not is_new_unit then raise exception 'Every existing unit must remain connected to a physical court space' using errcode='22023'; end if;
        if jsonb_array_length(item->'resource_ids')>0 then
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
