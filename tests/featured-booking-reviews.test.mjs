import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [migration, displayNameMigration, legacyFeaturedMigration, optionalFeaturedMigration, ownerScript, ownerHtml, landingScript, dashboardScript, landingCss] = await Promise.all([
    readFile(new URL('../supabase/migrations/20261102120000_account_customer_reviews.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20261102130000_customer_review_public_display_names.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20261020022539_featured_booking_reviews.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20261102140000_optional_featured_customer_reviews.sql', import.meta.url), 'utf8'),
    readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8'),
    readFile(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8'),
    readFile(new URL('../includes/landing-reviews.js', import.meta.url), 'utf8'),
    readFile(new URL('../includes/Dashboard.js', import.meta.url), 'utf8'),
    readFile(new URL('../Style/LandingNight.css', import.meta.url), 'utf8'),
]);

test('account reviews are editable once per customer and publish only safe, sample-labeled fields', () => {
    assert.match(migration, /customer_id uuid not null unique references auth\.users\(id\)/i);
    assert.match(migration, /is_sample boolean not null default false/i);
    assert.match(migration, /create policy customer_review_customer_insert[\s\S]*customer_id = \(select auth\.uid\(\)\)/i);
    assert.match(migration, /create policy customer_review_customer_update[\s\S]*customer_id = \(select auth\.uid\(\)\)/i);
    assert.match(migration, /new\.is_sample := false/i);
    assert.match(migration, /create table if not exists public\.public_customer_reviews[\s\S]*is_sample boolean/i);
    const publicProjection = migration.slice(migration.indexOf('create table if not exists public.public_customer_reviews')).split(');')[0];
    assert.doesNotMatch(publicProjection, /customer_id|booking_id/i);
    assert.match(migration, /row_number\(\) over \(partition by r\.customer_id order by r\.created_at desc, r\.id desc\)/i);
    assert.match(migration, /drop table if exists public\.booking_review/i);
    assert.match(migration, /id uuid primary key references public\.customer_review\(id\) on delete cascade/i);
    assert.match(migration, /create policy email_mfa_required on public\.customer_review as restrictive[\s\S]*internal\.has_verified_email_session\(\)/i);
    assert.match(migration, /create trigger customer_review_clear_featured_on_blank after update of comment/i);
    assert.match(migration, /create trigger customer_review_clear_featured_on_delete after delete/i);
    assert.match(migration, /where singleton = true and old\.id = any\(review_ids\)/i);
    assert.match(migration, /perform pg_advisory_xact_lock\(174698, 1\)/i);
    const activeMfaHook = migration.match(/create or replace function internal\.enforce_email_mfa_pre_request\(\)[\s\S]*?\$\$;/i)?.[0] || '';
    assert.match(activeMfaHook, /'public_customer_reviews', 'public_featured_customer_reviews'/i);
    assert.doesNotMatch(activeMfaHook, /public_booking_reviews/i);
    const summaryFunction = migration.match(/create or replace function public\.owner_review_summary\(\)[\s\S]*?\$\$;/i)?.[0] || '';
    assert.match(summaryFunction, /from public\.public_customer_reviews/i);
    assert.doesNotMatch(summaryFunction, /booking_review/i);
    assert.match(dashboardScript, /\.update\(\{ rating: feedbackRating, comment: message \|\| null \}\)[\s\S]*?\.eq\('customer_id', window\.inigosyncProfile\.id\)/);
    assert.match(dashboardScript, /const payload = \{ customer_id: window\.inigosyncProfile\.id, rating: feedbackRating, comment: message \|\| null \};[\s\S]*?reviewTable\.insert\(payload\)/);
    assert.doesNotMatch(dashboardScript, /from\('booking_review'\)|my_booking_reviews|data-dash-review-booking/);
});

test('public account review names are minimized, backfilled, and kept in sync privately', () => {
    assert.match(displayNameMigration, /add column if not exists display_name text/i);
    assert.match(displayNameMigration, /update public\.public_customer_reviews published[\s\S]*?internal\.customer_review_public_display_name\(profile\.full_name, profile\.first_name, profile\.last_name\)/i);
    assert.match(displayNameMigration, /split_part\(profile_first_name, ' ', 1\)[\s\S]*?split_part\(full_name, ' ', 1\)[\s\S]*?regexp_replace\(full_name, '\^\.\*\[\[:space:\]\]'/i);
    assert.match(displayNameMigration, /profile_first_name ~ '\^\[\[:alpha:\]\]\[\[:alpha:\]\[:digit:\]''’\.\-\]\*\$'/i);
    assert.match(displayNameMigration, /case when structured_last_name ~[\s\S]*?then structured_last_name[\s\S]*?when full_last_name ~/i);
    assert.match(displayNameMigration, /upper\(left\(last_name, 1\)\)/i);
    assert.match(displayNameMigration, /display_name !~ '@'/i);
    assert.match(displayNameMigration, /display_name !~\* '\^\[0-9a-f\]\{8\}/i);
    assert.match(displayNameMigration, /display_name !~ '\^\[\+\(\)0-9 \.\-\]\{7,\}\$'/i);
    assert.match(displayNameMigration, /after update of full_name, first_name, last_name on public\.profiles/i);
    assert.match(displayNameMigration, /security definer[\s\S]*?set search_path = ''/i);
    assert.match(displayNameMigration, /revoke all on function public\.sync_customer_review_public_display_name\(\) from public, anon, authenticated/i);
    assert.match(displayNameMigration, /security_invoker = true[\s\S]*?r\.display_name/i);
    assert.doesNotMatch(displayNameMigration.match(/create or replace view public\.public_featured_customer_reviews[\s\S]*?where s\.singleton = true;/i)?.[0] || '', /customer_id|booking_id|full_name|email/i);
});

test('featured review persistence is owner-only and accepts up to three distinct written public reviews', () => {
    assert.match(legacyFeaturedMigration, /alter table public\.owner_featured_review_selection enable row level security/i);
    assert.match(legacyFeaturedMigration, /check \(review_ids is null or cardinality\(review_ids\) = 3\)/i);
    assert.match(migration, /internal\.is_active_owner\(\(select auth\.uid\(\)\)\)/i);
    assert.match(optionalFeaturedMigration, /check \(review_ids is null or cardinality\(review_ids\) between 0 and 3\)/i);
    assert.match(optionalFeaturedMigration, /requested_ids uuid\[\] := coalesce\(p_review_ids, '\{\}'::uuid\[\]\)/i);
    assert.match(optionalFeaturedMigration, /requested_count > 3/i);
    assert.match(optionalFeaturedMigration, /count\(distinct ids\.review_id\)[\s\S]*?<> requested_count/i);
    assert.match(optionalFeaturedMigration, /eligible_count <> requested_count/i);
    assert.match(optionalFeaturedMigration, /nullif\(btrim\(r\.comment\), ''\) is not null/i);
    assert.match(optionalFeaturedMigration, /revoke all on function public\.owner_save_featured_customer_reviews\(uuid\[\]\) from public, anon, authenticated/i);
    assert.match(optionalFeaturedMigration, /grant execute on function public\.owner_save_featured_customer_reviews\(uuid\[\]\) to authenticated/i);
    assert.match(optionalFeaturedMigration, /set review_ids = array_remove\(review_ids, old\.id\)/i);
    assert.match(optionalFeaturedMigration, /internal\.is_active_owner\(\(select auth\.uid\(\)\)\)/i);
    assert.match(migration, /security_invoker = true/i);
});

test('owner picker allows removing selected reviews and confirms any changed selection', () => {
    assert.match(ownerHtml, /data-featured-review-open disabled/);
    assert.match(ownerHtml, /role="dialog" aria-modal="true" aria-labelledby="featuredReviewModalTitle"/);
    assert.match(ownerHtml, /data-featured-review-slots/);
    assert.match(ownerHtml, /<h4 id="ownerReviewBrowserTitle">All customer reviews<\/h4>/);
    assert.match(ownerHtml, /data-owner-review-list/);
    assert.match(ownerHtml, /data-owner-review-rating="all"/);
    assert.doesNotMatch(ownerHtml, /<h3>Featured booking reviews<\/h3>/);
    assert.doesNotMatch(ownerHtml, /Choose exactly three public booking reviews/);
    assert.match(ownerHtml, /data-featured-review-save disabled/);
    assert.match(ownerHtml, /data-featured-review-chips/);
    assert.match(ownerHtml, /data-featured-review-clear/);
    assert.match(ownerScript, /data-featured-review-remove/);
    assert.match(ownerScript, /!featuredSelectionChanged\(\) \|\| savingFeaturedReviews/);
    assert.match(ownerScript, /idsToSave\.length[\s\S]*remove all featured reviews[\s\S]*Customer feedback will remain saved/i);
    assert.match(ownerScript, /featuredSelectionChanged\(\)/);
    assert.match(ownerScript, /Discard review changes\?/);
    assert.match(ownerScript, /Save homepage reviews\?/);
    assert.match(ownerScript, /window\.InigoOwnerUI\?\.close\(reviewModal\)/);
    assert.match(ownerScript, /owner_save_featured_customer_reviews/);
    assert.match(ownerScript, /review\.comment\.trim\(\)\.length > 0/);
    assert.match(ownerScript, /async function loadOwnerReviewBrowser\(force = false\)/);
    assert.match(ownerScript, /\(!force && ownerReviewBrowserLoading\) \|\| \(!force && ownerReviewBrowserLoaded\)/);
    assert.match(ownerScript, /event\.detail === 'feedback'[\s\S]*?loadOwnerReviewBrowser\(true\)/);
    assert.match(ownerScript, /from\('public_customer_reviews'\)\.select\('id,rating,comment,is_sample,created_at,display_name', \{ count: 'exact' \}\)[\s\S]*?ownerReviewBrowserPage \* REVIEW_PAGE_SIZE/);
    assert.match(ownerScript, /window\.escapeHtml\(review\.display_name \|\| 'Customer'\)/);
    assert.doesNotMatch(ownerScript, /owner-review-sample-badge|Sample review/);
    assert.doesNotMatch(ownerHtml, /Sample entries are labeled/);
    assert.match(ownerScript, /owner-featured-review-slot[\s\S]*?review\.display_name \|\| 'Customer'/);
    assert.match(ownerScript, /No written comment/);
    assert.match(ownerScript, /data-owner-review-rating/);
    assert.doesNotMatch(ownerScript, /from\('feedback'\)/);
    assert.doesNotMatch(ownerHtml, /data-owner-direct-feedback|Direct customer feedback/);
});

test('landing page defaults to the saved selection and browses only public review fields', () => {
    assert.match(landingScript, /from\('public_featured_customer_reviews'\)/);
    assert.match(landingScript, /order\('display_order', \{ ascending: true \}\)/);
    assert.match(landingScript, /from\('public_customer_reviews'\)\.select\('rating,comment,is_sample,created_at,display_name'\)/);
    assert.match(landingScript, /sourceLabel\.textContent = review\.display_name \|\| 'Customer'/);
    assert.doesNotMatch(landingScript, /onsite-review-sample-badge/);
    assert.match(landingScript, /readMore\.hidden = quote\.scrollHeight <= quote\.clientHeight \+ 1/);
    assert.match(landingScript, /dialogClose\.setAttribute\('aria-label', 'Close full review'\)/);
    assert.match(landingScript, /\.range\(offset, offset \+ PAGE_SIZE - 1\)/);
    assert.match(landingScript, /\.eq\('rating'/);
    assert.match(landingScript, /max-width: 700px[\s\S]*max-width: 900px/);
    assert.match(landingScript, /if \(position \+ count < featuredReviews\.length\)[\s\S]*position \+= 1/);
    assert.match(landingScript, /position === 0 && \(!browsing \|\| Boolean\(selectedRating\)\)/);
    assert.match(landingScript, /if \(!selectedRating\)[\s\S]*incoming = incoming\.filter\(review => !featuredKeys\.has\(reviewKey\(review\)\)\)/);
    assert.match(landingScript, /order\('created_at', \{ ascending: false \}\)/);
    assert.match(landingScript, /next\?\.addEventListener/);
    assert.match(landingScript, /previous\?\.addEventListener/);
    assert.match(landingScript, /No written comment\./);
    assert.match(landingScript, /There are no additional public reviews beyond the featured picks\./);
    assert.match(landingScript, /There are no public \$\{selectedRating\}-star reviews yet\./);
    assert.doesNotMatch(landingScript, /select\([^)]*(customer_id|booking_id|full_name|email)/);
    assert.match(landingScript, /No featured reviews yet/);
});

test('landing review controls use a rating strip and bounded carousel without legacy filters', async () => {
    const landingHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    assert.match(landingHtml, /data-review-rating="5"[\s\S]*data-review-rating="1"/);
    assert.match(landingHtml, /data-review-all[^>]*aria-pressed="true">All/);
    assert.match(landingHtml, /Filter by rating:/);
    assert.match(landingHtml, /Some feedback here is generated presentation content\./);
    assert.doesNotMatch(landingHtml, /Verified booking reviews|Verified customer/);
    assert.match(landingHtml, /onsite-review-carousel[\s\S]*data-review-previous[\s\S]*data-onsite-review-grid[\s\S]*data-review-next/);
    assert.doesNotMatch(landingHtml, /data-review-mode|data-review-rating-filter|data-review-load-more/);
    assert.match(landingCss, /body\.landing-night::before\s*\{[^}]*z-index:\s*-1;/);
    assert.match(landingCss, /\.landing-night \.about-story-band\s*\{[^}]*background:/);
    assert.match(landingCss, /\.landing-night \.site-footer\s*\{[^}]*background:/);
    assert.match(landingHtml, /<div class="footer-grid">[\s\S]*?<div class="footer-map-block"/);
});
