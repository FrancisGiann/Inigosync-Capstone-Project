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
    [...auditPanel.matchAll(/data-owner-audit-(search|datetime|role)/g)].map(([, field]) => field),
    ['search', 'datetime', 'role'],
  );
  assert.doesNotMatch(auditPanel, /data-owner-audit-(?:from|to|category|actor)(?:\s|[=>])/);
  assert.deepEqual(
    [...auditPanel.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(([, label]) => label.replaceAll('&amp;', '&')),
    ['Event ID', 'Date & Time', 'Event', 'Role', 'Actor', 'Amount', 'Summary'],
  );
});

test('summary view is a keyboard accessible dialog and RPC date bounds use Manila time', () => {
  assert.match(js, /data-owner-audit-summary="\$\{index\}"/);
  assert.match(html, /data-owner-audit-detail-modal hidden/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="ownerAuditDetailTitle"/);
  assert.match(js, /aria-label="View detailed summary for event \$\{window\.escapeHtml\(eventId\)\}"/);
  assert.match(js, /window\.escapeHtml\(label\).*window\.escapeHtml\(value\)/);
  assert.match(js, /new Date\(`\$\{value\}:00\+08:00`\)/);
  assert.match(js, /setUTCMinutes\(date\.getUTCMinutes\(\) \+ 1\)/);
  assert.match(js, /p_from: auditDateTimeBoundaryIso\(auditDateTime\?\.value\)/);
  assert.match(js, /p_to: auditDateTimeBoundaryIso\(auditDateTime\?\.value, true\)/);
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
