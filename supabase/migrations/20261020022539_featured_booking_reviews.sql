-- Store the owner's ordered selection of exactly three written public
-- booking reviews. Null means the owner has not made a selection yet.
create table public.owner_featured_review_selection (
    singleton boolean primary key default true check (singleton),
    review_ids uuid[] null,
    constraint owner_featured_review_selection_exactly_three
        check (review_ids is null or cardinality(review_ids) = 3)
);

alter table public.owner_featured_review_selection enable row level security;
revoke all on public.owner_featured_review_selection from public, anon, authenticated;
grant select on public.owner_featured_review_selection to anon, authenticated;
create policy owner_featured_review_selection_public_read
    on public.owner_featured_review_selection for select to anon, authenticated
    using (true);

create or replace function public.owner_save_featured_booking_reviews(p_review_ids uuid[])
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

    if p_review_ids is null
       or cardinality(p_review_ids) <> 3
       or array_position(p_review_ids, null) is not null
       or (select count(distinct ids.review_id) from unnest(p_review_ids) as ids(review_id)) <> 3 then
        raise exception 'Exactly three different reviews must be selected' using errcode = '22023';
    end if;

    select count(*) into eligible_count
    from public.public_booking_reviews r
    where r.id = any (p_review_ids)
      and nullif(btrim(r.comment), '') is not null;

    if eligible_count <> 3 then
        raise exception 'Each selected review must have a written public comment' using errcode = '22023';
    end if;

    insert into public.owner_featured_review_selection (singleton, review_ids)
    values (true, p_review_ids)
    on conflict (singleton) do update set review_ids = excluded.review_ids;

    return p_review_ids;
end;
$$;
revoke all on function public.owner_save_featured_booking_reviews(uuid[]) from public, anon, authenticated;
grant execute on function public.owner_save_featured_booking_reviews(uuid[]) to authenticated;

create or replace view public.public_featured_booking_reviews
with (security_invoker = true)
as
select r.rating, r.comment, r.created_at, selected.ordinality::smallint as display_order
from public.owner_featured_review_selection s
cross join lateral unnest(s.review_ids) with ordinality as selected(review_id, ordinality)
join public.public_booking_reviews r on r.id = selected.review_id
where s.singleton = true;

revoke all on public.public_featured_booking_reviews from public, anon, authenticated;
grant select on public.public_featured_booking_reviews to anon, authenticated;

comment on table public.owner_featured_review_selection is
    'Owner-controlled ordered set of exactly three eligible public booking review ids; null indicates no selection.';
comment on view public.public_featured_booking_reviews is
    'The three owner-selected public review fields needed by the landing page, in the chosen order.';
