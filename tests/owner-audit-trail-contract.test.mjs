import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');
const sql = readFileSync(new URL('../supabase/migrations/20261020120000_owner_audit_trail_filters_details.sql', import.meta.url), 'utf8');
const categorySql = readFileSync(new URL('../supabase/migrations/20261103120000_owner_audit_trail_category_filter.sql', import.meta.url), 'utf8');
const sortSql = readFileSync(new URL('../supabase/migrations/20261103130000_owner_audit_trail_sort.sql', import.meta.url), 'utf8');

test('owner audit trail exposes only the requested filters and columns', () => {
  const auditPanel = html.match(/<section class="admin-panel" data-admin-panel="audit">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(auditPanel, 'audit panel exists');
  assert.deepEqual(
    [...auditPanel.matchAll(/data-owner-audit-(search|date|from|to|role|category|sort)/g)].map(([, field]) => field),
    ['search', 'date', 'from', 'to', 'role', 'category', 'sort'],
  );
  assert.match(html, /data-admin-nav="audit"[\s\S]*?Activity Logs/);
  assert.match(auditPanel, /data-owner-audit-clear hidden>Clear filters/);
  assert.match(auditPanel, /data-owner-audit-category><option value="all">All categories/);
  assert.match(auditPanel, /data-owner-audit-sort><option value="newest">Newest to oldest/);
  assert.match(auditPanel, /<option value="oldest">Oldest to newest<\/option>/);
  assert.match(auditPanel, /<option value="event_az">Event A–Z<\/option>/);
  assert.match(auditPanel, /<option value="event_za">Event Z–A<\/option>/);
  assert.match(auditPanel, /type="date"[^>]*data-owner-audit-date/);
  assert.match(auditPanel, /data-owner-audit-time-picker="from"/);
  assert.match(auditPanel, /data-owner-audit-time-picker="to"/);
  assert.equal([...auditPanel.matchAll(/data-owner-audit-time-trigger="(?:from|to)"/g)].length, 2);
  assert.equal([...auditPanel.matchAll(/data-owner-audit-time-popover="(?:from|to)"/g)].length, 2);
  assert.doesNotMatch(auditPanel, /data-owner-audit-actor(?:\s|[=>])/);
  assert.deepEqual(
    [...auditPanel.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(([, label]) => label.replaceAll('&amp;', '&')),
    ['Event ID', 'Date & Time', 'Event', 'Role', 'Actor', 'Amount', 'Summary'],
  );
});

test('audit event summaries are inline and RPC date bounds use Manila time', () => {
  assert.match(js, /function auditSummary\(item\)/);
  assert.match(js, /class="owner-audit-summary" title="\$\{window\.escapeHtml\(summary\)\}"/);
  assert.doesNotMatch(html, /data-owner-audit-detail-modal/);
  assert.match(js, /new Date\(`\$\{localValue\}:00\+08:00`\)/);
  assert.match(js, /timeZone: 'Asia\/Manila', year: 'numeric', month: '2-digit', day: '2-digit'/);
  assert.match(js, /auditDate\.max = auditManilaToday\(\)/);
  assert.match(js, /if \(selectedDate > auditManilaToday\(\)\) return null/);
  assert.match(js, /updateAuditDateMax\(\);\s+if \(isAuditPanelVisible\(\)/);
  assert.match(js, /setUTCMinutes\(date\.getUTCMinutes\(\) \+ 1\)/);
  assert.match(js, /if \(picker\.input\) picker\.input\.disabled = !hasValidDate/);
  assert.match(js, /function renderAuditTimePicker\(picker\)/);
  assert.match(js, /const minimum = kind === 'to' && auditFrom\?\.value \? auditTimeMinutes\(auditFrom\.value\) : 0/);
  assert.match(js, /return kind !== 'to' \|\| absolute >= minimum/);
  assert.match(js, /ArrowDown', 'ArrowUp'/);
  assert.match(js, /event\.key === 'Escape'/);
  assert.match(js, /auditTo\.value = ''/);
  assert.match(js, /if \(from && to && to < from\) return null/);
  assert.match(js, /const nextDateValue = nextDate\.toISOString\(\)\.slice\(0, 10\)/);
  assert.match(js, /p_from: dateBounds\.from/);
  assert.match(js, /p_to: dateBounds\.to/);
  assert.match(js, /p_category: auditCategory\?\.value \|\| 'all'/);
  assert.match(js, /p_sort: auditSort\?\.value \|\| 'newest'/);
  assert.match(js, /function updateAuditClearButton\(\)/);
  assert.match(js, /auditClear\?\.addEventListener\('click'/);
  assert.match(js, /if \(auditCategory\) auditCategory\.value = 'all'/);
  assert.match(js, /if \(auditSort\) auditSort\.value = 'newest'/);
  assert.match(js, /title: 'Activity Logs'/);
});

test('audit RPC keeps active-owner authorization, bounded paging, and narrow search', () => {
  assert.match(sql, /p\.role = 'admin' and p\.status = 'active'/);
  assert.match(sql, /p_limit < 1 or p_limit > 50/);
  assert.match(sql, /p_offset < 0 or p_offset > 100000/);
  assert.match(sql, /strpos\(pg_catalog\.lower\(e\.event_id::text\)/);
  assert.match(sql, /strpos\(pg_catalog\.lower\(e\.actor_name\)/);
  assert.doesNotMatch(sql, /e\.action.*p_search|e\.summary.*p_search|details::text.*p_search/);
  assert.match(sql, /revoke all on function public\.owner_audit_trail\([^;]+ from public, anon;/);
  assert.match(sql, /grant execute on function public\.owner_audit_trail\([^;]+ to authenticated;/);
  assert.match(sql, /'details', page\.details/);
  for (const safeDetail of ["'customer',", "'checked_in_at',", "'checked_out_at',", "'subtotal',", "'base_amount',", "'fee',", "'gross_amount',"]) {
    assert.ok(sql.includes(safeDetail), `curated details include ${safeDetail}`);
  }
  assert.match(sql, /left join public\.booking b on a\.entity_type = 'booking' and b\.booking_id::text = a\.entity_id/);
  assert.match(sql, /left join public\.walk_in_booking walkin/);
  assert.match(sql, /left join internal\.staff_walkin_orders walkin_order/);
  assert.match(sql, /order_reservation\.customer_name/);
  assert.doesNotMatch(sql, /'actor_id'|'target_id'|'entity_id'|'payment_id'|'paymongo_payment_id'|'customer_id'|'email'|'phone'|'address'/);
  assert.match(categorySql, /coalesce\(p_category, 'all'\) not in \('all', 'access', 'bookings', 'walkins', 'payments', 'account', 'other'\)/);
  assert.match(categorySql, /when a\.entity_type in \('walkin', 'walk_in_booking', 'walkin_order'\) then 'walkins'/);
  assert.match(categorySql, /when a\.entity_type = 'booking' then 'bookings'/);
  assert.match(categorySql, /timed_in\|timed_out\|auto_timed_out/);
  assert.match(categorySql, /when e\.source in \('walkin', 'walk_in', 'walk_in_booking'\) then 'walkins'/);
  assert.match(categorySql, /when pg_catalog\.lower\(a\.action\) ~ '\(payment\|pay\|collect\)' then 'payments'[\s\S]*?when a\.entity_type in/);
  assert.match(categorySql, /e\.category = coalesce\(p_category, 'all'\)/);
  assert.match(categorySql, /p\.id = \(select auth\.uid\(\)\) and p\.role = 'admin' and p\.status = 'active'/);
  assert.match(categorySql, /revoke all on function public\.owner_audit_trail\([^;]+ from public, anon;/);
  assert.match(categorySql, /grant execute on function public\.owner_audit_trail\([^;]+ to authenticated;/);
});

test('audit RPC validates sorting and applies it before pagination with stable JSON row order', () => {
  assert.match(sortSql, /drop function if exists public\.owner_audit_trail\(text, timestamptz, timestamptz, text, uuid, text, integer, integer\)/);
  assert.match(sortSql, /create function public\.owner_audit_trail\([\s\S]*?p_actor_role text default 'all',[\s\S]*?p_sort text default 'newest',[\s\S]*?p_offset integer default 0,[\s\S]*?p_limit integer default 25/);
  assert.match(sortSql, /coalesce\(p_sort, 'newest'\) not in \('newest', 'oldest', 'event_az', 'event_za'\)/);
  assert.match(sortSql, /p\.role = 'admin' and p\.status = 'active'/);

  const pageStart = sortSql.indexOf('), page as (');
  const pageEnd = sortSql.indexOf('\n  select jsonb_build_object(', pageStart);
  assert.notEqual(pageStart, -1, 'server-side page CTE exists');
  assert.notEqual(pageEnd, -1, 'page CTE ends before response assembly');
  const pageSql = sortSql.slice(pageStart, pageEnd);
  assert.ok(pageSql.indexOf('order by') < pageSql.indexOf('offset p_offset limit p_limit'), 'sorting precedes offset and limit');
  assert.match(pageSql, /then created_at end desc nulls last/);
  assert.match(pageSql, /then created_at end asc nulls last/);
  assert.match(pageSql, /then pg_catalog\.lower\(action\) end asc nulls last/);
  assert.match(pageSql, /then pg_catalog\.lower\(action\) end desc nulls last/);
  assert.match(pageSql, /created_at desc, event_id desc, source asc/);

  const aggregateSql = sortSql.slice(sortSql.indexOf("'rows', coalesce((select jsonb_agg"));
  assert.match(aggregateSql, /jsonb_agg\([\s\S]*?\) order by[\s\S]*?page\.created_at desc, page\.event_id desc, page\.source asc\) from page/);
  assert.match(aggregateSql, /then pg_catalog\.lower\(page\.action\) end asc nulls last/);
  assert.match(aggregateSql, /then pg_catalog\.lower\(page\.action\) end desc nulls last/);
  assert.match(sortSql, /revoke all on function public\.owner_audit_trail\(text, timestamptz, timestamptz, text, uuid, text, text, integer, integer\) from public, anon;/);
  assert.match(sortSql, /grant execute on function public\.owner_audit_trail\(text, timestamptz, timestamptz, text, uuid, text, text, integer, integer\) to authenticated;/);
});
