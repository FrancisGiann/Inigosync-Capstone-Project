const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const primaryMigrationPath = 'supabase/migrations/20261012091900_require_primary_auth_for_email_mfa.sql';
const stagedInviteMigrationPath = 'supabase/migrations/20261012091910_allow_invite_amr_while_staged.sql';
const activationMigrationPath = 'supabase/migrations/20261012092000_activate_email_mfa_for_live_users.sql';
const stageMigrationPath = 'supabase/migrations/20261012091800_stage_email_mfa_edge_enforcement.sql';
const nativeProofMigrationPath = 'supabase/migrations/20261025172615_auth_session_native_email_proof.sql';
const signupOtpMigrationPath = 'supabase/migrations/20261025234435_signup_otp_native_email_proof.sql';
const migration = fs.readFileSync(primaryMigrationPath, 'utf8');
const stagedInviteMigration = fs.readFileSync(stagedInviteMigrationPath, 'utf8');
const activationMigration = fs.readFileSync(activationMigrationPath, 'utf8');
const stageMigration = fs.readFileSync(stageMigrationPath, 'utf8');
const nativeProofMigration = fs.readFileSync(nativeProofMigrationPath, 'utf8');
const signupOtpMigration = fs.readFileSync(signupOtpMigrationPath, 'utf8');
const allowlistMatch = migration.match(/m\.authentication_method\s+in\s*\(([^)]+)\)/i);
assert(allowlistMatch, 'primary auth SQL must have an explicit AMR allowlist');
const acceptedMethods = new Set([...allowlistMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
const hasPrimaryMethod = methods => methods.some(method => acceptedMethods.has(method));

for (const method of ['password', 'oauth', 'sso/saml', 'email/signup']) {
    assert(acceptedMethods.has(method), `${method} is an accepted primary authentication method`);
    assert.equal(hasPrimaryMethod([method]), true);
}
for (const method of ['otp', 'magiclink', 'recovery', 'invite', 'token_refresh', 'anonymous']) {
    assert.equal(hasPrimaryMethod([method]), false, `${method} alone cannot satisfy the primary authentication check`);
}
assert.equal(hasPrimaryMethod(['otp', 'password']), true, 'a session carrying the password AMR remains eligible');
assert.equal(hasPrimaryMethod([]), false, 'a missing AMR row fails closed');
assert.match(migration, /join auth\.mfa_amr_claims m on m\.session_id = s\.id/i,
    'the AMR must belong to the exact Auth session');
assert.match(migration, /s\.id = p_session_id[\s\S]*s\.user_id = p_user_id/i,
    'the live session must match both the requested session and user');
assert.doesNotMatch(migration, /profiles_email_mfa_select/,
    'primary function setup alone must not restrict profile reads while staging is disabled');
assert.match(stageMigration, /enabled boolean not null default false/i,
    'the staging switch starts with enforcement disabled');
assert.match(activationMigration, /update internal\.email_mfa_enforcement set enabled = true/i,
    'activation enables guarded Edge checks');
assert.match(activationMigration, /profiles_email_mfa_select[\s\S]*email_mfa_live_session/,
    'activation applies the primary-auth profile policy together with enforcement');
assert.match(stagedInviteMigration, /m\.authentication_method\s*=\s*'invite'[\s\S]*e\.enabled\s+is\s+false/i,
    'invite AMR is admitted only when the enforcement singleton explicitly disables MFA');
const primaryMethods = new Set(acceptedMethods);
const stagedSessionAllowed = (method, enabled) => primaryMethods.has(method)
    || (method === 'invite' && enabled === false);
assert.equal(stagedSessionAllowed('invite', false), true,
    'the currently deployed invite completion flow works while enforcement is explicitly staged off');
assert.equal(stagedSessionAllowed('invite', true), false,
    'invite-only sessions are rejected once enforcement is active');
assert.equal(stagedSessionAllowed('invite', null), false,
    'a missing or NULL enforcement state rejects invite-only sessions');
for (const method of ['otp', 'magiclink', 'recovery']) {
    assert.equal(stagedSessionAllowed(method, false), false,
        `${method} remains rejected while enforcement is staged off`);
    assert.equal(stagedSessionAllowed(method, true), false,
        `${method} remains rejected after activation`);
}
const migrationOrder = [stageMigrationPath, primaryMigrationPath, stagedInviteMigrationPath, activationMigrationPath].map(path =>
    path.match(/(\d{14})/)[1]);
assert.deepEqual(migrationOrder, ['20261012091800', '20261012091900', '20261012091910', '20261012092000'],
    'the primary predicate and staged invite compatibility must precede activation');

const edgeSource = fs.readFileSync('supabase/functions/email-mfa/index.ts', 'utf8');
assert.match(edgeSource, /email_mfa_has_primary_auth/,
    'the Edge MFA endpoint checks primary authentication before handling challenges');
assert.match(edgeSource, /if \(action !== 'revoke'\)[\s\S]*hasPrimaryAuth !== true/,
    'challenge begin, verify, and check fail closed while revocation remains available');
assert.match(edgeSource, /action === 'begin'[\s\S]*email_mfa_check_session[\s\S]*sessionAlreadyVerified === true/,
    'begin short-circuits only after the server-side exact-session proof check');
assert.doesNotMatch(edgeSource, /authData\.user\.user_metadata|payload\.user_metadata|nativeEmailProof|skipMfa/i,
    'the Edge Function accepts no browser-controlled or user-editable provider bypass claim');

assert.match(nativeProofMigration, /auth\.mfa_amr_claims m on m\.session_id = s\.id/i,
    'native proof is tied to the AMR of the exact Auth session');
assert.match(nativeProofMigration, /s\.id = p_session_id[\s\S]*s\.user_id = p_user_id/i,
    'native proof checks both the exact session and user');
assert.match(nativeProofMigration, /u\.email_confirmed_at is not null/i,
    'native proof requires Auth-confirmed email');
assert.match(nativeProofMigration, /u\.confirmation_sent_at is not null/i,
    'email/signup AMR only bypasses the second code when confirmation mail was actually sent');
assert.match(nativeProofMigration, /lower\(u\.email\) = lower\(p\.email\)/i,
    'Auth and profile canonical emails must match');
assert.match(nativeProofMigration, /p\.status = 'active'[\s\S]*p\.role in \('customer', 'staff', 'admin'\)/i,
    'native proof retains active account role/status gates');
assert.doesNotMatch(nativeProofMigration, /raw_user_meta_data|user_metadata/i,
    'native proof never trusts user-editable metadata');
assert.match(nativeProofMigration, /m\.authentication_method = 'oauth'/i,
    'an exact OAuth AMR can use the provider-authenticated session path');
assert.match(nativeProofMigration, /m\.authentication_method = 'email\/signup'[\s\S]*u\.confirmation_sent_at is not null/i,
    'email/signup is conditional on a sent confirmation email');
assert.match(nativeProofMigration, /create or replace function internal\.has_verified_email_session\(\)[\s\S]*email_mfa_session_has_native_proof[\s\S]*email_mfa_verified_sessions/i,
    'RLS accepts native proof while preserving server-recorded email-MFA proof');
assert.match(nativeProofMigration, /create or replace function public\.email_mfa_check_session[\s\S]*email_mfa_session_has_native_proof[\s\S]*email_mfa_verified_sessions/i,
    'Edge checks and RLS share native proof plus custom-MFA proof');

// Supabase records a confirmed signup code as AMR `otp`. Both the profile
// bootstrap gate and the native-proof gate must recognize only the OTP session
// created alongside the first email confirmation on an email-only Auth account.
for (const functionName of ['email_mfa_live_session', 'email_mfa_session_has_native_proof']) {
    const section = signupOtpMigration.split(`create or replace function internal.${functionName}(`)[1]?.split('$$;')[0];
    assert(section, `${functionName} is updated for the observed signup AMR`);
    assert.match(section, /m\.authentication_method = 'otp'/i,
        `${functionName} considers the observed OTP AMR`);
    assert.match(section, /u\.phone is null[\s\S]*u\.phone_confirmed_at is null[\s\S]*i\.provider = 'phone'/i,
        `${functionName} excludes Auth phone identities`);
    assert.match(section, /u\.confirmation_sent_at <= u\.email_confirmed_at[\s\S]*u\.email_confirmed_at between s\.created_at - interval '30 seconds'[\s\S]*s\.created_at \+ interval '30 seconds'/i,
        `${functionName} binds OTP admission to the email-confirmation session`);
}
assert.doesNotMatch(signupOtpMigration, /m\.authentication_method\s+in\s*\([^)]*'otp'/i,
    'OTP is never added to the general primary-method allowlist');

const nativeProof = ({ method, emailConfirmed, confirmationSent, authEmail, profileEmail, role = 'customer', status = 'active', onboardingComplete = true,
    hasAuthPhone = false, hasPhoneIdentity = false, confirmationSession = false }) => {
    const profileAllowed = (status === 'active' && ['customer', 'staff', 'admin'].includes(role))
        || (role === 'staff' && status === 'pending' && onboardingComplete === false);
    return emailConfirmed === true && authEmail?.toLowerCase() === profileEmail?.toLowerCase()
        && profileAllowed
        && (method === 'oauth' || (method === 'email/signup' && confirmationSent === true)
            || (method === 'otp' && confirmationSent === true && confirmationSession === true
                && !hasAuthPhone && !hasPhoneIdentity));
};
const proofFixture = { emailConfirmed: true, confirmationSent: true, authEmail: 'user@example.test', profileEmail: 'USER@example.test' };
assert.equal(nativeProof({ ...proofFixture, method: 'oauth', confirmationSent: false }), true,
    'OAuth proof depends on this session AMR, confirmed canonical email and profile, not a Supabase confirmation-mail setting');
assert.equal(nativeProof({ ...proofFixture, method: 'email/signup' }), true,
    'email/signup with a sent and confirmed signup email can use its native email proof');
assert.equal(nativeProof({ ...proofFixture, method: 'email/signup', confirmationSent: false }), false,
    'email/signup cannot bypass MFA when Confirm Email was disabled and no confirmation was sent');
assert.equal(nativeProof({ ...proofFixture, method: 'email/signup', emailConfirmed: false }), false,
    'an unconfirmed signup email cannot use native proof');
assert.equal(nativeProof({ ...proofFixture, method: 'password' }), false,
    'password authentication still requires the custom email-MFA verified-session row');
for (const method of ['otp', 'magiclink', 'recovery', 'invite', 'email_change', 'token_refresh']) {
    assert.equal(nativeProof({ ...proofFixture, method }), false, `${method} without signup confirmation cannot use native email proof`);
}
assert.equal(nativeProof({ ...proofFixture, method: 'otp', confirmationSession: true }), true,
    'the one OTP session created at first email confirmation can use native proof');
assert.equal(nativeProof({ ...proofFixture, method: 'otp', confirmationSession: true, hasAuthPhone: true }), false,
    'a phone-capable Auth account cannot use the signup OTP exception');
assert.equal(nativeProof({ ...proofFixture, method: 'otp', confirmationSession: true, hasPhoneIdentity: true }), false,
    'an Auth phone identity cannot use the signup OTP exception');
assert.equal(nativeProof({ ...proofFixture, method: 'oauth', profileEmail: 'other@example.test' }), false,
    'native proof fails closed on a profile/Auth email mismatch');
assert.equal(nativeProof({ ...proofFixture, method: 'oauth', status: 'disabled' }), false,
    'native proof fails closed for disabled accounts');
assert.equal(nativeProof({ ...proofFixture, method: 'email/signup', role: 'staff', status: 'pending', onboardingComplete: false }), true,
    'only the existing pending-staff onboarding exception remains eligible');
assert.equal(nativeProof({ ...proofFixture, method: 'email/signup', role: 'admin', status: 'pending', onboardingComplete: false }), false,
    'other pending accounts remain ineligible');

const helperSource = fs.readFileSync('supabase/functions/_shared/email-mfa.ts', 'utf8');
assert.match(helperSource, /email_mfa_check_session/,
    'guarded Edge functions require the database proof check when enforcement is active');
const helper = helperSource
    .replace(/: Promise<boolean>/g, '')
    .replace(/: string \| null/g, '')
    .replace(/: string/g, '')
    .replace(/: any/g, '')
    .replace('export async function hasVerifiedEmailSession', 'async function hasVerifiedEmailSession')
    + '\nglobalThis.hasVerifiedEmailSession = hasVerifiedEmailSession;';
const context = { atob };
vm.runInNewContext(helper, context);

(async () => {
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const token = `header.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.signature`;
    const calls = [];
    const admin = { rpc: async name => {
        calls.push(name);
        if (name === 'email_mfa_enforcement_enabled') return { data: true, error: null };
        // This is the same database predicate used by RLS and returns false
        // for OTP-only/recovery sessions, even after their token is refreshed.
        return { data: false, error: null };
    } };
    assert.equal(await context.hasVerifiedEmailSession(admin, token, 'user-1'), false,
        'an OTP-only session cannot pass the guarded Edge check');
    assert.deepEqual(calls, ['email_mfa_enforcement_enabled', 'email_mfa_check_session']);

    const verifiedAdmin = { rpc: async name => ({ data: name === 'email_mfa_enforcement_enabled' || name === 'email_mfa_check_session', error: null }) };
    assert.equal(await context.hasVerifiedEmailSession(verifiedAdmin, token, 'user-1'), true,
        'a primary session with server-recorded email proof can pass the guarded Edge check');
    console.log('PASS primary AMR allowlist, exact-session binding, staged invite compatibility, and guarded signup OTP proof');
})().catch(error => { console.error(error); process.exitCode = 1; });
