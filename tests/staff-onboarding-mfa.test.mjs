import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20261015080000_allow_pending_staff_email_mfa.sql', import.meta.url), 'utf8');

test('email MFA proof accepts active accounts or only pending staff still completing onboarding', () => {
  assert.match(migration, /create or replace function internal\.has_verified_email_session\(\)/i);
  assert.match(migration, /create or replace function public\.email_mfa_check_session\(p_user_id uuid, p_session_id uuid\)/i);
  assert.equal((migration.match(/p\.status = 'active' and p\.role in \('customer',\s*'staff',\s*'admin'\)/g) || []).length, 2);
  assert.equal((migration.match(/p\.role = 'staff' and p\.status = 'pending' and p\.onboarding_complete is false/g) || []).length, 2);
  assert.equal((migration.match(/p\.status = 'pending'/g) || []).length, 2);
});

test('email MFA proof remains tied to the live verified user session and expiry', () => {
  assert.match(migration, /v\.user_id = auth\.uid\(\)/);
  assert.match(migration, /v\.session_id = \(auth\.jwt\(\)->>'session_id'\)::uuid/);
  assert.match(migration, /v\.user_id = p_user_id and v\.session_id = p_session_id/);
  assert.equal((migration.match(/v\.last_activity_at > now\(\) - interval '7 days'/g) || []).length, 2);
  assert.equal((migration.match(/internal\.email_mfa_live_session\(v\.user_id, v\.session_id\)/g) || []).length, 2);
});
