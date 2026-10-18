import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20261018120000_staff_balance_qrph.sql', import.meta.url), 'utf8');

test('QR intent registration and attachment remain service-role-only and tied to an existing payment attempt', () => {
    assert.match(migration, /register_paymongo_qrph_intent[\s\S]*?walkin_order_id is not null or balance_source is not null/i);
    assert.match(migration, /revoke all on function public\.register_paymongo_qrph_intent\(uuid,jsonb,text\) from public,anon,authenticated/i);
    assert.match(migration, /grant execute on function public\.register_paymongo_qrph_intent\(uuid,jsonb,text\) to service_role/i);
    assert.match(migration, /attach_paymongo_qrph_intent[\s\S]*?walkin_order_id is not null or balance_source is not null/i);
    assert.match(migration, /qr_livemode=p_qr_livemode/i);
    assert.match(migration, /revoke all on function public\.attach_paymongo_qrph_intent\(uuid,text,text,boolean,text\) from public,anon,authenticated/i);
    assert.match(migration, /grant execute on function public\.attach_paymongo_qrph_intent\(uuid,text,text,boolean,text\) to service_role/i);
});

test('paid QR webhook settlement accepts only persisted walk-in or balance QR intents', () => {
    assert.match(migration, /where a\.paymongo_session_id=p_intent_id and a\.qr_image_url is not null[\s\S]*?a\.walkin_order_id is not null or a\.balance_source in \('booking','walkin'\)/i);
    assert.match(migration, /public\.record_paymongo_paid\(p_event_id,p_intent_id,p_payment_id,p_amount_minor,p_fee_minor,p_net_minor\)/i);
    assert.match(migration, /revoke all on function public\.record_paymongo_qrph_paid\(text,text,text,bigint,bigint,bigint\) from public,anon,authenticated/i);
});

test('interrupted balance QR setup can be expired through provider reconciliation', () => {
    assert.match(migration, /a\.status='creating'[\s\S]*?a\.balance_id is not null and a\.created_at<=now\(\)-interval '15 minutes'/i);
    assert.match(migration, /status='expired'[\s\S]*?balance_source in \('booking','walkin'\)/i);
    assert.match(migration, /revoke all on function public\.mark_paymongo_checkout_expired\(uuid,text\) from public,anon,authenticated/i);
});
