-- First-party reviews are tied to a fully paid, completed customer booking.
-- The private table holds the booking/customer link; public reads go through
-- a projection that never exposes booking IDs or customer account details.
create table if not exists public.booking_review (
    id uuid primary key default gen_random_uuid(),
    booking_id bigint not null unique references public.booking(booking_id) on update cascade on delete restrict,
    customer_id uuid not null references auth.users(id) on update cascade on delete cascade,
    display_name text not null,
    rating smallint not null check (rating between 1 and 5),
    comment text null check (comment is null or char_length(comment) <= 2000),
    created_at timestamptz not null default now()
);

create index if not exists booking_review_rating_created_idx
    on public.booking_review (rating, created_at desc, id desc);
create index if not exists booking_review_created_idx
    on public.booking_review (created_at desc, id desc);

alter table public.booking_review enable row level security;
revoke all on table public.booking_review from public, anon, authenticated;
grant insert (booking_id, rating, comment) on public.booking_review to authenticated;

create or replace function public.prepare_booking_review()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
    v_customer_id uuid;
    v_status text;
    v_total numeric;
    v_paid numeric;
    v_full_name text;
    v_first_name text;
    v_last_initial text;
begin
    if auth.uid() is null then
        raise exception 'Sign in with the booking account to submit a review' using errcode = '42501';
    end if;

    select b.customer_id, b.status, b.amount_total, b.amount_paid, p.full_name
      into v_customer_id, v_status, v_total, v_paid, v_full_name
    from public.booking b
    left join public.profiles p on p.id = b.customer_id
    where b.booking_id = new.booking_id;

    if not found or v_customer_id <> auth.uid() then
        raise exception 'This booking is not available for review' using errcode = '42501';
    end if;
    if v_status <> 'completed' or v_total is null or v_total <= 0 or coalesce(v_paid, 0) < v_total then
        raise exception 'A completed, fully paid booking is required to review' using errcode = '23514';
    end if;

    v_full_name := nullif(btrim(v_full_name), '');
    v_first_name := coalesce(nullif(split_part(v_full_name, ' ', 1), ''), 'Verified customer');
    v_last_initial := left(nullif(split_part(v_full_name, ' ', 2), ''), 1);

    new.customer_id := auth.uid();
    new.display_name := case when v_last_initial is null then v_first_name else v_first_name || ' ' || v_last_initial || '.' end;
    new.comment := nullif(btrim(new.comment), '');
    if new.comment is not null then
        new.comment := regexp_replace(new.comment,
            '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}', '[email removed]', 'gi');
        new.comment := regexp_replace(new.comment,
            '(\\+?63|0)9[0-9[:space:].()/-]{7,}[0-9]', '[phone number removed]', 'g');
    end if;
    new.created_at := now();
    return new;
end;
$$;

revoke all on function public.prepare_booking_review() from public, anon, authenticated;

drop trigger if exists booking_review_prepare on public.booking_review;
create trigger booking_review_prepare
before insert on public.booking_review
for each row execute function public.prepare_booking_review();

drop policy if exists booking_review_customer_insert on public.booking_review;
create policy booking_review_customer_insert on public.booking_review
    for insert to authenticated
    with check (
        customer_id = (select auth.uid())
        and exists (
            select 1
            from public.booking b
            where b.booking_id = booking_review.booking_id
              and b.customer_id = (select auth.uid())
              and b.status = 'completed'
              and b.amount_total > 0
              and b.amount_paid >= b.amount_total
        )
    );

drop policy if exists booking_review_customer_or_admin_read on public.booking_review;
create policy booking_review_customer_or_admin_read on public.booking_review
    for select to authenticated
    using (
        customer_id = (select auth.uid())
        or (
            public.inigosync_is_admin()
            and exists (
                select 1 from public.profiles p
                where p.id = (select auth.uid()) and p.role = 'admin' and p.status <> 'disabled'
            )
        )
    );

create or replace view public.owner_booking_reviews
with (security_barrier = true)
as
select r.id, r.booking_id, r.display_name, r.rating, r.comment, r.created_at
from public.booking_review r
where public.inigosync_is_admin()
  and exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.role = 'admin' and p.status <> 'disabled'
  );

create or replace view public.public_booking_reviews
with (security_barrier = true)
as
select r.id, r.display_name, r.rating, r.comment, r.created_at
from public.booking_review r;

create or replace view public.my_booking_reviews
with (security_barrier = true)
as
select r.booking_id
from public.booking_review r
where r.customer_id = (select auth.uid());

revoke all on public.owner_booking_reviews, public.public_booking_reviews, public.my_booking_reviews from public, anon, authenticated;
grant select on public.owner_booking_reviews to authenticated;
grant select on public.public_booking_reviews to anon, authenticated;
grant select on public.my_booking_reviews to authenticated;

comment on table public.booking_review is
    'One immutable on-site review per completed, fully paid customer booking. Public access is through public_booking_reviews, which contains no account or booking identifiers.';
