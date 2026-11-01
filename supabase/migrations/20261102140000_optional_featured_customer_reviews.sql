-- The owner may feature zero to three written public customer reviews.
-- Existing valid selections (including the current three) remain unchanged.
alter table public.owner_featured_review_selection
    drop constraint if exists owner_featured_review_selection_exactly_three;
alter table public.owner_featured_review_selection
    add constraint owner_featured_review_selection_up_to_three
    check (review_ids is null or cardinality(review_ids) between 0 and 3);

-- Keep the remaining selected reviews if one comment becomes blank or a
-- customer deletes their review. The feedback row itself is never deleted by
-- owner selection changes.
create or replace function public.clear_invalid_featured_customer_reviews()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform pg_advisory_xact_lock(174698, 1);
    if tg_op = 'DELETE' then
        update public.owner_featured_review_selection
        set review_ids = array_remove(review_ids, old.id)
        where singleton = true and old.id = any(review_ids);
    elsif nullif(btrim(new.comment), '') is null then
        update public.owner_featured_review_selection
        set review_ids = array_remove(review_ids, old.id)
        where singleton = true and old.id = any(review_ids);
    end if;
    return null;
end;
$$;
revoke all on function public.clear_invalid_featured_customer_reviews() from public, anon, authenticated;

create or replace function public.owner_save_featured_customer_reviews(p_review_ids uuid[])
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
    requested_ids uuid[] := coalesce(p_review_ids, '{}'::uuid[]);
    requested_count integer;
    eligible_count integer;
begin
    if not internal.is_active_owner((select auth.uid())) then
        raise exception 'Only an active owner can select featured reviews' using errcode = '42501';
    end if;

    -- Serialize with invalidation triggers so a concurrent review edit or
    -- deletion cannot leave an invalid selected ID after this write.
    perform pg_advisory_xact_lock(174698, 1);
    requested_count := cardinality(requested_ids);
    if coalesce(array_ndims(requested_ids), 1) <> 1
       or requested_count > 3
       or array_position(requested_ids, null) is not null
       or (select count(distinct ids.review_id) from unnest(requested_ids) as ids(review_id)) <> requested_count then
        raise exception 'Up to three different reviews may be selected' using errcode = '22023';
    end if;

    select count(*) into eligible_count
    from public.public_customer_reviews r
    where r.id = any(requested_ids) and nullif(btrim(r.comment), '') is not null;
    if eligible_count <> requested_count then
        raise exception 'Each selected review must have a written public comment' using errcode = '22023';
    end if;

    insert into public.owner_featured_review_selection (singleton, review_ids)
    values (true, requested_ids)
    on conflict (singleton) do update set review_ids = excluded.review_ids;
    return requested_ids;
end;
$$;
revoke all on function public.owner_save_featured_customer_reviews(uuid[]) from public, anon, authenticated;
grant execute on function public.owner_save_featured_customer_reviews(uuid[]) to authenticated;

comment on table public.owner_featured_review_selection is
    'Owner-controlled ordered set of zero to three eligible public customer review IDs; null or empty indicates no selection.';
comment on view public.public_featured_customer_reviews is
    'The owner-selected public review fields needed by the landing page, in the chosen order.';
