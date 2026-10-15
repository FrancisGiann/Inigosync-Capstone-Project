import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const accessMigration = await readFile(new URL('../supabase/migrations/20261015100000_gate_pending_staff_access.sql', import.meta.url), 'utf8');
const onboardingMigration = await readFile(new URL('../supabase/migrations/20261015070000_staff_self_service_onboarding.sql', import.meta.url), 'utf8');
const completionHandler = await readFile(new URL('../supabase/functions/complete-staff-onboarding/index.ts', import.meta.url), 'utf8');

test('legacy profile policies cannot grant pending staff broader access', () => {
  for (const policy of [
    'users_can_read_own_profile', 'staff_can_read_customer_profiles', 'admin_can_read_all_profiles',
    'users_can_update_own_profile', 'admin_can_update_all_profiles',
  ]) assert.match(accessMigration, new RegExp(`drop policy if exists "${policy}" on public\\.profiles`, 'i'));
  assert.match(accessMigration, /create policy profiles_pending_staff_select_own on public\.profiles as restrictive/i);
  assert.match(accessMigration, /p\.role = 'staff' and p\.status = 'pending'\s+and p\.onboarding_complete is false/i);
  assert.match(accessMigration, /or id = \(select auth\.uid\(\)\)/i);
});

test('profile trigger prevents active staff accounts with incomplete onboarding', () => {
  assert.match(accessMigration, /new\.role = 'staff' and new\.status = 'active' and new\.onboarding_complete is not true/i);
  assert.match(accessMigration, /Staff onboarding must be complete before activation/);
  assert.match(onboardingMigration, /new\.onboarding_complete is distinct from old\.onboarding_complete[\s\S]*auth\.jwt\(\)->>'role'[\s\S]*'service_role'/i);
  assert.match(onboardingMigration, /p\.status='active'[\s\S]*p\.onboarding_complete is true/i);
  assert.match(onboardingMigration, /create or replace function internal\.is_staff_or_admin[\s\S]*p\.status='active'[\s\S]*p\.onboarding_complete is true/i);
  assert.match(onboardingMigration, /create or replace function public\.inigosync_is_staff_or_admin[\s\S]*p\.status='active'[\s\S]*p\.onboarding_complete is true/i);
});

test('completion cannot reactivate an account disabled during onboarding', () => {
  assert.match(completionHandler, /\.eq\('status', 'pending'\)\.eq\('onboarding_complete', false\)[\s\S]*\.select\('id'\)\.maybeSingle\(\)/);
  assert.match(completionHandler, /if \(!completedProfile\)[\s\S]*return json\(\{ error: .*\}, 409\)/);
  assert.ok(completionHandler.indexOf('if (!completedProfile)') < completionHandler.indexOf(".from('staff_onboarding_credentials').delete()"));
});
