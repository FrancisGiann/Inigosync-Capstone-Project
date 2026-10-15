import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { canInviteStaff } from '../supabase/functions/invite-staff/_shared/authorize-owner.ts';
import { validateStaffInvite } from '../supabase/functions/invite-staff/_shared/validate-staff.ts';

const inviteHandler = await readFile(new URL('../supabase/functions/invite-staff/index.ts', import.meta.url), 'utf8');
const completionHandler = await readFile(new URL('../supabase/functions/complete-staff-onboarding/index.ts', import.meta.url), 'utf8');
const onboardingMarkup = await readFile(new URL('../Pages/staff_onboarding.html', import.meta.url), 'utf8');
const onboardingScript = await readFile(new URL('../includes/staff_onboarding.js', import.meta.url), 'utf8');
const ownerMarkup = await readFile(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8');
const staffAddModal = ownerMarkup.slice(ownerMarkup.indexOf('data-admin-staff-modal'), ownerMarkup.indexOf('data-admin-staff-edit-modal'));
const ownerScript = await readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');
const authGuard = await readFile(new URL('../includes/authGuard.js', import.meta.url), 'utf8');
const emailMfa = await readFile(new URL('../supabase/functions/email-mfa/index.ts', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261015070000_staff_self_service_onboarding.sql', import.meta.url), 'utf8');

test('staff account creation accepts only a valid personal email and supported position', () => {
  assert.deepEqual(validateStaffInvite({ email: ' Staff@Example.test ', position: 'Secretary' }), {
    email: 'staff@example.test', position: 'Secretary',
  });
  assert.deepEqual(validateStaffInvite({ email: 'staff@example.test', position: 'Court Attendant', full_name: 'ignored' }), {
    email: 'staff@example.test', position: 'Court Attendant',
  });
  for (const payload of [null, [], {}, { email: 'bad', position: 'Secretary' }, { email: 'staff@example.test', position: 'owner' }]) {
    assert.throws(() => validateStaffInvite(payload));
  }
});

test('only active admin profiles may create staff accounts', () => {
  assert.equal(canInviteStaff({ role: 'admin', status: 'active' }), true);
  for (const profile of [null, undefined, { role: 'staff', status: 'active' }, { role: 'admin', status: 'pending' }, { role: 'admin', status: 'disabled' }]) {
    assert.equal(canInviteStaff(profile), false);
  }
});

test('owner form collects only the email and position and never receives the password', () => {
  assert.match(staffAddModal, /data-admin-staff-email/);
  assert.match(staffAddModal, /data-admin-staff-role/);
  for (const field of ['data-admin-staff-name', 'data-admin-staff-birthdate', 'data-admin-staff-address', 'data-admin-staff-gender', 'data-admin-staff-emergency-name']) {
    assert.doesNotMatch(staffAddModal, new RegExp(field));
  }
  assert.match(ownerScript, /JSON\.stringify\(\{ email, position \}\)/);
  assert.match(inviteHandler, /admin\.auth\.admin\.createUser\(/);
  assert.match(inviteHandler, /email_confirm: true/);
  assert.match(inviteHandler, /RESEND_API_KEY/);
  assert.match(inviteHandler, /STAFF_ONBOARDING_FROM_EMAIL/);
  assert.match(inviteHandler, /STAFF_ONBOARDING_LOGIN_URL/);
  assert.ok(inviteHandler.indexOf("if (!url || !serviceKey || !anonKey || !resendKey || !from || !loginUrl)") < inviteHandler.indexOf('admin.auth.admin.createUser('));
  assert.match(inviteHandler, /\.ilike\('email', details\.email\)/);
  assert.match(inviteHandler, /An account already uses this email\. It was left unchanged\./);
  assert.match(inviteHandler, /admin\.auth\.admin\.deleteUser\(userId\)/);
  assert.doesNotMatch(inviteHandler, /inviteUserByEmail|temporaryPassword\s*[:,}]\s*temporaryPassword/);
  assert.doesNotMatch(inviteHandler, /console\.(?:log|error)\(/);
});

test('new staff remain pending until server verifies a distinct password and saves personal details', () => {
  assert.match(inviteHandler, /status: 'pending', onboarding_complete: false/);
  assert.match(completionHandler, /profile\.status !== 'pending'/);
  assert.match(completionHandler, /onboarding_complete !== false/);
  assert.match(completionHandler, /passwordHash === credentials\.data\.temporary_password_hash/);
  assert.match(completionHandler, /passwordAuth\.auth\.signInWithPassword/);
  assert.match(completionHandler, /onboarding_complete: true/);
  assert.match(migration, /grant select, insert, update, delete on public\.staff_onboarding_credentials to service_role/i);
  assert.match(migration, /p\.role='admin' or p\.onboarding_complete is true/i);
  assert.match(migration, /Staff onboarding can only be completed by the server/);
  assert.match(authGuard, /profile\.onboarding_complete !== true/);
  assert.match(authGuard, /staff_onboarding\.html/);
  assert.match(emailMfa, /profile\?\.status === 'pending' && profile\?\.onboarding_complete === false/);
  assert.match(onboardingMarkup, /name="full_name"/);
  assert.match(onboardingMarkup, /name="birthdate"/);
  assert.doesNotMatch(onboardingMarkup, /contact_num|emergency_contact_number|phoneValidation/);
  assert.doesNotMatch(onboardingScript, /contact_num|emergency_contact_number/);
  assert.doesNotMatch(completionHandler, /contact_num|emergency_contact_number|contact_phone_in_use|record_contact_phone_validation/);
});
