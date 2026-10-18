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

function checkoutFixture({ channel, requestBody, settings = { card_enabled: true, gcash_enabled: true, qrph_enabled: false }, savedRequest = null, existingIntent = false, preparedOverride = null, expiresAt = '2031-01-01T00:15:00Z', webhookReady = true, testUrl = 'https://test.paymongo.com/qrph/fixture', qrImageUrl = 'data:image/png;base64,AAAA', secretMode = 'test', intentLivemode = false, attachedLivemode = false, providerLivemode = false, ordersLookupStatus = 200, legacyLookupStatus = 200, throwRpc = null } = {}) {
    let handler;
    let checkoutRequest;
    let fixtureAttachedArgs;
    const apiRequests = [];
    const rpcCalls = [];
    const admin = {
        auth: { getUser: async () => ({ data: { user: { id: 'staff-1' } }, error: null }) },
        rpc: async (name, args) => {
            rpcCalls.push({ name, args });
            if (name === throwRpc) throw new Error('fixture database transport failure');
            if (name === 'staff_create_walkin_order_service') return { data: { order_id: orderId, base_minor: 12000 }, error: null };
            if (name === 'prepare_staff_walkin_checkout') return { data: preparedOverride || { status: 'creating', attempt_id: attemptId, base_minor: 12000, expires_at: expiresAt, checkout_request: savedRequest, ...(existingIntent ? { paymongo_session_id: 'pi_fixture' } : {}) }, error: null };
            if (name === 'register_paymongo_checkout_request') return { data: true, error: null };
            if (name === 'attach_paymongo_checkout') return { data: true, error: null };
            if (name === 'register_paymongo_qrph_intent') return { data: true, error: null };
            if (name === 'attach_paymongo_qrph_intent') { fixtureAttachedArgs = args; return { data: true, error: null }; }
            throw new Error(`Unexpected RPC: ${name}`);
        },
        from: table => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: table === 'profiles' ? { role: 'staff', status: 'active' } : settings, error: null }) }),
    };
    runInNewContext(executable, {
        Deno: { env: { get: key => ({ APP_BASE_URL: 'https://inigos.example', SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_ROLE_KEY: 'service-key', PAYMONGO_SECRET_KEY: secretMode === 'test' ? 'sk_test_fixture' : 'sk_live_fixture', PAYMONGO_PUBLIC_KEY: secretMode === 'test' ? 'pk_test_fixture' : 'pk_live_fixture', PAYMONGO_WEBHOOK_SECRET: 'whsec_fixture' })[key] }, serve: fn => { handler = fn; } },
        createClient: () => admin,
        hasVerifiedEmailSession: async () => true,
        hasPaymongoPaidWebhook: async () => true,
        hasPaymongoWebhook: async () => webhookReady,
        enabledPaymongoMethods: settings => [ ...(settings?.card_enabled ? ['card'] : []), ...(settings?.gcash_enabled ? ['gcash'] : []), ...(settings?.qrph_enabled ? ['qrph'] : []) ],
        fetch: async (url, options) => {
            apiRequests.push({ url, options });
            if (url.endsWith('/v1/payment_intents')) {
                checkoutRequest = JSON.parse(options.body).data.attributes;
                return new Response(JSON.stringify({ data: { id: 'pi_fixture', attributes: { client_key: 'pi_fixture_secret', amount: 12000, currency: 'PHP', livemode: intentLivemode } } }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (url.endsWith('/v1/payment_methods'))
                return new Response(JSON.stringify({ data: { id: 'pm_fixture' } }), { status: 200, headers: { 'content-type': 'application/json' } });
            if (url.includes('/attach'))
                return new Response(JSON.stringify({ data: { id: 'pi_fixture', attributes: { amount: 12000, livemode: attachedLivemode, next_action: { code: { image_url: qrImageUrl, test_url: testUrl } } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
            if (url.includes('/v1/payment_intents/pi_fixture')) {
                const status = url.startsWith('https://orders-api.paymongo.com/') ? ordersLookupStatus : legacyLookupStatus;
                if (status !== 200) return new Response(JSON.stringify({ errors: [] }), { status });
                return new Response(JSON.stringify({ data: { id: 'pi_fixture', attributes: { amount: 12000, livemode: providerLivemode, next_action: { code: { image_url: qrImageUrl, test_url: testUrl } } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            checkoutRequest = JSON.parse(options.body).data.attributes;
            return new Response(JSON.stringify({ data: { id: 'cs_fixture', attributes: { checkout_url: 'https://checkout.paymongo.com/fixture', livemode: false } } }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
        Request, Response, URL, AbortSignal, btoa, console,
    });
    const request = new Request('https://db.example/functions/v1/staff-walkin-checkout', {
        method: 'POST', headers: { authorization: 'Bearer staff-token', origin: 'https://inigos.example' },
        body: JSON.stringify(requestBody || { order_id: orderId, ...(channel ? { channel } : {}) }),
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
    assert.equal(result.qr_image_url, 'data:image/png;base64,AAAA', 'PayMongo test QR image is returned for display');
    assert.equal(result.qr_test_url, 'https://test.paymongo.com/qrph/fixture');
    assert.equal(fixture.attachedArgs().p_qr_test_url, 'https://test.paymongo.com/qrph/fixture');
    assert.equal(fixture.attachedArgs().p_qr_livemode, false);
});

test('unexpected QR Ph setup errors return a retryable pending-order response instead of a platform 5xx', async () => {
    const fixture = checkoutFixture({ channel: 'qrph', throwRpc: 'attach_paymongo_qrph_intent',
        settings: { card_enabled: false, gcash_enabled: false, qrph_enabled: true } });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.order_id, orderId);
    assert.match(result.message, /unexpected error while saving QR Ph image/i);
    assert.ok(fixture.rpcCalls.some(call => call.name === 'register_paymongo_qrph_intent'), 'the created intent remains registered for idempotent retry');
});

test('fresh live QR Ph intent and attachment return a live QR without test metadata', async () => {
    const fixture = checkoutFixture({
        channel: 'qrph', settings: { card_enabled: false, gcash_enabled: false, qrph_enabled: true },
        secretMode: 'live', intentLivemode: true, attachedLivemode: true,
    });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.qr_image_url, 'data:image/png;base64,AAAA');
    assert.equal(result.test_mode, false);
    assert.equal(result.qr_test_url, undefined);
    assert.equal(fixture.attachedArgs().p_qr_livemode, true);
    assert.equal(fixture.attachedArgs().p_qr_test_url, null);
    assert.deepEqual(fixture.rpcCalls.map(call => call.name), [
        'prepare_staff_walkin_checkout', 'register_paymongo_qrph_intent', 'attach_paymongo_qrph_intent',
    ]);
});

test('fresh live intent rejects a test-mode attachment before persisting the QR', async () => {
    const fixture = checkoutFixture({
        channel: 'qrph', settings: { card_enabled: false, gcash_enabled: false, qrph_enabled: true },
        secretMode: 'live', intentLivemode: true, attachedLivemode: false,
    });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).qr_image_url, undefined);
    assert.equal(fixture.rpcCalls.some(call => call.name === 'register_paymongo_qrph_intent'), true,
        'the provider intent reference is registered for safe recovery');
    assert.equal(fixture.rpcCalls.some(call => call.name === 'attach_paymongo_qrph_intent'), false,
        'the QR image and livemode are not persisted after an attachment mode mismatch');
    assert.equal(fixture.attachedArgs(), undefined);
});

test('new QR Ph order is created through the verified service path with the reviewed quote', async () => {
    const items = [{ listing_id: 'listing-1', unit_id: 'unit-1', starts_at: '2031-01-01T03:00:00Z', ends_at: '2031-01-01T04:00:00Z', rate_quantity: 1, quoted_minor: 12000 }];
    const fixture = checkoutFixture({
        channel: 'qrph', settings: { card_enabled: false, gcash_enabled: false, qrph_enabled: true },
        requestBody: { guest_name: 'QR Guest', guest_mobile: null, items, channel: 'qrph' },
    });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.order_id, orderId);
    assert.equal(result.test_mode, true);
    assert.equal(result.qr_test_url, 'https://test.paymongo.com/qrph/fixture');
    assert.deepEqual(fixture.rpcCalls.map(call => call.name), [
        'staff_create_walkin_order_service', 'prepare_staff_walkin_checkout',
        'register_paymongo_qrph_intent', 'attach_paymongo_qrph_intent',
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.rpcCalls[0].args)), {
        p_staff_id: 'staff-1', p_customer_id: null, p_guest_name: 'QR Guest',
        p_guest_mobile: null, p_items: items, p_payment_method: 'paymongo',
    });
});

test('sandbox QR Ph rejects an untrusted test_url but still returns the actual test QR image', async () => {
    const fixture = checkoutFixture({ channel: 'qrph', settings: { card_enabled: false, gcash_enabled: false, qrph_enabled: true }, testUrl: 'https://attacker.example/steal' });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.test_mode, true);
    assert.equal(result.qr_test_url, null);
    assert.equal(result.qr_image_url, 'data:image/png;base64,AAAA');
    assert.equal(fixture.attachedArgs().p_qr_test_url, null);
});

test('QR Ph rejects an invalid provider QR image before attaching or returning it', async () => {
    const fixture = checkoutFixture({ channel: 'qrph', settings: { card_enabled: false, gcash_enabled: false, qrph_enabled: true }, qrImageUrl: 'https://attacker.example/qr.png' });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).message, 'PayMongo did not return a valid dynamic QR code. Retry setup before taking payment.');
    assert.equal(fixture.rpcCalls.some(call => call.name === 'attach_paymongo_qrph_intent'), false);
});

test('saved test QR attempts return the validated image and trusted simulator URL', async () => {
    const fixture = checkoutFixture({
        channel: 'qrph', settings: { card_enabled: false, gcash_enabled: false, qrph_enabled: true },
        preparedOverride: { status: 'ready', attempt_id: attemptId, base_minor: 12000,
            expires_at: '2031-01-01T00:15:00Z', qr_image_url: 'data:image/png;base64,SAVED',
            qr_livemode: false,
            qr_test_url: 'https://test.paymongo.com/qrph/saved',
            checkout_request: { payment_method_allowed: ['qrph'] } },
    });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.qr_image_url, 'data:image/png;base64,SAVED');
    assert.equal(result.test_mode, true);
    assert.equal(result.qr_test_url, 'https://test.paymongo.com/qrph/saved');
    assert.deepEqual(fixture.apiRequests, [], 'a saved ready QR is reused without creating another provider object');
});

test('saved live QR cannot be replayed or labeled as test after switching to test credentials', async () => {
    const fixture = checkoutFixture({
        channel: 'qrph', settings: { card_enabled: false, gcash_enabled: false, qrph_enabled: true },
        preparedOverride: { status: 'ready', attempt_id: attemptId, base_minor: 12000,
            expires_at: '2031-01-01T00:15:00Z', qr_image_url: 'data:image/png;base64,LIVE',
            qr_livemode: true, checkout_request: { payment_method_allowed: ['qrph'] } },
    });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 409);
    const result = await response.json();
    assert.equal(result.qr_image_url, undefined);
    assert.equal(result.test_mode, undefined);
    assert.match(result.message, /different or unknown PayMongo mode/);
    assert.deepEqual(fixture.apiRequests, [], 'a mode mismatch is rejected before any provider replay or image exposure');
});

test('partial PayMongo intent mode mismatch fails closed before creating or attaching a payment method', async () => {
    const savedRequest = { amount: 12000, currency: 'PHP', payment_method_allowed: ['qrph'], client_key: 'pi_fixture_secret', qr_expiry_seconds: 850 };
    const fixture = checkoutFixture({ channel: 'qrph', settings: { card_enabled: false, gcash_enabled: false, qrph_enabled: true }, savedRequest, existingIntent: true, providerLivemode: true });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 409);
    assert.match((await response.json()).message, /different or unknown mode or amount/);
    assert.equal(fixture.apiRequests.some(call => call.url.endsWith('/v1/payment_methods')), false);
    assert.equal(fixture.apiRequests.some(call => call.url.includes('/attach')), false);
    assert.deepEqual(fixture.rpcCalls.map(call => call.name), ['prepare_staff_walkin_checkout']);
});

test('saved QR attempts fail closed when the persisted image is invalid', async () => {
    const fixture = checkoutFixture({
        channel: 'qrph', settings: { card_enabled: false, gcash_enabled: false, qrph_enabled: true },
        preparedOverride: { status: 'ready', attempt_id: attemptId, base_minor: 12000,
            expires_at: '2031-01-01T00:15:00Z', qr_image_url: 'https://attacker.example/qr.png',
            checkout_request: { payment_method_allowed: ['qrph'] } },
    });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).qr_image_url, undefined);
    assert.deepEqual(fixture.apiRequests, []);
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
    assert.equal(result.qr_image_url, 'data:image/png;base64,AAAA');
    assert.equal(fixture.attachedArgs().p_qr_test_url, 'https://test.paymongo.com/qrph/fixture');
    assert.equal(fixture.attachedArgs().p_qr_livemode, false);
    assert.equal(fixture.apiRequests.some(call => call.url.endsWith('/v1/payment_methods')), false);
    assert.deepEqual(fixture.rpcCalls.map(call => call.name), ['prepare_staff_walkin_checkout', 'attach_paymongo_qrph_intent']);
});

test('QR setup retry retrieves a legacy intent after orders-api returns 404', async () => {
    const savedRequest = { amount: 12000, currency: 'PHP', payment_method_allowed: ['qrph'], client_key: 'pi_fixture_secret', qr_expiry_seconds: 850 };
    const fixture = checkoutFixture({ channel: 'qrph', settings: { card_enabled: false, gcash_enabled: false, qrph_enabled: true },
        savedRequest, existingIntent: true, ordersLookupStatus: 404 });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 200);
    assert.deepEqual(fixture.apiRequests.map(call => call.url), [
        'https://orders-api.paymongo.com/v1/payment_intents/pi_fixture',
        'https://api.paymongo.com/v1/payment_intents/pi_fixture',
    ]);
    assert.equal(fixture.attachedArgs().p_qr_livemode, false);
});

test('QR setup retry does not create another payment method when both intent lookups return 404', async () => {
    const savedRequest = { amount: 12000, currency: 'PHP', payment_method_allowed: ['qrph'], client_key: 'pi_fixture_secret', qr_expiry_seconds: 850 };
    const fixture = checkoutFixture({ channel: 'qrph', settings: { card_enabled: false, gcash_enabled: false, qrph_enabled: true },
        savedRequest, existingIntent: true, ordersLookupStatus: 404, legacyLookupStatus: 404 });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 409);
    assert.equal(fixture.apiRequests.some(call => call.url.endsWith('/v1/payment_methods')), false);
    assert.equal(fixture.attachedArgs(), undefined);
});
