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

function checkoutFixture({ channel, settings = { card_enabled: true, gcash_enabled: true }, savedRequest = null, expiresAt = '2031-01-01T00:15:00Z' } = {}) {
    let handler;
    let checkoutRequest;
    const rpcCalls = [];
    const admin = {
        auth: { getUser: async () => ({ data: { user: { id: 'staff-1' } }, error: null }) },
        rpc: async (name, args) => {
            rpcCalls.push({ name, args });
            if (name === 'prepare_staff_walkin_checkout') return { data: { status: 'creating', attempt_id: attemptId, base_minor: 12000, expires_at: expiresAt, checkout_request: savedRequest }, error: null };
            if (name === 'register_paymongo_checkout_request') return { data: true, error: null };
            if (name === 'attach_paymongo_checkout') return { data: true, error: null };
            throw new Error(`Unexpected RPC: ${name}`);
        },
        from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: settings, error: null }) }),
    };
    runInNewContext(executable, {
        Deno: { env: { get: key => ({ APP_BASE_URL: 'https://inigos.example', SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_ROLE_KEY: 'service-key', PAYMONGO_SECRET_KEY: 'sk_test_fixture' })[key] }, serve: fn => { handler = fn; } },
        createClient: () => admin,
        fetch: async (_url, options) => {
            checkoutRequest = JSON.parse(options.body).data.attributes;
            return new Response(JSON.stringify({ data: { id: 'cs_fixture', attributes: { checkout_url: 'https://checkout.paymongo.com/fixture', livemode: false } } }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
        Request, Response, URL, AbortSignal, btoa, console,
    });
    const request = new Request('https://db.example/functions/v1/staff-walkin-checkout', {
        method: 'POST', headers: { authorization: 'Bearer staff-token', origin: 'https://inigos.example' },
        body: JSON.stringify({ order_id: orderId, ...(channel ? { channel } : {}) }),
    });
    return { request, handler: () => handler, rpcCalls, checkoutRequest: () => checkoutRequest };
}

test('QR checkout offers GCash only and returns the customer to a public page', async () => {
    const fixture = checkoutFixture({ channel: 'gcash' });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 200);
    assert.deepEqual(Array.from(fixture.checkoutRequest().payment_method_types), ['gcash']);
    assert.equal(new URL(fixture.checkoutRequest().success_url).pathname, '/Pages/walkin_payment_return.html');
    assert.equal(new URL(fixture.checkoutRequest().success_url).searchParams.get('result'), 'submitted');
    assert.equal(new URL(fixture.checkoutRequest().cancel_url).searchParams.get('result'), 'cancelled');
    assert.equal(new URL(fixture.checkoutRequest().success_url).searchParams.has('order'), false);
    const result = await response.json();
    assert.equal(result.expires_at, '2031-01-01T00:15:00Z');
    assert.equal(result.channel, 'gcash');
});

test('QR checkout fails closed when GCash is disabled', async () => {
    const fixture = checkoutFixture({ channel: 'gcash', settings: { card_enabled: true, gcash_enabled: false } });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 409);
    assert.equal(fixture.checkoutRequest(), undefined);
});

test('QR checkout requires a readable owner payment setting', async () => {
    const fixture = checkoutFixture({ channel: 'gcash', settings: null });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 503);
    assert.equal(fixture.checkoutRequest(), undefined);
});

test('expired walk-in hold cannot create or replay a checkout', async () => {
    const fixture = checkoutFixture({ channel: 'gcash', expiresAt: '2020-01-01T00:00:00Z' });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 409);
    assert.equal(fixture.checkoutRequest(), undefined);
    assert.deepEqual(fixture.rpcCalls.map(call => call.name), ['prepare_staff_walkin_checkout']);
});

test('checkout rejects unknown payment channels before creating an attempt', async () => {
    const fixture = checkoutFixture({ channel: 'qrph' });
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

test('retry replays the original GCash checkout request without changing its method', async () => {
    const savedRequest = {
        line_items: [{ name: 'Front desk walk-in order', amount: 12000, currency: 'PHP', quantity: 1 }],
        payment_method_types: ['gcash'],
        success_url: 'https://inigos.example/Pages/walkin_payment_return.html?result=submitted',
        cancel_url: 'https://inigos.example/Pages/walkin_payment_return.html?result=cancelled',
        reference_number: attemptId.replaceAll('-', ''), pass_on_fees: true,
    };
    const fixture = checkoutFixture({ savedRequest });
    const response = await fixture.handler()(fixture.request);
    assert.equal(response.status, 200);
    assert.deepEqual(fixture.checkoutRequest(), savedRequest);
    assert.equal((await response.json()).channel, 'gcash');
});
