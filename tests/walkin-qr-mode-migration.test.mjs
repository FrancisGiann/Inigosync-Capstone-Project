import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20261017045802_persist_walkin_qrph_livemode.sql', import.meta.url), 'utf8');

test('walk-in QR mode is persisted only through the service-only verified attach function', () => {
    assert.match(migration, /add column if not exists qr_livemode boolean/i);
    assert.match(migration, /drop function if exists public\.attach_paymongo_qrph_intent\(uuid,text,text,text\)/i);
    assert.match(migration, /p_qr_livemode boolean/i);
    assert.match(migration, /qr_image_url=p_qr_image_url,qr_livemode=p_qr_livemode/i);
    assert.match(migration, /revoke all on function public\.attach_paymongo_qrph_intent\(uuid,text,text,boolean,text\) from public,anon,authenticated/i);
    assert.match(migration, /grant execute on function public\.attach_paymongo_qrph_intent\(uuid,text,text,boolean,text\) to service_role/i);
});

test('staff checkout preparation returns persisted QR mode for fail-closed replay checks', () => {
    assert.match(migration, /'qr_livemode',v_attempt\.qr_livemode/i);
    assert.match(migration, /check \(qr_livemode is null or qr_image_url is not null\)/i);
});
