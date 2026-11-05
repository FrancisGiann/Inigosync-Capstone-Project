import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { enabledPaymongoMethods } from '../supabase/functions/_shared/paymongo-methods.mjs';

const migration = await readFile(new URL('../supabase/migrations/20261105022742_paymongo_wallet_method_guards.sql', import.meta.url), 'utf8');

test('wallet-only PayMongo settings remain valid and authoritative creation gates recognize them', () => {
    assert.match(migration, /check \(card_enabled or gcash_enabled or maya_enabled or grab_pay_enabled or qrph_enabled\)/);
    assert.match(migration, /public\.prepare_paid_checkout_cart\(uuid,jsonb,text\)/);
    assert.match(migration, /public\.staff_create_walkin_order\(uuid,text,text,jsonb,text\)/);
    assert.doesNotMatch(migration, /public\.prepare_staff_walkin_checkout\(uuid,uuid\)/,
        'the checkout status RPC does not own an enabled-method gate and is not dynamically patched');
    assert.match(migration, /s\.maya_enabled or s\.grab_pay_enabled/);
    assert.deepEqual(enabledPaymongoMethods({
        card_enabled: false, gcash_enabled: false, maya_enabled: true,
        grab_pay_enabled: true, qrph_enabled: false,
    }), ['paymaya', 'grab_pay']);
});
