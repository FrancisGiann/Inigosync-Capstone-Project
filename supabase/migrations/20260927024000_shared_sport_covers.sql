-- Each listing reads the same sport cover URL from the database on both
-- landing cards and the owner Court Listings page. Both bowling listings use
-- the bowling cover. All app pages live under Pages/, so this path resolves
-- to the checked-in static asset in local preview and deployment alike.
update public.court c
set image_url = '../assets/landing/sports-covers/' || s.slug || '.png'
from public.sport s
where s.id = c.sport_id
  and s.slug in ('basketball','badminton','bowling','billiards','lawn-tennis',
                 'pickleball','table-tennis','volleyball')
  and (c.image_url is null or btrim(c.image_url) = '');
