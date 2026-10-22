import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [migration, ownerScript, ownerHtml, landingScript] = await Promise.all([
    readFile(new URL('../supabase/migrations/20261020022539_featured_booking_reviews.sql', import.meta.url), 'utf8'),
    readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8'),
    readFile(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8'),
    readFile(new URL('../includes/landing-reviews.js', import.meta.url), 'utf8'),
]);

test('featured review persistence is owner-only and accepts exactly three distinct written public reviews', () => {
    assert.match(migration, /alter table public\.owner_featured_review_selection enable row level security/i);
    assert.match(migration, /check \(review_ids is null or cardinality\(review_ids\) = 3\)/i);
    assert.match(migration, /internal\.is_active_owner\(\(select auth\.uid\(\)\)\)/i);
    assert.match(migration, /cardinality\(p_review_ids\) <> 3/i);
    assert.match(migration, /count\(distinct ids\.review_id\)[\s\S]*?<> 3/i);
    assert.match(migration, /nullif\(btrim\(r\.comment\), ''\) is not null/i);
    assert.match(migration, /revoke all on function public\.owner_save_featured_booking_reviews\(uuid\[\]\) from public, anon, authenticated/i);
    assert.match(migration, /grant execute on function public\.owner_save_featured_booking_reviews\(uuid\[\]\) to authenticated/i);
    assert.match(migration, /security_invoker = true/i);
});

test('owner picker uses an accessible modal and confirms changed selections at exactly three', () => {
    assert.match(ownerHtml, /data-featured-review-open disabled/);
    assert.match(ownerHtml, /role="dialog" aria-modal="true" aria-labelledby="featuredReviewModalTitle"/);
    assert.match(ownerHtml, /data-featured-review-slots/);
    assert.match(ownerHtml, /<h4 id="ownerReviewBrowserTitle">All customer reviews<\/h4>/);
    assert.match(ownerHtml, /data-owner-review-list/);
    assert.match(ownerHtml, /data-owner-review-rating="all"/);
    assert.doesNotMatch(ownerHtml, /<h3>Featured booking reviews<\/h3>/);
    assert.doesNotMatch(ownerHtml, /Choose exactly three public booking reviews/);
    assert.match(ownerHtml, /data-featured-review-save disabled/);
    assert.match(ownerScript, /draftFeaturedReviewIds\.length !== 3/);
    assert.match(ownerScript, /featuredSelectionChanged\(\)/);
    assert.match(ownerScript, /Discard review changes\?/);
    assert.match(ownerScript, /Save featured reviews\?/);
    assert.match(ownerScript, /window\.InigoOwnerUI\?\.close\(reviewModal\)/);
    assert.match(ownerScript, /owner_save_featured_booking_reviews/);
    assert.match(ownerScript, /review\.comment\.trim\(\)\.length > 0/);
    assert.match(ownerScript, /async function loadOwnerReviewBrowser\(force = false\)/);
    assert.match(ownerScript, /\(!force && ownerReviewBrowserLoading\) \|\| \(!force && ownerReviewBrowserLoaded\)/);
    assert.match(ownerScript, /event\.detail === 'feedback'[\s\S]*?loadOwnerReviewBrowser\(true\)/);
    assert.match(ownerScript, /from\('public_booking_reviews'\)\.select\('id,rating,comment,created_at', \{ count: 'exact' \}\)[\s\S]*?ownerReviewBrowserPage \* REVIEW_PAGE_SIZE/);
    assert.match(ownerScript, /No written comment/);
    assert.match(ownerScript, /data-owner-review-rating/);
    assert.doesNotMatch(ownerScript, /from\('feedback'\)/);
    assert.doesNotMatch(ownerHtml, /data-owner-direct-feedback|Direct customer feedback/);
});

test('landing page reads only the saved public selection in display order', () => {
    assert.match(landingScript, /from\('public_featured_booking_reviews'\)/);
    assert.match(landingScript, /order\('display_order', \{ ascending: true \}\)/);
    assert.doesNotMatch(landingScript, /from\('public_booking_reviews'\)/);
    assert.match(landingScript, /No featured reviews yet/);
});
