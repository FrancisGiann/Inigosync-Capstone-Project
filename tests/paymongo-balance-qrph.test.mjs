import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = (await readFile(new URL('../supabase/functions/paymongo-balance-checkout/index.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '');
const executable = stripTypeScriptTypes(source, { mode: 'strip' });

function fixture(body) {
    let handler;
    const rpcCalls = [];
    const providerCalls = [];
    const admin = {
        auth: { getUser: async () => ({ data: { user: { id: 'staff-1' } }, error: null }) },
        rpc: async (name, args) => {
            rpcCalls.push({ name, args });
            if (name === 'prepare_paymongo_balance_checkout') return { data: {
                attempt_id: 'attempt-qr', amount_minor: 5000, status: 'creating',
                expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            }, error: null };
            if (name === 'register_paymongo_qrph_intent' || name === 'attach_paymongo_qrph_intent')
                return { data: true, error: null };
            throw new Error(`Unexpected RPC ${name}`);
        },
        from: table => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({
            data: table === 'app_settings' ? { qrph_enabled: true, card_enabled: false, gcash_enabled: false } : null,
            error: null,
        }) }),
    };
    runInNewContext(executable, {
        Deno: { env: { get: key => ({ APP_BASE_URL: 'https://inigos.example', SUPABASE_URL: 'https://db.example',
            SUPABASE_SERVICE_ROLE_KEY: 'service-key', PAYMONGO_SECRET_KEY: 'sk_test_fixture',
            PAYMONGO_PUBLIC_KEY: 'pk_test_fixture', PAYMONGO_WEBHOOK_SECRET: 'whsec_fixture' })[key] }, serve: fn => { handler = fn; } },
        createClient: () => admin,
        hasVerifiedEmailSession: async () => true,
        hasPaymongoPaidWebhook: async () => true,
        hasPaymongoWebhook: async () => true,
        enabledPaymongoMethods: settings => [
            ...(settings?.card_enabled ? ['card'] : []), ...(settings?.gcash_enabled ? ['gcash'] : []),
            ...(settings?.qrph_enabled ? ['qrph'] : []),
        ],
        fetch: async (url, options) => {
            providerCalls.push({ url, options });
            if (url.endsWith('/v1/payment_intents')) return new Response(JSON.stringify({ data: { id: 'pi_balance',
                attributes: { amount: 5000, currency: 'PHP', livemode: false, client_key: 'pi_balance_secret' } } }), { status: 200 });
            if (url.endsWith('/v1/payment_methods')) return new Response(JSON.stringify({ data: { id: 'pm_balance' } }), { status: 200 });
            return new Response(JSON.stringify({ data: { id: 'pi_balance', attributes: { amount: 5000, livemode: false,
                next_action: { code: { image_url: 'data:image/png;base64,AAAA', test_url: 'https://test.paymongo.com/qrph/balance' } } } } }), { status: 200 });
        },
        Request, Response, URL, AbortSignal, btoa, console,
    });
    const request = new Request('https://db.example/functions/v1/paymongo-balance-checkout', {
        method: 'POST', headers: { authorization: 'Bearer staff-token', origin: 'https://inigos.example' },
        body: JSON.stringify(body),
    });
    return { getHandler: () => handler, request, rpcCalls, providerCalls };
}

test('staff balance QR creates one persisted PayMongo intent and returns a QR only after attach succeeds', async () => {
    const f = fixture({ source: 'booking', id: '42', channel: 'qrph' });
    const response = await f.getHandler()(f.request);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.qr_image_url, 'data:image/png;base64,AAAA');
    assert.equal(result.test_mode, true);
    assert.equal(result.qr_test_url, 'https://test.paymongo.com/qrph/balance');
    assert.deepEqual(f.rpcCalls.map(call => call.name), [
        'prepare_paymongo_balance_checkout', 'register_paymongo_qrph_intent', 'attach_paymongo_qrph_intent',
    ]);
    assert.equal(f.rpcCalls[1].args.p_request.amount, 5000);
    assert.equal(f.rpcCalls[1].args.p_request.payment_method_allowed[0], 'qrph');
    assert.equal(f.rpcCalls[2].args.p_qr_livemode, false);
    assert.equal(f.providerCalls.some(call => call.url.includes('/v2/checkout_sessions')), false);
});

test('balance checkout rejects unsupported payment channels before preparing a charge', async () => {
    const f = fixture({ source: 'booking', id: '42', channel: 'gcash' });
    const response = await f.getHandler()(f.request);
    assert.equal(response.status, 400);
    assert.deepEqual(f.rpcCalls, []);
    assert.deepEqual(f.providerCalls, []);
});

