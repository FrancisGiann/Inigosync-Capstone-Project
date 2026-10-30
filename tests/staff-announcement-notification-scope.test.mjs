import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20261030000000_staff_booking_notifications_and_ending_alerts.sql', import.meta.url), 'utf8');
const feed = migration.match(/create or replace function internal\.notification_feed\([\s\S]*?\$\$;/i)?.[0] || '';
const capture = migration.match(/create or replace function internal\.capture_due_account_notices\([\s\S]*?\$\$;/i)?.[0] || '';

test('staff notifications include only published admin announcements addressed to staff', () => {
  assert.ok(feed, 'notification feed replacement exists');
  assert.match(feed, /from internal\.app_announcements a[\s\S]*?join public\.profiles creator on creator\.id=a\.created_by/i);
  assert.match(feed, /a\.publish_at\s*<=\s*now\(\)/i);
  assert.match(feed, /p_role\s*=\s*'staff'\s+and a\.audience\s*=\s*'staff'/i);
  assert.doesNotMatch(feed, /p_role\s*=\s*'staff'\s+and a\.audience\s+in/i);
  assert.match(feed, /p_role\s*=\s*'customer' and a\.audience\s+in\s*\('both','customers'\)/i);
});

test('staff feed includes maintenance, ending-soon alerts, and unattended events only', () => {
  assert.match(feed, /from internal\.account_notice_events n\s+where p_role='staff' and n\.audience='staff'\s+and n\.category in \('maintenance','ending_soon'\)/i);
  assert.match(feed, /from internal\.customer_operational_events e\s+where p_role='staff' and e\.action='unattended'/i);
  assert.match(feed, /'activity:'\|\|e\.id::text[\s\S]*?'unattended',e\.created_at/i,
    'unattended event UUIDs provide stable read keys');
  assert.match(feed, /case when n\.category='maintenance' then '#court-schedule'/i,
    'staff maintenance alerts target the staff court schedule');
  assert.doesNotMatch(feed, /e\.action in\s*\([^)]*booking_created|e\.action in\s*\([^)]*payment_recorded/i,
    'ordinary booking and payment activity stays out of the staff feed');
  assert.match(feed, /from internal\.customer_maintenance_notices n[\s\S]*?where p_role='customer' and n\.customer_id=p_user_id/i,
    'customer maintenance notices remain scoped to their own bookings');
  assert.match(feed, /where p_role='customer' and r\.customer_id=p_user_id[\s\S]*?b\.status='confirmed'/i,
    'booking reminders remain limited to the customer who owns a confirmed booking');
});

test('capture persists deduplicated 10-minute end alerts for active online and walk-in bookings', () => {
  assert.ok(capture, 'scheduled notice capture replacement exists');
  assert.match(capture, /'ending-soon:booking:'\|\|b\.booking_id::text[\s\S]*?'ending_soon','staff'/i);
  assert.match(capture, /b\.status='confirmed' and b\.checked_in_at is not null and b\.checked_out_at is null[\s\S]*?b\.end_at>now\(\) and b\.end_at<=now\(\)\+interval '10 minutes'/i);
  assert.match(capture, /'ending-soon:walkin:'\|\|w\.walkin_id::text[\s\S]*?'ending_soon','staff'/i);
  assert.match(capture, /w\.status='confirmed' and w\.checked_in_at is not null and w\.checked_out_at is null[\s\S]*?w\.end_at>now\(\) and w\.end_at<=now\(\)\+interval '10 minutes'/i);
  assert.equal((capture.match(/on conflict\(key\) do nothing/gi) || []).length, 5,
    'all captured notices use their unique key so scheduled retries cannot duplicate them');
  assert.match(migration, /revoke all on function internal\.capture_due_account_notices\(\) from public,anon,authenticated/i);
});

test('customer announcement audience and notification read scoping are preserved', async () => {
  const baseMigration = await readFile(new URL('../supabase/migrations/20260929035843_staff_activity_announcements_notifications.sql', import.meta.url), 'utf8');
  assert.match(baseMigration, /cron\.schedule\('inigosync-publish-account-notices','\* \* \* \* \*',[\s\S]*?internal\.capture_due_account_notices\(\)/i,
    'the existing per-minute capture job continues to publish alerts');
  assert.match(feed, /p_role='customer' and a\.audience in \('both','customers'\)/i);
  assert.match(feed, /join public\.profiles creator on creator\.id=a\.created_by[\s\S]*?creator\.role='admin'/i);
  assert.match(migration, /revoke all on function internal\.notification_feed\(uuid,text\) from public,anon,authenticated/i);
  assert.match(baseMigration, /create or replace function public\.mark_notification_read[\s\S]*?internal\.notification_feed\(uid,account_role\)/i);
  assert.match(baseMigration, /create or replace function public\.staff_mark_all_notifications_read[\s\S]*?internal\.notification_feed\(uid,'staff'\)/i);
});

test('the admin announcement composer and separate owner activity/audit features remain available', async () => {
  const html = await readFile(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../Style/owner_dashboard.css', import.meta.url), 'utf8');
  const baseMigration = await readFile(new URL('../supabase/migrations/20260929035843_staff_activity_announcements_notifications.sql', import.meta.url), 'utf8');
  assert.match(html, /data-owner-announcement-form/);
  assert.match(html, /data-owner-announcement-audience/);
  assert.match(baseMigration, /create or replace function public\.owner_publish_announcement[\s\S]*?p\.role='admin'[\s\S]*?insert into internal\.app_announcements/i);
  assert.doesNotMatch(html, /data-admin-notif|data-owner-notification-modal/);
  assert.doesNotMatch(js, /refreshOwnerActivityNotifications|data-admin-notif|data-owner-notification-modal/);
  assert.doesNotMatch(css, /admin-notif|admin-badge-dot/);
  assert.match(js, /window\.InigoOwnerUI\.recordActivity\s*=\s*recordOwnerActivity/);
  assert.match(js, /owner_audit_trail/);
});

test('read state continues to consume the same staff-scoped notification feed', async () => {
  const baseMigration = await readFile(new URL('../supabase/migrations/20260929035843_staff_activity_announcements_notifications.sql', import.meta.url), 'utf8');
  assert.match(baseMigration, /create or replace function public\.staff_list_notifications[\s\S]*?list_account_notifications\('staff'/i);
  assert.match(baseMigration, /create or replace function public\.mark_notification_read[\s\S]*?internal\.notification_feed\(uid,account_role\)/i);
  assert.match(baseMigration, /create or replace function public\.staff_mark_all_notifications_read[\s\S]*?internal\.notification_feed\(uid,'staff'\)/i);
  assert.match(migration, /revoke all on function internal\.notification_feed\(uuid,text\) from public,anon,authenticated/i);
});
