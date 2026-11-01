-- Replace booking-bound reviews with one editable, public review per account.
-- Keep the latest legacy review for each account; older duplicates are obsolete
-- under the new one-review-per-account contract and are removed below.

create table if not exists public.customer_review (
    id uuid primary key default gen_random_uuid(),
    customer_id uuid not null unique references auth.users(id) on update cascade on delete cascade,
    rating smallint not null check (rating between 1 and 5),
    comment text null check (comment is null or (char_length(comment) <= 2000 and length(trim(comment)) > 0)),
    is_sample boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists customer_review_rating_created_idx
    on public.customer_review (rating, created_at desc, id desc);
create index if not exists customer_review_created_idx
    on public.customer_review (created_at desc, id desc);

alter table public.customer_review enable row level security;
revoke all on public.customer_review from public, anon, authenticated;
grant select (id, customer_id, rating, comment, is_sample, created_at, updated_at) on public.customer_review to authenticated;
grant insert (customer_id, rating, comment) on public.customer_review to authenticated;
grant update (rating, comment) on public.customer_review to authenticated;

drop policy if exists customer_review_customer_read on public.customer_review;
create policy customer_review_customer_read on public.customer_review
    for select to authenticated
    using (customer_id = (select auth.uid()));
drop policy if exists customer_review_customer_insert on public.customer_review;
create policy customer_review_customer_insert on public.customer_review
    for insert to authenticated
    with check (customer_id = (select auth.uid()) and internal.is_active_customer((select auth.uid())));
drop policy if exists customer_review_customer_update on public.customer_review;
create policy customer_review_customer_update on public.customer_review
    for update to authenticated
    using (customer_id = (select auth.uid()) and internal.is_active_customer((select auth.uid())))
    with check (customer_id = (select auth.uid()) and internal.is_active_customer((select auth.uid())));

-- Keep new private review reads and writes behind the same verified-email
-- session gate applied to existing private customer tables.
drop policy if exists email_mfa_required on public.customer_review;
create policy email_mfa_required on public.customer_review as restrictive
    for all to authenticated
    using (internal.has_verified_email_session())
    with check (internal.has_verified_email_session());

create or replace function public.prepare_customer_review()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if auth.uid() is not null then
        if new.customer_id <> auth.uid() or not internal.is_active_customer(auth.uid()) then
            raise exception 'Only the active customer account can edit this review' using errcode = '42501';
        end if;
        -- Authenticated customers can never mark their own review as a sample.
        new.is_sample := false;
    end if;

    new.comment := nullif(btrim(new.comment), '');
    if new.comment is not null then
        new.comment := regexp_replace(new.comment,
            '[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}', '[email removed]', 'gi');
        new.comment := regexp_replace(new.comment,
            '([+]?63|0)9[0-9[:space:].()/-]{7,}[0-9]', '[phone number removed]', 'g');
    end if;
    if tg_op = 'INSERT' then
        new.created_at := coalesce(new.created_at, now());
    end if;
    new.updated_at := now();
    return new;
end;
$$;
revoke all on function public.prepare_customer_review() from public, anon, authenticated;
drop trigger if exists customer_review_prepare on public.customer_review;
create trigger customer_review_prepare before insert or update on public.customer_review
for each row execute function public.prepare_customer_review();

-- Convert one real legacy review per account, preserving its id for a valid
-- featured selection. Prefer the newest row deterministically.
insert into public.customer_review (id, customer_id, rating, comment, is_sample, created_at, updated_at)
select id,
       customer_id,
       rating,
       nullif(btrim(regexp_replace(
           regexp_replace(comment, '[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}', '[email removed]', 'gi'),
           '([+]?63|0)9[0-9[:space:].()/-]{7,}[0-9]', '[phone number removed]', 'g')), ''),
       false,
       created_at,
       created_at
from (
    select r.id, r.customer_id, r.rating, r.comment, r.created_at,
           row_number() over (partition by r.customer_id order by r.created_at desc, r.id desc) as account_review_order
    from public.booking_review r
) ranked
where account_review_order = 1
on conflict (customer_id) do nothing;

create table if not exists public.public_customer_reviews (
    id uuid primary key references public.customer_review(id) on delete cascade,
    rating smallint not null check (rating between 1 and 5),
    comment text null check (comment is null or char_length(comment) <= 2000),
    is_sample boolean not null default false,
    created_at timestamptz not null,
    updated_at timestamptz not null
);
alter table public.public_customer_reviews enable row level security;
revoke all on public.public_customer_reviews from public, anon, authenticated;
grant select on public.public_customer_reviews to anon, authenticated;
drop policy if exists public_customer_reviews_read on public.public_customer_reviews;
create policy public_customer_reviews_read on public.public_customer_reviews
    for select to anon, authenticated using (true);

create or replace function public.publish_customer_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.public_customer_reviews (id, rating, comment, is_sample, created_at, updated_at)
    values (new.id, new.rating, new.comment, new.is_sample, new.created_at, new.updated_at)
    on conflict (id) do update set
        rating = excluded.rating,
        comment = excluded.comment,
        is_sample = excluded.is_sample,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at;
    return new;
end;
$$;
revoke all on function public.publish_customer_review() from public, anon, authenticated;
drop trigger if exists customer_review_publish on public.customer_review;
create trigger customer_review_publish after insert or update on public.customer_review
for each row execute function public.publish_customer_review();

insert into public.public_customer_reviews (id, rating, comment, is_sample, created_at, updated_at)
select id, rating, comment, is_sample, created_at, updated_at from public.customer_review
on conflict (id) do update set
    rating = excluded.rating, comment = excluded.comment, is_sample = excluded.is_sample,
    created_at = excluded.created_at, updated_at = excluded.updated_at;

-- The legacy selection may contain duplicate-account rows removed above.
-- Preserve it only if all three selected IDs still resolve to written reviews.
update public.owner_featured_review_selection s
set review_ids = null
where s.singleton = true
  and s.review_ids is not null
  and (
      cardinality(s.review_ids) <> 3
      or (select count(*) from public.public_customer_reviews r
          where r.id = any(s.review_ids) and nullif(btrim(r.comment), '') is not null) <> 3
  );

-- A selected review must remain written. If its owner edits the comment to
-- blank, clear the all-or-none selection; account deletion does the same.
create or replace function public.clear_invalid_featured_customer_reviews()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    -- Serialize invalidation with owner selection so concurrent comment edits
    -- cannot make a stale three-review selection win after this trigger.
    perform pg_advisory_xact_lock(174698, 1);
    if tg_op = 'DELETE' then
        update public.owner_featured_review_selection
        set review_ids = null
        where singleton = true and old.id = any(review_ids);
    elsif nullif(btrim(new.comment), '') is null then
        update public.owner_featured_review_selection
        set review_ids = null
        where singleton = true and old.id = any(review_ids);
    end if;
    return null;
end;
$$;
revoke all on function public.clear_invalid_featured_customer_reviews() from public, anon, authenticated;
drop trigger if exists customer_review_clear_featured_on_blank on public.customer_review;
create trigger customer_review_clear_featured_on_blank after update of comment on public.customer_review
for each row execute function public.clear_invalid_featured_customer_reviews();
drop trigger if exists customer_review_clear_featured_on_delete on public.customer_review;
create trigger customer_review_clear_featured_on_delete after delete on public.customer_review
for each row execute function public.clear_invalid_featured_customer_reviews();

create or replace function public.owner_save_featured_customer_reviews(p_review_ids uuid[])
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
    eligible_count integer;
begin
    if not internal.is_active_owner((select auth.uid())) then
        raise exception 'Only an active owner can select featured reviews' using errcode = '42501';
    end if;
    -- Use the same transaction lock as comment/delete invalidation triggers.
    perform pg_advisory_xact_lock(174698, 1);
    if p_review_ids is null or cardinality(p_review_ids) <> 3
       or array_position(p_review_ids, null) is not null
       or (select count(distinct ids.review_id) from unnest(p_review_ids) as ids(review_id)) <> 3 then
        raise exception 'Exactly three different reviews must be selected' using errcode = '22023';
    end if;
    select count(*) into eligible_count
    from public.public_customer_reviews r
    where r.id = any(p_review_ids) and nullif(btrim(r.comment), '') is not null;
    if eligible_count <> 3 then
        raise exception 'Each selected review must have a written public comment' using errcode = '22023';
    end if;
    insert into public.owner_featured_review_selection (singleton, review_ids)
    values (true, p_review_ids)
    on conflict (singleton) do update set review_ids = excluded.review_ids;
    return p_review_ids;
end;
$$;
revoke all on function public.owner_save_featured_customer_reviews(uuid[]) from public, anon, authenticated;
grant execute on function public.owner_save_featured_customer_reviews(uuid[]) to authenticated;
drop function if exists public.owner_save_featured_booking_reviews(uuid[]);

-- Keep the owner summary RPC operational after the legacy booking table is
-- removed. It reads only the new public-safe projection.
create or replace function public.owner_review_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    review_count bigint;
    average_rating numeric;
    rating_counts jsonb;
begin
    if (select auth.uid()) is null or not exists (
        select 1 from public.profiles p
        where p.id = (select auth.uid()) and p.role = 'admin' and coalesce(p.status, 'active') <> 'disabled'
    ) then
        raise exception 'Active owner access is required' using errcode = '42501';
    end if;

    select count(*), round(avg(rating)::numeric, 1),
           jsonb_build_object(
               '1', count(*) filter (where rating = 1),
               '2', count(*) filter (where rating = 2),
               '3', count(*) filter (where rating = 3),
               '4', count(*) filter (where rating = 4),
               '5', count(*) filter (where rating = 5)
           )
    into review_count, average_rating, rating_counts
    from public.public_customer_reviews;

    return jsonb_build_object(
        'average_rating', coalesce(average_rating, 0.0),
        'total_count', review_count,
        'star_counts', rating_counts
    );
end;
$$;
revoke all on function public.owner_review_summary() from public, anon;
grant execute on function public.owner_review_summary() to authenticated;

create or replace view public.public_featured_customer_reviews
with (security_invoker = true)
as
select r.rating, r.comment, r.is_sample, r.created_at, selected.ordinality::smallint as display_order
from public.owner_featured_review_selection s
cross join lateral unnest(s.review_ids) with ordinality as selected(review_id, ordinality)
join public.public_customer_reviews r on r.id = selected.review_id
where s.singleton = true;
revoke all on public.public_featured_customer_reviews from public, anon, authenticated;
grant select on public.public_featured_customer_reviews to anon, authenticated;

-- Keep unauthenticated-by-email sessions on the existing public GET surface,
-- replacing the obsolete booking review endpoints with account review reads.
create or replace function internal.enforce_email_mfa_pre_request()
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, auth, internal
as $$
declare
    v_role text := coalesce(auth.jwt()->>'role', '');
    v_path text := ltrim(coalesce(current_setting('request.path', true), ''), '/');
    v_method text := upper(coalesce(current_setting('request.method', true), 'GET'));
begin
    if v_role is distinct from 'authenticated' then return; end if;
    if internal.has_verified_email_session() then return; end if;
    if v_method in ('GET', 'HEAD') and v_path in (
        'profiles', 'app_settings', 'assets', 'court', 'court_unit_inventory',
        'court_unit_resource_map', 'event', 'physical_court_resource',
        'public_customer_reviews', 'public_featured_customer_reviews', 'sport', 'testimonial'
    ) then return; end if;
    if v_path in (
        'rpc/signup_email_availability', 'rpc/signup_phone_availability',
        'rpc/court_occupancy', 'rpc/booking_rules_for_date'
    ) then return; end if;
    raise sqlstate '42501' using message = 'Email verification required for this session.';
end;
$$;
revoke all on function internal.enforce_email_mfa_pre_request() from public, anon, authenticated;
grant execute on function internal.enforce_email_mfa_pre_request()
    to anon, authenticated, service_role, authenticator;
alter role authenticator set pgrst.db_pre_request = 'internal.enforce_email_mfa_pre_request';
notify pgrst, 'reload config';

drop view if exists public.my_booking_reviews;
drop view if exists public.owner_booking_reviews;
drop view if exists public.public_featured_booking_reviews;
drop table if exists public.public_booking_reviews;
drop table if exists public.booking_review;

comment on table public.customer_review is
    'One editable customer review per account, independent of booking history. is_sample marks synthetic demonstration content.';
comment on table public.public_customer_reviews is
    'Public-safe projection of customer reviews. Contains no account, booking, contact, or display-name identifiers; is_sample must be shown to visitors.';
comment on table public.owner_featured_review_selection is
    'Owner-controlled ordered selection of exactly three eligible public customer reviews; null indicates no selection.';
comment on view public.public_featured_customer_reviews is
    'Exactly the owner-selected public-safe customer review fields in display order, including the explicit sample marker.';
