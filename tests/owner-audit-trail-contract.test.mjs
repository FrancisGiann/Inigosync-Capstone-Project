import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');
const sql = readFileSync(new URL('../supabase/migrations/20261020120000_owner_audit_trail_filters_details.sql', import.meta.url), 'utf8');

test('owner audit trail exposes only the requested filters and columns', () => {
  const auditPanel = html.match(/<section class="admin-panel" data-admin-panel="audit">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(auditPanel, 'audit panel exists');
  assert.deepEqual(
    [...auditPanel.matchAll(/data-owner-audit-(search|date|from|to|role)/g)].map(([, field]) => field),
    ['search', 'date', 'from', 'to', 'role'],
  );
  assert.match(auditPanel, /type="date"[^>]*data-owner-audit-date/);
  assert.match(auditPanel, /data-owner-audit-time-picker="from"/);
  assert.match(auditPanel, /data-owner-audit-time-picker="to"/);
  assert.equal([...auditPanel.matchAll(/data-owner-audit-time-trigger="(?:from|to)"/g)].length, 2);
  assert.equal([...auditPanel.matchAll(/data-owner-audit-time-popover="(?:from|to)"/g)].length, 2);
  assert.match(auditPanel, /Optional\. Leave From blank to start at midnight or To blank to include the rest of the day\./);
  assert.doesNotMatch(auditPanel, /data-owner-audit-(?:category|actor)(?:\s|[=>])/);
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
});
