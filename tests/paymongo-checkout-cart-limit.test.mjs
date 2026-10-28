import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { enabledPaymongoMethods } from '../supabase/functions/_shared/paymongo-methods.mjs';

const edgeSource = (await readFile(new URL('../supabase/functions/paymongo-checkout/index.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '');
const executable = stripTypeScriptTypes(edgeSource, { mode: 'strip' });

test('nine-item online checkout reaches database preparation without an Edge Function count cap', async () => {
    let handler;
    const rpcCalls = [];
    const attempt = { id: 'attempt-1', status: 'ready', checkout_url: 'https://paymongo.example/checkout', item_count: 9 };
    const admin = {
        auth: { getUser: async () => ({ data: { user: { id: 'customer-1' } }, error: null }) },
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
            data: { card_enabled: true, gcash_enabled: true, qrph_enabled: false }, error: null,
        }) }) }) }),
        rpc: async (name, args) => {
            rpcCalls.push({ name, args });
            if (name === 'prepare_paid_checkout_cart') return { data: { attempt_id: attempt.id, item_count: 9 }, error: null };
            if (name === 'get_paymongo_checkout_attempt_detail') return { data: [attempt], error: null };
            throw new Error(`Unexpected RPC ${name}`);
        },
    };
    runInNewContext(executable, {
        Deno: {
            env: { get: key => ({ APP_BASE_URL: 'https://inigos.example', SUPABASE_URL: 'https://db.example',
                SUPABASE_SERVICE_ROLE_KEY: 'service-key', PAYMONGO_SECRET_KEY: 'sk_test_fixture' })[key] },
            serve: callback => { handler = callback; },
        },
        createClient: () => admin,
        hasVerifiedEmailSession: async () => true,
        hasPaymongoPaidWebhook: async () => true,
        enabledPaymongoMethods,
        Request, Response, URL, AbortSignal, btoa, console,
        fetch: async () => { throw new Error('an existing checkout should not need another PayMongo request'); },
    });

    const response = await handler(new Request('https://db.example/functions/v1/paymongo-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer customer-token', origin: 'https://inigos.example' },
        body: JSON.stringify({ terms_acceptance: { accepted: true, version: 'customer-booking-v1' },
            payment_option: 'full', items: Array.from({ length: 9 }, () => ({})) }),
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).attempt_id, attempt.id);
    assert.equal(rpcCalls.length, 2);
    assert.equal(rpcCalls[0].name, 'prepare_paid_checkout_cart');
    assert.equal(rpcCalls[0].args.p_items.length, 9);

    const migration = await readFile(new URL('../supabase/migrations/20261028084420_remove_paid_checkout_cart_item_cap.sql', import.meta.url), 'utf8');
    assert.match(migration, /jsonb_array_length\(p_items\)=0/);
    assert.match(migration, /octet_length\(p_items::text\)>1048576/);
    assert.match(migration, /Choose at least one reservation and a valid payment option/);
});

test('customer cart checkout requires the current explicit terms acknowledgment before preparing holds', async () => {
    let handler;
    const rpcCalls = [];
    let webhookChecks = 0;
    const admin = {
        auth: { getUser: async () => ({ data: { user: { id: 'customer-1' } }, error: null }) },
        rpc: async (...args) => { rpcCalls.push(args); throw new Error('terms must be checked before database access'); },
    };
    runInNewContext(executable, {
        Deno: {
            env: { get: key => ({ APP_BASE_URL: 'https://inigos.example', SUPABASE_URL: 'https://db.example',
                SUPABASE_SERVICE_ROLE_KEY: 'service-key', PAYMONGO_SECRET_KEY: 'sk_test_fixture' })[key] },
            serve: callback => { handler = callback; },
        },
        createClient: () => admin,
        hasVerifiedEmailSession: async () => true,
        hasPaymongoPaidWebhook: async () => { webhookChecks += 1; return false; },
        enabledPaymongoMethods,
        Request, Response, URL, AbortSignal, btoa, console, fetch,
    });

    for (const terms_acceptance of [undefined, { accepted: true, version: 'old-version' }, { accepted: false, version: 'customer-booking-v1' }]) {
        const response = await handler(new Request('https://db.example/functions/v1/paymongo-checkout', {
            method: 'POST',
            headers: { authorization: 'Bearer customer-token', origin: 'https://inigos.example' },
            body: JSON.stringify({ ...(terms_acceptance ? { terms_acceptance } : {}), payment_option: 'full', items: [{}] }),
        }));
        assert.equal(response.status, 400);
        assert.match((await response.json()).message, /accept the booking and payment terms/i);
    }
    assert.deepEqual(rpcCalls, [], 'unaccepted cart requests create no holds or checkout attempts');
    assert.equal(webhookChecks, 0, 'unaccepted cart requests fail before checking provider readiness');

    const legacyRetry = await handler(new Request('https://db.example/functions/v1/paymongo-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer customer-token', origin: 'https://inigos.example' },
        body: JSON.stringify({ booking_id: 123 }),
    }));
    assert.equal(legacyRetry.status, 503, 'legacy booking retry does not use the new-cart acceptance contract');
});
