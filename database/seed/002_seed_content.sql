-- ============================================================================
-- IñigoSync — Seed: sports, courts, sample events, placeholder testimonials
-- ============================================================================
-- Run this in the Supabase SQL editor AFTER database/schema/002_content_tables.sql.
-- (database/seed/001_seed_users.sql can run before or after this file — they
-- don't depend on each other.)
--
-- Safe to re-run: every insert is guarded by "on conflict ... do nothing" or
-- "where not exists", so re-running this script does not create duplicate
-- rows.
--
-- Rates are left NULL on every court on purpose — the owner (Ms. Driz)
-- hasn't confirmed listing rates. Do not invent prices here;
-- the frontend renders the existing '—' placeholder for a NULL rate.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- sport — the 9 sport categories offered, matching includes/courts-data.js
-- ----------------------------------------------------------------------------
insert into public.sport (slug, name, display_order)
values
    ('basketball',   'Basketball',   1),
    ('badminton',    'Badminton',    2),
    ('lawn-tennis',  'Lawn Tennis',  3),
    ('pickleball',   'Pickleball',   4),
    ('bowling-duckpin', 'Bowling — Duckpin', 5),
    ('bowling-tenpin',  'Bowling — Ten-Pin', 6),
    ('billiards',       'Billiards',         7),
    ('table-tennis',    'Table Tennis',      8),
    ('volleyball',      'Volleyball',        9)
on conflict (slug) do nothing;

-- Repair the established Ten-Pin listing's sport relationship on re-runs.
-- Updating this FK leaves the court row id and its booking/unit history intact.
update public.court c
set sport_id = s.id
from public.sport s
where s.slug = 'bowling-tenpin'
  and c.slug = 'bowling-tenpin'
  and c.sport_id is distinct from s.id;

-- ----------------------------------------------------------------------------
-- court — one row per bookable listing on the landing page's Courts & Facilities
-- grid. Duckpin and ten-pin are separate sports and separate court listings;
-- the landing page can still merge them into one marketing "Bowling" card.
-- ----------------------------------------------------------------------------
insert into public.court (sport_id, slug, name, quantity, unit, description, rate, rate_unit, status, display_order)
select s.id, v.slug, v.name, v.quantity, v.unit, v.description, null, v.rate_unit, 'Available', v.display_order
from (values
    ('basketball',      'basketball',       'Basketball',           2,  'courts', 'Full court · Indoor · Scoreboard',                 '/hr',   1),
    ('badminton',       'badminton',        'Badminton',            9,  'courts', 'Indoor · Rackets for rent',                        '/hr',   2),
    ('lawn-tennis',     'lawn-tennis',      'Lawn Tennis',          3,  'courts', 'Outdoor · Professional grade',                     '/hr',   3),
    ('pickleball',      'pickleball',       'Pickleball',           2,  'courts', 'Indoor · Recently added',                          '/hr',   4),
    ('bowling-duckpin', 'bowling-duckpin',  'Bowling — Duckpin',    8,  'lanes',  'Duckpin bowling · Shoes included',                 '/set',  5),
    ('bowling-tenpin',  'bowling-tenpin',   'Bowling — Ten-Pin',    12, 'lanes',  'Ten-pin bowling · Shoes included',                 '/set',  6),
    ('billiards',       'billiards',        'Billiards',            2,  'tables', 'Professional pool tables · Cue service available', '/hr',   7),
    ('table-tennis',    'table-tennis',     'Table Tennis',         2,  'tables', 'Tournament-grade tables · Paddles for rent',       '/hr',   8),
    ('volleyball',      'volleyball',       'Volleyball',           1,  'court',  'Full court · Indoor · Net included',               '/hr',   9)
) as v(sport_slug, slug, name, quantity, unit, description, rate_unit, display_order)
join public.sport s on s.slug = v.sport_slug
on conflict (slug) do nothing;

-- ----------------------------------------------------------------------------
-- event — sample featured events for the Hero carousel + Featured Events
-- section. event_date is relative to whenever this script actually runs, so
-- the demo always looks "current" instead of showing a hardcoded past date.
--
-- image_url points at the same real photos already sitting in database/web/
-- (and already hardcoded into Pages/owner_dashboard.html and
-- Pages/user_dashboard.html for these exact events) — this mirrors
-- includes/landingPage.js's EVENTS_FALLBACK so the DB-sourced path renders
-- identically to the offline fallback once this table exists, instead of
-- reverting to image-slot placeholders the moment it does.
-- ----------------------------------------------------------------------------
insert into public.event (sport_id, tag, title, meta, event_date, image_url, display_order)
select s.id, v.tag, v.title, v.meta, v.event_date, v.image_url, v.display_order
from (values
    ('basketball', 'Tournament',    'Bocohan Summer Basketball League — Finals', 'Court 1 · Elimination round',              (current_date + 2)::date, '../database/web/basketball.jpg',   1),
    (null,         'This weekend',  'Weekend Open Play',                         'Sat & Sun · 8:00 AM – 10:00 PM · all courts', (current_date + 3)::date, '../database/web/announcement.jpg', 2),
    ('badminton',  'New courts',    'Badminton Courts Now Open',                 '9 courts total · book any slot online',     null,                     '../database/web/badminton.jpg',    3),
    (null,         'Lanes',         'Duckpin & Ten-Pin Night',                   '20 lanes total · Mon–Thu',                  null,                     '../database/web/bowling.jpg',      4),
    ('volleyball', 'Open gym',      'Volleyball Open Gym',                       'Every Friday · 6:00 PM – 9:00 PM',          null,                     '../database/web/volleyball.jpg',   5)
) as v(sport_slug, tag, title, meta, event_date, image_url, display_order)
left join public.sport s on s.slug = v.sport_slug
where not exists (
    select 1 from public.event e where e.title = v.title
);

-- ----------------------------------------------------------------------------
-- testimonial — OBVIOUS PLACEHOLDERS ONLY.
--
-- The owner has no real customer quotes yet, and a live Google Reviews feed
-- was investigated and rejected (Places API review content can't legally be
-- stored, and the card-free Maps Demo Key explicitly excludes user-generated
-- reviews — see implementation_plan.md, D3). Every row below uses a
-- transparently fake author name and a "[PLACEHOLDER]" quote so nothing here
-- can ever be mistaken for — or accidentally ship as — a real endorsement.
--
-- Before any real launch: replace every row with a real quote the customer
-- actually gave the business, with their sign-off, per Ms. Driz. Do not
-- copy real Google review text in here even after that — see D3's note on
-- review-text copyright belonging to the reviewer, not Google.
-- ----------------------------------------------------------------------------
-- Note: there's no unique column to key an ON CONFLICT off of here (unlike
-- sport/court's `slug`), so idempotency is done the same way as the event
-- insert above — insert only the rows whose author_name isn't already there.
insert into public.testimonial (author_name, rating, quote, source_label, display_order)
select v.author_name, v.rating, v.quote, v.source_label, v.display_order
from (values
    ('Placeholder Customer A', 5, '[PLACEHOLDER] Great courts and easy to book — swap in a real quote once it''s approved.', 'Placeholder — awaiting a real quote', 1),
    ('Placeholder Customer B', 5, '[PLACEHOLDER] Friendly staff and the place is always clean.',                            'Placeholder — awaiting a real quote', 2),
    ('Placeholder Customer C', 4, '[PLACEHOLDER] Good variety of sports under one roof.',                                  'Placeholder — awaiting a real quote', 3),
    ('Placeholder Customer D', 5, '[PLACEHOLDER] Booking online saved us so much back-and-forth.',                        'Placeholder — awaiting a real quote', 4),
    ('Placeholder Customer E', 4, '[PLACEHOLDER] Lanes were in great shape for our bowling night.',                        'Placeholder — awaiting a real quote', 5),
    ('Placeholder Customer F', 5, '[PLACEHOLDER] Been coming here for years, never disappoints.',                          'Placeholder — awaiting a real quote', 6)
) as v(author_name, rating, quote, source_label, display_order)
where not exists (
    select 1 from public.testimonial t where t.author_name = v.author_name
);
