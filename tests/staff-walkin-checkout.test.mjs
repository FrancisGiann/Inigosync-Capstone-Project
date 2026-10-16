import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = (await readFile(new URL('../supabase/functions/staff-walkin-checkout/index.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '');
const executable = stripTypeScriptTypes(source, { mode: 'strip' });
const orderId = 'a25dc45b-40ba-4b5b-96d6-4487dbe7a526';
const attemptId = 'd25dc45b-40ba-4b5b-96d6-4487dbe7a526';

function checkoutFixture({ channel, settings = { card_enabled: true, gcash_enabled: true, qrph_enabled: false }, savedRequest = null, existingIntent = false, expiresAt = '2031-01-01T00:15:00Z', webhookReady = true, testUrl = 'https://test.paymongo.com/qrph/fixture' } = {}) {
    let handler;
    let checkoutRequest;
    let fixtureAttachedArgs;
    const apiRequests = [];
    const rpcCalls = [];
    const admin = {
        auth: { getUser: async () => ({ data: { user: { id: 'staff-1' } }, error: null }) },
        rpc: async (name, args) => {
            rpcCalls.push({ name, args });
            if (name === 'prepare_staff_walkin_checkout') return { data: { status: 'creating', attempt_id: attemptId, base_minor: 12000, expires_at: expiresAt, checkout_request: savedRequest, ...(existingIntent ? { paymongo_session_id: 'pi_fixture' } : {}) }, error: null };
            if (name === 'register_paymongo_checkout_request') return { data: true, error: null };
            if (name === 'attach_paymongo_checkout') return { data: true, error: null };
            if (name === 'register_paymongo_qrph_intent') return { data: true, error: null };
            if (name === 'attach_paymongo_qrph_intent') { fixtureAttachedArgs = args; return { data: true, error: null }; }
            throw new Error(`Unexpected RPC: ${name}`);
        },
        from: table => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: table === 'profiles' ? { role: 'staff', status: 'active' } : settings, error: null }) }),
    };
    runInNewContext(executable, {
        Deno: { env: { get: key => ({ APP_BASE_URL: 'https://inigos.example', SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_ROLE_KEY: 'service-key', PAYMONGO_SECRET_KEY: 'sk_test_fixture', PAYMONGO_PUBLIC_KEY: 'pk_test_fixture', PAYMONGO_WEBHOOK_SECRET: 'whsec_fixture' })[key] }, serve: fn => { handler = fn; } },
        createClient: () => admin,
        hasVerifiedEmailSession: async () => true,
        hasPaymongoPaidWebhook: async () => true,
        hasPaymongoWebhook: async () => webhookReady,
        enabledPaymongoMethods: settings => [ ...(settings?.card_enabled ? ['card'] : []), ...(settings?.gcash_enabled ? ['gcash'] : []), ...(settings?.qrph_enabled ? ['qrph'] : []) ],
        fetch: async (url, options) => {
            apiRequests.push({ url, options });
            if (url.endsWith('/v1/payment_intents')) {
                checkoutRequest = JSON.parse(options.body).data.attributes;
                return new Response(JSON.stringify({ data: { id: 'pi_fixture', attributes: { client_key: 'pi_fixture_secret', amount: 12000, currency: 'PHP', livemode: false } } }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (url.includes('/v1/payment_intents/pi_fixture'))
                return new Response(JSON.stringify({ data: { id: 'pi_fixture', attributes: { amount: 12000, livemode: false, next_action: { code: { image_url: 'data:image/png;base64,AAAA', test_url: testUrl } } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
            if (url.endsWith('/v1/payment_methods'))
                return new Response(JSON.stringify({ data: { id: 'pm_fixture' } }), { status: 200, headers: { 'content-type': 'application/json' } });
            if (url.includes('/attach'))
                return new Response(JSON.stringify({ data: { id: 'pi_fixture', attributes: { amount: 12000, livemode: false, next_action: { code: { image_url: 'data:image/png;base64,AAAA', test_url: testUrl } } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
            checkoutRequest = JSON.parse(options.body).data.attributes;
            return new Response(JSON.stringify({ data: { id: 'cs_fixture', attributes: { checkout_url: 'https://checkout.paymongo.com/fixture', livemode: false } } }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
        Request, Response, URL, AbortSignal, btoa, console,
    });
    const request = new Request('https://db.example/functions/v1/staff-walkin-checkout', {
        method: 'POST', headers: { authorization: 'Bearer staff-token', origin: 'https://inigos.example' },
        body: JSON.stringify({ order_id: orderId, ...(channel ? { channel } : {}) }),
    });
    return { request, handler: () => handler, rpcCalls, checkoutRequest: () => checkoutRequest, apiRequests, attachedArgs: () => fixtureAttachedArgs };
}

test('direct QR Ph flow makes an amount-specific PayMongo intent with GCash disabled', async () => {
    const fixture = checkoutFixture({ channel: 'qrph', settings: { card_enabled: false, gcash_enabled: false, qrph_enabled: true } });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 200);
    assert.deepEqual(Array.from(fixture.checkoutRequest().payment_method_allowed), ['qrph']);
    assert.equal(fixture.checkoutRequest().amount, 12000);
    assert.equal(fixture.apiRequests.some(call => call.url.includes('/v2/checkout_sessions')), false);
    assert.equal(fixture.apiRequests.some(call => call.url.endsWith('/v1/payment_methods')), true);
    assert.equal(fixture.apiRequests.some(call => call.url.includes('/payment_intents/pi_fixture/attach')), true);
    assert.match(fixture.apiRequests.find(call => call.url.endsWith('/v1/payment_methods')).options.headers['Idempotency-Key'], /:qrph-method$/);
    assert.match(fixture.apiRequests.find(call => call.url.includes('/attach')).options.headers['Idempotency-Key'], /:qrph-attach$/);
    assert.deepEqual(fixture.rpcCalls.map(call => call.name), [
        'prepare_staff_walkin_checkout', 'register_paymongo_qrph_intent', 'attach_paymongo_qrph_intent',
    ]);
    const result = await response.json();
    assert.equal(result.expires_at, '2031-01-01T00:15:00Z');
    assert.equal(result.channel, 'qrph');
    assert.equal(result.test_mode, true);
    assert.equal(result.qr_image_url, undefined, 'test QR image must never be surfaced');
    assert.equal(result.qr_test_url, 'https://test.paymongo.com/qrph/fixture');
    assert.equal(fixture.attachedArgs().p_qr_test_url, 'https://test.paymongo.com/qrph/fixture');
});

test('sandbox QR Ph rejects an untrusted test_url and does not surface the QR image', async () => {
    const fixture = checkoutFixture({ channel: 'qrph', settings: { card_enabled: false, gcash_enabled: false, qrph_enabled: true }, testUrl: 'https://attacker.example/steal' });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.test_mode, true);
    assert.equal(result.qr_test_url, null);
    assert.equal(result.qr_image_url, undefined);
    assert.equal(fixture.attachedArgs().p_qr_test_url, null);
});

test('QR Ph checkout fails closed when the QR payment setting is disabled', async () => {
    const fixture = checkoutFixture({ channel: 'qrph', settings: { card_enabled: true, gcash_enabled: false, qrph_enabled: false } });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 409);
    assert.equal(fixture.checkoutRequest(), undefined);
});

test('QR Ph checkout requires a readable owner payment setting', async () => {
    const fixture = checkoutFixture({ channel: 'qrph', settings: null });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 503);
    assert.equal(fixture.checkoutRequest(), undefined);
});

test('expired walk-in hold cannot create or replay a checkout', async () => {
    const fixture = checkoutFixture({ channel: 'qrph', settings: { card_enabled: true, gcash_enabled: true, qrph_enabled: true }, expiresAt: '2020-01-01T00:00:00Z' });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 409);
    assert.equal(fixture.checkoutRequest(), undefined);
    assert.deepEqual(fixture.rpcCalls.map(call => call.name), ['prepare_staff_walkin_checkout']);
});

test('checkout rejects unknown payment channels before creating an attempt', async () => {
    const fixture = checkoutFixture({ channel: 'gcash' });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 400);
    assert.equal(fixture.rpcCalls.length, 0);
});

test('existing online checkout keeps Card and GCash and staff return', async () => {
    const fixture = checkoutFixture();
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 200);
    assert.deepEqual(Array.from(fixture.checkoutRequest().payment_method_types), ['card', 'gcash']);
    assert.equal(new URL(fixture.checkoutRequest().success_url).pathname, '/Pages/staff_dashboard.html');
    assert.equal(new URL(fixture.checkoutRequest().success_url).searchParams.get('order'), orderId);
});

test('direct QR Ph flow fails closed without the payment.paid webhook', async () => {
    const fixture = checkoutFixture({ channel: 'qrph', settings: { card_enabled: true, gcash_enabled: false, qrph_enabled: true }, webhookReady: false });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 503);
    assert.equal(fixture.apiRequests.length, 0);
    assert.equal(fixture.rpcCalls.length, 0);
});

test('QR setup retry recovers an already attached PayMongo QR instead of creating another payment method', async () => {
    const savedRequest = { amount: 12000, currency: 'PHP', payment_method_allowed: ['qrph'], client_key: 'pi_fixture_secret', qr_expiry_seconds: 850 };
    const fixture = checkoutFixture({ channel: 'qrph', settings: { card_enabled: false, gcash_enabled: false, qrph_enabled: true }, savedRequest, existingIntent: true });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.test_mode, true);
    assert.equal(result.qr_test_url, 'https://test.paymongo.com/qrph/fixture');
    assert.equal(result.qr_image_url, undefined);
    assert.equal(fixture.attachedArgs().p_qr_test_url, 'https://test.paymongo.com/qrph/fixture');
    assert.equal(fixture.apiRequests.some(call => call.url.endsWith('/v1/payment_methods')), false);
    assert.deepEqual(fixture.rpcCalls.map(call => call.name), ['prepare_staff_walkin_checkout', 'attach_paymongo_qrph_intent']);
});
