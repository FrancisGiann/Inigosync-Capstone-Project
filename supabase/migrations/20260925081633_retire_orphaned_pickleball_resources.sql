do $$
declare
    v_expected_count integer;
begin
    select count(*) into v_expected_count
    from public.physical_court_resource r
    where r.name in ('Pickleball · Court 1', 'Pickleball · Court 2');

    if v_expected_count <> 2 then
        raise exception 'Expected exactly two obsolete Pickleball resources, found %', v_expected_count;
    end if;

    if exists (
        select 1
        from public.physical_court_resource r
        where r.name in ('Pickleball · Court 1', 'Pickleball · Court 2')
          and (
              exists (select 1 from public.court_unit_resource_map m where m.resource_id = r.id)
              or exists (select 1 from internal.reservation_resource_slots s where s.resource_id = r.id)
          )
    ) then
        raise exception 'Refusing to retire a mapped or reserved Pickleball resource';
    end if;

    update public.physical_court_resource
    set is_active = false
    where name in ('Pickleball · Court 1', 'Pickleball · Court 2');
end;
$$;
