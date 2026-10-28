import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { enabledPaymongoMethods } from '../supabase/functions/_shared/paymongo-methods.mjs';

const edgeSource = (await readFile(new URL('../supabase/functions/paymongo-checkout/index.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '');
const executable = stripTypeScriptTypes(edgeSource, { mode: 'strip' });

test('only customer checkout expands to the PayMongo sandbox method set', () => {
    const settings = { card_enabled: true, gcash_enabled: true, qrph_enabled: false };
    assert.deepEqual(enabledPaymongoMethods(settings), ['card', 'gcash']);
    assert.deepEqual(enabledPaymongoMethods(settings, { testMode: false }), ['card', 'gcash']);
    assert.deepEqual(enabledPaymongoMethods({ card_enabled: false, gcash_enabled: true, qrph_enabled: true }),
        ['gcash', 'qrph'], 'live channels remain owner-controlled');
    assert.deepEqual(enabledPaymongoMethods(settings, { testMode: true }),
        ['card', 'gcash', 'paymaya', 'grab_pay']);
    assert.deepEqual(enabledPaymongoMethods(null, { testMode: true }), [], 'missing settings still fail closed');
});

async function createCheckoutForKey(secretKey, { amountMinor = 5000, totalMinor = amountMinor,
    paymentOption = 'full', qrphEnabled = true, legacy = false } = {}) {
    let handler;
    let requestAttributes;
    const checkoutId = '11111111-2222-4333-8444-555555555555';
    const admin = {
        auth: { getUser: async () => ({ data: { user: { id: 'customer-1' } }, error: null }) },
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
            data: { card_enabled: true, gcash_enabled: true, qrph_enabled: qrphEnabled }, error: null,
        }) }) }) }),
        rpc: async (name) => {
            if (name === 'prepare_paid_checkout_cart') return { data: { attempt_id: checkoutId, item_count: 1 }, error: null };
            if (name === 'prepare_paymongo_checkout') return { data: [{ attempt_id: checkoutId,
                courts: 'Court 1' }], error: null };
            if (name === 'get_paymongo_checkout_attempt_detail') return { data: [{ id: checkoutId,
                status: 'creating', amount_minor: amountMinor, total_minor: totalMinor,
                payment_option: paymentOption, item_count: 1 }], error: null };
            if (name === 'register_paymongo_checkout_request' || name === 'attach_paymongo_checkout')
                return { data: true, error: null };
            throw new Error(`Unexpected RPC ${name}`);
        },
    };
    const isTestKey = secretKey.startsWith('sk_test_');
    runInNewContext(executable, {
        Deno: {
            env: { get: key => ({ APP_BASE_URL: 'https://sandbox.inigosync.example', SUPABASE_URL: 'https://db.example',
                SUPABASE_SERVICE_ROLE_KEY: 'service-key', PAYMONGO_SECRET_KEY: secretKey,
                PAYMONGO_WEBHOOK_SECRET: 'webhook-secret' })[key] },
            serve: callback => { handler = callback; },
        },
        createClient: () => admin,
        hasVerifiedEmailSession: async () => true,
        hasPaymongoPaidWebhook: async () => true,
        enabledPaymongoMethods,
        Request, Response, URL, AbortSignal, btoa, console,
        fetch: async (url, options) => {
            assert.equal(url, 'https://api.paymongo.com/v2/checkout_sessions');
            requestAttributes = JSON.parse(options.body).data.attributes;
            return { ok: true, status: 200, json: async () => ({ data: { id: 'cs_fixture', attributes: {
                checkout_url: 'https://checkout.paymongo.com/session', livemode: !isTestKey,
            } } }) };
        },
    });
    const response = await handler(new Request('https://db.example/functions/v1/paymongo-checkout', {
        method: 'POST', headers: { authorization: 'Bearer customer-token', origin: 'https://sandbox.inigosync.example' },
        body: JSON.stringify(legacy ? { booking_id: 123 } : {
            terms_acceptance: { accepted: true, version: 'customer-booking-v1' },
            payment_option: paymentOption, items: [{}],
        }),
    }));
    assert.equal(response.status, 200);
    return requestAttributes;
}

test('test secret enables requested hosted options and live secret keeps configured methods exactly', async () => {
    assert.deepEqual((await createCheckoutForKey('sk_test_fixture')).payment_method_types,
        ['card', 'gcash', 'paymaya', 'grab_pay', 'qrph']);
    assert.deepEqual((await createCheckoutForKey('sk_live_fixture', { qrphEnabled: false })).payment_method_types,
        ['card', 'gcash']);
});

test('test QR Ph is owner-controlled and available for full and deposit customer carts', async () => {
    const onePeso = await createCheckoutForKey('sk_test_fixture', { amountMinor: 100 });
    assert.deepEqual(onePeso.payment_method_types, ['card', 'gcash', 'paymaya', 'grab_pay', 'qrph']);
    assert.equal(onePeso.pass_on_fees, true);
    assert.deepEqual((await createCheckoutForKey('sk_test_fixture', { amountMinor: 200 })).payment_method_types,
        ['card', 'gcash', 'paymaya', 'grab_pay', 'qrph']);
    assert.deepEqual((await createCheckoutForKey('sk_test_fixture', { amountMinor: 201 })).payment_method_types,
        ['card', 'gcash', 'paymaya', 'grab_pay', 'qrph']);
    assert.deepEqual((await createCheckoutForKey('sk_test_fixture', { amountMinor: 32500, totalMinor: 65000,
        paymentOption: 'downpayment' })).payment_method_types, ['card', 'gcash', 'paymaya', 'grab_pay', 'qrph']);
    assert.deepEqual((await createCheckoutForKey('sk_test_fixture', { amountMinor: 100,
        totalMinor: 200, qrphEnabled: false })).payment_method_types, ['card', 'gcash', 'paymaya', 'grab_pay']);
    assert.deepEqual((await createCheckoutForKey('sk_test_fixture', { amountMinor: 200,
        qrphEnabled: false })).payment_method_types, ['card', 'gcash', 'paymaya', 'grab_pay']);
    assert.deepEqual((await createCheckoutForKey('sk_live_fixture', { amountMinor: 100 })).payment_method_types,
        ['card', 'gcash', 'qrph']);
});

test('legacy booking retries add owner-enabled QR Ph only when creating a new test session', async () => {
    assert.deepEqual((await createCheckoutForKey('sk_test_fixture', { legacy: true })).payment_method_types,
        ['card', 'gcash', 'paymaya', 'grab_pay', 'qrph']);
    assert.deepEqual((await createCheckoutForKey('sk_test_fixture', { legacy: true, qrphEnabled: false }))
        .payment_method_types, ['card', 'gcash', 'paymaya', 'grab_pay']);
});
