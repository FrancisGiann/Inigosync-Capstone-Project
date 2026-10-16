import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { validPaymongoSignature } from '../supabase/functions/paymongo-webhook/_shared/paymongo-signature.ts';
import { paidCheckoutPayment } from '../supabase/functions/paymongo-webhook/_shared/paid-checkout.ts';
import { paidQrPhPayment } from '../supabase/functions/_shared/paid-qrph-payment.mjs';

const workerSource = stripTypeScriptTypes((await readFile(new URL('../supabase/functions/paymongo-expire-checkouts/index.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, ''), { mode: 'strip' });
const webhookSource = stripTypeScriptTypes((await readFile(new URL('../supabase/functions/paymongo-webhook/index.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, ''), { mode: 'strip' });

function serve(source, dependencies, env, fetcher = async () => { throw new Error('Unexpected fetch'); }) {
    let handler;
    runInNewContext(source, {
        Deno: { env: { get: key => env[key] }, serve: fn => { handler = fn; } },
        createClient: dependencies.createClient,
        validPaymongoSignature, paidCheckoutPayment, paidQrPhPayment,
        fetch: fetcher, Request, Response, Headers, URL, AbortSignal, btoa, crypto, console,
    });
    return () => handler;
}

function paymentIntent({ amount = 12000, status = 'succeeded', payments = [] } = {}) {
    return { data: { id: 'pi_Qrphfixture', type: 'payment_intent', attributes: {
        status, livemode: false, amount, currency: 'PHP', payment_method_allowed: ['qrph'], payments,
    } } };
}

const payment = { id: 'pay_Qrphfixture', type: 'payment', attributes: {
    status: 'paid', currency: 'PHP', amount: 12000, fee: 300, net_amount: 11700,
    payment_intent_id: 'pi_Qrphfixture', source: { type: 'qrph' },
} };

function workerFixture(providerResource) {
    const calls = [];
    const admin = { rpc: async (name, args) => {
        calls.push({ name, args });
        if (name === 'verify_paymongo_expiry_worker') return { data: true, error: null };
        if (name === 'list_paymongo_checkouts_due_for_expiry') return { data: [{
            attempt_id: 'attempt-fixture', session_id: 'pi_Qrphfixture',
            checkout_request: { amount: 12000, currency: 'PHP', payment_method_allowed: ['qrph'] },
        }], error: null };
        return { data: name === 'record_paymongo_qrph_paid' ? 'paid' : true, error: null };
    } };
    const handler = serve(workerSource, { createClient: () => admin }, {
        SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_ROLE_KEY: 'service-fixture',
        PAYMONGO_SECRET_KEY: 'sk_test_fixture',
    }, async () => new Response(JSON.stringify(providerResource), { status: 200 }));
    const request = () => new Request('https://db.example/functions/v1/paymongo-expire-checkouts', {
        method: 'POST', headers: { 'x-paymongo-cron-secret': 'cron-fixture' }, body: '{}',
    });
    return { calls, handler, request };
}

test('expiry worker reconciles a provider-succeeded dynamic QR payment', async () => {
    const fixture = workerFixture(paymentIntent({ payments: [payment] }));
    const response = await fixture.handler()(fixture.request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { processed: 1, expired: 0, paid: 1, deferred: 0 }, JSON.stringify(fixture.calls));
    const settlement = fixture.calls.find(call => call.name === 'record_paymongo_qrph_paid');
    assert.deepEqual(JSON.parse(JSON.stringify(settlement.args)), {
        p_event_id: 'expiry-reconcile:pi_Qrphfixture:pay_Qrphfixture',
        p_intent_id: 'pi_Qrphfixture', p_payment_id: 'pay_Qrphfixture',
        p_amount_minor: 12000, p_fee_minor: 300, p_net_minor: 11700,
    });
});

test('expiry worker marks a still-pending QR intent expired after its hold', async () => {
    const fixture = workerFixture(paymentIntent({ status: 'awaiting_next_action' }));
    const response = await fixture.handler()(fixture.request());
    assert.deepEqual(await response.json(), { processed: 1, expired: 1, paid: 0, deferred: 0 });
    assert.ok(fixture.calls.some(call => call.name === 'mark_paymongo_checkout_expired'
        && call.args.p_attempt_id === 'attempt-fixture' && call.args.p_session_id === 'pi_Qrphfixture'));
    assert.equal(fixture.calls.some(call => call.name === 'record_paymongo_qrph_paid'), false);
});

test('expiry worker defers an amount mismatch without settlement or hold release', async () => {
    const fixture = workerFixture(paymentIntent({ amount: 11999, payments: [payment] }));
    const response = await fixture.handler()(fixture.request());
    assert.deepEqual(await response.json(), { processed: 1, expired: 0, paid: 0, deferred: 1 });
    assert.equal(fixture.calls.some(call => ['record_paymongo_qrph_paid', 'mark_paymongo_checkout_expired'].includes(call.name)), false);
});

async function signedHeader(rawBody, secret, timestamp) {
    const bytes = new TextEncoder().encode(`${timestamp}.${rawBody}`);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
    return `t=${timestamp},te=${[...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')},li=`;
}

test('signed QR payment event retries a failed settlement RPC and records the intent', async () => {
    const now = Math.floor(Date.now() / 1000);
    const raw = JSON.stringify({ data: { id: 'evt_qrph_fixture', attributes: {
        type: 'payment.paid', livemode: false, data: payment,
    } } });
    const signature = await signedHeader(raw, 'whsec_fixture', now);
    let rpcAttempts = 0;
    const argsSeen = [];
    const admin = { rpc: async (name, args) => {
        assert.equal(name, 'record_paymongo_qrph_paid');
        argsSeen.push(args);
        rpcAttempts++;
        return rpcAttempts === 1 ? { data: null, error: { message: 'temporary database error' } }
            : { data: 'paid', error: null };
    } };
    const handler = serve(webhookSource, { createClient: () => admin }, {
        PAYMONGO_WEBHOOK_SECRET: 'whsec_fixture', PAYMONGO_SECRET_KEY: 'sk_test_fixture',
        SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_ROLE_KEY: 'service-fixture',
    });
    const request = () => new Request('https://db.example/functions/v1/paymongo-webhook', {
        method: 'POST', headers: { 'Paymongo-Signature': signature }, body: raw,
    });
    const first = await handler()(request());
    const second = await handler()(request());
    assert.equal(first.status, 503, `provider should retry after a transient database failure: ${await first.clone().text()}`);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { received: true, result: 'paid' });
    assert.equal(rpcAttempts, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(argsSeen[1])), {
        p_event_id: 'evt_qrph_fixture', p_intent_id: 'pi_Qrphfixture', p_payment_id: 'pay_Qrphfixture',
        p_amount_minor: 12000, p_fee_minor: 300, p_net_minor: 11700,
    });
});
