import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const html = (await readFile(new URL('../Pages/staff_dashboard.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const css = (await readFile(new URL('../Style/staff_dashboard.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const source = (await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const migration = (await readFile(new URL('../supabase/migrations/20261101210000_staff_booking_extension_payments.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const edge = (await readFile(new URL('../supabase/functions/staff-booking-extension-checkout/index.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('Overview extension control is compact and adjacent to Time-Out only for eligible in-play hourly rows', () => {
    assert.match(source, /data-staff-action="timeout"[^<]*<\/button>\$\{canOfferExtension \? '<button type="button" class="staff-extension-plus"/);
    assert.match(source, /staffExtensionAvailabilityCache\.get\(`\$\{row\.sourceType\}:\$\{target\.idValue\}`\) === true/);
    assert.match(source, /staffDerivedStatus\(row\) === 'inplay'[\s\S]*row\.raw\?\.checked_in_at/);
    assert.match(css, /\.staff-extension-plus\s*\{[\s\S]*width:\s*28px;\s*height:\s*28px/);
    assert.match(html, /data-staff-extension-step="duration"[\s\S]*data-staff-extension-duration/);
    assert.match(html, /data-staff-extension-step="payment"[\s\S]*data-staff-extension-method/);
    assert.match(html, /data-staff-extension-cash-modal[\s\S]*data-staff-extension-cash-keypad/);
    assert.match(source, /if \(radio\.value === 'cash'\)[\s\S]*openStaffExtensionCashCalculator\(\)/);
});

test('Cash extension rechecks and updates atomically through staff RPC; no browser booking update', () => {
    assert.match(source, /staff_booking_extension_options/);
    assert.match(source, /staff_collect_cash_for_booking_extension/);
    assert.match(source, /parseCashTenderMinor\(staffExtensionCashInput\?\.value\)/);
    assert.doesNotMatch(source, /from\(['"]booking['"]\)\.update\([^)]*end_at/);
    assert.match(migration, /grant execute on function public\.staff_collect_cash_for_booking_extension\(text,bigint,integer,bigint\) to authenticated/);
    assert.match(migration, /v_tender<p_amount_minor/);
    assert.match(migration, /The next time is no longer available/);
    assert.match(migration, /v_max_minutes:=greatest\(0,floor\(extract\(epoch from \(v_max_end-r\.ends_at\)\)\/3600\)::integer\*60\)/);
    assert.match(migration, /for v_minutes in 60\.\.v_max_minutes by 60 loop/);
    assert.match(migration, /set end_at=v_new_end,amount_total=coalesce\(amount_total,v_base\)\+v_amount/);
});

test('Extension cash calculator uses integer cents and rejects underpayment', () => {
    const helperStart = source.indexOf('    function parseCashTenderMinor(value) {');
    const helperEnd = source.indexOf('\n\n', helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart);
    const input = { value: '35.25', hidden: false };
    const change = { textContent: '' };
    const validation = { hidden: false, textContent: '' };
    const confirm = { disabled: false };
    const context = {
        staffExtensionCashInput: input,
        staffExtensionSelected: { amount_minor: 3500 },
        staffExtensionCashDue: { textContent: '' }, staffExtensionCashChange: change,
        staffExtensionCashValidation: validation, staffExtensionCashConfirm: confirm,
        formatStaffPeso: value => `₱${value.toFixed(2)}`,
    };
    const sourceFns = source.slice(helperStart, helperEnd);
    const updateStart = source.indexOf('    function updateStaffExtensionCashCalculator() {');
    const updateEnd = source.indexOf('\n\n    function parseCashTenderMinor', updateStart);
    assert.ok(updateStart >= 0 && updateEnd > updateStart);
    runInNewContext(`${sourceFns}\n${source.slice(updateStart, updateEnd)}; globalThis.parse = parseCashTenderMinor; globalThis.update = updateStaffExtensionCashCalculator;`, context);
    context.update();
    assert.equal(change.textContent, '₱0.25');
    assert.equal(confirm.disabled, false);
    input.value = '34.99';
    context.update();
    assert.equal(change.textContent, '—');
    assert.equal(confirm.disabled, true);
    input.value = '35.251';
    assert.equal(context.parse(input.value), null);
});

test('Online extension holds the physical slot and only extends from verified PayMongo settlement', () => {
    assert.match(edge, /hasVerifiedEmailSession/);
    assert.match(edge, /p_staff_id:\s*authData\.user\.id/);
    assert.match(edge, /register_paymongo_checkout_request/);
    assert.match(edge, /mark_staff_booking_extension_ready/);
    assert.match(edge, /send_email_receipt:\s*false/);
    assert.match(migration, /insert into internal\.reservation_resource_slots\(hold_item_id,resource_id,during\)/);
    assert.match(migration, /public\.record_paymongo_paid/);
    assert.match(migration, /v_marker:=E'\\n  if a\.intent_id is not null then'/);
    assert.match(migration, /if x\.starts_at<=now\(\) then[\s\S]*refund_review_required',true/);
    assert.match(migration, /p\.role='staff' and p\.status='active'/);
    assert.match(migration, /a\.intent_id is not null and exists\(select 1 from internal\.staff_booking_extension_checkouts/);
    assert.match(migration, /perform internal\.persist_payment_acknowledgment\(v_payment_id,'booking',x\.extension_reservation_id,null\)/);
    assert.match(migration, /where a\.id=p_attempt_id and x\.staff_id=v_actor/);
    assert.match(migration, /checked_out_at timestamptz,status text,customer_id uuid,listing_id uuid/);
    assert.match(migration, /values\(coalesce\(r\.customer_id,p_staff_id\),'creating','full'/);
    assert.match(migration, /payment_option,pass_on_fees,staff_id\)[\s\S]*values\(null,v_intent,coalesce\(r\.customer_id,p_staff_id\)[\s\S]*,p_staff_id\)/);
    assert.match(migration, /create trigger paymongo_release_reviewed_staff_extension_hold[\s\S]*execute function internal\.release_reviewed_staff_extension_hold\(\)/);
    assert.match(migration, /delete from internal\.reservation_resource_slots s where s\.hold_item_id in[\s\S]*where i\.intent_id=new\.intent_id/);
    assert.match(source, /PayMongo confirmed payment and the booking was extended/);
    assert.match(source, /PayMongo did not return a valid checkout link/);
    assert.match(source, /method === 'cash' && result\?\.data\?\.ok !== true/);
});
