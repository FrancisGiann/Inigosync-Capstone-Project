-- Correct the two Lawn Tennis zone-1 labels and complete their Pickleball links.
update public.physical_court_resource r
set name = 'Lawn Tennis ' || u.label || ' · Pickleball Zone 1'
from public.court_unit_resource_map m
join public.court_unit_inventory u on u.id = m.court_unit_id
join public.court c on c.id = u.court_id
where r.id = m.resource_id
  and c.slug = 'lawn-tennis'
  and u.label in ('Court 1', 'Court 2')
  and r.name = 'Lawn Tennis Court ' || u.label || ' · Pickleball Zone 1';

insert into public.court_unit_resource_map (court_unit_id, resource_id)
select pickle.id, r.id
from public.court c
join public.court_unit_inventory pickle on pickle.court_id = c.id
join lateral (values
    ('Court 7', 'Lawn Tennis Court 1 · Pickleball Zone 1'),
    ('Court 9', 'Lawn Tennis Court 2 · Pickleball Zone 1')
) assigned(pickle_label, resource_name) on assigned.pickle_label = pickle.label
join public.physical_court_resource r on r.name = assigned.resource_name
where c.slug = 'pickleball'
on conflict do nothing;
