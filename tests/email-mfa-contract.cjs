const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const values = new Map();
const calls = [];
const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
};
const window = {
    crypto: { getRandomValues(bytes) { bytes.fill(0xab); return bytes; } },
    sb: {
        auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }) },
        functions: { invoke: async (name, { body }) => {
            calls.push({ name, body });
            if (body.action === 'begin') return { data: { verified: false, challenge_id: 'challenge-1' }, error: null };
            if (body.action === 'verify') return { data: { verified: true }, error: null };
            return { data: { verified: true }, error: null };
        } },
    },
};
vm.runInNewContext(fs.readFileSync('includes/emailMfa.js', 'utf8'), { window, localStorage });

(async () => {
    const mfa = window.InigoEmailMfa;
    await mfa.check();
    assert.equal(values.size, 0, 'checking a session never creates remembered-device state');

    await mfa.begin({ userId: 'user-1', remember: true });
    const rememberedSecret = values.get('inigosync-email-mfa-device:v1:user-1');
    assert.match(rememberedSecret, /^[a-f0-9]{64}$/);
    assert.equal(calls.at(-1).body.remember, true);
    assert.equal(calls.at(-1).body.device_secret, rememberedSecret);

    await mfa.begin({ userId: 'user-1', remember: false });
    const uncheckedBegin = calls.at(-1).body;
    assert.equal(uncheckedBegin.remember, false);
    assert.equal(uncheckedBegin.device_secret, rememberedSecret, 'unchecked login sends an existing secret so the server can recognize this trusted device');
    assert.equal(values.get('inigosync-email-mfa-device:v1:user-1'), rememberedSecret,
        'unchecked login preserves the secret for future sign-ins on the same device');

    await mfa.verify({ userId: 'user-1', challengeId: 'challenge-1', code: '123456', remember: false });
    assert.equal(calls.at(-1).body.device_secret, null, 'unchecked verification cannot create or persist a trusted-device secret');

    await mfa.begin({ userId: 'never-trusted-user', remember: false });
    assert.equal(calls.at(-1).body.device_secret, null, 'a never-trusted device has no secret to present when unchecked');
    assert.equal(values.has('inigosync-email-mfa-device:v1:never-trusted-user'), false,
        'an unchecked sign-in never creates local trust state');

    const migration = fs.readFileSync('supabase/migrations/20261012090000_email_session_verification.sql', 'utf8');
    assert.match(migration, /alter role authenticator set pgrst\.db_pre_request/);
    assert.match(migration, /last_activity_at > now\(\) - interval '7 days'/);
    assert.match(migration, /profiles_email_mfa_select[\s\S]*id = auth\.uid\(\) or internal\.has_verified_email_session\(\)/);
    assert.match(migration, /email_mfa_required_storage_insert/);
    assert.doesNotMatch(migration, /my_booking_reviews', 'sport/);
    assert.match(migration, /not an AAL2 claim/i);

    const rememberedDeviceMigration = fs.readFileSync('supabase/migrations/20261012092100_preserve_remembered_email_mfa_devices.sql', 'utf8');
    const beginFunction = rememberedDeviceMigration.match(/create or replace function public\.email_mfa_begin\([\s\S]*?\$\$;/i)?.[0];
    assert(beginFunction, 'the append-only migration replaces only the MFA begin behavior');
    assert.match(beginFunction, /p_device_hash is not null[\s\S]*expires_at > now\(\)/,
        'device trust is checked even when the current sign-in did not check Remember me');
    assert.doesNotMatch(beginFunction, /if not p_remember[\s\S]*delete from internal\.email_mfa_trusted_devices/i,
        'unchecked sign-in does not revoke existing device trust');
    assert.match(beginFunction, /expires_at <= now\(\)/,
        'an expired device trust record is removed and cannot skip the email code');
    assert.match(beginFunction, /internal\.email_mfa_live_session\(p_user_id, p_session_id\)/,
        'the replacement retains the exact live Auth session check');
    assert.match(migration, /if p_remember and p_device_hash is not null[\s\S]*insert into internal\.email_mfa_trusted_devices/i,
        'only a checked successful verification can create trusted-device state');

    const emailEdge = fs.readFileSync('supabase/functions/email-mfa/index.ts', 'utf8');
    assert.match(emailEdge, /verifyEmailChallenge/);
    for (const path of [
        'invite-staff', 'payment-health', 'paymongo-balance-checkout',
        'paymongo-checkout', 'staff-walkin-checkout', 'validate-contact-phone',
    ]) {
        assert.match(fs.readFileSync(`supabase/functions/${path}/index.ts`, 'utf8'), /hasVerifiedEmailSession/,
            `${path} requires server-validated email proof`);
    }

    const edgeHelperSource = fs.readFileSync('supabase/functions/_shared/email-mfa.ts', 'utf8');
    const runnableEdgeHelper = edgeHelperSource
        .replace(/: Promise<boolean>/g, '')
        .replace(/: string \| null/g, '')
        .replace(/: string/g, '')
        .replace(/: any/g, '')
        .replace('export async function hasVerifiedEmailSession', 'async function hasVerifiedEmailSession')
        + '\nglobalThis.hasVerifiedEmailSession = hasVerifiedEmailSession;';
    const edgeHelper = { atob };
    vm.runInNewContext(runnableEdgeHelper, edgeHelper);
    const stagedCalls = [];
    const stagedAdmin = { rpc: async name => {
        stagedCalls.push(name);
        return { data: false, error: null };
    } };
    assert.equal(await edgeHelper.hasVerifiedEmailSession(stagedAdmin, 'not-a-jwt', 'user-1'), true,
        'flag-off staging preserves access for an Auth-validated JWT without session_id');
    assert.deepEqual(stagedCalls, ['email_mfa_enforcement_enabled'], 'staging does not require an MFA proof lookup');

    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const token = `header.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.signature`;
    const activeCalls = [];
    const activeAdmin = { rpc: async (name, args) => {
        activeCalls.push({ name, args });
        if (name === 'email_mfa_enforcement_enabled') return { data: true, error: null };
        return { data: true, error: null };
    } };
    assert.equal(await edgeHelper.hasVerifiedEmailSession(activeAdmin, token, 'user-1'), true,
        'flag-on enforcement accepts only the existing session proof check');
    assert.deepEqual(activeCalls.map(call => call.name), ['email_mfa_enforcement_enabled', 'email_mfa_check_session']);
    assert.equal(activeCalls[1].args.p_user_id, 'user-1');
    assert.equal(activeCalls[1].args.p_session_id, sessionId);
    assert.equal(await edgeHelper.hasVerifiedEmailSession({ rpc: async name => ({ data: name === 'email_mfa_enforcement_enabled', error: null }) }, token, 'user-1'), false,
        'flag-on enforcement rejects sessions without proof');
    assert.equal(await edgeHelper.hasVerifiedEmailSession({ rpc: async () => ({ data: null, error: new Error('unavailable') }) }, token, 'user-1'), false,
        'an unavailable enforcement flag fails closed');
    assert.equal(await edgeHelper.hasVerifiedEmailSession({ rpc: async () => ({ data: null, error: null }) }, token, 'user-1'), false,
        'a missing enforcement singleton fails closed');

    const stagedMigration = fs.readFileSync('supabase/migrations/20261012091800_stage_email_mfa_edge_enforcement.sql', 'utf8');
    assert.match(stagedMigration, /enabled boolean not null default false/i);
    assert.match(stagedMigration, /revoke all on internal\.email_mfa_enforcement from public, anon, authenticated, service_role/i);
    assert.match(stagedMigration, /grant execute on function public\.email_mfa_enforcement_enabled\(\) to service_role/i);
    assert.doesNotMatch(stagedMigration, /grant execute on function public\.email_mfa_enforcement_enabled\(\)[\s\S]*to[^;]*authenticated/i);
    assert.match(stagedMigration, /select \(select enabled from internal\.email_mfa_enforcement where singleton\)/i,
        'a missing singleton returns NULL for the helper to reject');
    const activationMigration = fs.readFileSync('supabase/migrations/20261012092000_activate_email_mfa_for_live_users.sql', 'utf8');
    assert.match(activationMigration, /update internal\.email_mfa_enforcement set enabled = true/i);
    const readonlyHookMigration = fs.readFileSync('supabase/migrations/20261013090000_make_email_mfa_pre_request_read_only.sql', 'utf8');
    const readonlyHook = readonlyHookMigration.match(/create or replace function internal\.enforce_email_mfa_pre_request\(\)[\s\S]*?\$\$;/i)?.[0];
    assert(readonlyHook, 'the follow-up migration replaces the active pre-request hook');
    assert.match(readonlyHook, /returns void language plpgsql stable security definer/i,
        'the PostgREST hook is declared read-only for STABLE RPC transactions');
    assert.doesNotMatch(readonlyHook, /\b(insert|update|delete|truncate)\b/i,
        'the read-only hook never writes session or enforcement state');
    assert.match(readonlyHook, /if internal\.has_verified_email_session\(\) then return; end if/i,
        'a verified session still passes the hook');
    for (const path of [
        'profiles', 'app_settings', 'assets', 'court', 'court_unit_inventory',
        'court_unit_resource_map', 'event', 'physical_court_resource',
        'public_booking_reviews', 'sport', 'testimonial',
    ]) assert(readonlyHook.includes(`'${path}'`), `the bootstrap GET allowlist retains ${path}`);
    for (const path of [
        'rpc/signup_email_availability', 'rpc/signup_phone_availability',
        'rpc/court_occupancy', 'rpc/booking_rules_for_date',
    ]) assert(readonlyHook.includes(`'${path}'`), `the narrow pre-verification RPC allowlist retains ${path}`);
    assert.match(readonlyHook, /raise sqlstate '42501' using message = 'Email verification required for this session\.'/i,
        'unverified sessions remain denied outside the allowlist');
    assert.match(readonlyHookMigration, /alter role authenticator set pgrst\.db_pre_request/i,
        'the updated hook remains installed for PostgREST');

    const sessionTouchRpc = migration.match(/create or replace function public\.email_mfa_touch_session\([\s\S]*?\$\$;/i)?.[0];
    assert(sessionTouchRpc, 'the explicit verified-session inactivity touch RPC remains defined');
    assert.match(sessionTouchRpc, /update internal\.email_mfa_verified_sessions[\s\S]*last_activity_at = now\(\)/i);
    assert.match(migration, /public\.email_mfa_touch_session\(uuid,uuid\)[\s\S]*to service_role/i,
        'only the service role can execute the session touch RPC');
    const emailMfaEdge = fs.readFileSync('supabase/functions/email-mfa/index.ts', 'utf8');
    assert.match(emailMfaEdge, /if \(payload\.activity === true\)[\s\S]*admin\.rpc\('email_mfa_touch_session'/i,
        'real activity still refreshes the inactivity timestamp through the Edge Function');
    const deferMigration = fs.readFileSync('supabase/migrations/20261012091000_defer_email_mfa_enforcement_for_live_users.sql', 'utf8');
    assert.match(deferMigration, /update internal\.email_mfa_enforcement set enabled = false/i);

    const { verifyEmailChallenge } = await import('../supabase/functions/_shared/email-mfa-core.mjs');
    async function challengeCase({ challenge = true, attempts = true, sessionId = 'session-1', verify = { data: { user: { id: 'user-1' }, session: { access_token: 'temp-token' } }, error: null }, revokeError = null, finish = true } = {}) {
        const calls = [];
        const admin = { auth: { admin: { signOut: async (...args) => {
            calls.push({ name: 'adminSignOut', args });
            return { error: revokeError };
        } } }, rpc: async (name, args) => {
            calls.push({ name, args });
            if (name === 'email_mfa_get_challenge') return { data: challenge && args.p_session_id === 'session-1' ? [{ email: 'user@example.test' }] : [], error: null };
            if (name === 'email_mfa_record_attempt') return { data: attempts, error: null };
            if (name === 'email_mfa_finish') return { data: finish, error: null };
            throw new Error(`unexpected RPC ${name}`);
        } };
        const emailAuth = { auth: {
            verifyOtp: async args => { calls.push({ name: 'verifyOtp', args }); return verify; },
        } };
        const result = await verifyEmailChallenge({ admin, emailAuth, userId: 'user-1', sessionId,
            challengeId: 'challenge-1', code: '123456', remember: true, deviceHash: '\\xhash' });
        return { result, calls };
    }

    const success = await challengeCase();
    assert.deepEqual(success.result, { status: 200, body: { verified: true, remembered: true } });
    assert.equal(success.calls.find(c => c.name === 'email_mfa_get_challenge').args.p_session_id, 'session-1', 'challenge lookup is bound to original session');
    assert(success.calls.findIndex(c => c.name === 'adminSignOut') < success.calls.findIndex(c => c.name === 'email_mfa_finish'),
        'the temporary email-only session is revoked before original-session proof is granted');
    assert.deepEqual(success.calls.find(c => c.name === 'adminSignOut').args, ['temp-token', 'local'],
        'revocation uses the verifyOtp access token and local scope');
    assert.equal(success.calls.some(c => c.name === 'signOut'), false, 'the temporary client session is not used for revocation');

    const wrongCode = await challengeCase({ verify: { data: { user: null, session: null }, error: new Error('invalid OTP') } });
    assert.equal(wrongCode.result.status, 400);
    assert.equal(wrongCode.calls.some(c => c.name === 'email_mfa_finish'), false, 'wrong code never grants proof');

    const wrongUser = await challengeCase({ verify: { data: { user: { id: 'other-user' }, session: { access_token: 'temp-token' } }, error: null } });
    assert.equal(wrongUser.result.status, 400);
    assert.deepEqual(wrongUser.calls.find(c => c.name === 'adminSignOut').args, ['temp-token', 'local'], 'wrong-user OTP session is revoked by its returned token');
    assert.equal(wrongUser.calls.some(c => c.name === 'email_mfa_finish'), false, 'wrong-user OTP cannot prove the original session');

    const wrongUserRevokeFailure = await challengeCase({
        verify: { data: { user: { id: 'other-user' }, session: { access_token: 'temp-token' } }, error: null },
        revokeError: new Error('revocation failed'),
    });
    assert.equal(wrongUserRevokeFailure.result.status, 503, 'failed wrong-user session revocation fails closed');
    assert.equal(wrongUserRevokeFailure.calls.some(c => c.name === 'email_mfa_finish'), false, 'failed wrong-user revocation never grants proof');

    const expired = await challengeCase({ challenge: false });
    assert.equal(expired.result.status, 400);
    assert.equal(expired.calls.some(c => c.name === 'verifyOtp'), false, 'expired/replayed challenge does not reach Auth verification');

    const wrongSession = await challengeCase({ sessionId: 'other-session' });
    assert.equal(wrongSession.result.status, 400);
    assert.equal(wrongSession.calls.some(c => c.name === 'verifyOtp'), false, 'a code from another Auth session cannot be replayed');

    const attemptsExceeded = await challengeCase({ attempts: false });
    assert.equal(attemptsExceeded.result.status, 400);
    assert.equal(attemptsExceeded.calls.some(c => c.name === 'verifyOtp'), false, 'attempt-limit rejection happens before OTP verification');

    const revokeFailure = await challengeCase({ revokeError: new Error('revocation failed') });
    assert.equal(revokeFailure.result.status, 503);
    assert.equal(revokeFailure.calls.some(c => c.name === 'email_mfa_finish'), false, 'failed temporary-session revocation fails closed');

    const replayAtFinish = await challengeCase({ finish: false });
    assert.equal(replayAtFinish.result.status, 400, 'a challenge consumed or expired during verification cannot be replayed');
    assert(replayAtFinish.calls.findIndex(c => c.name === 'adminSignOut') < replayAtFinish.calls.findIndex(c => c.name === 'email_mfa_finish'));
    console.log('PASS email MFA client contract, server proof coverage, inactivity/revocation guardrails, and OTP-session revocation ordering');
})().catch(error => { console.error(error); process.exitCode = 1; });
