import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20261017072914_scope_staff_notifications_to_staff_announcements.sql', import.meta.url), 'utf8');
const feed = migration.match(/create or replace function internal\.notification_feed\([\s\S]*?\$\$;/i)?.[0] || '';
const capture = migration.match(/create or replace function internal\.capture_due_account_notices\([\s\S]*?\$\$;/i)?.[0] || '';

test('staff notifications are published staff announcements authored by admins', () => {
  assert.ok(feed, 'notification feed replacement exists');
  assert.match(feed, /from internal\.app_announcements a[\s\S]*?join public\.profiles creator on creator\.id=a\.created_by/i);
  assert.match(feed, /a\.publish_at\s*<=\s*now\(\)/i);
  assert.match(feed, /p_role\s*=\s*'staff'\s+and a\.audience\s*=\s*'staff'\s+and creator\.role\s*=\s*'admin'/i);
  assert.match(feed, /p_role\s*=\s*'customer'[\s\S]*?a\.audience\s+in\s*\('both','customers'\)/i);
});

test('staff feed includes only staff maintenance notices beyond the approved announcements', () => {
  assert.match(feed, /from internal\.account_notice_events n\s+where \(p_role='staff' and n\.category='maintenance' and n\.audience='staff'\)/i);
  assert.match(feed, /case when n\.category='maintenance' then '#court-schedule'/i,
    'maintenance notifications target the staff dashboard schedule route');
  assert.match(feed, /from internal\.customer_operational_events e\s+where p_role='customer'/i);
  const activity = feed.match(/from internal\.customer_operational_events e[\s\S]*?\$\$;/i)?.[0] || '';
  assert.match(activity, /where p_role='customer'/i);
  assert.match(capture, /'maintenance','staff',now\(\),'#court-schedule'/i);
  assert.match(migration, /update internal\.account_notice_events\s+set audience='staff'\s+where category='maintenance'/i,
    'previously captured maintenance notices are made staff-only');
});

test('customer feeds exclude maintenance notices, including already captured events', () => {
  assert.match(feed, /p_role='customer' and n\.category<>'maintenance' and n\.audience in \('both','customers'\)/i);
  assert.match(migration, /where category='maintenance' and audience is distinct from 'staff'/i);
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
