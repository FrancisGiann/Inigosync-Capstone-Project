// No real users, credentials, emails or SMS: provider responses are deterministic fixtures.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function mockClient(options) {
    const user = { id: options.userId || 'fixture-user', identities: [{ provider: 'email' }], app_metadata: { provider: options.provider || 'email' } };
    let authUserEmail = 'customer@example.test';
    let currentEmailChangeOtp = '111111';
    let newEmailChangeOtp = '222222';
    let session = options.oauth || options.dashboard ? { user } : null;
    const record = (kind, data) => {
        const calls = JSON.parse(sessionStorage.getItem('fixture-calls') || '[]');
        calls.push({ kind, data }); sessionStorage.setItem('fixture-calls', JSON.stringify(calls));
    };
    if (options.oauth || options.oauthReturn) sessionStorage.setItem('inigosync-oauth-pending', '1');
    const trustedKey = (role, userId = user.id) => `inigosync-trusted-device:${role}:${userId}`;
    window.InigoAuthStorage = {
        setRememberSession(remember) {
            record('rememberSessionChoice', { remember });
            if (remember) sessionStorage.removeItem('inigosync-session-only');
            else sessionStorage.setItem('inigosync-session-only', '1');
        },
        isRememberSession: () => sessionStorage.getItem('inigosync-session-only') !== '1',
        isDeviceTrusted(userId, role, now = Date.now()) {
            try {
                const key = trustedKey(role, userId);
                const record = JSON.parse(localStorage.getItem(key) || 'null');
                if (!record || record.version !== 1 || !Number.isFinite(record.lastActivityAt)
                    || now >= record.lastActivityAt + 7 * 24 * 60 * 60 * 1000) {
                    localStorage.removeItem(key);
                    return false;
                }
                return true;
            } catch (_) { return false; }
        },
        rememberDevice(userId, role, now = Date.now()) {
            localStorage.setItem(trustedKey(role, userId), JSON.stringify({ version: 1, lastActivityAt: now }));
            return true;
        },
        clearDeviceTrust(userId) {
            for (const role of ['customer', 'staff', 'admin']) localStorage.removeItem(trustedKey(role, userId));
            localStorage.removeItem(`inigosync-trusted-device:${userId}`);
        },
        touchDeviceTrust(userId, role, now = Date.now()) {
            return this.isDeviceTrusted(userId, role, now) && this.rememberDevice(userId, role, now);
        }
    };
    window.sb = {
        rpc: (name, data) => {
            if (name === 'record_account_session_event') {
                record('accountSessionEvent', data);
                return Promise.resolve({ data: true, error: null });
            }
            if (name === 'save_customer_personal_details') {
                record('personalSave', data);
                return Promise.resolve({ data: null, error: null });
            }
            const checkEmail = async () => {
                record('emailCheck', data);
                if (data.email_address === 'slow@example.test') await new Promise(resolve => setTimeout(resolve, 900));
                if (options.emailMode === 'error') return { error: { message: 'Network error' } };
                return { data: options.emailMode === 'rate_limited' ? 'rate_limited' : ['taken@example.test', 'slow@example.test'].includes(data.email_address) ? 'taken' : 'available' };
            };
            return { abortSignal: checkEmail, then(resolve, reject) { return checkEmail().then(resolve, reject); } };
        },
        auth: {
            getSession: async () => {
                if (options.sessionReadError) {
                    window.InigoLoading?.show('Restoring session…');
                    throw new Error(options.sessionReadError);
                }
                return { data: { session } };
            },
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            signOut: async () => { record('signOut'); session = null; return {}; },
            signInWithPassword: async () => {
                record('passwordSessionCreated');
                if (options.passwordError) return { data: {}, error: { code: 'invalid_credentials', message: 'Invalid login credentials' } };
                session = { user }; return { data: { user, session } };
            },
            signInWithOtp: async data => { record('emailOtp', data); return {}; },
            signUp: async data => {
                record('signUp', data);
                if (options.registrationRace === 'error') return { data: {}, error: { code: 'user_already_exists', message: 'Already registered' } };
                if (options.registrationRace === 'identities') return { data: { user: { ...user, identities: [] }, session: null } };
                session = options.emailConfirmation ? null : { user }; return { data: { user, session } };
            },
            updateUser: async data => {
                record('updateUser', data);
                if (data.email) user.pendingEmailChange = data.email;
                return {};
            },
            verifyOtp: async data => {
                record('verifyOtp', data);
                if (data.type === 'signup') { session = { user }; return {}; }
                if (data.type === 'email_change') {
                    if (data.email === 'customer@example.test' && data.token === currentEmailChangeOtp) {
                        if (options.delayEmailChangeToken === data.token) await new Promise(resolve => setTimeout(resolve, 200));
                        return {};
                    }
                    if (data.email === 'new-customer@example.test' && data.token === newEmailChangeOtp && user.pendingEmailChange === data.email) {
                        authUserEmail = data.email;
                        delete user.pendingEmailChange;
                        return {};
                    }
                    return { error: { message: 'Email change token expired' } };
                }
                if (data.token !== '123456') return { error: { message: 'Token expired' } };
                session = { user };
                return { data: { user, session } };
            },
            resend: async data => {
                record('resend', data);
                if (data.type === 'email_change') {
                    currentEmailChangeOtp = '333333';
                    newEmailChangeOtp = '444444';
                }
                return {};
            },
            getUser: async () => { record('getUser'); return { data: { user: { ...user, email: authUserEmail } } }; },
            signInWithOAuth: async data => { record('oauth', data); return { error: { message: 'Fixture stopped redirect' } }; }
        },
        functions: {
            invoke: async (name, args) => {
                record('function', { name, body: args?.body });
                if (name === 'email-mfa') {
                    const action = args?.body?.action;
                    if (action === 'begin') {
                        const trusted = options.trustedDeviceUserId === user.id && args.body.remember === true;
                        return { data: trusted ? { verified: true, remembered: true }
                            : { verified: false, challenge_id: 'challenge-fixture', resent: true }, error: null };
                    }
                    if (action === 'verify') {
                        record('emailMfaVerify', args.body);
                        return args.body.code === '123456'
                            ? { data: { verified: true, remembered: args.body.remember === true }, error: null }
                            : { data: null, error: { message: 'That code did not match or has expired.' } };
                    }
                    if (action === 'check') return { data: { verified: true }, error: null };
                    if (action === 'revoke') return { data: { verified: true }, error: null };
                    return { data: null, error: { message: 'Invalid email verification request.' } };
                }
                if (name !== 'validate-contact-phone') return { data: {}, error: null };
                if (options.validationError) {
                    const message = options.validationError === true ? 'Phone validation is unavailable.' : options.validationError;
                    return { data: null, error: { message, context: new Response(JSON.stringify({ message }), { status: options.validationStatus || 503, headers: { 'content-type': 'application/json' } }) } };
                }
                if (options.validationReason) return { data: { valid: false, reason: options.validationReason }, error: null };
                return { data: { valid: true, normalized: options.validationNormalized || '+639171234567', phone_type: options.phoneType || 'mobile' }, error: null };
            }
        },
        from: table => {
            let write = false;
            const query = {
                select() { return query; }, eq() { return query; }, order() { return query; }, limit() { return query; },
                in() { return query; }, gte() { return query; }, lte() { return query; }, is() { return query; }, not() { return query; }, or() { return query; },
                update(data) { record(table === 'customer_private_details' ? 'privateWrite' : 'profileWrite', data); write = true; return query; },
                upsert: async data => { record('sessionWrite', data); return {}; },
                single: async () => write ? { data: { id: user.id } } : rowData(),
                maybeSingle: async () => write ? { data: { id: user.id } } : rowData(),
                then(resolve, reject) { return Promise.resolve(write ? { data: null, error: null } : { data: [], error: null }).then(resolve, reject); }
            };
            function rowData() {
                if (table === 'customer_private_details') return { data: { user_id: user.id, birthdate: null, gender: options.gender || null, civil_status: null, emergency_contact_name: null, emergency_contact_number: null } };
                return profile();
            }
            return query;
        }
    };
    function profile() {
        return { data: { id: user.id, role: options.role || 'customer', status: options.disabled ? 'disabled' : 'active', email: 'customer@example.test', full_name: 'Fixture Customer', contact_num: options.contactNum || null, contact_num_validated: options.contactNumValidated || false, contact_num_validated_at: options.contactNumValidatedAt || null } };
    }
}
(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        async function setup(options = {}, startUrl = 'http://127.0.0.1:4178/index.html') {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
            page.setDefaultTimeout(10000);
            await page.route(/^https:\/\//, r => r.abort());
            await page.route('**/Config/supabaseClient.js', r => r.fulfill({ contentType: 'application/javascript', body: `(${mockClient})(${JSON.stringify(options)})` }));
            await page.route('**/includes/landingPage.js', r => r.fulfill({ contentType: 'application/javascript', body: '' }));
            await page.route('https://elfsightcdn.com/**', r => r.abort());
            await page.route('**/*dashboard.html', r => r.fulfill({ contentType: 'text/html', body: '<h1>Dashboard fixture</h1>' }));
            await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
            return page;
        }
        async function setupDashboard(options = {}) {
            const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
            page.setDefaultTimeout(10000);
            await page.route(/^https:\/\//, r => r.abort());
            await page.route('**/Config/supabaseClient.js', r => r.fulfill({ contentType: 'application/javascript', body: `(${mockClient})(${JSON.stringify({ dashboard: true, ...options })})` }));
            await page.goto('http://127.0.0.1:4178/Pages/user_dashboard.html', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => window.inigosyncProfile?.id === 'fixture-user');
            return page;
        }
        const calls = page => page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-calls') || '[]'));
        if (process.env.REMEMBER_DEVICE_ONLY === '1') {
            const makeStorage = () => {
                const values = new Map();
                return {
                    getItem: key => values.has(key) ? values.get(key) : null,
                    setItem: (key, value) => values.set(key, String(value)),
                    removeItem: key => values.delete(key),
                    has: key => values.has(key)
                };
            };
            const adapterLocal = makeStorage();
            const adapterSession = makeStorage();
            let productionClientOptions;
            const adapterWindow = { supabase: { createClient: (_url, _key, options) => { productionClientOptions = options; return {}; } } };
            vm.runInNewContext(fs.readFileSync('Config/supabaseClient.js', 'utf8'), {
                window: adapterWindow, localStorage: adapterLocal, sessionStorage: adapterSession, URL, Date, console
            });
            const adapter = adapterWindow.InigoAuthStorage;
            const authStorageKey = 'sb-xrlwtnwamboucihsamrr-auth-token';
            const supabaseStorage = productionClientOptions.auth.storage;
            adapterLocal.setItem(authStorageKey, 'existing-persistent-session');
            adapter.setRememberSession(false);
            assert.equal(adapterLocal.getItem(authStorageKey), null);
            assert.equal(adapterSession.getItem(authStorageKey), 'existing-persistent-session');
            assert.equal(adapter.isRememberSession(), false);
            assert.equal(supabaseStorage.getItem(authStorageKey), 'existing-persistent-session');
            supabaseStorage.setItem(authStorageKey, 'session-only-refresh');
            assert.equal(adapterSession.getItem(authStorageKey), 'session-only-refresh');
            assert.equal(adapterLocal.getItem(authStorageKey), null);
            adapter.setRememberSession(true);
            assert.equal(adapterSession.getItem(authStorageKey), null);
            assert.equal(adapterLocal.getItem(authStorageKey), 'session-only-refresh');
            assert.equal(adapter.isRememberSession(), true);
            supabaseStorage.removeItem(authStorageKey);
            assert.equal(adapterLocal.getItem(authStorageKey), null);
            assert.equal(adapterSession.getItem(authStorageKey), null);

            assert.equal(adapter.isDeviceTrusted, undefined, 'browser-side trust markers cannot authorize a session');
            assert.equal(adapter.rememberDevice, undefined, 'device trust is stored and checked by the server');
            assert.equal(adapter.touchDeviceTrust, undefined, 'browser activity cannot extend server-side trust');

            const page = await setup({ role: 'customer' });
            await page.locator('.cta-buttons [data-auth-open]').click();
            const login = page.locator('[data-auth-panel="login"]');
            await login.locator('[name="email"]').fill('account@example.test');
            await login.locator('[name="password"]').fill('Fixture2026!');
            await login.locator('[name="remember"]').check();
            await login.locator('button[type="submit"]').click();
            await page.locator('[data-auth-panel="verify"].is-active').waitFor();
            const pendingCalls = await calls(page);
            assert(pendingCalls.some(c => c.kind === 'function' && c.data?.name === 'email-mfa' && c.data?.body?.action === 'begin'));
            assert.equal(pendingCalls.some(c => c.kind === 'signOut'), false, 'password session stays bound to its server-side email challenge');
            assert.equal(Boolean(await page.evaluate(async () => (await sb.auth.getSession()).data.session)), true);
            for (let i = 0; i < 6; i++) await page.locator('[data-otp-box]').nth(i).fill('123456'[i]);
            await page.locator('[data-auth-panel="verify"] button[type="submit"]').click();
            await page.waitForURL('**/user_dashboard.html');
            assert.match(await page.evaluate(() => localStorage.getItem('inigosync-email-mfa-device:v1:fixture-user')), /^[a-f0-9]{64}$/);
            await page.close();

            const trustedPage = await setup({ role: 'customer', trustedDeviceUserId: 'fixture-user' });
            await trustedPage.evaluate(() => localStorage.setItem('inigosync-email-mfa-device:v1:fixture-user', 'a'.repeat(64)));
            await trustedPage.locator('.cta-buttons [data-auth-open]').click();
            const trustedForm = trustedPage.locator('[data-auth-panel="login"]');
            await trustedForm.locator('[name="email"]').fill('account@example.test');
            await trustedForm.locator('[name="password"]').fill('Fixture2026!');
            await trustedForm.locator('[name="remember"]').check();
            await trustedForm.locator('button[type="submit"]').click();
            await trustedPage.waitForURL('**/user_dashboard.html');
            assert(!(await calls(trustedPage)).some(c => c.kind === 'emailMfaVerify'), 'server-validated trust can skip the code');
            await trustedPage.close();

            for (const remember of [true, false]) {
                const oauthPage = await browser.newPage();
                oauthPage.setDefaultTimeout(10000);
                await oauthPage.route(/^https:\/\//, r => r.abort());
                await oauthPage.route('**/Config/supabaseClient.js', r => r.fulfill({ contentType: 'application/javascript', body: `(${mockClient})(${JSON.stringify({ oauth: true, role: 'customer' })})` }));
                await oauthPage.route('**/*dashboard.html', r => r.fulfill({ contentType: 'text/html', body: '<h1>Dashboard fixture</h1>' }));
                await oauthPage.addInitScript(value => sessionStorage.setItem('inigosync-oauth-remember', value ? '1' : '0'), remember);
                await oauthPage.goto('http://127.0.0.1:4178/index.html', { waitUntil: 'domcontentloaded' });
                await oauthPage.locator('[data-auth-panel="verify"].is-active').waitFor();
                for (let i = 0; i < 6; i++) await oauthPage.locator('[data-otp-box]').nth(i).fill('123456'[i]);
                await oauthPage.locator('[data-auth-panel="verify"] button[type="submit"]').click();
                await oauthPage.waitForURL('**/user_dashboard.html');
                assert.equal(Boolean(await oauthPage.evaluate(() => localStorage.getItem('inigosync-email-mfa-device:v1:fixture-user'))), remember);
                assert.equal(await oauthPage.evaluate(() => sessionStorage.getItem('inigosync-session-only')), remember ? null : '1');
                assert((await calls(oauthPage)).some(c => c.kind === 'rememberSessionChoice' && c.data.remember === remember));
                await oauthPage.close();
            }

            const uncheckedPage = await setup({ role: 'customer' });
            await uncheckedPage.evaluate(() => localStorage.setItem('inigosync-email-mfa-device:v1:fixture-user', 'b'.repeat(64)));
            await uncheckedPage.locator('.cta-buttons [data-auth-open]').click();
            const uncheckedForm = uncheckedPage.locator('[data-auth-panel="login"]');
            await uncheckedForm.locator('[name="email"]').fill('account@example.test');
            await uncheckedForm.locator('[name="password"]').fill('Fixture2026!');
            await uncheckedForm.locator('button[type="submit"]').click();
            await uncheckedPage.locator('[data-auth-panel="verify"].is-active').waitFor();
            assert((await calls(uncheckedPage)).some(c => c.kind === 'function' && c.data?.name === 'email-mfa' && c.data?.body?.action === 'begin' && c.data?.body?.remember === false));
            assert.equal(await uncheckedPage.evaluate(() => localStorage.getItem('inigosync-email-mfa-device:v1:fixture-user')), null);
            await uncheckedPage.locator('[data-auth-close]').click();
            await uncheckedPage.waitForFunction(() => document.querySelector('[data-auth-overlay]').hidden);
            assert.equal(await uncheckedPage.evaluate(async () => (await sb.auth.getSession()).data.session), null);
            await uncheckedPage.close();

            const failedPassword = await setup({ role: 'customer', passwordError: true });
            await failedPassword.evaluate(() => localStorage.setItem('sb-xrlwtnwamboucihsamrr-auth-token', 'existing-persistent-session'));
            await failedPassword.locator('.cta-buttons [data-auth-open]').click();
            const failedPasswordForm = failedPassword.locator('[data-auth-panel="login"]');
            await failedPasswordForm.locator('[name="email"]').fill('account@example.test');
            await failedPasswordForm.locator('[name="password"]').fill('wrong-password');
            await failedPasswordForm.locator('button[type="submit"]').click();
            await failedPassword.waitForFunction(() => JSON.parse(sessionStorage.getItem('fixture-calls') || '[]').some(c => c.kind === 'passwordSessionCreated'));
            await failedPassword.waitForTimeout(50);
            assert(!(await calls(failedPassword)).some(c => c.kind === 'rememberSessionChoice'));
            assert.equal(await failedPassword.evaluate(() => localStorage.getItem('sb-xrlwtnwamboucihsamrr-auth-token')), 'existing-persistent-session');
            assert.equal(await failedPassword.evaluate(() => sessionStorage.getItem('inigosync-session-only')), null);
            await failedPassword.close();

            const failedSignup = await setup({ registrationRace: 'error' });
            await signup(failedSignup, '', true);
            await failedSignup.waitForFunction(() => JSON.parse(sessionStorage.getItem('fixture-calls') || '[]').some(c => c.kind === 'signUp'));
            await failedSignup.waitForTimeout(50);
            assert(!(await calls(failedSignup)).some(c => c.kind === 'rememberSessionChoice'));
            assert.equal(await failedSignup.evaluate(() => sessionStorage.getItem('inigosync-session-only')), null);
            await failedSignup.close();

            const crossAccountPage = await setup({ role: 'customer', userId: 'different-user' });
            await crossAccountPage.evaluate(() => localStorage.setItem('inigosync-email-mfa-device:v1:different-user', 'c'.repeat(64)));
            await crossAccountPage.locator('.cta-buttons [data-auth-open]').click();
            const crossAccountForm = crossAccountPage.locator('[data-auth-panel="login"]');
            await crossAccountForm.locator('[name="email"]').fill('account@example.test');
            await crossAccountForm.locator('[name="password"]').fill('Fixture2026!');
            await crossAccountForm.locator('[name="remember"]').check();
            await crossAccountForm.locator('button[type="submit"]').click();
            await crossAccountPage.locator('[data-auth-panel="verify"].is-active').waitFor();
            assert((await calls(crossAccountPage)).some(c => c.kind === 'function' && c.data?.name === 'email-mfa' && c.data?.body?.action === 'begin'));
            await crossAccountPage.close();

            for (const role of ['staff', 'admin']) {
                const rolePage = await setup({ role });
                await rolePage.locator('.cta-buttons [data-auth-open]').click();
                await rolePage.locator('[data-auth-tab="admin"]').click();
                const roleForm = rolePage.locator('[data-auth-panel="admin"]');
                await roleForm.locator('[name="admin-email"]').fill('account@example.test');
                await roleForm.locator('[name="admin-password"]').fill('Fixture2026!');
                await roleForm.locator('[name="remember"]').check();
                await roleForm.locator('button[type="submit"]').click();
                await rolePage.locator('[data-auth-panel="verify"].is-active').waitFor();
                for (let i = 0; i < 6; i++) await rolePage.locator('[data-otp-box]').nth(i).fill('123456'[i]);
                await rolePage.locator('[data-auth-panel="verify"] button[type="submit"]').click();
                await rolePage.waitForURL(role === 'staff' ? '**/staff_dashboard.html' : '**/owner_dashboard.html');
                assert.match(await rolePage.evaluate(() => localStorage.getItem('inigosync-email-mfa-device:v1:fixture-user')), /^[a-f0-9]{64}$/);
                await rolePage.close();
            }

            const expiry = await setup();
            const boundary = await expiry.evaluate(() => {
                const key = 'inigosync-trusted-device:customer:fixture-user';
                const now = 2_000_000_000_000;
                localStorage.setItem(key, JSON.stringify({ version: 1, lastActivityAt: now - 7 * 86400000 + 1 }));
                const before = InigoAuthStorage.isDeviceTrusted('fixture-user', 'customer', now);
                localStorage.setItem(key, JSON.stringify({ version: 1, lastActivityAt: now - 7 * 86400000 }));
                const at = InigoAuthStorage.isDeviceTrusted('fixture-user', 'customer', now);
                localStorage.setItem('inigosync-trusted-device:fixture-user', '1');
                const old = InigoAuthStorage.isDeviceTrusted('fixture-user', 'customer', now);
                return { before, at, old };
            });
            assert.deepEqual(boundary, { before: true, at: false, old: false });
            await expiry.close();

            const signupPage = await setup({ emailConfirmation: true });
            await signupPage.locator('.cta-buttons [data-auth-open]').click();
            await signupPage.locator('[role="tab"][data-auth-tab="signup"]').click();
            const signupForm = signupPage.locator('[data-auth-panel="signup"]');
            await signupForm.locator('[name="email"]').fill('customer@example.test');
            await signupForm.locator('[name="password"]').fill('Fixture2026!');
            await signupForm.locator('[name="remember"]').check();
            await signupForm.locator('[data-signup-next]').click();
            await signupForm.locator('[name="surname"]').fill('Tester');
            await signupForm.locator('[name="firstname"]').fill('Customer');
            await signupForm.locator('[name="terms"]').check();
            await signupForm.locator('button[type="submit"]').click();
            assert.equal(await signupPage.locator('[data-auth-panel="verify"] [data-verify-heading]').innerText(), 'Verify your email');
            for (let i = 0; i < 6; i++) await signupPage.locator('[data-otp-box]').nth(i).fill('123456'[i]);
            await signupPage.locator('[data-auth-panel="verify"] button[type="submit"]').click();
            await signupPage.locator('[data-auth-panel="verify"].is-active').waitFor();
            for (let i = 0; i < 6; i++) await signupPage.locator('[data-otp-box]').nth(i).fill('123456'[i]);
            await signupPage.locator('[data-auth-panel="verify"] button[type="submit"]').click();
            await signupPage.waitForURL('**/user_dashboard.html');
            assert.match(await signupPage.evaluate(() => localStorage.getItem('inigosync-email-mfa-device:v1:fixture-user')), /^[a-f0-9]{64}$/);
            await signupPage.close();

            const signupChoicePage = await setup({ emailConfirmation: true });
            await signupChoicePage.locator('.cta-buttons [data-auth-open]').click();
            await signupChoicePage.locator('[role="tab"][data-auth-tab="signup"]').click();
            const signupChoiceForm = signupChoicePage.locator('[data-auth-panel="signup"]');
            assert.equal(await signupChoiceForm.locator('[name="remember"]').count(), 1, 'signup has a single remembered-device choice across its steps and Google flow');
            await signupChoiceForm.locator('[name="email"]').fill('customer@example.test');
            await signupChoiceForm.locator('[name="password"]').fill('Fixture2026!');
            await signupChoiceForm.locator('[name="remember"]').check();
            await signupChoiceForm.locator('[name="remember"]').uncheck();
            await signupChoiceForm.locator('[data-signup-next]').click();
            await signupChoiceForm.locator('[name="surname"]').fill('Tester');
            await signupChoiceForm.locator('[name="firstname"]').fill('Customer');
            await signupChoiceForm.locator('[name="terms"]').check();
            await signupChoiceForm.locator('button[type="submit"]').click();
            for (let i = 0; i < 6; i++) await signupChoicePage.locator('[data-otp-box]').nth(i).fill('123456'[i]);
            await signupChoicePage.locator('[data-auth-panel="verify"] button[type="submit"]').click();
            await signupChoicePage.locator('[data-auth-panel="verify"].is-active').waitFor();
            for (let i = 0; i < 6; i++) await signupChoicePage.locator('[data-otp-box]').nth(i).fill('123456'[i]);
            await signupChoicePage.locator('[data-auth-panel="verify"] button[type="submit"]').click();
            await signupChoicePage.waitForURL('**/user_dashboard.html');
            assert.equal(await signupChoicePage.evaluate(() => localStorage.getItem('inigosync-email-mfa-device:v1:fixture-user')), null, 'the final unchecked signup choice does not persist trust');
            await signupChoicePage.close();

            const expiredDashboard = await browser.newPage();
            expiredDashboard.setDefaultTimeout(10000);
            await expiredDashboard.route(/^https:\/\//, r => r.abort());
            await expiredDashboard.route('**/Config/supabaseClient.js', r => r.fulfill({ contentType: 'application/javascript', body: `(${mockClient})(${JSON.stringify({ dashboard: true })})` }));
            await expiredDashboard.addInitScript(() => localStorage.setItem('inigosync-trusted-device:fixture-user', JSON.stringify({ version: 1, lastActivityAt: Date.now() - 7 * 86400000 })));
            await expiredDashboard.goto('http://127.0.0.1:4178/Pages/user_dashboard.html', { waitUntil: 'domcontentloaded' });
            await expiredDashboard.waitForFunction(() => window.inigosyncProfile?.id === 'fixture-user');
            assert.equal((await calls(expiredDashboard)).some(c => c.kind === 'signOut'), false,
                'the server proof, not a stale client marker, controls dashboard access');
            await expiredDashboard.close();

            const activeDashboard = await browser.newPage();
            activeDashboard.setDefaultTimeout(10000);
            await activeDashboard.route(/^https:\/\//, r => r.abort());
            await activeDashboard.route('**/Config/supabaseClient.js', r => r.fulfill({ contentType: 'application/javascript', body: `(${mockClient})(${JSON.stringify({ dashboard: true })})` }));
            await activeDashboard.addInitScript(() => localStorage.setItem('inigosync-trusted-device:customer:fixture-user', JSON.stringify({ version: 1, lastActivityAt: Date.now() - 1000 })));
            await activeDashboard.goto('http://127.0.0.1:4178/Pages/user_dashboard.html', { waitUntil: 'domcontentloaded' });
            await activeDashboard.waitForFunction(() => window.inigosyncProfile?.id === 'fixture-user');
            assert((await calls(activeDashboard)).some(c => c.kind === 'function' && c.data?.name === 'email-mfa' && c.data?.body?.action === 'check'),
                'dashboard entry checks server-side email proof before exposing the profile');
            await activeDashboard.close();
            console.log('PASS server-bound email session gate, trusted-device expiry contract, dashboard proof check, and signup confirmation plus second-step flow');
            return;
        }
        if (process.env.EMAIL_CHANGE_ONLY === '1') {
            const dashboard = await setupDashboard({ delayEmailChangeToken: '111111' });
            await dashboard.locator('[data-dash-nav="settings"]').first().click();
            await dashboard.locator('[data-dash-personal-edit]').click();
            await dashboard.locator('[data-dash-email-edit]').click();
            await dashboard.locator('[data-dash-email-proposal-input]').fill('new-customer@example.test');
            await dashboard.waitForFunction(() => document.querySelector('[data-dash-email-proposal-status]').textContent === 'Available');
            await dashboard.locator('[data-dash-email-proposal-save]').click();
            await dashboard.locator('[data-dash-personal-save]').click();
            await dashboard.locator('[data-dash-confirm-modal]').waitFor({ state: 'visible' });
            await dashboard.locator('[data-dash-confirm-accept]').click();
            await dashboard.waitForFunction(() => JSON.parse(sessionStorage.getItem('fixture-calls') || '[]').some(c => c.kind === 'updateUser'));
            assert.equal(await dashboard.locator('[data-dash-settings-email]').inputValue(), 'customer@example.test', 'new email is not displayed as saved after it is requested');

            const fillCode = async code => {
                for (let i = 0; i < code.length; i++) await dashboard.locator('[data-dash-email-otp-box]').nth(i).fill(code[i]);
            };
            const autofillCode = async code => dashboard.locator('[data-dash-email-otp-box]').first().evaluate((input, value) => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }, code);
            assert.equal(await dashboard.locator('[data-dash-email-otp-box]').count(), 6);
            assert.equal(await dashboard.locator('[data-dash-email-otp-title]').innerText(), 'Verify your current email');
            assert.equal(await dashboard.locator('[data-dash-email-otp-box]').first().getAttribute('maxlength'), '6', 'first box can accept native one-time-code autofill');
            await autofillCode('111111');
            assert.equal(await dashboard.locator('[data-dash-email-otp-box]').evaluateAll(boxes => boxes.map(box => box.value).join('')), '111111', 'multi-digit one-time-code autofill distributes digits across boxes');
            await dashboard.locator('[data-dash-email-otp-box]').nth(5).fill('0');
            await dashboard.locator('[data-dash-email-otp-verify]').click();
            await dashboard.locator('[data-dash-confirm-modal]').waitFor({ state: 'visible' });
            await dashboard.locator('[data-dash-confirm-accept]').click();
            await dashboard.waitForFunction(() => document.querySelector('[data-dash-email-otp-status]').textContent.includes('Email change token expired'));
            assert.equal(await dashboard.locator('[data-dash-email-otp-title]').innerText(), 'Verify your current email', 'an invalid code does not advance the verification step');
            assert.equal(await dashboard.locator('[data-dash-settings-email]').inputValue(), 'customer@example.test', 'an invalid code leaves the saved email unchanged');
            await autofillCode('111111');
            await dashboard.locator('[data-dash-email-otp-verify]').click();
            await dashboard.locator('[data-dash-confirm-modal]').waitFor({ state: 'visible' });
            await dashboard.locator('[data-dash-confirm-accept]').click();
            const resendButton = dashboard.locator('[data-dash-email-otp-resend]');
            assert.equal(await resendButton.isDisabled(), true, 'resend is disabled while OTP verification is in flight');
            await resendButton.evaluate(button => button.dispatchEvent(new Event('click', { bubbles: true })));
            assert.equal((await calls(dashboard)).filter(c => c.kind === 'resend').length, 0, 'a synthetic click cannot resend while verification is in flight');
            await resendButton.evaluate(button => {
                button.disabled = false;
                button.dispatchEvent(new Event('click', { bubbles: true }));
            });
            await dashboard.waitForFunction(() => JSON.parse(sessionStorage.getItem('fixture-calls') || '[]').some(c => c.kind === 'resend'));
            await dashboard.waitForFunction(() => document.querySelector('[data-dash-email-otp-title]').textContent === 'Verify your current email');
            assert.equal(await dashboard.locator('[data-dash-settings-email]').inputValue(), 'customer@example.test', 'late verification cannot advance the UI after a concurrent resend resets codes');
            const resendCall = (await calls(dashboard)).find(c => c.kind === 'resend');
            assert.deepEqual(resendCall.data, { type: 'email_change', email: 'new-customer@example.test' });
            await fillCode('333333');
            await dashboard.locator('[data-dash-email-otp-verify]').click();
            await dashboard.locator('[data-dash-confirm-modal]').waitFor({ state: 'visible' });
            await dashboard.locator('[data-dash-confirm-accept]').click();
            await dashboard.waitForFunction(() => document.querySelector('[data-dash-email-otp-title]').textContent === 'Verify your new email');
            assert.equal(await dashboard.locator('[data-dash-settings-email]').inputValue(), 'customer@example.test', 'confirming the current address leaves the saved email unchanged');

            await fillCode('444444');
            await dashboard.locator('[data-dash-email-otp-verify]').click();
            await dashboard.locator('[data-dash-confirm-modal]').waitFor({ state: 'visible' });
            await dashboard.locator('[data-dash-confirm-accept]').click();
            await dashboard.waitForFunction(() => document.querySelector('[data-dash-settings-email]').value === 'new-customer@example.test');
            const verifications = (await calls(dashboard)).filter(c => c.kind === 'verifyOtp');
            assert.deepEqual(verifications.map(c => c.data), [
                { email: 'customer@example.test', token: '111110', type: 'email_change' },
                { email: 'customer@example.test', token: '111111', type: 'email_change' },
                { email: 'customer@example.test', token: '333333', type: 'email_change' },
                { email: 'new-customer@example.test', token: '444444', type: 'email_change' },
            ]);
            assert((await calls(dashboard)).some(c => c.kind === 'getUser'), 'Auth user email is checked before profile email updates');
            await dashboard.close();
            console.log('PASS secure customer email change: current and new OTPs are verified in sequence, and profile email changes only after Supabase confirms the new address');
            return;
        }
        const oauthRedirect = await setup();
        await oauthRedirect.evaluate(() => history.replaceState(null, '', '/index.html?fixture=auth-query##access_token=fixture-fragment#access_token=fixture-fragment-two&refresh_token=fixture-refresh'));
        await oauthRedirect.locator('.cta-buttons [data-auth-open]').click();
        await oauthRedirect.locator('#google-signin-login button').click();
        const oauthRequest = (await calls(oauthRedirect)).find(call => call.kind === 'oauth');
        assert.equal(oauthRequest.data.options.redirectTo, 'http://127.0.0.1:4178/index.html', 'Google OAuth return URL excludes existing query and auth fragment');
        assert.deepEqual(oauthRequest.data.options.queryParams, { prompt: 'select_account' });
        await oauthRedirect.close();
        async function firstStep(page, email) {
            await page.locator('.cta-buttons [data-auth-open]').click();
            await page.locator('[role="tab"][data-auth-tab="signup"]').click();
            const form = page.locator('[data-auth-panel="signup"]');
            await form.locator('[name="email"]').fill(email);
            await form.locator('[name="password"]').fill('Fixture2026!');
            return form;
        }
        for (const width of [320, 390, 768, 1440]) {
            for (const theme of ['light', 'dark']) {
                const page = await setup();
                await page.setViewportSize({ width, height: 900 });
                await page.addStyleTag({ content: '.auth-modal, .auth-modal * { animation: none !important; transition: none !important; }' });
                await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
                const form = await firstStep(page, '');
                const height = await form.evaluate(el => el.getBoundingClientRect().height);
                const borders = [];
                for (const [email, label] of [['taken@example.test', 'Not available'], ['new@example.test', 'Available']]) {
                    await form.locator('[name="email"]').fill(email);
                    await page.waitForFunction(label => document.querySelector('[data-signup-email-status]').textContent === label, label);
                    assert.equal(await form.evaluate(el => el.getBoundingClientRect().height), height, `${width}px ${theme}: email status must not resize form`);
                    borders.push(await form.locator('[name="email"]').evaluate(el => getComputedStyle(el).borderColor));
                    assert(await form.evaluate(el => el.scrollWidth <= el.clientWidth));
                }
                assert.notEqual(borders[0], borders[1]);
                await page.close();
            }
        }
        for (const width of [320, 390]) {
            for (const theme of ['light', 'dark']) {
                const page = await setup({ oauth: true, role: 'admin' });
                await page.setViewportSize({ width, height: 844 });
                await page.evaluate(themeName => document.documentElement.dataset.theme = themeName, theme);
                const notice = page.locator('[data-auth-notice]');
                await notice.waitFor({ state: 'visible' });
                await page.waitForTimeout(300);
                const geometry = await notice.evaluate(el => {
                    const box = el.getBoundingClientRect();
                    const close = el.querySelector('[data-auth-notice-close]').getBoundingClientRect();
                    return { left: box.left, right: box.right, closeWidth: close.width, closeHeight: close.height, background: getComputedStyle(el).backgroundColor };
                });
                assert(geometry.left >= 0 && geometry.right <= width, `${width}px ${theme}: auth message stays within viewport`);
                assert.equal(geometry.closeWidth, 44, `${width}px ${theme}: close button has a 44px target`);
                assert.equal(geometry.closeHeight, 44, `${width}px ${theme}: close button has a 44px target`);
                assert.notEqual(geometry.background, 'rgba(0, 0, 0, 0)', `${width}px ${theme}: message has a theme surface`);
                await notice.locator('[data-auth-notice-close]').focus();
                await page.keyboard.press('Enter');
                await page.waitForFunction(() => document.querySelector('[data-auth-notice]').hidden);
                assert.equal(await page.locator('[data-auth-overlay]').isVisible(), true, 'closing the message leaves the auth dialog open');
                assert.equal(await page.locator('[data-auth-panel="login"] [name="email"]').evaluate(el => document.activeElement === el), true, 'keyboard dismissal restores the prior form focus');
                await page.close();
            }
        }
        const taken = await setup();
        const takenForm = await firstStep(taken, 'Taken@Example.test');
        await taken.waitForFunction(() => document.querySelector('[data-signup-email-status]').textContent.includes('Not available'));
        await taken.screenshot({ path: require('node:path').join(require('node:os').tmpdir(), 'inigosync-email-taken.png') });
        await takenForm.locator('[data-signup-next]').click();
        assert(await takenForm.locator('[data-signup-step="1"]').evaluate(el => el.classList.contains('is-active')));
        assert.match(await taken.locator('[data-auth-notice]').innerText(), /already registered/);
        assert(!(await calls(taken)).some(c => c.kind === 'signUp'));
        await takenForm.locator('[name="email"]').fill('new@example.test');
        await takenForm.locator('[data-signup-next]').click();
        await takenForm.locator('[data-signup-step="2"].is-active').waitFor();
        await taken.close();
        for (const emailMode of ['error', 'rate_limited']) {
            const page = await setup({ emailMode });
            const form = await firstStep(page, 'new@example.test');
            await form.locator('[data-signup-next]').click();
            await page.waitForFunction(() => /Try again|Wait 1 min/.test(document.querySelector('[data-signup-email-status]').textContent));
            await page.locator('[data-auth-notice]').waitFor({ state: 'visible' });
            assert.match(await page.locator('[data-auth-notice]').innerText(), emailMode === 'error' ? /could not check that email/i : /Too many email checks/);
            assert(await form.locator('[data-signup-step="1"]').evaluate(el => el.classList.contains('is-active')));
            await page.close();
        }
        const stale = await setup();
        const staleForm = await firstStep(stale, 'slow@example.test');
        await stale.waitForFunction(() => JSON.parse(sessionStorage.getItem('fixture-calls') || '[]').some(c => c.kind === 'emailCheck'));
        await staleForm.locator('[name="email"]').fill('new@example.test');
        await staleForm.locator('[data-signup-next]').click();
        await staleForm.locator('[data-signup-step="2"].is-active').waitFor();
        await stale.waitForTimeout(1000);
        assert(!/Not available/.test(await stale.locator('[data-signup-email-status]').innerText()));
        await stale.close();
        async function signup(page, phone = '', remember = false) {
            await page.locator('.cta-buttons [data-auth-open]').click();
            await page.locator('[role="tab"][data-auth-tab="signup"]').click();
            const form = page.locator('[data-auth-panel="signup"]');
            await form.locator('[name="email"]').fill('customer@example.test');
            await form.locator('[name="password"]').fill('Fixture2026!');
            if (remember) await form.locator('[name="remember"]').check();
            await form.locator('[data-signup-next]').click();
            await form.locator('[name="surname"]').fill('Tester');
            await form.locator('[name="firstname"]').fill('Customer');
            await form.locator('[name="mobile"]').fill(phone);
            await form.locator('[name="terms"]').check();
            await form.locator('button[type="submit"]').click();
        }
        for (const role of ['admin', 'staff']) {
            const page = await setup({ oauth: true, role });
            const notice = page.locator('[data-auth-notice]');
            await notice.waitFor({ state: 'visible' });
            assert.match(await notice.innerText(), /cannot be used for customer/);
            assert.equal(await notice.getAttribute('role'), 'alert');
            assert.equal(await notice.locator('[data-auth-notice-close]').getAttribute('aria-label'), 'Dismiss message');
            assert((await calls(page)).some(c => c.kind === 'signOut'));
            assert(!(await calls(page)).some(c => ['profileWrite', 'sessionWrite'].includes(c.kind)));
            assert(await page.evaluate(async () => !(await sb.auth.getSession()).data.session));
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => document.querySelector('[data-auth-notice]').hidden);
            assert.equal(await page.locator('[data-auth-overlay]').isVisible(), true, 'Escape dismisses the popup before closing the auth modal');
            await page.close();
        }
        const disabled = await setup({ oauth: true, disabled: true });
        await disabled.locator('[data-auth-notice]').waitFor({ state: 'visible' });
        assert.match(await disabled.locator('[data-auth-notice]').innerText(), /disabled/);
        await disabled.close();
        const customer = await setup(
            { oauth: true },
            'http://127.0.0.1:4178/index.html#access_token=fixture-access&refresh_token=fixture-refresh'
        );
        await customer.waitForURL('**/user_dashboard.html');
        const customerSessionEvents = (await calls(customer)).filter(call => call.kind === 'accountSessionEvent');
        assert.deepEqual(customerSessionEvents.map(call => call.data), [{ p_kind: 'sign_in', p_reason: 'app_login' }], 'successful authentication records sign-in through the server-derived account session RPC without a client actor ID');
        await customer.close();
        const missingOauthSession = await setup({ oauthReturn: true });
        await missingOauthSession.locator('[data-auth-notice]').waitFor({ state: 'visible' });
        assert.match(await missingOauthSession.locator('[data-auth-notice]').innerText(), /Google sign-in did not finish/);
        assert.equal(await missingOauthSession.locator('[data-auth-overlay]').isVisible(), true);
        await missingOauthSession.close();
        const rejectedOauthSession = await setup({ oauthReturn: true, sessionReadError: 'Session lookup failed.' });
        const loading = rejectedOauthSession.locator('.inigo-loading-overlay');
        await rejectedOauthSession.locator('[data-auth-notice]').waitFor({ state: 'visible' });
        assert.match(await rejectedOauthSession.locator('[data-auth-notice]').innerText(), /Session lookup failed/);
        assert.equal(await rejectedOauthSession.locator('[data-auth-overlay]').isVisible(), true);
        await rejectedOauthSession.waitForFunction(() => {
            const el = document.querySelector('.inigo-loading-overlay');
            return el?.hasAttribute('hidden') && getComputedStyle(el).opacity === '0';
        });
        assert.equal(await loading.getAttribute('hidden'), '');
        assert.equal(await loading.evaluate(el => getComputedStyle(el).opacity), '0');
        await rejectedOauthSession.close();
        for (const role of ['staff', 'admin', 'customer']) {
            const page = await setup({ role });
            await page.locator('.cta-buttons [data-auth-open]').click();
            const panel = role === 'customer' ? 'admin' : 'login';
            if (panel === 'admin') await page.locator('[data-auth-tab="admin"]').click();
            const form = page.locator(`[data-auth-panel="${panel}"]`);
            await form.locator('input[type="email"]').fill('account@example.test');
            await form.locator('input[type="password"]').fill('Fixture2026!');
            await form.locator('button[type="submit"]').click();
            await page.locator('[data-auth-notice]').waitFor({ state: 'visible' });
            assert(!(await calls(page)).some(c => ['emailOtp', 'sessionWrite'].includes(c.kind)));
            assert((await calls(page)).some(c => c.kind === 'signOut'));
            await page.close();
        }

        async function passwordLogin(page, panel = 'login', remember = false) {
            await page.locator('.cta-buttons [data-auth-open]').click();
            if (panel === 'admin') await page.locator('[data-auth-tab="admin"]').click();
            const form = page.locator(`[data-auth-panel="${panel}"]`);
            await form.locator('input[type="email"]').fill('account@example.test');
            await form.locator('input[type="password"]').fill('Fixture2026!');
            if (remember) await form.locator('[name="remember"]').check();
            await form.locator('button[type="submit"]').click();
            return form;
        }
        const rememberedLogin = await setup({ role: 'customer' });
        await passwordLogin(rememberedLogin, 'login', true);
        await rememberedLogin.locator('[data-auth-panel="verify"].is-active').waitFor();
        let rememberedCalls = await calls(rememberedLogin);
        assert(rememberedCalls.findIndex(c => c.kind === 'signOut') < rememberedCalls.findIndex(c => c.kind === 'emailOtp'), 'the password session is removed before the OTP is sent');
        assert.equal(await rememberedLogin.evaluate(async () => (await sb.auth.getSession()).data.session), null, 'an unfinished OTP gate has no authenticated Supabase session');
        for (let i = 0; i < 6; i++) await rememberedLogin.locator('[data-otp-box]').nth(i).fill(String(i + 1));
        await rememberedLogin.locator('[data-auth-panel="verify"] button[type="submit"]').click();
        await rememberedLogin.waitForURL('**/user_dashboard.html');
        assert(await rememberedLogin.evaluate(() => InigoAuthStorage.isDeviceTrusted('fixture-user', 'customer')));
        await rememberedLogin.close();

        const trustedLogin = await setup({ role: 'customer' });
        await trustedLogin.evaluate(() => InigoAuthStorage.rememberDevice('fixture-user', 'customer'));
        await passwordLogin(trustedLogin, 'login', true);
        await trustedLogin.waitForURL('**/user_dashboard.html');
        assert(!(await calls(trustedLogin)).some(c => c.kind === 'emailOtp'), 'a checked, fresh same-account trust marker skips the repeat OTP');
        await trustedLogin.close();

        const uncheckedLogin = await setup({ role: 'customer' });
        await uncheckedLogin.evaluate(() => InigoAuthStorage.rememberDevice('fixture-user', 'customer'));
        await passwordLogin(uncheckedLogin);
        await uncheckedLogin.locator('[data-auth-panel="verify"].is-active').waitFor();
        assert((await calls(uncheckedLogin)).some(c => c.kind === 'emailOtp'), 'an unchecked fresh choice overrides earlier device trust');
        assert.equal(await uncheckedLogin.evaluate(() => localStorage.getItem('inigosync-trusted-device:customer:fixture-user')), null);
        await uncheckedLogin.locator('[data-auth-close]').click();
        await uncheckedLogin.waitForFunction(() => document.querySelector('[data-auth-overlay]').hidden);
        assert.equal(await uncheckedLogin.evaluate(async () => (await sb.auth.getSession()).data.session), null, 'cancelling the OTP gate leaves no active password session');
        await uncheckedLogin.close();

        const otherAccount = await setup({ role: 'customer', userId: 'other-user' });
        await otherAccount.evaluate(() => InigoAuthStorage.rememberDevice('fixture-user', 'customer'));
        await passwordLogin(otherAccount, 'login', true);
        await otherAccount.locator('[data-auth-panel="verify"].is-active').waitFor();
        assert((await calls(otherAccount)).some(c => c.kind === 'emailOtp'), 'trust for another account cannot skip OTP');
        await otherAccount.close();

        for (const role of ['staff', 'admin']) {
            const page = await setup({ role });
            await passwordLogin(page, 'admin', true);
            await page.locator('[data-auth-panel="verify"].is-active').waitFor();
            for (let i = 0; i < 6; i++) await page.locator('[data-otp-box]').nth(i).fill(String(i + 1));
            await page.locator('[data-auth-panel="verify"] button[type="submit"]').click();
            await page.waitForURL(role === 'staff' ? '**/staff_dashboard.html' : '**/owner_dashboard.html');
            assert(await page.evaluate(roleName => InigoAuthStorage.isDeviceTrusted('fixture-user', roleName), role), `${role} password login records role-specific trust`);
            await page.close();
        }

        const signupOtp = await setup({ emailConfirmation: true });
        await signup(signupOtp, '', true);
        assert.equal(await signupOtp.locator('[data-auth-panel="signup"] [name="remember"]').isChecked(), true);
        assert.equal(await signupOtp.locator('[data-auth-panel="verify"] [data-verify-heading]').innerText(), 'Verify your email', 'signup always keeps its first email confirmation step');
        assert((await calls(signupOtp)).some(c => c.kind === 'signUp'));
        for (let i = 0; i < 6; i++) await signupOtp.locator('[data-otp-box]').nth(i).fill(String(i + 1));
        await signupOtp.locator('[data-auth-panel="verify"] button[type="submit"]').click();
        await signupOtp.waitForURL('**/user_dashboard.html');
        assert(await signupOtp.evaluate(() => InigoAuthStorage.isDeviceTrusted('fixture-user', 'customer')), 'confirmed signup honors its Remember me choice');
        await signupOtp.close();

        const trustBoundary = await setup();
        const boundaryResult = await trustBoundary.evaluate(() => {
            const key = 'inigosync-trusted-device:customer:fixture-user';
            const now = 2_000_000_000_000;
            localStorage.setItem(key, JSON.stringify({ version: 1, lastActivityAt: now - 7 * 24 * 60 * 60 * 1000 + 1 }));
            const justBeforeExpiry = InigoAuthStorage.isDeviceTrusted('fixture-user', 'customer', now);
            localStorage.setItem(key, JSON.stringify({ version: 1, lastActivityAt: now - 7 * 24 * 60 * 60 * 1000 }));
            const atExpiry = InigoAuthStorage.isDeviceTrusted('fixture-user', 'customer', now);
            localStorage.setItem('inigosync-trusted-device:fixture-user', '1');
            const legacyMarker = InigoAuthStorage.isDeviceTrusted('fixture-user', 'customer', now);
            return { justBeforeExpiry, atExpiry, legacyMarker };
        });
        assert.deepEqual(boundaryResult, { justBeforeExpiry: true, atExpiry: false, legacyMarker: false }, 'trust expires at exactly seven inactive days and legacy markers fail closed');
        await trustBoundary.close();

        const staleDashboard = await browser.newPage();
        staleDashboard.setDefaultTimeout(10000);
        await staleDashboard.route(/^https:\/\//, r => r.abort());
        await staleDashboard.route('**/Config/supabaseClient.js', r => r.fulfill({ contentType: 'application/javascript', body: `(${mockClient})(${JSON.stringify({ dashboard: true })})` }));
        await staleDashboard.addInitScript(() => localStorage.setItem('inigosync-trusted-device:fixture-user', '1'));
        await staleDashboard.goto('http://127.0.0.1:4178/Pages/user_dashboard.html', { waitUntil: 'domcontentloaded' });
        await staleDashboard.waitForURL('**/index.html');
        assert((await calls(staleDashboard)).some(c => c.kind === 'signOut'), 'a legacy remembered session cannot enter a dashboard without fresh trust');
        await staleDashboard.close();

        const blank = await setup(); await signup(blank);
        await blank.waitForURL('**/user_dashboard.html');
        const blankSignup = (await calls(blank)).find(c => c.kind === 'signUp');
        assert.equal(Object.hasOwn(blankSignup.data.options.data, 'contact_num'), false, 'signup metadata must not persist an unvalidated number');
        assert(!(await calls(blank)).some(c => c.kind === 'function'));
        await blank.close();

        const invalid = await setup(); await signup(invalid, '0912');
        assert(!(await calls(invalid)).some(c => c.kind === 'signUp')); await invalid.close();
        for (const registrationRace of ['error', 'identities']) {
            const page = await setup({ registrationRace }); await signup(page);
            await page.locator('[data-signup-step="1"].is-active').waitFor();
            assert.match(await page.locator('[data-auth-notice]').innerText(), /already registered/);
            assert(page.url().includes('index.html')); await page.close();
        }

        for (const emailConfirmation of [false, true]) {
            const page = await setup({ emailConfirmation });
            await page.setViewportSize({ width: emailConfirmation ? 320 : 390, height: 844 });
            await signup(page, '09171234567');
            if (emailConfirmation) {
                await page.locator('[data-auth-panel="verify"].is-active').waitFor();
                for (let i = 0; i < 6; i++) await page.locator('[data-otp-box]').nth(i).fill(String(i + 1));
                await page.locator('[data-auth-panel="verify"] button[type="submit"]').click();
            }
            await page.locator('[data-auth-panel="phone"].is-active').waitFor();
            assert.equal(await page.locator('[data-signup-phone-validate]').innerText(), 'Validate and save');
            await page.locator('[data-signup-phone-validate]').click();
            await page.waitForFunction(() => document.querySelector('[data-signup-phone-status]').textContent.includes('Validated as an active'));
            const currentCalls = await calls(page);
            const validationCall = currentCalls.find(c => c.kind === 'function');
            assert.equal(validationCall.data.name, 'validate-contact-phone');
            assert.deepEqual(validationCall.data.body, { phone: '09171234567' });
            const profileWrite = currentCalls.find(c => c.kind === 'profileWrite');
            assert.deepEqual(profileWrite.data, { contact_num: '+639171234567' });
            assert.equal(Object.hasOwn(profileWrite.data, 'phone_verified'), false);
            assert.match(await page.locator('[data-signup-phone-status]').innerText(), /does not confirm ownership/);
            await page.locator('[data-signup-phone-skip]').click();
            await page.waitForURL('**/user_dashboard.html');
            await page.close();
        }

        for (const validationReason of ['invalid', 'not_mobile', 'inactive', 'status_unknown']) {
            const page = await setup({ validationReason }); await signup(page, '09171234567');
            await page.locator('[data-signup-phone-validate]').click();
            await page.locator('[data-auth-notice]').waitFor({ state: 'visible' });
            assert(!(await calls(page)).some(c => c.kind === 'profileWrite'), validationReason);
            await page.locator('[data-signup-phone-skip]').click();
            await page.waitForURL('**/user_dashboard.html'); await page.close();
        }
        for (const validationError of ['budget exceeded', 'provider unavailable']) {
            const page = await setup({ validationError, validationStatus: validationError === 'budget exceeded' ? 429 : 503 });
            await signup(page, '09171234567');
            await page.locator('[data-signup-phone-validate]').click();
            await page.locator('[data-auth-notice]').waitFor({ state: 'visible' });
            assert.match(await page.locator('[data-auth-notice]').innerText(), /unavailable|budget/i);
            assert(!(await calls(page)).some(c => c.kind === 'profileWrite'));
            await page.locator('[data-signup-phone-skip]').click();
            await page.waitForURL('**/user_dashboard.html'); await page.close();
        }

        const cancelled = await setup(); await signup(cancelled, '09171234567');
        await cancelled.locator('[data-auth-panel="phone"].is-active').waitFor();
        await cancelled.locator('[data-auth-close]').click();
        await cancelled.waitForFunction(() => document.querySelector('[data-auth-overlay]').hidden);
        assert(cancelled.url().includes('index.html'));
        assert(!(await calls(cancelled)).some(c => ['profileWrite', 'sessionWrite', 'function'].includes(c.kind)));
        await cancelled.close();

        const dashboard = await setupDashboard({ gender: 'Female' });
        await dashboard.locator('[data-dash-nav="profile"]').first().click();
        await dashboard.waitForFunction(() => document.querySelector('[data-dash-profile-gender]').textContent === 'Female');
        assert.equal(await dashboard.locator('[data-dash-profile-gender]').innerText(), 'Female', 'customer profile view shows the saved gender');
        await dashboard.locator('[data-dash-nav="settings"]').first().click();
        await dashboard.waitForFunction(() => document.querySelector('[data-dash-settings-display-gender]').textContent === 'Female');
        await dashboard.locator('[data-dash-personal-edit]').click();
        assert.equal(await dashboard.locator('[data-dash-settings-gender]').inputValue(), 'Female', 'edit profile loads the saved gender');
        await dashboard.locator('[data-dash-settings-gender]').selectOption('Male');
        await dashboard.locator('[data-dash-personal-save]').click();
        await dashboard.locator('[data-dash-confirm-modal]').waitFor({ state: 'visible' });
        assert.equal((await calls(dashboard)).filter(c => c.kind === 'personalSave').length, 0, 'personal information is not saved before confirmation');
        await dashboard.locator('[data-dash-confirm-accept]').click();
        await dashboard.waitForFunction(() => JSON.parse(sessionStorage.getItem('fixture-calls') || '[]').some(c => c.kind === 'personalSave'));
        const nameWrite = (await calls(dashboard)).find(c => c.kind === 'personalSave');
        assert.deepEqual(nameWrite.data, {
            p_full_name: 'Fixture Customer', p_first_name: 'Fixture', p_middle_name: '', p_last_name: 'Customer',
            p_birthdate: null, p_gender: 'Male', p_civil_status: null, p_emergency_contact_name: null,
        });
        assert.equal(await dashboard.locator('[data-dash-profile-gender]').innerText(), 'Male', 'saved gender updates the customer profile view');
        assert.equal(await dashboard.locator('[data-dash-settings-display-gender]').innerText(), 'Male', 'saved gender updates the settings summary');

        await dashboard.locator('[data-dash-personal-edit]').click();
        assert.equal(await dashboard.locator('[data-dash-settings-email]').inputValue(), 'customer@example.test', 'current email remains read-only');
        await dashboard.locator('[data-dash-email-edit]').click();
        await dashboard.locator('[data-dash-email-proposal-input]').fill('new-customer@example.test');
        await dashboard.waitForFunction(() => document.querySelector('[data-dash-email-proposal-status]').textContent === 'Available');
        await dashboard.locator('[data-dash-email-proposal-save]').click();
        assert.equal(await dashboard.locator('[data-dash-settings-email]').inputValue(), 'customer@example.test', 'staged email does not replace the current address');
        await dashboard.locator('[data-dash-personal-save]').click();
        await dashboard.locator('[data-dash-confirm-modal]').waitFor({ state: 'visible' });
        assert.equal((await calls(dashboard)).filter(c => c.kind === 'updateUser').length, 0, 'email change request waits for Save confirmation');
        await dashboard.locator('[data-dash-confirm-accept]').click();
        await dashboard.waitForFunction(() => JSON.parse(sessionStorage.getItem('fixture-calls') || '[]').some(c => c.kind === 'updateUser'));
        const emailRequest = (await calls(dashboard)).find(c => c.kind === 'updateUser');
        assert.deepEqual(emailRequest.data, { email: 'new-customer@example.test' });
        assert.equal(await dashboard.locator('[data-dash-settings-email]').inputValue(), 'customer@example.test', 'requested but unverified address is not shown as saved');
        const fillEmailOtp = async code => {
            for (let i = 0; i < code.length; i++) await dashboard.locator('[data-dash-email-otp-box]').nth(i).fill(code[i]);
        };
        assert.equal(await dashboard.locator('[data-dash-email-otp-title]').innerText(), 'Verify your current email');
        await fillEmailOtp('111111');
        await dashboard.locator('[data-dash-email-otp-verify]').click();
        await dashboard.locator('[data-dash-confirm-modal]').waitFor({ state: 'visible' });
        await dashboard.locator('[data-dash-confirm-accept]').click();
        await dashboard.waitForFunction(() => document.querySelector('[data-dash-email-otp-title]').textContent === 'Verify your new email');
        const afterCurrentConfirm = await calls(dashboard);
        const currentEmailVerify = afterCurrentConfirm.find(c => c.kind === 'verifyOtp');
        assert.deepEqual(currentEmailVerify.data, { email: 'customer@example.test', token: '111111', type: 'email_change' });
        assert.equal(await dashboard.locator('[data-dash-settings-email]').inputValue(), 'customer@example.test', 'confirming the old address does not update the saved profile email');
        await fillEmailOtp('222222');
        await dashboard.locator('[data-dash-email-otp-verify]').click();
        await dashboard.locator('[data-dash-confirm-modal]').waitFor({ state: 'visible' });
        await dashboard.locator('[data-dash-confirm-accept]').click();
        await dashboard.waitForFunction(() => document.querySelector('[data-dash-settings-email]').value === 'new-customer@example.test');
        const emailVerifications = (await calls(dashboard)).filter(c => c.kind === 'verifyOtp');
        assert.deepEqual(emailVerifications.map(c => c.data), [
            { email: 'customer@example.test', token: '111111', type: 'email_change' },
            { email: 'new-customer@example.test', token: '222222', type: 'email_change' },
        ]);
        assert((await calls(dashboard)).some(c => c.kind === 'getUser'), 'confirmed profile email is checked against the current Auth user');
        assert.equal(await dashboard.locator('[data-dash-settings-email]').inputValue(), 'new-customer@example.test');

        const mobileInput = dashboard.locator('[data-dash-settings-mobile]');
        await mobileInput.fill('09171234567');
        await dashboard.waitForFunction(() => document.querySelector('[data-dash-mobile-status]').textContent.includes('Validated as an active'));
        assert.equal((await calls(dashboard)).filter(c => c.kind === 'function').length, 1, 'one valid changed number triggers one automatic provider validation');
        await dashboard.locator('[data-dash-mobile-validate]').click();
        await dashboard.locator('[data-dash-confirm-modal]').waitFor({ state: 'visible' });
        assert.equal((await calls(dashboard)).filter(c => c.kind === 'profileWrite' && Object.hasOwn(c.data, 'contact_num')).length, 0, 'validated phone waits for save confirmation');
        await dashboard.locator('[data-dash-confirm-accept]').click();
        await dashboard.waitForFunction(() => JSON.parse(sessionStorage.getItem('fixture-calls') || '[]').some(c => c.kind === 'profileWrite'));
        const dashboardCalls = await calls(dashboard);
        assert.deepEqual(dashboardCalls.find(c => c.kind === 'function').data, { name: 'validate-contact-phone', body: { phone: '09171234567', purpose: 'contact' } });
        assert.deepEqual(dashboardCalls.find(c => c.kind === 'profileWrite' && Object.hasOwn(c.data, 'contact_num')).data, { contact_num: '09171234567' });
        assert.equal(dashboardCalls.filter(c => c.kind === 'function').length, 1, 'one click must cause exactly one provider lookup');
        assert.match(await dashboard.locator('[data-dash-mobile-status]').innerText(), /does not confirm ownership/);
        await mobileInput.fill('09171234567');
        await dashboard.waitForFunction(() => document.querySelector('[data-dash-mobile-status]').textContent.includes('unchanged'));
        assert.equal((await calls(dashboard)).filter(c => c.kind === 'function').length, 1, 'unchanged number must not use provider quota');

        await dashboard.locator('[data-dash-settings-emergency-number]').fill('09171234567');
        await dashboard.waitForFunction(() => document.querySelector('[data-dash-emergency-status]').textContent.includes('Validated as an active'));
        assert.equal((await calls(dashboard)).filter(c => c.kind === 'function').length, 2, 'emergency number is independently validated even when it matches the own number');
        await dashboard.locator('[data-dash-emergency-save]').click();
        await dashboard.locator('[data-dash-confirm-modal]').waitFor({ state: 'visible' });
        assert.equal((await calls(dashboard)).filter(c => c.kind === 'privateWrite' && Object.hasOwn(c.data, 'emergency_contact_number')).length, 0, 'emergency number waits for save confirmation');
        await dashboard.locator('[data-dash-confirm-accept]').click();
        await dashboard.waitForFunction(() => JSON.parse(sessionStorage.getItem('fixture-calls') || '[]').some(c => c.kind === 'privateWrite' && Object.hasOwn(c.data, 'emergency_contact_number')));
        const emergencyCalls = await calls(dashboard);
        assert.deepEqual(emergencyCalls.filter(c => c.kind === 'function')[1].data, { name: 'validate-contact-phone', body: { phone: '09171234567', purpose: 'emergency' } });
        assert.deepEqual(emergencyCalls.find(c => c.kind === 'privateWrite' && Object.hasOwn(c.data, 'emergency_contact_number')).data, { emergency_contact_number: '09171234567' });
        await dashboard.close();

        const rejectedDashboard = await setupDashboard({ validationReason: 'inactive' });
        await rejectedDashboard.locator('[data-dash-nav="settings"]').first().click();
        await rejectedDashboard.locator('[data-dash-personal-edit]').click();
        await rejectedDashboard.locator('[data-dash-settings-mobile]').fill('09171234567');
        await rejectedDashboard.waitForFunction(() => document.querySelector('[data-dash-mobile-status]').textContent.includes('not active'));
        assert(!(await calls(rejectedDashboard)).some(c => c.kind === 'profileWrite'));
        await rejectedDashboard.close();

        const signOutDashboard = await setupDashboard();
        await signOutDashboard.locator('[data-dash-logout]').first().evaluate(button => button.click());
        await signOutDashboard.waitForURL('**/index.html');
        const signOutEvents = (await calls(signOutDashboard)).filter(call => call.kind === 'accountSessionEvent');
        assert.deepEqual(signOutEvents.map(call => call.data), [{ p_kind: 'sign_out', p_reason: 'app_logout' }], 'explicit app sign-out uses the server-derived account session RPC without a client actor ID');
        await signOutDashboard.close();

        console.log('PASS signup and customer contact number validation: no unproved signup metadata, active provider result required, failures do not save, unchanged values avoid provider quota, and one UI click makes one authenticated lookup');
        console.log('PASS early email checks: taken/available, edit recovery, stale responses, network failure, rate limit and final-signup races');
        console.log('PASS OAuth role/disabled rejections, customer OAuth, email-confirmed and immediate signup, optional/invalid number, validation failure, and no SMS or Auth phone OTP');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
