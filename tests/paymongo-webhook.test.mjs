import test from 'node:test';
import assert from 'node:assert/strict';
import { validPaymongoSignature } from '../supabase/functions/paymongo-webhook/_shared/paymongo-signature.ts';
import { paidCheckoutPayment as webhookPayment } from '../supabase/functions/paymongo-webhook/_shared/paid-checkout.ts';
import { paidCheckoutPayment as expiryPayment } from '../supabase/functions/paymongo-expire-checkouts/_shared/paid-checkout.ts';

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
