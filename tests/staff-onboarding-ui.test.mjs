import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../Pages/staff_onboarding.html', import.meta.url), 'utf8');
const supabaseClient = await readFile(new URL('../Config/supabaseClient.js', import.meta.url), 'utf8');
const script = await readFile(new URL('../includes/staff_onboarding.js', import.meta.url), 'utf8');
const style = await readFile(new URL('../Style/staff_onboarding.css', import.meta.url), 'utf8');
const guard = await readFile(new URL('../includes/authGuard.js', import.meta.url), 'utf8');
const completionHandler = await readFile(new URL('../supabase/functions/complete-staff-onboarding/index.ts', import.meta.url), 'utf8');
const onboardingSchema = await readFile(new URL('../database/schema/019_staff_private_onboarding.sql', import.meta.url), 'utf8');
const phoneHelperGrant = await readFile(new URL('../supabase/migrations/20261102191200_staff_onboarding_phone_helper_execute.sql', import.meta.url), 'utf8');
const optionalPhoneMigration = await readFile(new URL('../supabase/migrations/20261103003957_optional_staff_onboarding_mobile.sql', import.meta.url), 'utf8');
const adultStaffMigration = await readFile(new URL('../supabase/migrations/20261103025242_optional_middle_name_staff_minimum_age.sql', import.meta.url), 'utf8');

test('onboarding presents four digestible setup steps inside one card', () => {
  assert.ok(page.indexOf('supabase-js@2/dist/umd/supabase.js') < page.indexOf('../Config/supabaseClient.js'), 'Supabase UMD client loads before the shared client configuration');
  assert.match(page, /<main class="staff-onboarding-card"/);
  assert.match(page, /class="staff-onboarding-header"[\s\S]*data-staff-onboarding-theme/);
  assert.match(page, /data-staff-onboarding-step="password"[\s\S]*New password[\s\S]*data-staff-onboarding-step="name"[\s\S]*Your name[\s\S]*data-staff-onboarding-step="personal"[\s\S]*Personal details[\s\S]*data-staff-onboarding-step="contact"[\s\S]*Contact and privacy/);
  assert.doesNotMatch(page, /Current password|staffSetupCurrentPassword|name="current_password"/);
  assert.match(page, /Style\/typography\.css[\s\S]*Style\/staff_onboarding\.css/);
  assert.match(page, /class="theme-toggle staff-onboarding-theme"[\s\S]*class="sun-circle"[\s\S]*class="moon-path"/);
  assert.match(style, /font-family: var\(--font-display\)/);
  assert.match(style, /font-family: var\(--font-body\)/);
  assert.match(page, /<footer class="staff-onboarding-footer"[\s\S]*data-staff-onboarding-submit/);
  assert.match(page, /data-staff-onboarding-saving[\s\S]*Saving securely/);
  assert.match(page, /Style\/Loading\.css/);
  assert.match(page, /includes\/loadingOverlay\.js/);
  assert.match(script, /InigoLoading\?\.show\('Saving your password and profile securely/);
  assert.match(script, /InigoLoading\?\.hide\(\)/);
  assert.match(page, /data-staff-onboarding-content\]\[hidden\] \{ display:none; \}/);
  assert.match(page, /html:root\[data-theme\] \.staff-onboarding-card \.staff-onboarding-theme \{ position:static; inset:auto; z-index:auto; \}/);
});

test('password is held in memory until the final setup submission and can safely resume', () => {
  assert.match(supabaseClient, /persistSession:\s*false[\s\S]*autoRefreshToken:\s*false/);
  assert.match(script, /window\.sb\.auth\.updateUser\(\{ password: passwordForCompletion \}\)/);
  assert.match(script, /withTimeout\([\s\S]*Saving your password took too long/);
  assert.match(script, /passwordError\.code !== 'same_password'/);
  assert.doesNotMatch(script, /const currentPassword|staffSetupCurrentPassword|current_password/);
  assert.match(script, /passwordForCompletion = entered/);
  assert.match(script, /password: passwordForCompletion/);
  assert.match(script, /localStorage\.setItem\(pendingPasswordKey\(\), String\(Date\.now\(\)\)\)/);
  assert.doesNotMatch(script, /localStorage\.setItem\([^\n]*password\b/);
  assert.match(script, /setSaving\(true\)[\s\S]*auth\.updateUser[\s\S]*complete-staff-onboarding/);
  assert.match(script, /Saving your password and profile securely/);
  assert.match(script, /if \(!passwordForCompletion\) \{\s*showStep\('password'\);\s*errorEl\.textContent = 'For your security, enter your password again to continue\.'/);
  assert.match(script, /completionSucceeded = true/);
  assert.match(page, /data-staff-onboarding-success[\s\S]*Setup complete/);
  assert.match(script, /if \(completionSucceeded\) window\.location\.replace\(new URL\('staff_dashboard\.html'/);
  assert.match(script, /passwordForCompletion = entered/);
});

test('personal details require all requested fields, gate consent, and allow an optional validated phone', () => {
  assert.match(page, /name="first_name"[\s\S]*name="middle_name"[\s\S]*name="last_name"/);
  assert.match(page, /Middle name <span>\(optional\)<\/span>/);
  assert.doesNotMatch(page, /name="middle_name"[^>]*required/);
  assert.match(script, /birthdate\.max = adultBirthdateCutoff/);
  assert.match(completionHandler, /value <= adultBirthdateCutoff/);
  assert.doesNotMatch(completionHandler, /!middleName/);
  assert.match(adultStaffMigration, /p_birthdate > \(\(current_timestamp at time zone 'Asia\/Manila'\)::date - interval '18 years'\)::date/i);
  assert.doesNotMatch(adultStaffMigration, /nullif\(btrim\(p_middle_name\), ''\) is null/i);
  assert.match(page, /name="birthdate"[^>]*required[\s\S]*name="gender"[^>]*required[\s\S]*name="civil_status"[^>]*required[\s\S]*name="address"[^>]*required/);
  assert.match(page, /name="contact_num" type="tel"[^>]*maxlength="18"(?![^>]*required)/);
  assert.doesNotMatch(page, /Staff position|Account status|readonly/);
  assert.match(page, /data-staff-onboarding-privacy-modal[\s\S]*data-privacy-disagree[\s\S]*data-privacy-agree/);
  assert.match(page, /<iframe src="privacy.html\?embed=1" title="IñigoSync Privacy Policy"/);
  assert.match(page, /name="privacy_policy_accepted" value="yes" required data-staff-onboarding-privacy-checkbox/);
  assert.match(script, /functions\/v1\/validate-contact-phone/);
  assert.match(script, /purpose: 'emergency'/);
  assert.match(page, /data-staff-onboarding-emergency-status aria-live="polite"/);
  assert.match(script, /civil_status: values\.get\('civil_status'\)/);
  assert.match(script, /privacy_policy_accepted: privacyCheckbox\.checked/);
  assert.match(completionHandler, /payload\.privacy_policy_accepted !== true/);
  assert.match(completionHandler, /if \(contactNum && !\/\^\\\+639/);
  assert.match(optionalPhoneMigration, /p_contact_num is not null and p_contact_num !~/i);
  assert.match(completionHandler, /p_contact_num: contactNum \|\| null/);
  assert.doesNotMatch(script, /status:\s*['"]active['"]/);
  assert.match(completionHandler, /complete_staff_onboarding_profile/);
  assert.match(onboardingSchema, /create table if not exists public\.staff_private_details/i);
  assert.match(onboardingSchema, /civil_status text not null/i);
  assert.match(onboardingSchema, /proof\.purpose = 'emergency'[\s\S]*returning true into v_emergency_proof/i);
  assert.match(onboardingSchema, /staff_private_details_self_read[\s\S]*user_id = \(select auth\.uid\(\)\)/i);
  assert.match(onboardingSchema, /staff_private_details_owner_read[\s\S]*internal\.is_active_owner/i);
  assert.match(onboardingSchema, /grant execute on function public\.complete_staff_onboarding_profile[\s\S]*to service_role/i);
  assert.match(onboardingSchema, /status = 'pending' and p\.onboarding_complete is false/i);
  assert.match(phoneHelperGrant, /grant execute on function internal\.ph_mobile_to_e164\(text\) to service_role/i);
  assert.doesNotMatch(phoneHelperGrant, /to authenticated|to anon/i);
});

test('completed staff bypass onboarding and pending staff are kept behind the existing guard', () => {
  assert.match(guard, /profile\.role === 'staff' && profile\.onboarding_complete !== true[\s\S]*window\.location\.replace\(new URL\(onboardingPath/);
  assert.match(guard, /isStaffOnboardingPage && \(profile\.role !== 'staff' \|\| profile\.onboarding_complete === true \|\| legacyActiveStaff\)/);
  assert.match(guard, /Email verification is taking too long to respond/);
  assert.match(guard, /data-staff-onboarding-retry/);
  assert.match(guard, /withTimeout\(window\.InigoEmailMfa\?\.check/);
});
