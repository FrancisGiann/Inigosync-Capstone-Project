-- Synthetic demonstration reviews for the 28 active customer accounts on 2026-11-02.
-- Reruns preserve any existing review. Remove only is_sample=true rows after review and impact analysis.
with numbered_customers as (
    select p.id as customer_id, row_number() over (order by p.id) as rn
    from public.profiles p
    where p.role = 'customer' and p.status = 'active'
), sample_text(rn, comment) as (
    values
    (1, 'The booking steps felt unclear; clearer instructions would help.'),
    (2, 'I could find the court list, but the schedule details took extra effort to understand.'),
    (3, 'The reservation flow was manageable and the basic information was available.'),
    (4, 'The court choices were clear and selecting a time looked straightforward.'),
    (5, 'The booking flow looked smooth and the venue details were easy to follow.'),
    (6, 'I wanted clearer guidance before confirming a reservation.'),
    (7, 'The available times were useful, though some labels could be easier to understand.'),
    (8, 'The site gave enough information to compare the sports and courts.'),
    (9, 'The court descriptions were helpful for planning a visit.'),
    (10, 'The reservation steps felt simple from start to finish.'),
    (11, 'I had trouble spotting the next step in the booking process.'),
    (12, 'Pricing was visible, but I wanted a clearer explanation of the full amount.'),
    (13, 'The menu and court information were reasonably easy to use.'),
    (14, 'The schedule view made it easier to choose a suitable slot.'),
    (15, 'The sports list and booking details were convenient to browse.'),
    (16, 'I would appreciate more prominent help when a slot is unavailable.'),
    (17, 'The booking page worked, though the confirmation details could stand out more.'),
    (18, 'The court options were presented clearly enough for a first visit.'),
    (19, 'The available schedules were easy to compare.'),
    (20, 'The overall flow felt organized and quick to understand.'),
    (21, 'I expected more context around court availability before choosing.'),
    (22, 'Some instructions could be shorter and easier to scan.'),
    (23, 'The booking information covered the main questions I had.'),
    (24, 'The court and rate details were laid out clearly.'),
    (25, 'The process gave a clear path from court selection to confirmation.'),
    (26, 'I would like clearer feedback when changing a selected time.'),
    (27, 'The site was usable, but a few details could be easier to locate.'),
    (28, 'The reservation information was easy to review before continuing.')
)
insert into public.customer_review (customer_id, rating, comment, is_sample, created_at)
select c.customer_id, (((c.rn - 1) % 5) + 1)::smallint, t.comment, true,
       now() - ((28 - c.rn) * interval '1 minute')
from numbered_customers c
join sample_text t on t.rn = c.rn
on conflict (customer_id) do nothing;

