import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { canInviteStaff } from '../supabase/functions/invite-staff/_shared/authorize-owner.ts';
import { generateTemporaryPassword, validateStaffInvite } from '../supabase/functions/invite-staff/_shared/validate-staff.ts';

const inviteHandler = await readFile(new URL('../supabase/functions/invite-staff/index.ts', import.meta.url), 'utf8');
const staffValidation = await readFile(new URL('../supabase/functions/invite-staff/_shared/validate-staff.ts', import.meta.url), 'utf8');
const recoveryHandler = await readFile(new URL('../supabase/functions/recover-pending-staff/index.ts', import.meta.url), 'utf8');
const completionHandler = await readFile(new URL('../supabase/functions/complete-staff-onboarding/index.ts', import.meta.url), 'utf8');
const onboardingMarkup = await readFile(new URL('../Pages/staff_onboarding.html', import.meta.url), 'utf8');
const onboardingScript = await readFile(new URL('../includes/staff_onboarding.js', import.meta.url), 'utf8');
const ownerMarkup = await readFile(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8');
const staffAddModal = ownerMarkup.slice(ownerMarkup.indexOf('data-admin-staff-modal'), ownerMarkup.indexOf('data-admin-staff-edit-modal'));
const ownerScript = await readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');
const ownerStyles = await readFile(new URL('../Style/owner_dashboard.css', import.meta.url), 'utf8');
const toastScript = await readFile(new URL('../includes/loadingOverlay.js', import.meta.url), 'utf8');
const authGuard = await readFile(new URL('../includes/authGuard.js', import.meta.url), 'utf8');
const emailMfa = await readFile(new URL('../supabase/functions/email-mfa/index.ts', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261015070000_staff_self_service_onboarding.sql', import.meta.url), 'utf8');
const authEmailLookupMigration = await readFile(new URL('../supabase/migrations/20261102062517_staff_invite_auth_email_lookup.sql', import.meta.url), 'utf8');
const recoveryLockMigration = await readFile(new URL('../supabase/migrations/20261102073357_staff_onboarding_recovery_lock.sql', import.meta.url), 'utf8');
const recoveryProfileGuardMigration = await readFile(new URL('../supabase/migrations/20261102160000_allow_auth_email_sync_profile_guard.sql', import.meta.url), 'utf8');
const staffEmail = await import('../supabase/functions/_shared/staff-onboarding-email.mjs');
const emailDomain = await import('../supabase/functions/_shared/email-domain.mjs');

test('staff account creation accepts only a valid personal email and supported position', () => {
  assert.deepEqual(validateStaffInvite({ email: ' Staff@Example.test ', position: 'Secretary' }), {
    email: 'staff@example.test', position: 'Secretary',
  });
  assert.deepEqual(validateStaffInvite({ email: 'staff@example.test', position: 'Court Attendant', full_name: 'ignored' }), {
    email: 'staff@example.test', position: 'Court Attendant',
  });
  assert.equal(validateStaffInvite({ email: 'name@club.org', position: 'Secretary' }).email, 'name@club.org');
  assert.equal(validateStaffInvite({ email: 'name@club-mail.example', position: 'Secretary' }).email, 'name@club-mail.example');
  assert.equal(validateStaffInvite({ email: 'name_under%tag@club.org', position: 'Secretary' }).email, 'name_under%tag@club.org');
  for (const payload of [null, [], {}, { email: 'bad', position: 'Secretary' }, { email: 'name@localhost', position: 'Secretary' }, { email: 'staff..name@example.test', position: 'Secretary' }, { email: '.staff@example.test', position: 'Secretary' }, { email: 'staff@example..test', position: 'Secretary' }, { email: 'staff@.example.test', position: 'Secretary' }, { email: 'staff@example.test.', position: 'Secretary' }, { email: 'staff@-example.test', position: 'Secretary' }, { email: 'staff@example-.test', position: 'Secretary' }, { email: 'staff@example.test', position: 'owner' }]) {
    assert.throws(() => validateStaffInvite(payload));
  }
});

test('email domain preflight accepts MX and SMTP address fallback, rejects Null MX, and distinguishes lookup failure', async () => {
  const dns = answers => async url => ({ ok: true, json: async () => answers(new URL(url).searchParams.get('type')) });
  assert.equal(await emailDomain.emailDomainCanReceiveMail('staff@mx.example', dns(type => ({ Status: 0, Answer: type === 'MX' ? [{ type: 15, data: '10 mail.example.' }] : [] }))), true);
  assert.equal(await emailDomain.emailDomainCanReceiveMail('staff@fallback.example', dns(type => ({ Status: 0, Answer: type === 'A' ? [{ type: 1, data: '192.0.2.1' }] : [] }))), true);
  assert.equal(await emailDomain.emailDomainCanReceiveMail('staff@nomail.example', dns(type => ({ Status: 0, Answer: type === 'MX' ? [{ type: 15, data: '0 .' }] : [{ type: 1, data: '192.0.2.2' }] }))), false);
  await assert.rejects(emailDomain.emailDomainCanReceiveMail('staff@dns-down.example', async () => ({ ok: false, json: async () => ({}) })));
});

test('only active admin profiles may create staff accounts', () => {
  assert.equal(canInviteStaff({ role: 'admin', status: 'active' }), true);
  for (const profile of [null, undefined, { role: 'staff', status: 'active' }, { role: 'admin', status: 'pending' }, { role: 'admin', status: 'disabled' }]) {
    assert.equal(canInviteStaff(profile), false);
  }
});

test('temporary passwords are 16 readable characters with unbiased CSPRNG category selection', () => {
  const bytes = Uint8Array.from({ length: 512 }, (_, index) => index < 2 ? 255 : (index - 2) % 250);
  let offset = 0;
  const password = generateTemporaryPassword((target) => {
    target[0] = bytes[offset++] ?? 0;
    return target;
  });
  const alphabet = 'ABCDEFHJKMNPQRTUVWXYZabcdefghjkmnpqrtuvwxyz3479-';
  assert.equal(password.length, 16);
  assert.match(password, new RegExp(`^[${alphabet.replace('-', '\\-')}]{16}$`));
  assert.match(password, /[A-Z]/);
  assert.match(password, /[a-z]/);
  assert.match(password, /[3479]/);
  assert.match(password, /-/);
  assert.ok(offset > 32, 'the first out-of-range byte is rejected and additional secure bytes are sampled');
  assert.match(staffValidation, /bytes => crypto\.getRandomValues\(bytes\)/);
  assert.match(staffValidation, /byte < acceptLimit\) return byte % maxExclusive/);
  assert.ok((2 * Math.log2(21) + Math.log2(4) + 12 * Math.log2(47)) > 76,
    'required character classes plus the remaining alphabet provide over 76 bits of selection entropy');
});

test('staff email sends credentials only to the new account mailbox with escaped HTML', () => {
  const email = staffEmail.buildStaffOnboardingEmail({
    email: 'staff+new@example.test', position: '<Secretary>', password: 'random&secret',
    loginUrl: 'https://inigossportcenter.com/index.html?x=1&y=2',
  });
  assert.deepEqual(email.to, ['staff+new@example.test']);
  assert.match(email.text, /Temporary password: random&secret/);
  assert.match(email.html, /&lt;Secretary&gt;/);
  assert.match(email.html, /random&amp;secret/);
  assert.match(email.html, /x=1&amp;y=2/);
  assert.match(email.html, /background:#ff7900/);
  assert.match(email.html, /Iñigo<span style="color:#ff7900">Sync<\/span>/);
  assert.match(email.html, /STAFF SETUP/);
  assert.ok(email.html.length < 1800, 'the styled email stays compact');
  assert.match(email.text, /After signing in, choose a new password and complete setup\./);
  assert.equal(email.subject, 'Your InigoSync staff account');
  const resend = staffEmail.buildStaffOnboardingEmail({
    email: 'staff+new@example.test', position: 'Secretary', password: 'secret',
    loginUrl: 'https://inigossportcenter.com/index.html',
    subject: 'Your InigoSync staff account - setup resend 12345',
  });
  assert.match(resend.subject, /setup resend 12345/);
  const firstSubject = staffEmail.staffResendSubject(new Date('2026-11-02T13:01:40Z'));
  const nextSubject = staffEmail.staffResendSubject(new Date('2026-11-02T13:02:15Z'));
  assert.match(firstSubject, /Nov 2, 2026.*9:01:40 PM PHT/);
  assert.notEqual(firstSubject, nextSubject);
});

test('owner form collects only the email and position and never receives the password', () => {
  assert.match(staffAddModal, /data-admin-staff-email/);
  assert.match(staffAddModal, /data-admin-staff-role/);
  for (const field of ['data-admin-staff-name', 'data-admin-staff-birthdate', 'data-admin-staff-address', 'data-admin-staff-gender', 'data-admin-staff-emergency-name']) {
    assert.doesNotMatch(staffAddModal, new RegExp(field));
  }
  assert.match(ownerScript, /JSON\.stringify\(\{ email, position \}\)/);
  assert.match(inviteHandler, /admin\.auth\.admin\.createUser\(/);
  assert.match(inviteHandler, /generateTemporaryPassword\(\)/);
  assert.match(inviteHandler, /email_confirm: true/);
  assert.match(inviteHandler, /CUSTOMER_BOOKING_SMTP_USERNAME/);
  assert.match(inviteHandler, /CUSTOMER_BOOKING_SMTP_APP_PASSWORD/);
  assert.match(inviteHandler, /CUSTOMER_BOOKING_REMINDER_FROM_EMAIL/);
  assert.match(inviteHandler, /STAFF_ONBOARDING_LOGIN_URL/);
  assert.ok(inviteHandler.indexOf("if (!url || !serviceKey || !anonKey)") < inviteHandler.indexOf('admin.auth.getUser(token)'));
  assert.ok(inviteHandler.indexOf('if (checkEmail) {') < inviteHandler.indexOf("if (!smtpUsername || !smtpAppPassword || !from)"));
  assert.ok(inviteHandler.indexOf("if (!smtpUsername || !smtpAppPassword || !from)") < inviteHandler.indexOf('admin.auth.admin.createUser('));
  assert.match(inviteHandler, /deliverSmtpEmail\(/);
  assert.match(inviteHandler, /buildStaffOnboardingEmail\(/);
  assert.match(inviteHandler, /error\.reason === 'delivery_outcome_unknown'[\s\S]*?delivery_uncertain: true[\s\S]*?Do not create another account/);
  assert.doesNotMatch(inviteHandler, /RESEND_API_KEY|api\.resend\.com/);
  assert.match(inviteHandler, /\.eq\('email', details\.email\)/);
  assert.match(inviteHandler, /An account already uses this email\. It was left unchanged\./);
  assert.match(inviteHandler, /admin\.rpc\('owner_auth_email_exists'/);
  assert.match(inviteHandler, /emailDomainCanReceiveMail\(details\.email\)/);
  assert.match(inviteHandler, /Boolean\(existingProfile\) \|\| authEmailExists/);
  assert.match(authEmailLookupMigration, /security definer[\s\S]*set search_path = ''/i);
  assert.match(authEmailLookupMigration, /owner_profile\.role = 'admin'[\s\S]*owner_profile\.status = 'active'[\s\S]*owner_auth\.email_confirmed_at is not null/i);
  assert.match(authEmailLookupMigration, /pg_catalog\.lower\(existing_auth\.email\) = normalized/);
  assert.match(authEmailLookupMigration, /revoke all on function public\.owner_auth_email_exists\(uuid, text\) from public, anon, authenticated/i);
  assert.match(authEmailLookupMigration, /grant execute on function public\.owner_auth_email_exists\(uuid, text\) to service_role/i);
  assert.match(inviteHandler, /if \(\/already\|registered\|exists\/i\.test\(createError\?\.message \|\| ''\)\) return json\([\s\S]*?, 409\)/);
  assert.ok(inviteHandler.indexOf('canInviteStaff(caller)') < inviteHandler.indexOf('if (checkEmail) {'));
  assert.match(ownerMarkup, /data-admin-staff-email-status[^>]+role="status"/);
  assert.match(staffAddModal, /data-admin-staff-email-retry[^>]+hidden/);
  assert.match(ownerStyles, /html:root\[data-theme\] body\.admin-body \.admin-input\[data-admin-staff-email\]\[data-email-state="invalid"\][\s\S]*?border-color: var\(--color-alert\)/);
  assert.match(ownerStyles, /html:root\[data-theme\] body\.admin-body \.admin-input\[data-admin-staff-email\]\[data-email-state="available"\][\s\S]*?border-color: var\(--color-court-green\)/);
  assert.match(ownerScript, /STAFF_EMAIL_PATTERN = \/\^\[A-Za-z0-9/);
  assert.match(ownerScript, /setStaffEmailStatus\('duplicate', 'An account already uses this email\.'/);
  assert.match(ownerScript, /if \(res\.status === 409\) \{[\s\S]*?setStaffEmailStatus\('duplicate'/);
  assert.match(ownerScript, /staffEmailStatus\?\.dataset\.state !== 'available'/);
  assert.match(ownerScript, /staffEmailRetryBtn\?\.addEventListener\('click'/);
  assert.match(ownerScript, /beginStaffEmailAvailabilityCheck\(email, revision, 0\)/);
  assert.match(ownerScript, /state !== 'error'/);
  assert.match(ownerScript, /if \(result\.delivery_uncertain\)[\s\S]*?Forgot password\?/);
  assert.match(inviteHandler, /admin\.auth\.admin\.deleteUser\(userId\)/);
  assert.doesNotMatch(inviteHandler, /inviteUserByEmail|temporaryPassword\s*[:,}]\s*temporaryPassword/);
  assert.doesNotMatch(inviteHandler, /json\(\{[^}]*\b(?:temporaryPassword|password)\s*:/);
  assert.doesNotMatch(recoveryHandler, /json\(\{[^}]*\b(?:temporaryPassword|password)\s*:/);
  assert.doesNotMatch(inviteHandler, /console\.(?:log|error)\(/);
  assert.doesNotMatch(recoveryHandler, /console\.(?:log|error)\([^\n]*temporaryPassword/);
  assert.match(inviteHandler, /return json\(\{ success: true, email: details\.email \}\)/);
  assert.doesNotMatch(ownerMarkup, /value="pending">Invited/);
  assert.match(ownerScript, /Pending verification/);
  assert.match(ownerScript, /Correct email and resend setup/i);
  assert.match(ownerScript, /recover-pending-staff/);
  assert.match(recoveryHandler, /profile\.status !== 'pending'/);
  assert.match(recoveryHandler, /emailDomainCanReceiveMail\(email\)/);
  assert.match(recoveryHandler, /\.eq\('email', email\)\.neq\('id', targetId\)/);
  assert.match(recoveryHandler, /admin\.auth\.admin\.updateUserById\(targetId,[\s\S]*?email_confirm: true,[\s\S]*?password: temporaryPassword/);
  assert.match(recoveryHandler, /generateTemporaryPassword\(\)/);
  assert.match(recoveryHandler, /staff_onboarding_credentials'\)[\s\S]*?\.update\(\{ temporary_password_hash/);
  assert.match(recoveryHandler, /emailDomainCanReceiveMail\(email\)[\s\S]*?if \(profile\.role !== 'staff' \|\| profile\.status !== 'pending'/);
  assert.match(recoveryHandler, /pending: true/);
  assert.doesNotMatch(recoveryHandler, /status:\s*['"]active['"]/);
  assert.match(recoveryHandler, /admin\.rpc\('claim_pending_staff_recovery'/);
  assert.match(recoveryHandler, /recovery_lock_id: null, recovery_lock_until: null/);
  assert.match(recoveryHandler, /finally \{[\s\S]*?recovery_lock_id: null, recovery_lock_until: null/);
  assert.match(recoveryHandler, /return json\(recoveryLockReleaseFailed[\s\S]*?success: true, email, pending: true/);
  assert.match(recoveryHandler, /delivery_status: 'smtp_accepted'/);
  assert.match(recoveryHandler, /message_id: acceptedMessageId/);
  assert.match(recoveryHandler, /acceptedMessageId = smtpReceipt\?\.messageId \|\| null/);
  assert.match(recoveryHandler, /Mail server accepted setup email for \$\{email\}/);
  assert.ok(recoveryHandler.lastIndexOf('finally {') < recoveryHandler.indexOf('return json(recoveryLockReleaseFailed'), 'normal success response follows SMTP delivery and lock cleanup');
  assert.match(recoveryHandler, /recovery_lock_release_pending: true[\s\S]*?wait up to 10 minutes/);
  assert.match(recoveryHandler, /buildStaffOnboardingEmail\(/);
  assert.match(recoveryHandler, /subject: staffResendSubject\(\)/);
  assert.match(recoveryHandler, /delivery_outcome_unknown[\s\S]*?delivery_uncertain: true/);
  assert.match(ownerScript, /We couldn't confirm whether the setup email was sent[\s\S]*?newest message will work/);
  assert.match(ownerScript, /Setup email submitted to \$\{email\}\. Staff setup is pending\./);
  assert.doesNotMatch(ownerScript, /Setup email sent to \$\{email\}\. The account remains pending/);
  assert.match(ownerScript, /recoveryRetryBlocked \|\| staffRecoveryEmailStatus/);
  assert.match(toastScript, /el\.classList\.add\('is-visible'\);[\s\S]*?placeToastAboveOpenDialog\(\)/);
  assert.ok(recoveryHandler.indexOf("admin.rpc('claim_pending_staff_recovery'") < recoveryHandler.indexOf('admin.auth.admin.updateUserById('));
  assert.match(completionHandler, /recovery_lock_until/);
  assert.match(completionHandler, /An owner is correcting this account email/);
  assert.match(recoveryLockMigration, /for update/);
  assert.match(recoveryLockMigration, /interval '10 minutes'/);
  assert.match(recoveryLockMigration, /grant execute on function public\.claim_pending_staff_recovery\(uuid, uuid\) to service_role/i);
  assert.match(recoveryLockMigration, /revoke all on function public\.claim_pending_staff_recovery\(uuid, uuid\) from public, anon, authenticated/i);
  assert.match(recoveryLockMigration, /prevent_staff_activation_during_recovery/);
  assert.match(recoveryLockMigration, /recovery_lock_until > pg_catalog\.clock_timestamp\(\)/);
  assert.match(recoveryProfileGuardMigration, /new\.email is distinct from old\.email[\s\S]*?pg_catalog\.pg_trigger_depth\(\) < 2[\s\S]*?auth_user\.email is not distinct from new\.email/);
  assert.match(recoveryProfileGuardMigration, /new\.id is distinct from old\.id or new\.created_at is distinct from old\.created_at/);
  assert.match(recoveryProfileGuardMigration, /new\.onboarding_complete is distinct from old\.onboarding_complete[\s\S]*?service_role/);
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
