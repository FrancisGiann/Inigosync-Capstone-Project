import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20261016130000_walkin_qrph_intents_cash_tender.sql', import.meta.url), 'utf8');

test('walk-in payment migration keeps raw order creation behind the quote and guest guards', () => {
    assert.match(migration, /revoke all on function public\.staff_create_walkin_order\(uuid,text,text,jsonb,text\)\s+from public,anon,authenticated,service_role;/i);
    assert.doesNotMatch(migration, /grant execute on function public\.staff_create_walkin_order\(uuid,text,text,jsonb,text\)\s+to authenticated/i);
    assert.doesNotMatch(migration, /create or replace function public\.staff_create_walkin_order_quoted\(/i);
});

test('customer checkout preparation stays service-role-only', () => {
    assert.match(migration, /revoke all on function public\.prepare_paid_checkout_cart\(uuid,jsonb,text\) from public,anon,authenticated;/i);
    assert.match(migration, /grant execute on function public\.prepare_paid_checkout_cart\(uuid,jsonb,text\) to service_role;/i);
    assert.doesNotMatch(migration, /grant execute on function public\.prepare_paid_checkout_cart\(uuid,jsonb,text\) to authenticated/i);
});
