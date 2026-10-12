const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const primaryMigrationPath = 'supabase/migrations/20261012091900_require_primary_auth_for_email_mfa.sql';
const stagedInviteMigrationPath = 'supabase/migrations/20261012091910_allow_invite_amr_while_staged.sql';
const activationMigrationPath = 'supabase/migrations/20261012092000_activate_email_mfa_for_live_users.sql';
const stageMigrationPath = 'supabase/migrations/20261012091800_stage_email_mfa_edge_enforcement.sql';
const migration = fs.readFileSync(primaryMigrationPath, 'utf8');
const stagedInviteMigration = fs.readFileSync(stagedInviteMigrationPath, 'utf8');
const activationMigration = fs.readFileSync(activationMigrationPath, 'utf8');
const stageMigration = fs.readFileSync(stageMigrationPath, 'utf8');
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
    console.log('PASS primary AMR allowlist, exact-session binding, staged invite compatibility, activation strictness, and OTP-only rejection');
})().catch(error => { console.error(error); process.exitCode = 1; });
