-- Split the existing Ten-Pin court listing into its own sport category.
-- The court's primary key stays unchanged, preserving units, bookings, and
-- historical references that point to this listing.
insert into public.sport (slug, name, display_order)
values ('bowling-tenpin', 'Bowling — Ten-Pin', 6)
on conflict (slug) do update
set name = excluded.name,
    display_order = excluded.display_order;

update public.court c
set sport_id = s.id
from public.sport s
where s.slug = 'bowling-tenpin'
  and c.slug = 'bowling-tenpin'
  and c.sport_id is distinct from s.id;
