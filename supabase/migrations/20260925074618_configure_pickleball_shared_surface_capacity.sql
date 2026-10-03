-- Model the confirmed Pickleball footprint as capacity partitions of the host courts.
-- A host-court reservation maps to every zone on that surface; each Pickleball
-- unit maps to exactly one zone so the remaining zones can be booked in parallel.

update public.physical_court_resource r
set name = case c.slug
    when 'basketball' then 'Basketball Court 2 · Pickleball Zone 1'
    when 'volleyball' then 'Volleyball Court 1 · Pickleball Zone 1'
    when 'lawn-tennis' then 'Lawn Tennis Court ' || u.label || ' · Pickleball Zone 1'
end
from public.court_unit_resource_map m
join public.court_unit_inventory u on u.id = m.court_unit_id
join public.court c on c.id = u.court_id
where r.id = m.resource_id
  and ((c.slug = 'basketball' and u.label = 'Court 2')
    or (c.slug = 'volleyball' and u.label = 'Court 1')
    or (c.slug = 'lawn-tennis' and u.label in ('Court 1', 'Court 2')));

insert into public.physical_court_resource (name)
select zone.name
from (values
    ('Basketball Court 2 · Pickleball Zone 2'),
    ('Basketball Court 2 · Pickleball Zone 3'),
    ('Volleyball Court 1 · Pickleball Zone 2'),
    ('Volleyball Court 1 · Pickleball Zone 3'),
    ('Lawn Tennis Court 1 · Pickleball Zone 2'),
    ('Lawn Tennis Court 2 · Pickleball Zone 2')
) as zone(name)
where not exists (
    select 1 from public.physical_court_resource r where r.name = zone.name
);

insert into public.court_unit_inventory (court_id, label, is_active, inventory_verified)
select c.id, 'Court ' || n::text, true, true
from public.court c
cross join generate_series(1, 10) n
where c.slug = 'pickleball'
on conflict (court_id, label) do update
set is_active = true, inventory_verified = true;

update public.court c set quantity = 10 where c.slug = 'pickleball';

delete from public.court_unit_resource_map m
using public.court_unit_inventory u
join public.court c on c.id = u.court_id
where m.court_unit_id = u.id and c.slug = 'pickleball';

insert into public.court_unit_resource_map (court_unit_id, resource_id)
select host.id, r.id
from (values
    ('basketball', 'Court 2', 3, 'Basketball Court 2'),
    ('volleyball', 'Court 1', 3, 'Volleyball Court 1'),
    ('lawn-tennis', 'Court 1', 2, 'Lawn Tennis Court 1'),
    ('lawn-tennis', 'Court 2', 2, 'Lawn Tennis Court 2')
) as spec(slug, label, zone_count, host_name)
join public.court c on c.slug = spec.slug
join public.court_unit_inventory host on host.court_id = c.id and host.label = spec.label
cross join lateral generate_series(1, spec.zone_count) n
join public.physical_court_resource r
  on r.name = spec.host_name || ' · Pickleball Zone ' || n::text
on conflict do nothing;

insert into public.court_unit_resource_map (court_unit_id, resource_id)
select pickle.id, r.id
from public.court c
join public.court_unit_inventory pickle on pickle.court_id = c.id
cross join lateral (
    select case
        when substring(pickle.label from '[0-9]+')::integer between 1 and 3
            then 'Basketball Court 2 · Pickleball Zone ' || substring(pickle.label from '[0-9]+')
        when substring(pickle.label from '[0-9]+')::integer between 4 and 6
            then 'Volleyball Court 1 · Pickleball Zone ' || (substring(pickle.label from '[0-9]+')::integer - 3)
        when substring(pickle.label from '[0-9]+')::integer between 7 and 8
            then 'Lawn Tennis Court 1 · Pickleball Zone ' || (substring(pickle.label from '[0-9]+')::integer - 6)
        else 'Lawn Tennis Court 2 · Pickleball Zone ' || (substring(pickle.label from '[0-9]+')::integer - 8)
    end as resource_name
) assigned
join public.physical_court_resource r on r.name = assigned.resource_name
where c.slug = 'pickleball' and pickle.label ~ '^Court ([1-9]|10)$'
on conflict do nothing;
