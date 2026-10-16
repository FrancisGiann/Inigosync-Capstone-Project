import test from 'node:test';
import assert from 'node:assert/strict';
import { validPaymongoSignature } from '../supabase/functions/paymongo-webhook/_shared/paymongo-signature.ts';
import { paidCheckoutPayment as webhookPayment } from '../supabase/functions/paymongo-webhook/_shared/paid-checkout.ts';
import { paidCheckoutPayment as expiryPayment } from '../supabase/functions/paymongo-expire-checkouts/_shared/paid-checkout.ts';
import { paidQrPhPayment } from '../supabase/functions/_shared/paid-qrph-payment.mjs';
import { hasPaymongoWebhook } from '../supabase/functions/_shared/paymongo-readiness.mjs';
import { enabledPaymongoMethods } from '../supabase/functions/_shared/paymongo-methods.mjs';

async function signedHeader(rawBody, secret, timestamp, mode = 'te') {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`)));
    const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `t=${timestamp},te=${mode === 'te' ? hex : ''},li=${mode === 'li' ? hex : ''}`;
}

test('accepts a fresh test-mode signature over the exact raw body', async () => {
    const now = 1_800_000_000;
    const raw = '{"data":{"id":"evt_test"}}';
    const header = await signedHeader(raw, 'whsec_test', now);
    assert.equal(await validPaymongoSignature(raw, header, 'whsec_test', true, now), true);
});

test('rejects a different secret, modified body, and wrong mode field', async () => {
    const now = 1_800_000_000;
    const raw = '{"data":{"id":"evt_test"}}';
    const header = await signedHeader(raw, 'whsec_test', now);
    assert.equal(await validPaymongoSignature(raw, header, 'whsec_other', true, now), false);
    assert.equal(await validPaymongoSignature(`${raw} `, header, 'whsec_test', true, now), false);
    assert.equal(await validPaymongoSignature(raw, header, 'whsec_test', false, now), false);
});

test('rejects stale signatures and malformed digest values', async () => {
    const now = 1_800_000_000;
    const raw = '{"data":{"id":"evt_test"}}';
    const stale = await signedHeader(raw, 'whsec_test', now - 301);
    assert.equal(await validPaymongoSignature(raw, stale, 'whsec_test', true, now), false);
    assert.equal(await validPaymongoSignature(raw, `t=${now},te=not-hex,li=`, 'whsec_test', true, now), false);
});

test('direct QR Ph paid event parser returns the intent and exact gross/fee/net values', () => {
    const payment = { id: 'pay_Qrph1', type: 'payment', attributes: {
        status: 'paid', currency: 'PHP', amount: 12000, fee: 300, net_amount: 11700,
        payment_intent_id: 'pi_Qrph1', source: { type: 'qrph' },
    } };
    assert.deepEqual(paidQrPhPayment(payment), {
        paymentId: 'pay_Qrph1', intentId: 'pi_Qrph1', amountMinor: 12000, feeMinor: 300, netMinor: 11700,
    });
    assert.equal(paidQrPhPayment({ ...payment, attributes: { ...payment.attributes, amount: 11999 } }), null);
    assert.equal(paidQrPhPayment({ ...payment, attributes: { ...payment.attributes, source: { type: 'gcash' } } }), null);
    assert.equal(paidQrPhPayment({ ...payment, attributes: { ...payment.attributes, status: 'pending' } }), null);
});

test('PayMongo webhook readiness requires the requested event on the matching live endpoint', async () => {
    const fetcher = async () => new Response(JSON.stringify({ data: [{ attributes: {
        url: 'https://db.example/functions/v1/paymongo-webhook', status: 'enabled', livemode: true,
        events: ['checkout_session.payment.paid'],
    } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const args = { secretKey: 'sk_live_fixture', webhookSecret: 'whsec_fixture',
        supabaseUrl: 'https://db.example', fetcher };
    assert.equal(await hasPaymongoWebhook({ ...args, eventType: 'checkout_session.payment.paid' }), true);
    assert.equal(await hasPaymongoWebhook({ ...args, eventType: 'payment.paid' }), false);
});

test('QR Ph availability is independent from GCash and card owner settings', () => {
    assert.deepEqual(enabledPaymongoMethods({ card_enabled: false, gcash_enabled: false, qrph_enabled: true }), ['qrph']);
    assert.deepEqual(enabledPaymongoMethods({ card_enabled: false, gcash_enabled: false, qrph_enabled: false }), []);
});

for (const [name, parse] of [['webhook', webhookPayment], ['expiry reconciliation', expiryPayment]]) {
    test(`${name} extracts gross, provider fee, and net amounts for reconciliation`, () => {
        const result = parse({ payments: [{ id: 'pay_test_1', attributes: {
            status: 'paid', amount: 10000, fee: 300, net_amount: 9700, currency: 'PHP',
        } }] });
        assert.deepEqual(result, {
            paymentId: 'pay_test_1', amountMinor: 10000, feeMinor: 300, netMinor: 9700,
        });
    });

    test(`${name} rejects inconsistent provider fee reconciliation`, () => {
        assert.equal(parse({ payments: [{ id: 'pay_test_1', attributes: {
            status: 'paid', amount: 10000, fee: 301, net_amount: 9700, currency: 'PHP',
        } }] }), null);
    });

    test(`${name} ignores unpaid, invalid, and non-PHP payment records`, () => {
        assert.equal(parse({ payments: [{ id: 'pay_test_1', attributes: {
            status: 'failed', amount: 10000, currency: 'PHP',
        } }] }), null);
        assert.equal(parse({ payments: [{ id: 'pay_test_2', attributes: {
            status: 'paid', amount: 10000, currency: 'USD',
        } }] }), null);
    });
}
