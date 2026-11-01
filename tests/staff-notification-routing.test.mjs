import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20261102090000_staff_notification_record_targets.sql', import.meta.url), 'utf8');
const targetMigration = await readFile(new URL('../supabase/migrations/20261102100000_staff_notification_exact_transaction_targets.sql', import.meta.url), 'utf8');
const readStateMigration = await readFile(new URL('../supabase/migrations/20260929035843_staff_activity_announcements_notifications.sql', import.meta.url), 'utf8');
const js = await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');
const customerJs = await readFile(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
const staffOpenHandler = js.slice(js.indexOf("staffNotifList?.addEventListener('click', async event => {"), js.indexOf("document.addEventListener('inigosync:profile-ready'", js.indexOf("staffNotifList?.addEventListener('click', async event => {")));

test('staff notifications route to exact visible transaction or visit IDs', () => {
  assert.match(targetMigration, /when n\.category='ending_soon' and n\.key like 'ending-soon:%:%'[\s\S]*?transaction_id='\|\|a\.id::text[\s\S]*?a\.actor_id=p_user_id/i,
    'ending-soon links resolve to the exact time-in transaction visible to that staff account');
  assert.match(targetMigration, /\),\s*'#transactions\?view=transactions&no_transaction=1'\)/i,
    'ending-soon notices without a visible transaction open a safe explicit empty state');
  assert.match(targetMigration, /e\.source in \('booking','walkin'\) and nullif\(e\.source_id,''\) is not null[\s\S]*?view=unattended&visit_id='\|\|e\.source_id/i,
    'both booking and walk-in unattended events retain their exact reservation IDs');
  assert.match(js, /target\.hash\.split\('\?'\)\[0\]/);
  assert.match(js, /new URLSearchParams\(target\.hash\.split\('\?'\)\[1\] \|\| ''\)/);
  assert.match(js, /data-staff-tx-tab="\$\{targetView === 'unattended' \? 'unattended' : 'transactions'\}"/);
  assert.match(js, /txSearchInput\.value = exactTransactionId \|\| exactVisitId \|\| route\.get\('search'\) \|\| ''/);
  assert.match(js, /state\.exactIdField = 'transactionId'[\s\S]*?state\.exactId = exactTransactionId\.toLowerCase\(\)/);
  assert.match(js, /state\.exactIdField = 'visitId'[\s\S]*?state\.exactId = exactVisitId\.toLowerCase\(\)/);
  assert.match(js, /row\.dataset\[state\.exactIdField\] === state\.exactId/);
  assert.match(js, /tr\.dataset\.visitId = String\(row\.visit_id \?\? ''\)/);
  assert.match(js, /tr\.dataset\.transactionId = String\(row\.transaction_id \?\? ''\)\.toLowerCase\(\)/);
  assert.doesNotMatch(staffOpenHandler, /window\.open\(/, 'notification navigation stays in the staff dashboard without a popup');
});

test('customer and staff bell badges render numeric counts from durable feed responses', () => {
  assert.match(js, /staffNotifDot\.textContent = staffNotifUnreadCount > 99 \? '99\+' : String\(staffNotifUnreadCount\)/);
  assert.match(customerJs, /notifDot\.textContent = unreadCount > 99 \? '99\+' : String\(unreadCount\)/);
  assert.match(js, /rpc\('mark_notification_read', \{ p_key: item\.dataset\.staffNotifKey \}\)/);
  assert.match(customerJs, /rpc\('mark_notification_read', \{ p_key: key \}\)/);
  assert.match(readStateMigration, /create or replace function public\.mark_notification_read/i);
  assert.match(migration, /revoke all on function internal\.notification_feed\(uuid,text\) from public,anon,authenticated/i);
});
