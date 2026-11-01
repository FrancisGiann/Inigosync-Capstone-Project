-- Read-only checks to run after applying
-- 20261102120000_account_customer_reviews.sql in a disposable database.
-- Expected before sample seeding: legacy review conversion preserves the
-- distinct-customer count; the supplied live baseline was zero legacy rows.

select
    (select count(*) from public.customer_review) as private_reviews,
    (select count(*) from public.customer_review where is_sample) as sample_reviews,
    (select count(*) from public.public_customer_reviews) as public_reviews,
    (select count(*) from public.public_customer_reviews where is_sample) as public_samples;

select rating, count(*) as review_count, count(*) filter (where is_sample) as sample_count
from public.customer_review
group by rating
order by rating;

-- FK-backed publication must leave no private review without a public row and
-- no public row without its authoritative private review.
select
    (select count(*) from public.customer_review private
     left join public.public_customer_reviews public on public.id = private.id
     where public.id is null) as unpublished_reviews,
    (select count(*) from public.public_customer_reviews public
     left join public.customer_review private on private.id = public.id
     where private.id is null) as orphaned_public_rows;

-- A configured selection is all-or-none and every selected record is written.
select s.review_ids,
       cardinality(s.review_ids) as selected_count,
       count(r.id) filter (where nullif(btrim(r.comment), '') is not null) as written_selected_count
from public.owner_featured_review_selection s
left join lateral unnest(s.review_ids) selected(review_id) on true
left join public.public_customer_reviews r on r.id = selected.review_id
where s.singleton = true
group by s.review_ids;

-- Confirm the owner summary and active MFA hook reference the current model.
select pg_get_functiondef('public.owner_review_summary()'::regprocedure) as owner_review_summary_definition;
select pg_get_functiondef('internal.enforce_email_mfa_pre_request()'::regprocedure) as active_mfa_hook_definition;

-- Confirm the private table has both own-account and restrictive MFA policies.
select policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'customer_review'
order by policyname;

-- Disposable-database behavior cases to exercise as authenticated roles:
-- 1. An active customer with no booking can insert one review; a second upsert
--    changes the same customer_review row and public projection row.
-- 2. A different customer cannot read or update that row. A customer without
--    a verified-email session cannot use the private table.
-- 3. An owner can save exactly three distinct written review IDs; duplicate,
--    missing, rating-only, or non-owner selections are rejected.
-- 4. If a selected customer changes comment to NULL/blank, selection becomes
--    NULL in the same transaction. Deleting that customer removes the public
--    projection through its FK and also clears the featured selection.
-- 5. A service-role sample insert with is_sample=true appears in the public
--    projection marked true; an authenticated customer cannot set that flag.
