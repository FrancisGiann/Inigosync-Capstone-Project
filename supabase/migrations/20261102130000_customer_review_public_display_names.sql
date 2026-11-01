-- Publish only a first name and last initial for each account review.
-- Public review rows keep no account identifier, full profile name, or contact field.

create or replace function internal.customer_review_public_display_name(
    p_full_name text,
    p_first_name text default null,
    p_last_name text default null
)
returns text
language sql
immutable
set search_path = ''
as $$
    with normalized as (
        select nullif(btrim(regexp_replace(coalesce(p_full_name, ''), '[[:space:]]+', ' ', 'g')), '') as full_name,
               nullif(btrim(regexp_replace(coalesce(p_first_name, ''), '[[:space:]]+', ' ', 'g')), '') as profile_first_name,
               nullif(btrim(regexp_replace(coalesce(p_last_name, ''), '[[:space:]]+', ' ', 'g')), '') as profile_last_name
    ), candidates as (
        select btrim(split_part(profile_first_name, ' ', 1), '.,') as profile_first_name,
               btrim(split_part(full_name, ' ', 1), '.,') as full_first_name,
               nullif(btrim(regexp_replace(full_name, '^.*[[:space:]]', ''), '.,'), full_name) as full_last_name,
               nullif(btrim(regexp_replace(profile_last_name, '^.*[[:space:]]', ''), '.,'), '') as structured_last_name
        from normalized
    ), parts as (
        select case
                   when profile_first_name ~ '^[[:alpha:]][[:alpha:][:digit:]''’.-]*$'
                    and profile_first_name !~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' then profile_first_name
                   when full_first_name ~ '^[[:alpha:]][[:alpha:][:digit:]''’.-]*$'
                    and full_first_name !~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' then full_first_name
               end as first_name,
               case when structured_last_name ~ '^[[:alpha:]][[:alpha:][:digit:]''’.-]*$'
                     and structured_last_name !~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' then structured_last_name
                    when full_last_name ~ '^[[:alpha:]][[:alpha:][:digit:]''’.-]*$'
                     and full_last_name !~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' then full_last_name
               end as last_name
        from candidates
    )
    select case
        when first_name is null then 'Customer'
        when last_name is null then first_name
        else first_name || ' ' || upper(left(last_name, 1)) || '.'
    end
    from parts;
$$;
revoke all on function internal.customer_review_public_display_name(text, text, text) from public, anon, authenticated;

alter table public.public_customer_reviews
    add column if not exists display_name text;

-- Backfill all currently published rows from their private account link. This
-- also updates the 28 synthetic sample rows without exposing that link publicly.
update public.public_customer_reviews published
set display_name = internal.customer_review_public_display_name(profile.full_name, profile.first_name, profile.last_name)
from public.customer_review review
left join public.profiles profile on profile.id = review.customer_id
where review.id = published.id;

update public.public_customer_reviews
set display_name = 'Customer'
where display_name is null or btrim(display_name) = '';

alter table public.public_customer_reviews
    alter column display_name set default 'Customer',
    alter column display_name set not null;
alter table public.public_customer_reviews
    add constraint public_customer_reviews_display_name_shape
    check (display_name ~ '^[[:alpha:]][[:alpha:][:digit:]''’.-]*( [[:alpha:]][.])?$'
       and display_name !~ '@'
       and display_name !~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
       and display_name !~ '^[+()0-9 .-]{7,}$');

create or replace function public.publish_customer_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_full_name text;
    v_first_name text;
    v_last_name text;
    v_display_name text;
begin
    select profile.full_name, profile.first_name, profile.last_name
      into v_full_name, v_first_name, v_last_name
    from public.profiles profile
    where profile.id = new.customer_id;
    v_display_name := internal.customer_review_public_display_name(v_full_name, v_first_name, v_last_name);

    insert into public.public_customer_reviews (id, rating, comment, is_sample, created_at, updated_at, display_name)
    values (new.id, new.rating, new.comment, new.is_sample, new.created_at, new.updated_at, v_display_name)
    on conflict (id) do update set
        rating = excluded.rating,
        comment = excluded.comment,
        is_sample = excluded.is_sample,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        display_name = excluded.display_name;
    return new;
end;
$$;
revoke all on function public.publish_customer_review() from public, anon, authenticated;

create or replace function public.sync_customer_review_public_display_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.public_customer_reviews published
    set display_name = internal.customer_review_public_display_name(new.full_name, new.first_name, new.last_name)
    from public.customer_review review
    where review.id = published.id
      and review.customer_id = new.id;
    return new;
end;
$$;
revoke all on function public.sync_customer_review_public_display_name() from public, anon, authenticated;
drop trigger if exists profiles_sync_customer_review_public_display_name on public.profiles;
create trigger profiles_sync_customer_review_public_display_name
after update of full_name, first_name, last_name on public.profiles
for each row
when (old.full_name is distinct from new.full_name
   or old.first_name is distinct from new.first_name
   or old.last_name is distinct from new.last_name)
execute function public.sync_customer_review_public_display_name();

create or replace view public.public_featured_customer_reviews
with (security_invoker = true)
as
select r.rating, r.comment, r.is_sample, r.created_at,
       selected.ordinality::smallint as display_order, r.display_name
from public.owner_featured_review_selection s
cross join lateral unnest(s.review_ids) with ordinality as selected(review_id, ordinality)
join public.public_customer_reviews r on r.id = selected.review_id
where s.singleton = true;
revoke all on public.public_featured_customer_reviews from public, anon, authenticated;
grant select on public.public_featured_customer_reviews to anon, authenticated;

comment on table public.public_customer_reviews is
    'Public-safe review projection. display_name contains only first name and last initial (or first name alone), never an account, booking, email, phone, or full-name identifier; is_sample must be shown to visitors.';
