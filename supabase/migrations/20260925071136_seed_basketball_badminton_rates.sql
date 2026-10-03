update public.court_unit_inventory u
set pricing_tier = case
        when c.name = 'Basketball' and u.label = 'Court 1' then 'old'
        when c.name = 'Basketball' and u.label = 'Court 2' then 'new'
        when c.name = 'Badminton' and u.label in ('Court 1','Court 2','Court 3','Court 4','Court 5') then 'old'
        when c.name = 'Badminton' and u.label in ('Court 6','Court 7','Court 8','Court 9') then 'new'
    end,
    rate_day = case
        when c.name = 'Basketball' and u.label = 'Court 1' then 700
        when c.name = 'Basketball' and u.label = 'Court 2' then 1300
        when c.name = 'Badminton' and u.label in ('Court 1','Court 2','Court 3','Court 4','Court 5') then 250
        when c.name = 'Badminton' and u.label in ('Court 6','Court 7','Court 8','Court 9') then 300
    end,
    rate_night = case
        when c.name = 'Basketball' and u.label = 'Court 1' then 1000
        when c.name = 'Basketball' and u.label = 'Court 2' then 1300
        when c.name = 'Badminton' and u.label in ('Court 1','Court 2','Court 3','Court 4','Court 5') then 250
        when c.name = 'Badminton' and u.label in ('Court 6','Court 7','Court 8','Court 9') then 300
    end,
    rate_unit = '/hr'
from public.court c
where c.id = u.court_id
  and ((c.name = 'Basketball' and u.label in ('Court 1','Court 2'))
    or (c.name = 'Badminton' and u.label in ('Court 1','Court 2','Court 3','Court 4','Court 5','Court 6','Court 7','Court 8','Court 9')));
