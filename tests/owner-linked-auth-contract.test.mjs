import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/20261103140000_owner_linked_email_password_auth.sql', import.meta.url), 'utf8');
const singleOtpMigration = await readFile(new URL('../supabase/migrations/20261103150000_owner_linked_email_single_otp.sql', import.meta.url), 'utf8');
const challengeCleanupMigration = await readFile(new URL('../supabase/migrations/20261103170000_owner_linked_email_challenge_expiry_cleanup.sql', import.meta.url), 'utf8');
const edge = await readFile(new URL('../supabase/functions/owner-linked-auth/index.ts', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');
const page = await readFile(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8');
const auth = await readFile(new URL('../includes/auth.js', import.meta.url), 'utf8');
const plan = await readFile(new URL('../implementation_plan.md', import.meta.url), 'utf8');

function functionBody(source, name, nextName) {
  const start = source.indexOf(`create or replace function public.${name}(`);
  const end = source.indexOf(`create or replace function public.${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} exists`);
  return source.slice(start, end);
}

test('aliases are private email rows keyed independently of Google identities', () => {
  const table = migration.match(/create table internal\.owner_email_aliases\s*\(([\s\S]*?)\n\);/)?.[1];
  assert.ok(table);
  assert.match(table, /alias_id uuid primary key/);
  assert.match(table, /user_id uuid not null references auth\.users\(id\)/);
  assert.match(migration, /owner_email_aliases_normalized_email_uidx/);
  assert.doesNotMatch(migration, /auth\.identities|identity_id|provider\s*=\s*'google'/i);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /from public, anon, authenticated/);
});

test('adding an alias requires a live verified owner session and verifies the alias mailbox', () => {
  const begin = functionBody(migration, 'owner_email_begin_alias_verification', 'owner_email_verify_alias_code');
  const verify = functionBody(migration, 'owner_email_verify_alias_code', 'owner_email_begin_password_challenge');
  assert.match(begin, /email_mfa_check_session\(p_user_id,p_session_id\)/);
  assert.match(begin, /owner_email_enrollment_challenges/);
  assert.match(begin, /owner_email_auth_session_is_live\(p_user_id,p_session_id\)/);
  assert.match(begin, /p\.role='admin' and p\.status='active'/);
  assert.match(verify, /alias_code_hash is distinct from p_code_hash/);
  assert.match(verify, /insert into internal\.owner_email_aliases/);
  assert.match(verify, /owner_email_auth_session_is_live\(p_user_id,p_session_id\)/);
  assert.match(verify, /email_mfa_check_session\(p_user_id,p_session_id\)/);
  assert.match(verify, /p\.role='admin' and p\.status='active'/);
  assert.match(edge, /action === 'begin-add-email'/);
  assert.match(edge, /sendMail\(email, 'Verify an email/);
  assert.match(edge, /action === 'verify-alias-code'/);
  const enrollmentActions = edge.slice(edge.indexOf("if (action === 'begin-add-email')"), edge.indexOf("if (action === 'begin-password-setup')"));
  assert.equal((enrollmentActions.match(/sendMail\(/g) || []).length, 1, 'enrollment sends one OTP, only to the new alias mailbox');
  assert.match(dashboard, /invoke\('verify-alias-code'/);
  assert.match(dashboard, /aliasVerified = true; passwordProof = true/);
});

test('password setup reuses the initial alias proof and later Set/Change uses a no-code owner-session challenge', () => {
  const passwordSetup = edge.slice(edge.indexOf("if (action === 'begin-password-setup')"), edge.indexOf("if (action === 'save-password')"));
  assert.ok(passwordSetup.length > 0, 'password setup action exists');
  assert.match(passwordSetup, /p_code_hash: null/);
  assert.doesNotMatch(passwordSetup, /sendMail\(|randomCode\(|begin-password-code|verify-password-code/);
  assert.match(dashboard, /invoke\('begin-password-setup'/);
  assert.doesNotMatch(edge, /begin-owner-code|verify-owner-code|owner password verification code/);
  assert.doesNotMatch(dashboard, /main owner email code|begin-owner-code|verify-owner-code/);

  const beginSetup = functionBody(singleOtpMigration, 'owner_email_begin_password_challenge', 'owner_email_verify_owner_code');
  const savePassword = singleOtpMigration.slice(singleOtpMigration.indexOf('create or replace function public.owner_email_save_password('));
  for (const body of [beginSetup, savePassword]) {
    assert.match(body, /owner_email_auth_session_is_live\(p_user_id,p_session_id\)/);
    assert.match(body, /email_mfa_check_session\(p_user_id,p_session_id\)/);
    assert.match(body, /p\.role='admin' and p\.status='active'/);
  }
  assert.match(beginSetup, /p_code_hash is null then now\(\)/);
  assert.match(beginSetup, /email_verified_at is not null/);
  assert.match(savePassword, /owner_code_hash is null and owner_verified_at is null/);
  assert.match(singleOtpMigration, /function public\.owner_email_verify_owner_code[\s\S]*?select false/);
  assert.match(singleOtpMigration, /credential_version=credential_version\+1/);
  assert.match(singleOtpMigration, /delete from internal\.owner_email_sessions where user_id=p_user_id and alias_id=p_alias_id/);
});

test('alias-password login brokers the canonical user and waits for OTP to the alias', () => {
  assert.match(edge, /generateLink\(\{ type: 'magiclink', email: canonical \}\)/);
  assert.match(edge, /action === 'begin-login-code'/);
  assert.match(edge, /sendMail\(c\.email, 'Your IñigoSync sign-in code'/);
  assert.match(edge, /action === 'verify-login-code'/);
  const verifyLogin = edge.slice(edge.indexOf("if (action === 'verify-login-code')"));
  assert.match(verifyLogin, /return json\(\{ verified: true \}, 200, origin\)/);
  assert.match(auth, /verified\.verified !== true/);
  assert.match(migration, /owner_email_session_is_verified\(auth\.uid\(\)/);
  assert.match(migration, /owner_email_session_is_verified\(p_user_id,p_session_id\)/);
  assert.match(migration, /s\.not_after is null or s\.not_after>now\(\)/);
  assert.match(migration, /auth\.mfa_amr_claims m where m\.session_id=p_session_id and m\.authentication_method='magiclink'/);
});

test('expired enrollment challenges are independently pruned after their expiry', () => {
  assert.match(challengeCleanupMigration, /security definer[\s\S]*?set search_path = ''/);
  assert.match(challengeCleanupMigration, /delete from internal\.owner_email_enrollment_challenges\s+where expires_at <= pg_catalog\.now\(\)/);
  assert.match(challengeCleanupMigration, /from public, anon, authenticated/);
  assert.match(challengeCleanupMigration, /to service_role/);
  assert.match(challengeCleanupMigration, /'\*\/5 \* \* \* \*'/);
  assert.doesNotMatch(challengeCleanupMigration, /delete from internal\.owner_email_enrollment_challenges\s*;/);
});

test('rate-limit inputs are validated and expired limiter/challenge state is pruned', () => {
  const rateLimit = functionBody(migration, 'owner_email_login_rate_limit', 'owner_email_reset_login_limit');
  assert.match(rateLimit, /octet_length\(p_email_hash\)<>32/);
  assert.match(rateLimit, /octet_length\(p_ip_hash\)<>32/);
  assert.match(rateLimit, /owner_email_auth_attempts where window_started_at<now\(\)-interval '24 hours'/);
  assert.match(rateLimit, /owner_email_login_tickets where expires_at<=now\(\)/);
  assert.match(rateLimit, /owner_email_login_challenges where expires_at<=now\(\)/);
  assert.match(rateLimit, /owner_email_enrollment_challenges where expires_at<=now\(\)/);
  assert.match(rateLimit, /delete from internal\.owner_email_sessions s/);
  assert.match(rateLimit, /s\.verified_at<=now\(\)-interval '7 days'/);
  assert.match(rateLimit, /c\.session_id=s\.session_id and c\.expires_at>now\(\)/);
  assert.match(migration, /owner_email_code_attempts where window_started_at<now\(\)-interval '24 hours'/);
});

test('HMAC pepper is domain-separated from the existing service-role key', () => {
  assert.match(edge, /deriveHmacPepper\(serviceRoleKey: string\)/);
  assert.match(edge, /name: 'HKDF', hash: 'SHA-256'/);
  assert.match(edge, /owner-email-alias-auth\/hmac-pepper\/v1/);
  assert.match(edge, /Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\)/);
  assert.doesNotMatch(edge, /OWNER_LINKED_AUTH_PEPPER/);
  assert.match(plan, /Rotating the service-role key changes the derived HMAC key/);
  assert.match(plan, /PBKDF2 alias password hashes and already verified broker-session rows remain valid/);
});

test('linked confirmation notice is independent and never receives password material', () => {
  const notice = edge.match(/async function sendAliasNotice\([\s\S]*?\n}\n\nDeno\.serve/)?.[0];
  assert.ok(notice);
  assert.match(notice, /sendMail\(n\.email/);
  assert.match(notice, /contains no password/);
  assert.doesNotMatch(notice, /body\.password|passwordHash|codeHash|randomCode/);
  assert.match(migration, /values\(p_alias_id,p_user_id,e,'pending',null\)/);
  assert.match(edge, /delivery_uncertain/);
  assert.match(dashboard, /Retry linked notice/);
});

test('owner UI adds, manages, and revokes email aliases without secondary Google linking', () => {
  assert.match(page, /Linked email accounts/);
  assert.match(page, /data-admin-add-email/);
  assert.match(dashboard, /begin-add-email/);
  assert.match(dashboard, /remove-alias/);
  assert.match(dashboard, /separate password will stop working immediately/);
  assert.doesNotMatch(dashboard, /linkIdentity\(|data-admin-link-google|refreshLinkedGoogleEmails/);
});

test('alias recovery guidance does not claim that a reset code was sent', () => {
  assert.match(auth, /linked email alias with its own owner sign-in password/i);
  assert.match(auth, /a reset code may arrive/i);
  assert.doesNotMatch(auth, /we've sent a 6-digit reset code/i);
});
