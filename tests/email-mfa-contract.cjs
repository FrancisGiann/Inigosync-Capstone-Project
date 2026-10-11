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
    assert.equal(uncheckedBegin.device_secret, rememberedSecret, 'unchecked login sends an existing secret only for server revocation');
    assert.equal(values.has('inigosync-email-mfa-device:v1:user-1'), false, 'unchecked login clears local remembered-device state');

    await mfa.verify({ userId: 'user-1', challengeId: 'challenge-1', code: '123456', remember: false });
    assert.equal(calls.at(-1).body.device_secret, null, 'unchecked verification cannot create or persist a trusted-device secret');

    const migration = fs.readFileSync('supabase/migrations/20261012090000_email_session_verification.sql', 'utf8');
    assert.match(migration, /alter role authenticator set pgrst\.db_pre_request/);
    assert.match(migration, /last_activity_at > now\(\) - interval '7 days'/);
    assert.match(migration, /profiles_email_mfa_select[\s\S]*id = auth\.uid\(\) or internal\.has_verified_email_session\(\)/);
    assert.match(migration, /email_mfa_required_storage_insert/);
    assert.doesNotMatch(migration, /my_booking_reviews', 'sport/);
    assert.match(migration, /not an AAL2 claim/i);

    const emailEdge = fs.readFileSync('supabase/functions/email-mfa/index.ts', 'utf8');
    assert.match(emailEdge, /verifyEmailChallenge/);
    for (const path of [
        'invite-staff', 'payment-health', 'paymongo-balance-checkout',
        'paymongo-checkout', 'staff-walkin-checkout', 'validate-contact-phone',
    ]) {
        assert.match(fs.readFileSync(`supabase/functions/${path}/index.ts`, 'utf8'), /hasVerifiedEmailSession/,
            `${path} requires server-validated email proof`);
    }

    const { verifyEmailChallenge } = await import('../supabase/functions/_shared/email-mfa-core.mjs');
    async function challengeCase({ challenge = true, attempts = true, sessionId = 'session-1', verify = { data: { user: { id: 'user-1' }, session: { access_token: 'temp-token' } }, error: null }, revokeError = null, finish = true } = {}) {
        const calls = [];
        const admin = { rpc: async (name, args) => {
            calls.push({ name, args });
            if (name === 'email_mfa_get_challenge') return { data: challenge && args.p_session_id === 'session-1' ? [{ email: 'user@example.test' }] : [], error: null };
            if (name === 'email_mfa_record_attempt') return { data: attempts, error: null };
            if (name === 'email_mfa_finish') return { data: finish, error: null };
            throw new Error(`unexpected RPC ${name}`);
        } };
        const emailAuth = { auth: {
            verifyOtp: async args => { calls.push({ name: 'verifyOtp', args }); return verify; },
            signOut: async args => { calls.push({ name: 'signOut', args }); return { error: revokeError }; },
        } };
        const result = await verifyEmailChallenge({ admin, emailAuth, userId: 'user-1', sessionId,
            challengeId: 'challenge-1', code: '123456', remember: true, deviceHash: '\\xhash' });
        return { result, calls };
    }

    const success = await challengeCase();
    assert.deepEqual(success.result, { status: 200, body: { verified: true, remembered: true } });
    assert.equal(success.calls.find(c => c.name === 'email_mfa_get_challenge').args.p_session_id, 'session-1', 'challenge lookup is bound to original session');
    assert(success.calls.findIndex(c => c.name === 'signOut') < success.calls.findIndex(c => c.name === 'email_mfa_finish'),
        'the temporary email-only session is revoked before original-session proof is granted');

    const wrongCode = await challengeCase({ verify: { data: { user: null, session: null }, error: new Error('invalid OTP') } });
    assert.equal(wrongCode.result.status, 400);
    assert.equal(wrongCode.calls.some(c => c.name === 'email_mfa_finish'), false, 'wrong code never grants proof');

    const wrongUser = await challengeCase({ verify: { data: { user: { id: 'other-user' }, session: { access_token: 'temp-token' } }, error: null } });
    assert.equal(wrongUser.result.status, 400);
    assert(wrongUser.calls.some(c => c.name === 'signOut'), 'wrong-user OTP session is revoked');
    assert.equal(wrongUser.calls.some(c => c.name === 'email_mfa_finish'), false, 'wrong-user OTP cannot prove the original session');

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
    assert(replayAtFinish.calls.findIndex(c => c.name === 'signOut') < replayAtFinish.calls.findIndex(c => c.name === 'email_mfa_finish'));
    console.log('PASS email MFA client contract, server proof coverage, inactivity/revocation guardrails, and OTP-session revocation ordering');
})().catch(error => { console.error(error); process.exitCode = 1; });
