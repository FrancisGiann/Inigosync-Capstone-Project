import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const html = (await readFile(new URL('../Pages/staff_dashboard.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const css = (await readFile(new URL('../Style/staff_dashboard.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const source = (await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const migration = await readFile(new URL('../supabase/migrations/20261101190000_staff_timein_cash_tender.sql', import.meta.url), 'utf8');

test('Time-In payment methods only select; fixed title/footer leave the body scrollable', () => {
    assert.match(html, /<header class="staff-timein-header">\s*<h3 id="staffTimeInModalTitle">Time-In<\/h3>/);
    assert.match(html, /<div class="staff-timein-body staff-modal-body">/);
    assert.match(html, /<footer class="staff-form-actions staff-timein-footer">[\s\S]*data-staff-timein-cancel[\s\S]*data-staff-timein-confirm/);
    assert.match(html, /data-staff-timein-method="Cash"/);
    assert.match(html, /data-staff-timein-method="Online Payment"[\s\S]*Online Payment/);
    assert.doesNotMatch(html, /data-staff-timein-method="QR Payment"|data-staff-timein-qr-panel/);
    assert.match(html, /data-staff-timein-cash-key="Backspace"/);
    assert.match(html, /data-staff-timein-cash-key="Enter"/);
    assert.match(html, /data-staff-timein-cash-key="\."/);
    assert.match(css, /\.staff-timein-dialog\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;[\s\S]*overflow:\s*hidden/);
    assert.match(css, /\.staff-timein-body\s*\{[\s\S]*overflow-y:\s*auto/);

    const selectionStart = source.indexOf("    timeInPaymentOptionEls.forEach((option) => {\n        option.addEventListener('click'");
    const selectionEnd = source.indexOf("\n    if (timeInConfirmBtn) {\n        timeInConfirmBtn.addEventListener", selectionStart);
    const selection = source.slice(selectionStart, selectionEnd);
    assert.match(selection, /timeInSelectedMethod = radio\.dataset\.staffTimeinMethod/);
    assert.match(selection, /timeInConfirmBtn\.textContent = 'Pay'/);
    assert.doesNotMatch(selection, /\.rpc\(|\.invoke\(|staff_collect_cash_and_check_in/);
});

test('cash tender uses integer cents, rejects underpayment, and supports final server confirmation only', () => {
    const tenderStart = source.indexOf('    function timeInCashTenderMinor() {');
    const tenderEnd = source.indexOf('\n\n    function updateTimeInCashModal()', tenderStart);
    assert.ok(tenderStart >= 0 && tenderEnd > tenderStart);
    const tender = { value: '125.30' };
    const context = { timeInCashTenderInput: tender };
    runInNewContext(`${source.slice(tenderStart, tenderEnd)}; globalThis.parseTender = timeInCashTenderMinor;`, context);
    assert.equal(context.parseTender(), 12530);
    tender.value = '125.301';
    assert.equal(context.parseTender(), null);
    tender.value = '90071992547410';
    assert.equal(context.parseTender(), null, 'unsafe integer minor units are rejected');

    const updateStart = source.indexOf('    function updateTimeInCashModal() {');
    const updateEnd = source.indexOf('\n\n    function openTimeInCashModal', updateStart);
    const due = { textContent: '' };
    const change = { textContent: '' };
    const validation = { textContent: '', setAttribute() {} };
    const pay = { disabled: false };
    const updateContext = {
        timeInCashTenderDueMinor: 12530,
        timeInCashTenderInput: { value: '125.29' },
        timeInCashDueEl: due,
        timeInCashChangeEl: change,
        timeInCashValidationEl: validation,
        timeInCashPayBtn: pay,
        timeInCashSubmitting: false,
        timeInPaymentInFlight: false,
        staffCashEnabled: true,
        timeInCashTenderMinor: () => 12529,
        formatStaffPeso: value => `₱${value.toFixed(2)}`,
    };
    runInNewContext(`${source.slice(updateStart, updateEnd)}; globalThis.update = updateTimeInCashModal;`, updateContext);
    assert.equal(updateContext.update(), false);
    assert.equal(pay.disabled, true);
    assert.equal(change.textContent, '—');

    assert.match(source, /p_cash_tendered_minor:\s*tenderedMinor/);
    assert.match(source, /window\.sb\.rpc\('staff_collect_cash_and_check_in'/);
});

test('online Time-In opens only the verified hosted checkout and keeps payment pending until return', () => {
    assert.match(source, /window\.sb\.functions\.invoke\('paymongo-balance-checkout',\s*\{\s*body:\s*\{\s*source,\s*id:\s*String\(target\.idValue\)\s*\}/);
    assert.doesNotMatch(source, /paymongo-balance-checkout'[\s\S]{0,160}channel:\s*'qrph'/);
    assert.ok(source.includes('checkout\\.paymongo\\.com'));
    assert.match(source, /PayMongo confirmed the balance\. Review the reservation and confirm attendance\./);
});

test('cash RPC validates tender against the current balance and persists tender/change on payment and receipt', () => {
    assert.match(migration, /p_cash_tendered_minor is null or p_cash_tendered_minor<v_due_minor/);
    assert.match(migration, /cash_tendered_minor,cash_change_minor\)[\s\S]*p_cash_tendered_minor,v_change_minor/);
    assert.match(migration, /'cash_tendered_minor',p_cash_tendered_minor,'cash_change_minor',v_change_minor/);
    assert.match(migration, /Time-In opens 30 minutes before the scheduled start/);
    assert.match(migration, /grant execute on function public\.staff_collect_cash_and_check_in\(text,bigint,bigint\)\s+to authenticated/);
    assert.match(migration, /revoke all on function internal\.staff_collect_cash_and_check_in\(text,bigint,bigint\)\s+from public,anon,authenticated,service_role/);
});
