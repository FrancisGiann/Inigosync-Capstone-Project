import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const helper = await readFile(new URL('../includes/paymentAcknowledgment.js', import.meta.url), 'utf8');
const staffDashboard = await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');
const context = { window: { escapeHtml: (value) => String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]) } };
runInNewContext(helper, context);

test('payment acknowledgment renders English receipt details and removes a repeated sport prefix', () => {
    const html = context.window.InigoPaymentAcknowledgment.render({
        transaction_id: 'payment-123',
        payment_status: 'paid',
        payment_method: 'cash',
        issued_at: '2026-10-31T05:00:00Z',
        subtotal_minor: 150000,
        gross_minor: 150000,
        remaining_balance_minor: 0,
        items: [{
            reservation_id: 42,
            sport: 'Basketball',
            court: 'Basketball - Court 2',
            unit: 'Unit 2',
            starts_at: '2026-11-01T10:00:00+08:00',
            ends_at: '2026-11-01T11:00:00+08:00',
            duration_minutes: 60,
            subtotal_minor: 150000,
        }],
    });

    assert.match(html, /Transaction ID<\/span><strong>payment-123/);
    assert.match(html, /Sport:<\/span><strong>Basketball/);
    assert.match(html, /Court:<\/span><strong>Court 2/);
    assert.match(html, /Unit:<\/span><strong>Unit 2/);
    assert.doesNotMatch(html, /Court:<\/span><strong>Basketball/);
    assert.match(html, /Remaining balance<\/span><strong>₱0\.00/);
    assert.match(html, /Subtotal \(this payment\)<\/span><strong>₱1,500\.00/);
    assert.match(html, /TOTAL PAID/);

    const sameCourtAndUnit = context.window.InigoPaymentAcknowledgment.render({
        items: [{ sport: 'Basketball', court: 'Basketball Court 2', unit: 'Court 2' }],
    });
    assert.equal((sameCourtAndUnit.match(/<span>Unit:<\/span>/g) || []).length, 0,
        'a unit that repeats the normalized court is not printed a second time');

    const canonicalWalkin = context.window.InigoPaymentAcknowledgment.render({
        items: [{ sport: 'Badminton', court: 'Badminton', unit: 'Court 1' }],
    });
    assert.match(canonicalWalkin, /Sport:<\/span><strong>Badminton/);
    assert.match(canonicalWalkin, /Court:<\/span><strong>Court 1/);
    assert.doesNotMatch(canonicalWalkin, /Court:<\/span><strong>Badminton/);
    assert.equal((canonicalWalkin.match(/<span>Unit:<\/span>/g) || []).length, 0,
        'the specific unit becomes the court label when the saved court contains only the sport');
    assert.deepEqual(
        { ...context.window.InigoPaymentAcknowledgment.formatLocation({ sport: 'Badminton', court: 'Badminton', unit: 'Court 1' }) },
        { sport: 'Badminton', court: 'Court 1', unit: '' },
        'time-in receipts can reuse the same canonical location normalization',
    );

    const genericCourt = context.window.InigoPaymentAcknowledgment.render({
        items: [{ sport: 'Basketball', court: 'Basketball Court', unit: 'Court 2' }],
    });
    assert.match(genericCourt, /Court:<\/span><strong>Court 2/,
        'a generic sport-plus-Court value also falls back to the specific unit');
});

test('fully prepaid time-in acknowledgment keeps zero collected separate from zero remaining balance', () => {
    const receiptStart = staffDashboard.indexOf('function openTransactionVisitRecord(row)');
    const receiptEnd = staffDashboard.indexOf('function closeStaffReceiptModal()', receiptStart);
    const receipt = staffDashboard.slice(receiptStart, receiptEnd);

    assert.match(receipt, /prepaid \? '<div class="payment-ack-meta-row"><span>Remaining balance<\/span><strong>₱0\.00<\/strong><\/div>' : ''/);
    assert.match(receipt, /<span>Collected at Time-In<\/span><strong>\$\{window\.escapeHtml\(amount\)\}/);
    assert.match(receipt, /FULL PAYMENT PAID — NO NEW PAYMENT/);
    assert.match(receipt, /window\.InigoPaymentAcknowledgment\.formatLocation\(visit\)/);
    assert.match(receipt, /detail\('Court', location\.court\)/);
    assert.doesNotMatch(receipt, /detail\('Court', visit\.court\)/);
});
