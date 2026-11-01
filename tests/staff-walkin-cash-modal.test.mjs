import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const html = (await readFile(new URL('../Pages/staff_dashboard.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const source = (await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('cash tender is collected in an accessible modal with a numeric keypad', () => {
    const paymentStep = html.match(/<div class="staff-wizard-panel" data-staff-walkin-step="6">([\s\S]*?)<\/div>\s*<div class="staff-wizard-nav">/)?.[1] || '';
    assert.doesNotMatch(paymentStep, /data-staff-walkin-cash-tendered|data-staff-walkin-cash-change/);
    assert.match(html, /data-staff-walkin-save hidden>Complete cash payment/);
    assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="staffWalkinCashTitle"/);
    assert.match(html, /data-staff-walkin-cash-due/);
    assert.match(html, /data-staff-cash-key="0"/);
    assert.match(html, /data-staff-cash-key="\."/);
    assert.match(html, /data-staff-cash-key="Enter"/);
});

test('cash dialog disables Pay until tender covers the due amount and displays change', () => {
    const start = source.indexOf('    function updateWalkinCashModal() {');
    const end = source.indexOf('\n\n    function openWalkinCashModal()', start);
    const tenderStart = source.indexOf('    function walkinCashTenderMinor() {');
    const tenderEnd = source.indexOf('\n\n    function walkinCashTenderIsValid()', tenderStart);
    assert.ok(start >= 0 && end > start, 'cash dialog validation implementation exists');
    assert.ok(tenderStart >= 0 && tenderEnd > tenderStart, 'minor-unit tender parser exists');
    const due = { textContent: '' };
    const change = { textContent: '' };
    const validation = { textContent: '', attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
    const pay = { disabled: false };
    const tender = { value: '99.99' };
    const context = {
        walkinCashDueEl: due,
        walkinCashChange: change,
        walkinCashValidation: validation,
        walkinCashPayBtn: pay,
        walkinCashTenderedInput: tender,
        walkinSubmissionInFlight: false,
        walkinCashDueMinor: () => 10000,
        formatStaffPeso: value => `₱${value.toFixed(2)}`,
    };
    runInNewContext(`${source.slice(tenderStart, tenderEnd)}\n${source.slice(start, end)}; globalThis.update = updateWalkinCashModal;`, context);
    context.update();
    assert.equal(pay.disabled, true, 'underpayment cannot be submitted');
    assert.equal(change.textContent, '—');
    tender.value = '100.';
    context.update();
    assert.equal(pay.disabled, false, 'a trailing decimal point is treated as an exact whole-dollar amount');
    tender.value = '102.50';
    context.update();
    assert.equal(pay.disabled, false);
    assert.equal(due.textContent, '₱100.00');
    assert.equal(change.textContent, '₱2.50');
    tender.value = '100.001';
    context.update();
    assert.equal(pay.disabled, true, 'more than two decimal places are invalid');
});

test('cash tender input strips invalid characters and limits cents to two digits', () => {
    const start = source.indexOf('    function sanitizeWalkinCashTender() {');
    const end = source.indexOf('\n\n    if (walkinCashTenderedInput)', start);
    assert.ok(start >= 0 && end > start, 'cash input sanitizer exists');
    const input = {
        value: '1a2.345', selectionStart: 7,
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    };
    const context = {
        walkinCashTenderedInput: input,
        updateWalkinSummary() {},
        updateWalkinCashModal() {},
        renderWalkinWizard() {},
    };
    runInNewContext(`${source.slice(start, end)}; globalThis.sanitize = sanitizeWalkinCashTender;`, context);
    context.sanitize();
    assert.equal(input.value, '12.34');
});

test('paid walk-in auto-time-in trigger only handles confirmed, fully paid linked orders', async () => {
    const migration = await readFile(new URL('../supabase/migrations/20261101051738_staff_paid_walkin_auto_timein.sql', import.meta.url), 'utf8');
    const pricingMigration = await readFile(new URL('../supabase/migrations/20260925031348_authoritative_reservation_pricing.sql', import.meta.url), 'utf8');
    assert.match(migration, /before insert or update on public\.walk_in_booking/i);
    const pricingTrigger = /create trigger (zz_walkin_authoritative_amount)/i.exec(pricingMigration)?.[1];
    const timeInTrigger = /create trigger (zzzzzz_walkin_auto_time_in_paid_order)/i.exec(migration)?.[1];
    assert.ok(pricingTrigger && timeInTrigger && timeInTrigger > pricingTrigger,
        'auto-time-in runs after authoritative pricing to validate server-priced totals');
    const auditTrigger = /create trigger (zzzzzzzz_walkin_audit_auto_time_in_paid_order)/i.exec(migration)?.[1];
    assert.ok(auditTrigger && auditTrigger > 'walkin_audit_staff_action',
        'automatic time-in audit is written after the existing walk-in audit trigger');
    assert.match(migration, /o\.id = new\.walkin_order_id and o\.status = 'paid'/i);
    assert.match(migration, /new\.status = 'confirmed'/i);
    assert.match(migration, /new\.amount_paid >= new\.amount_total/i);
    assert.match(migration, /new\.payment_method in \('Cash', 'PayMongo'\)/i);
    assert.match(migration, /new\.checked_in_at is null/i);
    assert.match(migration, /'timed_in'/i);
    assert.match(migration, /'automatic_time_in', true/i);
    assert.match(migration, /join public\.payment p on p\.payment_id = o\.payment_id/i);
    assert.match(migration, /join internal\.payment_acknowledgments ack on ack\.payment_id = p\.payment_id/i);
    assert.match(migration, /p\.paid >= p\.cost and p\.paid > 0/i);
    assert.match(migration, /w\.amount_paid >= w\.amount_total/i);
    assert.match(migration, /a\.action = 'recorded_walk_in' and a\.actor_id = o\.staff_id/i,
        'historical attendance conversion requires a staff-created walk-in audit');
    assert.match(migration, /a\.action = 'marked_unattended' and a\.actor_id is null/i,
        'the migration only converts unattended legacy rows with a system no-show audit');
});

test('historical walk-in corrections preserve active paid arrivals and revert terminal no-show backfills', async () => {
    const gate = await readFile(new URL('../supabase/migrations/20261101150000_staff_paid_walkin_direct_update_guard.sql', import.meta.url), 'utf8');
    const correction = await readFile(new URL('../supabase/migrations/20261101132200_staff_walkin_attendance_backfill_correction.sql', import.meta.url), 'utf8');
    const unattended = await readFile(new URL('../supabase/migrations/20261101051924_staff_walkins_not_unattended.sql', import.meta.url), 'utf8');
    assert.match(correction, /w\.status\s*=\s*'completed'[\s\S]*?w\.end_at\s*<=\s*now\(\)/i);
    assert.match(correction, /no_show\.action\s*=\s*'marked_unattended'[\s\S]*?no_show\.actor_id\s+is\s+null/i);
    assert.match(correction, /set status\s*=\s*'unattended',[\s\S]*?checked_in_at\s*=\s*null,[\s\S]*?checked_out_at\s*=\s*null/i);
    assert.match(correction, /auto_time_in_backfill_reverted/i);
    assert.match(correction, /tg_op='INSERT' or \(tg_op='UPDATE' and old\.status='pending'\)/i,
        'automatic check-in may run only for inserts or pending-to-confirmed settlement');
    assert.match(correction, /new\.status = 'confirmed'/i);
    assert.match(gate, /current_setting\('inigosync\.staff_walkin_rpc'/i);
    assert.match(gate, /owner_order\.staff_id = \(select auth\.uid\(\)\)/i,
        'the effective final trigger is bound to the order-owning staff member');
    assert.match(gate, /owner_profile\.role = 'staff'[\s\S]*?owner_profile\.status = 'active'/i,
        'the authenticated RPC marker requires an active staff profile');
    assert.match(unattended, /update public\.booking b/i);
    assert.doesNotMatch(unattended, /update public\.walk_in_booking/i,
        'future attendance cleanup does not mark paid staff walk-ins unattended');
    assert.ok('20261101051738' < '20261101051924' && '20261101051924' < '20261101131600' && '20261101131600' < '20261101132200' && '20261101132200' < '20261101133000',
        'the backfill, no-show exclusion, trusted-path gate, and correction run in safe order');
});

test('cash creation and PayMongo settlement establish paid order status before reservation confirmation', async () => {
    const server = await readFile(new URL('../supabase/migrations/20261016130000_walkin_qrph_intents_cash_tender.sql', import.meta.url), 'utf8');
    const cashOrderStart = server.indexOf('create or replace function public.staff_create_walkin_order(');
    const cashOrderEnd = server.indexOf('\n$$;', cashOrderStart);
    const cashOrder = server.slice(cashOrderStart, cashOrderEnd);
    assert.ok(cashOrder.indexOf("case when p_payment_method='cash' then 'paid'") < cashOrder.indexOf('insert into public.walk_in_booking('));

    const settlementFile = await readFile(new URL('../supabase/migrations/20260929035830_staff_booking_rules_walkin_orders_attendance_receipts.sql', import.meta.url), 'utf8');
    const settlementStart = settlementFile.indexOf('create or replace function public.record_paymongo_paid(');
    const settlementEnd = settlementFile.indexOf('\n$$;', settlementStart);
    const settlement = settlementFile.slice(settlementStart, settlementEnd);
    assert.ok(settlement.indexOf("update internal.staff_walkin_orders set status='paid'") < settlement.indexOf('update public.walk_in_booking w set status=\'confirmed\''));
});
