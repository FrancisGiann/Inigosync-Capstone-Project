import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pagination from '../includes/staffPagination.js';

const html = await readFile(new URL('../Pages/staff_dashboard.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../Style/staff_dashboard.css', import.meta.url), 'utf8');
const receiptStyles = await readFile(new URL('../Style/paymentAcknowledgment.css', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261013043015_staff_transaction_records.sql', import.meta.url), 'utf8');
const transactionPanelStart = html.indexOf('<section class="staff-panel" data-staff-panel="transactions"');
const transactionPanelEnd = html.indexOf('<section class="staff-panel" data-staff-panel="profile"', transactionPanelStart);
const transactionPanel = html.slice(transactionPanelStart, transactionPanelEnd);

test('transaction toolbar has one date control after Sort and search/source controls on the right', () => {
    const headers = [...transactionPanel.matchAll(/<th>([^<]+)<\/th>/g)].map((match) => match[1]);
    assert.deepEqual(headers, ['Date', 'Customer Name', 'Sports', 'Court/Unit', 'Time', 'Source', 'Amount', 'Receipt']);
    assert.doesNotMatch(transactionPanel, /data-staff-tx-(?:from|to)|Timed in|Timed out|Payment history|<th>Status<\/th>/i);
    assert.equal((transactionPanel.match(/data-staff-tx-date/g) || []).length, 1);
    assert.ok(transactionPanel.indexOf('data-staff-tx-sort') < transactionPanel.indexOf('data-staff-tx-date'));
    assert.ok(transactionPanel.indexOf('data-staff-tx-date') < transactionPanel.indexOf('data-staff-search="transactions"'));
    assert.ok(transactionPanel.indexOf('data-staff-search="transactions"') < transactionPanel.indexOf('data-staff-filter-group="transactions"'));
    assert.match(transactionPanel, /data-staff-tx-sort/);
    assert.match(transactionPanel, /data-staff-pagination="transactions"/);
    assert.match(html, /data-staff-pagination="overview"/);
    assert.match(html, /includes\/staffPagination\.js/);
});

test('staff transaction client reads only the staff-attributed payment RPC', () => {
    assert.match(script, /rpc\('staff_get_involved_transactions'\)/);
    assert.match(script, /manilaDate\(row\.created_at\) === selectedDate/);
    assert.match(script, /selectedDate\s*\?\s*transactionRows\.filter[\s\S]*?:\s*transactionRows/);
    assert.doesNotMatch(script, /txDateInput\.value\s*=\s*manilaDate\(\)/);
    assert.match(script, /txDateInput\.addEventListener\('change', \(\) => \{\s*const state = filterableTableState\.get\('transactions'\);\s*if \(state\) state\.page = 1;\s*renderTransactionRows\(\);/);
    assert.match(script, /data-staff-payment-ack/);
});

test('staff table pagination shows ten rows, navigates numbered pages, and clamps after filtering or refresh', () => {
    const rows = Array.from({ length: 23 }, (_, index) => ({ id: index + 1, source: index % 2 ? 'online' : 'walkin' }));
    const first = pagination.paginateRows(rows, 1);
    const second = pagination.paginateRows(rows, 2);
    const last = pagination.paginateRows(rows, 3);
    assert.equal(first.rows.length, 10);
    assert.deepEqual(first.rows.map((row) => row.id), Array.from({ length: 10 }, (_, index) => index + 1));
    assert.deepEqual(second.rows.map((row) => row.id), Array.from({ length: 10 }, (_, index) => index + 11));
    assert.deepEqual(last.rows.map((row) => row.id), [21, 22, 23]);
    assert.deepEqual(pagination.pageNumbers(5, 10), [1, 'gap', 4, 5, 6, 'gap', 10]);

    const walkins = rows.filter((row) => row.source === 'walkin');
    assert.equal(pagination.paginateRows(walkins, 3).page, 2, 'a reduced filtered result clamps a stale page to its last page');
    assert.equal(pagination.paginateRows(walkins.slice(0, 5), 2).page, 1, 'a filter result below ten rows clamps to page one');
    assert.equal(pagination.paginateRows(rows.slice(0, 12), 3).rows.length, 2, 'a refreshed shorter dataset clamps and renders remaining rows');

    assert.match(script, /state\.page = 1;\s*applyFilters\(\);/);
    assert.match(script, /overviewPage = 1;\s*renderFilteredOverview\(\);/);
    assert.match(script, /renderStaffTablePagination\(pagination, matchingRows\.length, state\.page/);
    assert.match(script, /renderStaffTablePagination\(overviewPagination, visible\.length, overviewPage/);
    assert.match(script, /const timeOrder = \(Number\.isFinite\(bTime\) \? bTime : 0\) - \(Number\.isFinite\(aTime\) \? aTime : 0\);\s*return timeOrder \|\| staffOverviewIdLabel\(a\)\.localeCompare\(staffOverviewIdLabel\(b\)/,
        'Booking Overview sorts newest first with a deterministic ID tie-break');
});

test('View receipt opens the shared acknowledgment card with working print and download actions', () => {
    assert.match(html, /data-staff-receipt-modal[\s\S]*?role="dialog"[\s\S]*?aria-modal="true"[\s\S]*?data-staff-receipt-modal-content/);
    assert.match(script, /if \(receiptButton && row\?\.acknowledgment\)\s*\{\s*openTransactionAcknowledgment\(\{ acknowledgment: row\.acknowledgment, payment_id: row\.payment_id, source: row\.source \}\);/);
    assert.match(script, /renderStaffReceipt\(\{ \.\.\.ack, transaction_id: ack\.transaction_id \|\| payment\.payment_id, source: payment\.source \}, staffReceiptModalContent, 'transaction'\)/);
    assert.match(script, /data-staff-receipt-download="\$\{idAttr\}"/);
    assert.match(script, /data-staff-receipt-print/);
    assert.match(script, /InigoPaymentAcknowledgment\.print\(staffReceiptModalContent\?\.querySelector\('\.payment-ack-card'\)\)/);
    assert.match(script, /downloadStaffReceiptAsPng\(card, downloadBtn\.dataset\.staffReceiptDownload/);
    assert.match(script, /staffReceiptModal\.setAttribute\('data-open', ''\)/);
    assert.match(script, /staffReceiptModal\.removeAttribute\('data-open'\)/);
    assert.match(receiptStyles, /@page \{ size: auto; margin: 2mm; \}/);
    assert.match(receiptStyles, /body\.payment-ack-printing > :not\(\.payment-ack-print-root\)/);
    assert.doesNotMatch(styles + receiptStyles, /80mm 300mm/);
});

test('transaction RPC binds attribution to the active authenticated staff identity', () => {
    assert.match(migration, /v_actor uuid := \(select auth\.uid\(\)\)/);
    assert.match(migration, /p\.id = v_actor and p\.role = 'staff' and p\.status = 'active'/);
    assert.match(migration, /a\.actor_id = v_actor/);
    assert.match(migration, /where w\.walkin_id = pc\.context_id and w\.staff_id = v_actor\s+and w\.walkin_order_id is null and w\.payment_id = pc\.payment_id/);
    assert.match(migration, /where o\.id = pc\.order_id and o\.staff_id = v_actor and o\.payment_id = pc\.payment_id/);
    assert.doesNotMatch(migration, /w\.staff_id = v_actor[\s\S]{0,120}w\.balance_payment_id/,
        'walk-in ownership alone cannot attribute a later balance collected by another staff member');
    assert.match(migration, /a\.action in \(\s*'timed_in', 'collected_online_balance', 'late_online_balance_review',\s*'created_walkin_order', 'collected_online_walkin'/);
    assert.match(migration, /a\.details->>'payment_id' = pc\.payment_id::text/);
    assert.doesNotMatch(migration, /a\.action in \([\s\S]{0,200}'timed_out'/);
    assert.match(migration, /revoke all on function public\.staff_get_involved_transactions\(\) from public, anon/);
    assert.match(migration, /grant execute on function public\.staff_get_involved_transactions\(\) to authenticated/);
});

test('missing receipt recovery happens only after attribution, with a disabled UI fallback', () => {
    const attribution = migration.indexOf('  select coalesce(jsonb_agg(to_jsonb(attributed))');
    const recovery = migration.indexOf('perform internal.persist_payment_acknowledgment');
    assert.ok(attribution >= 0 && recovery > attribution, 'receipt reconstruction follows the attributed payment selection');
    assert.match(migration, /left join internal\.payment_acknowledgments ack[\s\S]*?where ack\.payment_id is null/);
    assert.match(script, /row\.acknowledgment \? '' : ' disabled title="Receipt unavailable for this payment"/);
});
