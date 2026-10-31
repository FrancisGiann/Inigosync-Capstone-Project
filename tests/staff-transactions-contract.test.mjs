import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pagination from '../includes/staffPagination.js';

const html = await readFile(new URL('../Pages/staff_dashboard.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../Style/staff_dashboard.css', import.meta.url), 'utf8');
const receiptStyles = await readFile(new URL('../Style/paymentAcknowledgment.css', import.meta.url), 'utf8');
const visitMigration = await readFile(new URL('../supabase/migrations/20261031145608_staff_transaction_records_redesign.sql', import.meta.url), 'utf8');
const deployedVisitMigration = await readFile(new URL('../supabase/migrations/20261031134804_staff_visit_transactions.sql', import.meta.url), 'utf8');
const legacyMigration = await readFile(new URL('../supabase/migrations/20261031134800_staff_transaction_status_and_method.sql', import.meta.url), 'utf8');
const transactionPanelStart = html.indexOf('<section class="staff-panel" data-staff-panel="transactions"');
const transactionPanelEnd = html.indexOf('<section class="staff-panel" data-staff-panel="profile"', transactionPanelStart);
const transactionPanel = html.slice(transactionPanelStart, transactionPanelEnd);

test('transaction toolbar and table expose the compact visit record fields', () => {
    const headers = [...transactionPanel.match(/data-staff-tx-headers="transactions">([\s\S]*?)<\/tr>/)[1].matchAll(/<th>([^<]+)<\/th>/g)].map((match) => match[1]);
    assert.deepEqual(headers, ['Transaction ID', 'Customer Name', 'Time In / Time Out', 'Source', 'Visit Status', 'Amount', 'Receipt']);
    const unattendedHeaders = [...transactionPanel.match(/data-staff-tx-headers="unattended" hidden>([\s\S]*?)<\/tr>/)[1].matchAll(/<th>([^<]+)<\/th>/g)].map((match) => match[1]);
    assert.deepEqual(unattendedHeaders, ['Visit Reference', 'Customer Name', 'Scheduled Visit', 'Source', 'Visit Status']);
    assert.match(transactionPanel, /role="tab"[^>]*data-staff-tx-tab="transactions">Transactions/);
    assert.match(transactionPanel, /role="tab"[^>]*data-staff-tx-tab="unattended"[^>]*>Unattended/);
    assert.doesNotMatch(transactionPanel, /<details|>Online</);
    assert.doesNotMatch(transactionPanel, /data-staff-tx-(?:from|to)|Timed in|Timed out|Payment history/i);
    assert.equal((transactionPanel.match(/data-staff-tx-date(\s|=)/g) || []).length, 1);
    assert.match(transactionPanel, /data-staff-tx-status/);
    assert.ok(transactionPanel.indexOf('data-staff-search="transactions"') < transactionPanel.indexOf('data-staff-tx-date'));
    assert.ok(transactionPanel.indexOf('data-staff-tx-date') < transactionPanel.indexOf('data-staff-tx-source-menu'));
    assert.ok(transactionPanel.indexOf('data-staff-tx-source-menu') < transactionPanel.indexOf('data-staff-tx-status'));
    assert.ok(transactionPanel.indexOf('data-staff-tx-status') < transactionPanel.indexOf('data-staff-tx-sort'));
    assert.match(transactionPanel, /data-staff-tx-sort/);
    assert.match(transactionPanel, /Search customer or transaction ID/);
    assert.match(transactionPanel, /data-staff-tx-status-choice="in_progress">In progress/);
    assert.match(transactionPanel, /data-staff-tx-status-choice="completed">Completed/);
    assert.match(transactionPanel, /data-staff-tx-status-menu[^>]*data-value="all"/);
    assert.match(transactionPanel, /data-staff-tx-status-reset hidden>Clear status filter/);
    assert.match(transactionPanel, /id="staff-tx-source-label">Source/);
    assert.match(transactionPanel, /id="staff-tx-source-current">All sources/);
    assert.match(transactionPanel, /data-staff-tx-source-choice="booking">Booking/);
    assert.match(transactionPanel, /data-staff-tx-source-choice="walkin">Walk-in/);
    assert.match(transactionPanel, /data-staff-tx-source-reset hidden>Clear source filter/);
    assert.doesNotMatch(transactionPanel, /data-staff-filter-group="transactions"|data-staff-chip/);
    assert.match(transactionPanel, /data-staff-tx-sort-current[^>]*aria-labelledby="staff-tx-sort-label staff-tx-sort-current-label"/);
    assert.doesNotMatch(transactionPanel, /data-staff-tx-status-choice="unattended"/);
    assert.match(transactionPanel, /Visit date/);
    assert.match(transactionPanel, /data-staff-pagination="transactions"/);
    assert.match(html, /data-staff-pagination="overview"/);
    assert.match(html, /includes\/staffPagination\.js/);
});

test('staff transaction client renders actual attendance times and collected-at-check-in amounts', () => {
    assert.match(script, /rpc\('staff_get_involved_transactions'\)/);
    assert.match(script, /transactionMatchesDates\(\s*row, '', selectedVisitDate, manilaDate\)/);
    assert.match(script, /txDateInput\.addEventListener\('change', \(\) => \{\s*const state = filterableTableState\.get\('transactions'\);\s*if \(state\) state\.page = 1;\s*renderTransactionRows\(\);/);
    assert.match(script, /data-staff-payment-ack/);
    assert.match(script, /row\.hasAttribute\('data-staff-empty-state'\)/);
    assert.match(script, /No transactions match your search and filters\./);
    assert.match(script, /row\.dataset\.visitStatus === statusMenu\.dataset\.value/);
    assert.match(script, /transactionStatusLabels\[visitStatus\]/);
    assert.match(script, /row\.checked_in_at/);
    assert.match(script, /row\.checked_out_at/);
    assert.match(script, /row\.amount_minor/);
    assert.match(script, /row\.status === 'unattended' \? 0 : row\.amount_minor/);
    assert.match(script, /row\.fully_paid === true \? 'Full payment paid' : 'No payment collected at Time-In'/);
    assert.match(script, /visibleStatuses = transactionView === 'unattended' \? \['unattended'\] : \['in_progress', 'completed'\]/);
    assert.match(script, /const visitReference = `\$\{source\} #\$\{row\.visit_id \|\| '—'\}`/);
    assert.match(script, /data-label="Scheduled visit"/);
    assert.match(script, /FULL PAYMENT PAID — NO NEW PAYMENT/);
    const unattendedRenderStart = script.indexOf("if (transactionView === 'unattended') {", script.indexOf('const receiptControl'));
    const unattendedRenderEnd = script.indexOf('} else {', unattendedRenderStart);
    assert.ok(unattendedRenderStart >= 0 && unattendedRenderEnd > unattendedRenderStart);
    assert.doesNotMatch(script.slice(unattendedRenderStart, unattendedRenderEnd), /Transaction ID|Time in \/ time out|data-staff-visit-record|Receipt/);
    assert.match(script, /receivedRows\.length && !transactionRows\.length/);
    assert.match(script, /payload\.schema_version !== 'visit_transactions_v1'/);
    assert.match(script, /Transaction records need a server update/);
    assert.ok(script.indexOf("payload.schema_version !== 'visit_transactions_v1'") < script.indexOf('const receivedRows = Array.isArray(payload.transactions)'));
    assert.match(script, /choice\.hidden = choiceValue === selectedValue/);
    assert.match(script, /state\.activeFilter = sourceMenu\.dataset\.value \|\| 'all'/);
    assert.match(script, /menu\.querySelector\('\[data-staff-tx-source\]'\)\?\.dispatchEvent\(new Event\('staffsourcechange'\)\)/);
    assert.match(script, /if \(statusMenu\) statusMenu\.hidden = transactionView === 'unattended'/);
    assert.match(script, /event\.key === 'ArrowRight' \? 1/);
    assert.match(script, /function activateTransactionTab\(tab\)[\s\S]*?renderTransactionRows\(\);/);
    assert.doesNotMatch(script.slice(script.indexOf('function activateTransactionTab(tab)'), script.indexOf("document.querySelectorAll('[data-staff-tx-tab]').forEach((tab)", script.indexOf('function activateTransactionTab(tab)'))), /sourceMenu\.dataset\.value\s*=/);
    assert.match(script, /transactionView === 'unattended' \? '5' : '7'/);
    assert.match(script, /staffstatuschange/);
    assert.doesNotMatch(script, /staff-tx-details/);
    assert.match(script, /data-label="Transaction ID"/);
    assert.match(script, /data-label="Time in \/ time out"/);
    assert.match(script, /data-label="Receipt"/);
});

test('transaction records fit the panel and stack into labeled cards on narrow viewports', () => {
    assert.match(styles, /\.staff-transaction-toolbar \{[^}]*display: grid; grid-template-columns: minmax\(0, 1\.7fr\) repeat\(4, minmax\(0, 1fr\)\)/);
    assert.match(styles, /\.staff-transaction-tab\.is-active/);
    assert.match(styles, /\.staff-transaction-menu-options\[hidden\], \.staff-transaction-menu-reset\[hidden\] \{ display: none !important; \}/);
    assert.match(styles, /\.staff-transaction-status-filter\[hidden\] \{ display: none !important; \}/);
    assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?\.staff-transaction-toolbar \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    assert.match(styles, /\.staff-transaction-toolbar \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    assert.match(styles, /\.staff-panel\[data-staff-panel="transactions"\] \.staff-table-wrap \{ overflow-x: hidden; \}/);
    assert.match(styles, /\.staff-table\[data-staff-table="transactions"\] \{ width: 100%; min-width: 0; table-layout: fixed; \}/);
    assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?\.staff-table\[data-staff-table="transactions"\] tbody > tr:not\(\[data-staff-empty-state\]\)\s*\{\s*display: grid/);
    assert.match(styles, /\.staff-table\[data-staff-table="transactions"\] tbody > tr > td::before\s*\{\s*content: attr\(data-label\)/);
});

test('visit-date search finds no-show and completed rows by scheduled visit date', () => {
    const dateInManila = (instant) => {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(instant);
        const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        return `${values.year}-${values.month}-${values.day}`;
    };
    const deposit = {
        created_at: '2026-10-27T10:00:00+08:00',
        status: 'unattended',
        visits: [
            { starts_at: '2026-11-01T14:00:00+08:00', ends_at: '2026-11-01T15:00:00+08:00' },
            { starts_at: '2026-11-03T16:00:00+08:00', ends_at: '2026-11-03T17:00:00+08:00' },
        ],
    };

    assert.equal(pagination.transactionMatchesDates(deposit, '', '2026-11-01', dateInManila), true,
        'the visit date finds a no-show row by its scheduled visit date');
    assert.equal(pagination.transactionMatchesDates(deposit, '', '2026-11-03', dateInManila), true,
        'each visit row can be searched independently by scheduled date');
    assert.equal(pagination.transactionMatchesDates(deposit, '', '2026-11-02', dateInManila), false);
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
    assert.match(html, /data-staff-receipt-modal[\s\S]*?role="dialog"[\s\S]*?aria-modal="true"[\s\S]*?staff-receipt-modal-head[\s\S]*?data-staff-receipt-close[\s\S]*?data-staff-receipt-modal-content[\s\S]*?staff-receipt-modal-footer[\s\S]*?data-staff-receipt-download[\s\S]*?data-staff-receipt-print/);
    assert.match(script, /openTransactionAcknowledgment\(\{ acknowledgment: row\.acknowledgment, payment_id: row\.payment_id, transaction_id: row\.transaction_id, source: row\.source \}\)/);
    assert.match(script, /renderStaffReceipt\(\{ \.\.\.ack, transaction_id: ack\.transaction_id \|\| payment\.payment_id, visit_transaction_id: payment\.transaction_id, payment_id: payment\.payment_id, source: payment\.source \}, staffReceiptModalContent, 'transaction'\)/);
    assert.match(script, /transactionId: receipt\.visit_transaction_id \|\| receipt\.transaction_id/);
    assert.match(script, /<span>Payment ID<\/span>/);
    assert.match(script, /setAttribute\('data-staff-receipt-download', String\(ack\.receipt_number \|\| ack\.receipt_id \|\| ack\.id \|\| 'receipt'\)\)/);
    assert.match(script, /data-staff-receipt-print/);
    assert.match(script, /InigoPaymentAcknowledgment\.print\(staffReceiptModalContent\?\.querySelector\('\.payment-ack-card'\)\)/);
    assert.match(script, /downloadStaffReceiptAsPng\(card, downloadBtn\.dataset\.staffReceiptDownload/);
    assert.match(script, /staffReceiptModal\.setAttribute\('data-open', ''\)/);
    assert.match(script, /staffReceiptModal\.removeAttribute\('data-open'\)/);
    assert.match(receiptStyles, /@page \{ size: auto; margin: 0; \}/);
    assert.match(receiptStyles, /body\.payment-ack-printing > \.payment-ack-print-root\s*\{[^}]*width:\s*47\.5mm;[^}]*padding:\s*\.75mm;/s);
    assert.match(receiptStyles, /body\.payment-ack-printing \.payment-ack-card\s*\{[^}]*width:\s*46mm;[^}]*max-width:\s*46mm/s);
    assert.match(receiptStyles, /\.payment-ack-total\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/s);
    assert.match(receiptStyles, /\.payment-ack-total strong\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    assert.match(receiptStyles, /\.payment-ack-total > \*\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere/s);
    assert.match(receiptStyles, /\.payment-ack-item > \*\s*\{[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere/s);
    assert.match(receiptStyles, /body\.payment-ack-printing > :not\(\.payment-ack-print-root\)/);
    assert.doesNotMatch(styles + receiptStyles, /58mm 300mm/);
});

test('visit transaction RPC uses persisted time-in event IDs and keeps no-shows free of payment data', () => {
    assert.match(visitMigration, /'schema_version', 'visit_transactions_v1'/);
    assert.match(visitMigration, /return coalesce\(v_result, jsonb_build_object\([\s\S]*?'schema_version', 'visit_transactions_v1',[\s\S]*?'transactions', '\[\]'::jsonb/);
    assert.match(visitMigration, /v_actor uuid := \(select auth\.uid\(\)\)/);
    assert.match(visitMigration, /p\.id = v_actor and p\.role = 'staff' and p\.status = 'active'/);
    assert.match(visitMigration, /a\.actor_id = v_actor/);
    assert.match(visitMigration, /a\.action = 'timed_in'[\s\S]*?or \(a\.action = 'collected_online_balance' and a\.details->>'time_in_recorded' = 'true'\)/);
    assert.match(visitMigration, /b\.checked_in_at is not null[\s\S]*?w\.checked_in_at is not null/);
    assert.match(visitMigration, /when visits\.checked_out_at is null then 'in_progress'/);
    assert.doesNotMatch(visitMigration, /b\.status = 'completed' and b\.checked_in_at/);
    assert.match(visitMigration, /a\.id as transaction_id/);
    assert.match(visitMigration, /null::uuid as transaction_id/);
    assert.match(visitMigration, /where b\.status = 'unattended'/);
    assert.match(visitMigration, /where w\.status = 'unattended'/);
    assert.match(visitMigration, /where b\.status = 'unattended' and b\.checked_in_at is null/);
    assert.match(visitMigration, /where w\.status = 'unattended' and w\.checked_in_at is null/);
    assert.match(visitMigration, /null::numeric as amount_collected/);
    assert.match(visitMigration, /b\.amount_total > 0 and b\.amount_paid >= b\.amount_total[\s\S]*?w\.amount_total > 0 and w\.amount_paid >= w\.amount_total/);
    assert.match(visitMigration, /'fully_paid', visits\.fully_paid/);
    assert.match(visitMigration, /'booking_total_minor', visits\.booking_total_minor/);
    assert.match(visitMigration, /'visit_id', visits\.visit_id/);
    assert.match(visitMigration, /'starts_at', visits\.visit_starts_at,[\s\S]*?'ends_at', visits\.visit_ends_at,[\s\S]*?'sport', visits\.visit_sport,[\s\S]*?'court', visits\.visit_court,[\s\S]*?'unit', visits\.visit_unit,[\s\S]*?'duration_minutes', visits\.visit_duration_minutes/);
    assert.match(visitMigration, /rate_unit_snapshot is not null or b\.payment_id is not null or b\.amount_paid > 0/);
    assert.match(visitMigration, /rate_unit_snapshot is not null or w\.payment_id is not null or w\.amount_paid > 0/);
    assert.match(visitMigration, /'checked_in_at', visits\.checked_in_at/);
    assert.match(visitMigration, /'checked_out_at', visits\.checked_out_at/);
    assert.match(visitMigration, /left join internal\.payment_acknowledgments ack on ack\.payment_id = visits\.payment_id/);
    assert.match(visitMigration, /revoke all on function public\.staff_get_involved_transactions\(\) from public, anon/);
    assert.match(visitMigration, /grant execute on function public\.staff_get_involved_transactions\(\) to authenticated/);
});

test('deployed visit transaction migration is preserved and redesign stays in a forward migration', () => {
    assert.match(deployedVisitMigration, /with completed_visits as/);
    assert.match(deployedVisitMigration, /b\.status = 'completed' and b\.checked_in_at is not null/);
    assert.match(deployedVisitMigration, /'schema_version', 'visit_transactions_v1'/);
    assert.doesNotMatch(deployedVisitMigration, /'in_progress'|with staff_timeins as/);
    assert.match(visitMigration, /with staff_timeins as/);
    assert.match(visitMigration, /when visits\.checked_out_at is null then 'in_progress'/);
});

test('switching Transactions and Unattended re-renders columns, rows, and view-specific empty/error states', () => {
    const activationStart = script.indexOf('function activateTransactionTab(tab)');
    const activationEnd = script.indexOf("document.querySelectorAll('[data-staff-tx-tab]').forEach((tab)", activationStart);
    const activation = script.slice(activationStart, activationEnd);
    assert.match(activation, /transactionView = tab\.dataset\.staffTxTab/);
    assert.match(activation, /state\.page = 1/);
    assert.match(activation, /renderTransactionRows\(\)/);
    assert.match(script, /header\.hidden = header\.dataset\.staffTxHeaders !== transactionView/);
    assert.match(script, /colspan="\$\{transactionView === 'unattended' \? '5' : '7'\}" class="staff-table-message" role="status"/);
    assert.match(script, /colspan="\$\{transactionView === 'unattended' \? '5' : '7'\}" class="staff-table-message"/);
});

test('in-progress time-in rows are returned before checkout and labeled by the client', () => {
    assert.match(visitMigration, /where a\.actor_id = v_actor[\s\S]*?b\.checked_in_at is not null[\s\S]*?w\.checked_in_at is not null/);
    assert.match(visitMigration, /when visits\.checked_out_at is null then 'in_progress'/);
    assert.match(script, /in_progress: 'In progress'/);
    assert.match(script, /visibleStatuses = transactionView === 'unattended' \? \['unattended'\] : \['in_progress', 'completed'\]/);
});

test('legacy transaction RPC retains its staff and receipt authorization rules', () => {
    assert.match(legacyMigration, /v_actor uuid := \(select auth\.uid\(\)\)/);
    assert.match(legacyMigration, /p\.id = v_actor and p\.role = 'staff' and p\.status = 'active'/);
    assert.match(legacyMigration, /a\.actor_id = v_actor/);
    assert.match(legacyMigration, /where w\.walkin_id = pc\.context_id and w\.staff_id = v_actor\s+and w\.walkin_order_id is null and w\.payment_id = pc\.payment_id/);
    assert.match(legacyMigration, /where o\.id = pc\.order_id and o\.staff_id = v_actor and o\.payment_id = pc\.payment_id/);
    assert.doesNotMatch(legacyMigration, /w\.staff_id = v_actor[\s\S]{0,120}w\.balance_payment_id/,
        'walk-in ownership alone cannot attribute a later balance collected by another staff member');
    assert.match(legacyMigration, /a\.action in \(\s*'timed_in', 'collected_online_balance', 'late_online_balance_review',\s*'created_walkin_order', 'collected_online_walkin'/);
    assert.match(legacyMigration, /a\.details->>'payment_id' = pc\.payment_id::text/);
    assert.match(legacyMigration, /or \(pc\.context_type in \('booking', 'walkin'\) and pc\.visit_status = 'unattended'\)/,
        'a persisted payment for an unattended booking remains visible even without a staff audit actor');
    assert.match(legacyMigration, /case\s+when b\.status = 'unattended' then 'unattended'[\s\S]*?when b\.checked_in_at is not null then 'attended'[\s\S]*?else 'booked'/);
    assert.match(legacyMigration, /when bool_and\(w\.status = 'unattended'\) then 'unattended'[\s\S]*?when bool_or\(w\.status = 'unattended'\) then 'partially_unattended'/);
    assert.match(legacyMigration, /'method', x\.payment_method/);
    assert.match(legacyMigration, /'status', x\.visit_status/);
    assert.match(legacyMigration, /'visits', x\.visits/);
    assert.match(legacyMigration, /jsonb_build_array\(jsonb_build_object\('starts_at', b\.time_date, 'ends_at', b\.end_at\)\)/);
    assert.match(legacyMigration, /select distinct w\.time_date as starts_at, w\.end_at as ends_at[\s\S]*?where w\.walkin_order_id = o\.id/);
    assert.doesNotMatch(legacyMigration, /a\.action in \([\s\S]{0,200}'timed_out'/);
    assert.match(legacyMigration, /revoke all on function public\.staff_get_involved_transactions\(\) from public, anon/);
    assert.match(legacyMigration, /grant execute on function public\.staff_get_involved_transactions\(\) to authenticated/);
});

test('zero-collection prepaid receipt is built from the time-in event without creating a payment', () => {
    assert.match(visitMigration, /left join internal\.payment_acknowledgments ack on ack\.payment_id = visits\.payment_id/);
    assert.match(script, /row\.acknowledgment && minorAmount !== 0[\s\S]*?row\.transaction_id[\s\S]*?data-staff-visit-record/);
    const receiptStart = script.indexOf('function openTransactionVisitRecord(row)');
    const receiptEnd = script.indexOf('function closeStaffReceiptModal()', receiptStart);
    const zeroReceipt = script.slice(receiptStart, receiptEnd);
    assert.match(zeroReceipt, /Number\(row\.amount_minor\) === 0/);
    assert.match(zeroReceipt, /row\.fully_paid === true/);
    assert.match(zeroReceipt, /amountMinor !== null && amountMinor !== undefined && amountMinor !== ''[\s\S]*?Number\(amountMinor\) === 0/);
    assert.match(zeroReceipt, /bookingTotalMinor !== null && bookingTotalMinor !== undefined && bookingTotalMinor !== ''/);
    assert.match(zeroReceipt, /FULL PAYMENT PAID — NO NEW PAYMENT/);
    assert.match(zeroReceipt, /NO PAYMENT COLLECTED AT TIME-IN/);
    assert.match(zeroReceipt, /₱0\.00 was collected at Time-In/);
    assert.match(zeroReceipt, /Booking ID|Walk-In ID/);
    assert.match(zeroReceipt, /row\.transaction_id/);
    assert.match(zeroReceipt, /visit\.sport/);
    assert.match(zeroReceipt, /visit\.court/);
    assert.match(zeroReceipt, /visit\.starts_at/);
    assert.match(zeroReceipt, /visit\.ends_at/);
    assert.match(zeroReceipt, /row\.booking_total_minor/);
    assert.match(zeroReceipt, /does not represent a new payment/);
    assert.match(zeroReceipt, /does not verify any earlier payment/);
    assert.doesNotMatch(zeroReceipt, /window\.sb|\.rpc\(|payment_id|insert into public\.payment/i);
    assert.match(script, /'<span aria-label="Receipt unavailable">—<\/span>'/);
});
