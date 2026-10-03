-- Add a sport, its public listing, and the configured number of bookable
-- units as one transaction. This avoids leaving a partial listing behind.
alter table public.court add column if not exists unit_images jsonb
    check (unit_images is null or jsonb_typeof(unit_images) = 'array');

-- Listing-level Maintenance was previously only a display label and never
-- gated customer/staff booking. Unit inventory is now the authoritative
-- availability state, so normalize that legacy label instead of implying
-- a booking block that never existed.
update public.court set status = 'Available' where status = 'Maintenance';

create or replace function public.admin_create_sport_with_units(
    p_name text,
    p_slug text,
    p_unit text,
    p_quantity integer,
    p_description text default null,
    p_status text default 'Available',
    p_image_url text default null,
    p_unit_images jsonb default null
)
returns table(sport_id uuid, court_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
    new_sport_id uuid;
    new_court_id uuid;
    unit_label text;
    unit_id uuid;
    resource_id uuid;
    n integer;
    next_order integer;
begin
    if auth.uid() is null or not exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.role = 'admin' and coalesce(p.status, 'active') <> 'disabled'
    ) then
        raise exception 'Administrator access is required' using errcode = '42501';
    end if;
    if nullif(btrim(p_name), '') is null or nullif(btrim(p_slug), '') is null
       or p_unit not in ('courts', 'lanes', 'tables', 'court')
       or p_quantity not between 1 and 50
       or p_status not in ('Available', 'Maintenance') then
        raise exception 'Sport details are invalid' using errcode = '22023';
    end if;

    select coalesce(max(display_order), 0) + 1 into next_order from public.court;
    insert into public.sport (slug, name, display_order, is_active)
    values (p_slug, btrim(p_name), next_order, true)
    returning id into new_sport_id;
    insert into public.court (sport_id, slug, name, quantity, unit, description, status, image_url, unit_images, display_order, is_active)
    values (new_sport_id, p_slug, btrim(p_name), p_quantity, p_unit, nullif(btrim(p_description), ''), p_status,
            nullif(btrim(p_image_url), ''), case when jsonb_typeof(p_unit_images) = 'array' then p_unit_images else null end, next_order, true)
    returning id into new_court_id;

    for n in 1..p_quantity loop
        unit_label := case when p_unit in ('lanes', 'tables') then initcap(regexp_replace(p_unit, 's$', '')) else 'Court' end || ' ' || n::text;
        insert into public.court_unit_inventory (court_id, label, availability_status, is_active, inventory_verified)
        values (new_court_id, unit_label,
                case when p_status = 'Maintenance' then 'maintenance' else 'available' end,
                p_status = 'Available', true)
        returning id into unit_id;
        insert into public.physical_court_resource (name) values (btrim(p_name) || ' · ' || unit_label)
        returning id into resource_id;
        insert into public.court_unit_resource_map (court_unit_id, resource_id) values (unit_id, resource_id);
    end loop;
    return query select new_sport_id, new_court_id;
end;
$$;

revoke all on function public.admin_create_sport_with_units(text, text, text, integer, text, text, text, jsonb) from public, anon;
grant execute on function public.admin_create_sport_with_units(text, text, text, integer, text, text, text, jsonb) to authenticated;
