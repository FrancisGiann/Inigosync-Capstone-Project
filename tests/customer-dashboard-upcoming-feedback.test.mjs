import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const html = await readFile(new URL('../Pages/user_dashboard.html', import.meta.url), 'utf8');
const ownerHtml = await readFile(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../Style/Dashboard.css', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
const ownerDashboard = await readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');
const upcomingSource = await readFile(new URL('../includes/dashboardUpcoming.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261004085347_customer_feedback.sql', import.meta.url), 'utf8');

const helperContext = { window: {} };
runInNewContext(upcomingSource, helperContext);
const upcoming = helperContext.window.InigoDashboardUpcoming;

test('upcoming preview returns only pending/confirmed future bookings, nearest first', () => {
    const now = Date.parse('2026-10-04T00:00:00Z');
    const rows = [
        { id: 'later', status: 'confirmed', time_date: '2026-10-06T10:00:00Z' },
        { id: 'cancelled', status: 'cancelled', time_date: '2026-10-04T10:00:00Z' },
        { id: 'past', status: 'confirmed', time_date: '2026-10-03T10:00:00Z' },
        { id: 'first', status: 'pending', time_date: '2026-10-04T01:00:00Z' },
        { id: 'complete', status: 'completed', time_date: '2026-10-04T02:00:00Z' },
        { id: 'invalid', status: 'confirmed', time_date: 'not-a-date' },
    ];
    assert.deepEqual(Array.from(upcoming.selectUpcomingReservations(rows, now), row => row.id), ['first', 'later']);
});

test('Show more reveals five at a time and stops at the result count', () => {
    assert.equal(upcoming.nextVisibleCount(5, 12, 5), 10);
    assert.equal(upcoming.nextVisibleCount(10, 12, 5), 12);
    assert.equal(upcoming.nextVisibleCount(5, 5, 5), 5);
});

test('customer bookings are loaded through an account-scoped query and retryable states are wired', () => {
    assert.match(dashboard, /\.from\('booking'\)[\s\S]*?\.eq\('customer_id',\s*window\.inigosyncProfile\.id\)/);
    assert.match(dashboard, /data-dash-upcoming-retry/);
    assert.match(dashboard, /renderUpcomingReservations\(null, true\)/);
    assert.match(html, /data-dash-upcoming-list[\s\S]*?Loading your reservations/);
    assert.match(html, /data-dash-upcoming-more[^>]*>Show more<\/button>/);
});

test('feedback schema restricts customer inserts to the active authenticated customer and owner reads to staff/admin', () => {
    assert.match(migration, /alter table public\.feedback enable row level security/i);
    assert.match(migration, /profile_id\s*=\s*\(select auth\.uid\(\)\)[\s\S]*?internal\.is_active_customer\(\(select auth\.uid\(\)\)\)/i);
    assert.match(migration, /feedback_customer_select_own[\s\S]*?using\s*\(profile_id\s*=\s*\(select auth\.uid\(\)\)\)/i);
    assert.match(migration, /feedback_staff_select_all[\s\S]*?public\.inigosync_is_staff_or_admin\(\)/i);
    assert.match(migration, /revoke all on public\.feedback from public, anon/i);
    assert.match(ownerDashboard, /\.from\('feedback'\)[\s\S]*?\.select\('id,rating,message,created_at'/);
    assert.match(ownerDashboard, /window\.escapeHtml\(entry\.message \|\| ''\)/);
    assert.match(ownerDashboard, /count\s*>\s*ownerFeedbackVisibleCount|\(count \|\| 0\) <= ownerFeedbackVisibleCount/);
    assert.match(dashboard, /\.from\('feedback'\)\.insert\([\s\S]*?profile_id:\s*window\.inigosyncProfile\.id/);
    assert.match(dashboard, /finally\s*\{\s*feedbackSubmitBtn\.disabled = false/);
});

test('dashboard presentation controls remain scoped and remove obsolete overview/search actions', () => {
    assert.match(css, /\.dash-hero-image\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/s);
    assert.match(css, /\.dash-hero-image\s*\{[^}]*object-fit:\s*contain/s);
    assert.doesNotMatch(html, /Book this slot|Search notifications|data-dash-notif-search|Review on Google/);
    assert.doesNotMatch(html, /data-dash-panel="overview"[\s\S]*?Courts section/);
    assert.match(dashboard, /dashTopbar\.classList\.add\('is-hidden'\)/);
    assert.match(dashboard, /dashTopbar\.classList\.remove\('is-hidden'\)/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(ownerHtml, /data-owner-direct-feedback/);
});
