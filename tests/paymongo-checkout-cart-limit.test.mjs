import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const edgeSource = (await readFile(new URL('../supabase/functions/paymongo-checkout/index.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '');
const executable = stripTypeScriptTypes(edgeSource, { mode: 'strip' });

test('nine-item online checkout is rejected before the RPC and capped in the database', async () => {
    let handler;
    const rpcCalls = [];
    const admin = {
        auth: { getUser: async () => ({ data: { user: { id: 'customer-1' } }, error: null }) },
        rpc: async (name, args) => { rpcCalls.push({ name, args }); return { data: null, error: null }; },
    };
    runInNewContext(executable, {
        Deno: {
            env: { get: key => ({ APP_BASE_URL: 'https://inigos.example', SUPABASE_URL: 'https://db.example',
                SUPABASE_SERVICE_ROLE_KEY: 'service-key', PAYMONGO_SECRET_KEY: 'sk_test_fixture' })[key] },
            serve: callback => { handler = callback; },
        },
        createClient: () => admin,
        Request, Response, URL, AbortSignal, btoa, console,
        fetch: async () => { throw new Error('oversized cart must not reach PayMongo'); },
    });

    const response = await handler(new Request('https://db.example/functions/v1/paymongo-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer customer-token', origin: 'https://inigos.example' },
        body: JSON.stringify({ payment_option: 'full', items: Array.from({ length: 9 }, () => ({})) }),
    }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /one and eight/);
    assert.deepEqual(rpcCalls, [], 'invalid cart never creates reservation holds or checkout attempts');

    const migration = await readFile(new URL('../supabase/migrations/20261004101500_restore_paid_checkout_cart_item_cap.sql', import.meta.url), 'utf8');
    assert.match(migration, /jsonb_array_length\(p_items\) not between 1 and 8/);
    assert.match(migration, /grant execute on function public\.prepare_paid_checkout_cart\(uuid,jsonb,text\) to service_role/);
});
