import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const helperSource = await readFile(new URL('../includes/paymentAcknowledgment.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261016035656_payment_ack_receipt_details.sql', import.meta.url), 'utf8');
const context = { window: { escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;') } };
runInNewContext(helperSource, context);
const render = context.window.InigoPaymentAcknowledgment.render;

test('new saved snapshots render the shared thermal acknowledgment with payment and item details', () => {
    const html = render({
        transaction_id: 12345,
        receipt_number: 'PA-20261016-0000001',
        issued_at: '2026-10-15T16:00:00Z',
        customer_name: 'Ari Customer',
        payment_method: 'paymongo',
        payment_status: 'paid',
        court_subtotal_minor: 100000,
        subtotal_minor: 100000,
        fee_minor: 5000,
        gross_minor: 105000,
        remaining_balance_minor: 0,
        items: [{
            reservation_id: 42, sport: 'Badminton', court: 'Court 1', unit: 'Court 1',
            starts_at: '2026-10-20T02:00:00Z', ends_at: '2026-10-20T04:00:00Z',
            duration_minutes: 120, rate_quantity: 1, billable_quantity: 2, rate_unit: '/hr',
            subtotal_minor: 100000,
        }],
    }, { sourceLabel: 'Booking ID', sourceId: 42 });

    for (const text of [
        'InigoSync', '(Inigos Sports Center)', 'PAYMENT ACKNOWLEDGEMENT',
        'Booking ID', '#42', 'Transaction ID', '12345', 'Ari Customer',
        'Badminton', 'Court 1', 'Duration: 2 hrs', '2 hrs × Rate unavailable per hour', '₱1,000.00',
        'Booking total', '₱1,000.00', 'Subtotal (this payment)', 'Processing fee', '₱50.00', 'TOTAL PAID', '₱1,050.00', 'Paid',
        'NOT AN OFFICIAL RECEIPT',
    ]) assert.ok(html.includes(text), `receipt includes ${text}`);
    assert.match(html, /Payment method<\/span><strong>Online<\/strong>/);
});

test('legacy snapshots retain recorded item amounts without invented transaction or rate data', () => {
    const html = render({
        receipt_id: 'legacy-ack',
        issued_at: null,
        payment_method: 'cash',
        payment_status: 'paid',
        subtotal: 300,
        fee: 0,
        total: 300,
        items: [{ sport: 'Basketball', court: 'Court A', starts_at: null, ends_at: null, subtotal: 300 }],
    }, { sourceLabel: 'Walk-in visit ID', sourceId: 'walkin-42', itemReferenceLabel: 'Visit ID' });
    assert.match(html, /Walk-in visit ID<\/span><strong>#walkin-42/);
    assert.match(html, /Item amount <strong>₱300\.00/);
    assert.match(html, /Payment method<\/span><strong>Cash/);
    assert.doesNotMatch(html, /Transaction ID|Payment date|×|Duration:/);
    assert.match(html, /Rate unavailable/);
    assert.match(html, /Processing fee[\s\S]*?₱0\.00/);
    assert.match(html, /Subtotal \(this payment\)<\/span><strong>₱300\.00/);
    assert.doesNotMatch(html, /Booking total|Remaining balance/);
});

test('down-payment receipt separates booking total, this transaction, and remaining balance', () => {
    const html = render({
        payment_status: 'down_payment', payment_method: 'cash',
        court_subtotal_minor: 10000, subtotal_minor: 5000, fee_minor: 0,
        gross_minor: 5000, remaining_balance_minor: 5000,
        items: [{ reservation_id: 8, sport: 'Badminton', duration_minutes: 60,
            rate_unit: '/hr', rate_quantity: 1, billable_quantity: 1, subtotal_minor: 10000 }],
    }, { sourceLabel: 'Booking ID', sourceId: 8 });
    assert.match(html, /Booking total<\/span><strong>₱100\.00/);
    assert.match(html, /Subtotal \(this payment\)<\/span><strong>₱50\.00/);
    assert.match(html, /Remaining balance<\/span><strong>₱50\.00/);
    assert.match(html, /Item amount <strong>₱100\.00/);
    assert.match(html, /TOTAL PAID<\/span><strong>₱50\.00/);
});

test('legacy hourly duration is shown separately without assuming an unsaved billable quantity', () => {
    const html = render({ items: [{ rate_unit: '/hr', duration_minutes: 90, subtotal: 450 }] });
    assert.match(html, /Duration: 1 hr 30 min/);
    assert.doesNotMatch(html, /1\.5 hrs ×/);
});

test('walk-in order receipts distinguish the order ID from each visit ID', () => {
    const html = render({ items: [{ reservation_id: 79, sport: 'Basketball', subtotal_minor: 5000 }] }, {
        sourceLabel: 'Walk-in order ID', sourceId: 'order-uuid', itemReferenceLabel: 'Visit ID',
    });
    assert.match(html, /Walk-in order ID<\/span><strong>#order-uuid/);
    assert.match(html, /Visit ID #79/);
});

test('each item renders its saved sport, court, and distinct unit as separate labeled fields', () => {
    const html = render({ items: [{ sport: 'Badminton', court: 'Badminton Hall', unit: 'Court 1' }] });
    assert.match(html, /Sport:<\/span><strong>Badminton<\/strong>/);
    assert.match(html, /Court:<\/span><strong>Badminton Hall<\/strong>/);
    assert.match(html, /Unit:<\/span><strong>Court 1<\/strong>/);
});

test('new acknowledgment insert trigger snapshots actual payment and reservation pricing facts', () => {
    assert.match(migration, /before insert on internal\.payment_acknowledgments/i);
    assert.match(migration, /'transaction_id', new\.payment_id/);
    assert.match(migration, /'duration_minutes', v_duration/);
    assert.match(migration, /'rate_quantity', v_quantity/);
    assert.match(migration, /'billable_quantity', v_billable_quantity/);
    assert.match(migration, /v_duration::numeric \/ 60/);
    assert.match(migration, /'rate_unit', v_rate_unit/);
    assert.doesNotMatch(migration, /rate_minor|round\(.*amount_total/s, 'rate is never inferred from the saved item total');
    assert.match(migration, /b\.payment_id = new\.payment_id or b\.balance_payment_id = new\.payment_id/);
    assert.match(migration, /w\.walkin_order_id = new\.order_id/);
});

