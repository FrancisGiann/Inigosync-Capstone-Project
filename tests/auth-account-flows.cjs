// No real users, credentials, emails or SMS: provider responses are deterministic fixtures.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function mockClient(options) {
    const user = { id: options.userId || 'fixture-user', identities: [{ provider: 'email' }], app_metadata: { provider: options.provider || 'email' } };
    let authUserEmail = 'customer@example.test';
    let emailMfaBeginCalls = 0;
    let currentEmailChangeOtp = '111111';
    let newEmailChangeOtp = '222222';
    let session = options.oauth || options.dashboard || sessionStorage.getItem('fixture-authenticated') === '1' ? { user } : null;
    const record = (kind, data) => {
        const calls = JSON.parse(sessionStorage.getItem('fixture-calls') || '[]');
        calls.push({ kind, data }); sessionStorage.setItem('fixture-calls', JSON.stringify(calls));
    };
    if (options.oauth || options.oauthReturn) sessionStorage.setItem('inigosync-oauth-pending', '1');
    if (options.oauthRememberDevice !== undefined) sessionStorage.setItem('inigosync-oauth-remember', options.oauthRememberDevice ? '1' : '0');
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
            if (name === 'signup_phone_availability') {
                const checkPhone = async () => {
                    record('phoneCheck', data);
                    if (data.phone_e164 === '+639171234567' && options.phoneMode === 'slow') await new Promise(resolve => setTimeout(resolve, 900));
                    if (options.phoneMode === 'error') return { error: { message: 'Network error' } };
                    return { data: options.phoneMode === 'rate_limited' ? 'rate_limited'
                        : options.phoneMode === 'in_use' || (options.phoneMode === 'slow' && data.phone_e164 === '+639171234567') ? 'in_use' : 'available' };
                };
                return { abortSignal: checkPhone, then(resolve, reject) { return checkPhone().then(resolve, reject); } };
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
                if (options.sessionReadDelay) await new Promise(resolve => setTimeout(resolve, options.sessionReadDelay));
                if (options.sessionReadError) {
                    window.InigoLoading?.show('Restoring session…');
                    throw new Error(options.sessionReadError);
                }
                return { data: { session } };
            },
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            signOut: async () => { record('signOut'); session = null; sessionStorage.removeItem('fixture-authenticated'); return {}; },
            signInWithPassword: async () => {
                record('passwordSessionCreated');
                if (options.passwordProviderError) return { data: {}, error: { code: 'provider_failure', message: options.passwordProviderError } };
                if (options.passwordError) return { data: {}, error: { code: 'invalid_credentials', message: 'Invalid login credentials' } };
                session = { user }; sessionStorage.setItem('fixture-authenticated', '1'); return { data: { user, session } };
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
                if (options.resendErrorCode) {
                    return { error: { code: options.resendErrorCode, message: 'Too many emails have been sent to this email address.' } };
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
                        const trusted = options.trustedDeviceUserId === user.id && typeof args.body.device_secret === 'string';
                        emailMfaBeginCalls += 1;
                        if (options.emailMfaBeginError && emailMfaBeginCalls === 1) {
                            return { data: null, error: { message: 'We could not send the verification code. Please wait a moment and try again.' } };
                        }
                        if (options.nativeEmailProof === true) {
                            return { data: { verified: true, remembered: false }, error: null };
                        }
                        const resent = !(options.emailMfaNoSendOnResend && emailMfaBeginCalls > 1);
                        return { data: trusted ? { verified: true, remembered: true }
                            : { verified: false, challenge_id: 'challenge-fixture', resent }, error: null };
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
                return { data: { valid: true, normalized: options.validationNormalized || '+639171234567', available: true }, error: null };
            }
        },
        from: table => {
            let write = false;
            let selectedColumns = '';
            const query = {
                select(columns = '') { selectedColumns = columns; return query; }, eq() { return query; }, order() { return query; }, limit() { return query; },
                in() { return query; }, gte() { return query; }, lte() { return query; }, is() { return query; }, not() { return query; }, or() { return query; },
                update(data) { record(table === 'customer_private_details' ? 'privateWrite' : 'profileWrite', data); write = true; return query; },
                upsert: async data => { record('sessionWrite', data); return {}; },
                single: async () => write ? { data: { id: user.id } } : rowData(),
                maybeSingle: async () => write ? { data: { id: user.id } } : rowData(),
                then(resolve, reject) { return Promise.resolve(write ? { data: null, error: null } : { data: [], error: null }).then(resolve, reject); }
            };
            function rowData() {
                if (table === 'customer_private_details') return { data: { user_id: user.id, birthdate: null, gender: options.gender || null, civil_status: null, emergency_contact_name: null, emergency_contact_number: null } };
                if (options.missingOnboardingColumn && selectedColumns.includes('onboarding_complete')) {
                    return { data: null, error: { code: '42703', message: 'column profiles.onboarding_complete does not exist' } };
                }
                return profile();
            }
            return query;
        }
    };
    function profile() {
        if (options.profileLoadError) return { data: null, error: { message: 'Internal profile query detail' } };
        return { data: { id: user.id, role: options.role || 'customer', status: options.status || (options.disabled ? 'disabled' : 'active'), email: 'customer@example.test', full_name: 'Fixture Customer', contact_num: options.contactNum || null, contact_num_validated: options.contactNumValidated || false, contact_num_validated_at: options.contactNumValidatedAt || null } };
    }
}
(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        async function setup(options = {}, startUrl = 'http://127.0.0.1:4178/index.html') {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
            page.setDefaultTimeout(10000);
            await page.route(/^https:\/\//, r => r.abort());
            if (options.oauthReturn) {
                await page.addInitScript(() => {
                    try {
                        if (location.pathname.endsWith('/index.html')) sessionStorage.setItem('inigosync-oauth-pending', '1');
                    } catch (_) { /* the initial about:blank document has no storage origin */ }
                });
            }
            await page.route('**/Config/supabaseClient.js', r => r.fulfill({ contentType: 'application/javascript', body: `(${mockClient})(${JSON.stringify(options)})` }));
            await page.route('**/includes/landingPage.js', r => r.fulfill({ contentType: 'application/javascript', body: '' }));
            await page.route('https://elfsightcdn.com/**', r => r.abort());
            if (!options.guardDashboard) {
                await page.route('**/*dashboard.html', r => r.fulfill({ contentType: 'text/html', body: '<h1>Dashboard fixture</h1>' }));
            }
            if (options.termsFailure) {
                await page.route('**/Pages/terms.html', r => r.fulfill({ status: 503, contentType: 'text/plain', body: 'Terms unavailable' }));
            }
            await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
            return page;
        }
        async function setupDashboard(options = {}) {
            const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
            page.setDefaultTimeout(10000);
            await page.route(/^https:\/\//, r => r.abort());
            await page.route('**/Config/supabaseClient.js', r => r.fulfill({ contentType: 'application/javascript', body: `(${mockClient})(${JSON.stringify({ dashboard: true, ...options })})` }));
            const dashboardPage = options.role === 'staff' ? 'staff_dashboard.html'
                : options.role === 'admin' ? 'owner_dashboard.html' : 'user_dashboard.html';
            await page.goto(`http://127.0.0.1:4178/Pages/${dashboardPage}`, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => window.inigosyncProfile?.id === 'fixture-user');
            return page;
        }
        const calls = page => page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-calls') || '[]'));
        if (process.env.SIGNUP_MFA_RETRY_ONLY === '1') {
            const page = await setup({ emailConfirmation: true, emailMfaBeginError: true });
            await page.locator('.cta-buttons [data-auth-open]').click();
            await page.locator('[role="tab"][data-auth-tab="signup"]').click();
            const form = page.locator('[data-auth-panel="signup"]');
            await form.locator('[name="email"]').fill('customer@example.test');
            await form.locator('[name="password"]').fill('Fixture2026!');
            await form.locator('[data-signup-next]').click();
            await form.locator('[name="surname"]').fill('Tester');
            await form.locator('[name="firstname"]').fill('Customer');
            await form.locator('[name="terms"]').check();
            await form.locator('button[type="submit"]').click();
            for (let i = 0; i < 6; i++) await page.locator('[data-otp-box]').nth(i).fill('123456'[i]);
            await page.locator('[data-auth-panel="verify"] button[type="submit"]').click();
            await page.locator('[data-auth-panel="verify"] [data-verify-heading]').filter({ hasText: "Confirm it's you" }).waitFor();
            await page.waitForFunction(() => {
                const loading = document.querySelector('.inigo-loading-overlay');
                return loading?.hidden === true && !loading.hasAttribute('data-open');
            });
            assert.equal(await page.locator('.inigo-loading-overlay').evaluate(el => el.hidden && !el.hasAttribute('data-open')), true,
                'failed initial MFA delivery clears the blocking loading overlay');
            for (let i = 0; i < 6; i++) await page.locator('[data-otp-box]').nth(i).fill(String(i + 1));
            await page.locator('[data-auth-panel="verify"] button[type="submit"]').click();
            await page.waitForFunction(() => document.querySelector('[data-auth-notice]').textContent.includes('no sign-in code has been sent yet'));
            assert.equal((await calls(page)).filter(call => call.kind === 'function' && call.data?.body?.action === 'verify').length, 0,
                'the consumed signup code is not sent as an MFA verification attempt');
            await page.evaluate(() => { document.querySelector('[data-otp-resend]').disabled = false; });
            await page.locator('[data-otp-resend]').click();
            await page.waitForFunction(() => document.querySelector('[data-auth-notice]').textContent === 'A new sign-in code was sent. Check your inbox.');
            assert.equal((await calls(page)).filter(call => call.kind === 'function' && call.data?.body?.action === 'begin').length, 2,
                'Resend starts a fresh login-MFA challenge');
            assert.equal((await calls(page)).filter(call => call.kind === 'resend').length, 0,
                'Resend does not request another signup confirmation code');
            for (let i = 0; i < 6; i++) await page.locator('[data-otp-box]').nth(i).fill('123456'[i]);
            await page.locator('[data-auth-panel="verify"] button[type="submit"]').click();
            await page.waitForURL('**/user_dashboard.html');
            await page.close();
            console.log('PASS failed signup MFA begin clears overlay, prevents stale-code verify, and retries with a fresh challenge');
            return;
        }
        async function runLogoutConfirmationTests() {
            const signOutDashboard = await setupDashboard();
            const customerLogoutButton = signOutDashboard.locator('[data-dash-logout]').first();
            await customerLogoutButton.evaluate(button => button.click());
            const logoutDialog = signOutDashboard.locator('.inigosync-logout-dialog');
            await logoutDialog.waitFor({ state: 'visible' });
            assert.equal(await logoutDialog.getAttribute('role'), 'dialog');
            assert.equal(await logoutDialog.getAttribute('aria-modal'), 'true');
            const dialogBounds = await logoutDialog.boundingBox();
            const viewport = signOutDashboard.viewportSize();
            assert(Math.abs(dialogBounds.x + dialogBounds.width / 2 - viewport.width / 2) <= 1,
                'logout card is horizontally centered in the viewport');
            assert(Math.abs(dialogBounds.y + dialogBounds.height / 2 - viewport.height / 2) <= 1,
                'logout card is vertically centered in the viewport');
            assert.equal((await calls(signOutDashboard)).filter(call => call.kind === 'signOut').length, 0,
                'opening the explicit logout confirmation keeps the current session');
            await signOutDashboard.locator('.inigosync-logout-cancel').click();
            assert.equal(await logoutDialog.isVisible(), false, 'Cancel closes the confirmation');
            assert.equal(await customerLogoutButton.evaluate(button => document.activeElement === button), true,
                'Cancel restores focus to the logout control that opened the dialog');
            assert.equal((await calls(signOutDashboard)).filter(call => call.kind === 'accountSessionEvent').length, 0,
                'Cancel does not record a sign-out event');
            await customerLogoutButton.evaluate(button => button.click());
            await logoutDialog.waitFor({ state: 'visible' });
            await signOutDashboard.locator('.inigosync-logout-cancel').press('Shift+Tab');
            await signOutDashboard.locator('.inigosync-logout-close').press('Shift+Tab');
            assert.equal(await signOutDashboard.evaluate(() => document.activeElement.classList.contains('inigosync-logout-confirm')),
                true, 'Shift+Tab from the first dialog control wraps focus to the last');
            await signOutDashboard.locator('.inigosync-logout-confirm').press('Tab');
            assert.equal(await signOutDashboard.evaluate(() => document.activeElement.classList.contains('inigosync-logout-close')),
                true, 'Tab from the last dialog control wraps focus to the first');
            await signOutDashboard.locator('.inigosync-logout-close').press('Escape');
            assert.equal(await logoutDialog.isVisible(), false, 'Escape dismisses the confirmation');
            assert.equal(await customerLogoutButton.evaluate(button => document.activeElement === button), true,
                'Escape restores focus to the logout control');
            await customerLogoutButton.evaluate(button => button.click());
            await logoutDialog.waitFor({ state: 'visible' });
            await signOutDashboard.locator('.inigosync-logout-overlay').click({ position: { x: 4, y: 4 } });
            assert.equal(await logoutDialog.isVisible(), false, 'clicking the backdrop dismisses the confirmation');
            assert.equal(await customerLogoutButton.evaluate(button => document.activeElement === button), true,
                'backdrop dismissal restores focus to the logout control');
            assert.equal((await calls(signOutDashboard)).filter(call => call.kind === 'signOut').length, 0,
                'Escape and backdrop dismissal keep the session active');
            await customerLogoutButton.evaluate(button => button.click());
            await logoutDialog.waitFor({ state: 'visible' });
            await signOutDashboard.locator('.inigosync-logout-confirm').evaluate(button => {
                button.click();
                button.click();
            });
            await signOutDashboard.waitForURL('**/index.html');
            const signOutEvents = (await calls(signOutDashboard)).filter(call => call.kind === 'accountSessionEvent');
            assert.deepEqual(signOutEvents.map(call => call.data), [{ p_kind: 'sign_out', p_reason: 'app_logout' }],
                'explicit app sign-out records the expected event');
            assert.equal((await calls(signOutDashboard)).filter(call => call.kind === 'signOut').length, 1,
                'confirming even with repeated clicks signs out exactly once');
            await signOutDashboard.close();

            for (const [roleName, profileTriggerSelector, logoutSelector] of [
                ['staff', '[data-staff-profile-trigger]', '[data-staff-logout]'],
                ['admin', '[data-admin-profile-trigger]', '[data-admin-logout]'],
            ]) {
                const roleDashboard = await setupDashboard({ role: roleName });
                const profileSelector = roleName === 'staff' ? '[data-staff-profile]' : '[data-admin-profile]';
                await roleDashboard.locator(profileTriggerSelector).click();
                await roleDashboard.waitForFunction(selector => document.querySelector(selector)?.hasAttribute('data-open') === true,
                    profileSelector);
                await roleDashboard.locator(logoutSelector).click();
                await roleDashboard.locator('.inigosync-logout-dialog').waitFor({ state: 'visible' });
                assert.equal((await calls(roleDashboard)).filter(call => call.kind === 'signOut').length, 0,
                    `${roleName} profile-menu logout waits for confirmation`);
                await roleDashboard.locator('.inigosync-logout-close').click();
                assert.equal((await calls(roleDashboard)).filter(call => call.kind === 'accountSessionEvent').length, 0,
                    `${roleName} close button cancels without recording a sign-out`);
                assert.equal(await roleDashboard.locator(profileTriggerSelector).evaluate(trigger =>
                    !trigger.closest('[data-open]')), true, `${roleName} logout click closes its profile menu`);
                await roleDashboard.locator(profileTriggerSelector).click();
                await roleDashboard.waitForFunction(selector => document.querySelector(selector)?.hasAttribute('data-open') === true,
                    profileSelector);
                await roleDashboard.locator(logoutSelector).click();
                await roleDashboard.locator('.inigosync-logout-dialog').waitFor({ state: 'visible' });
                await roleDashboard.locator('.inigosync-logout-confirm').click();
                await roleDashboard.waitForURL('**/index.html');
                assert.deepEqual((await calls(roleDashboard)).filter(call => call.kind === 'accountSessionEvent').map(call => call.data),
                    [{ p_kind: 'sign_out', p_reason: 'app_logout' }], `${roleName} confirm uses the shared sign-out path once`);
                assert.equal((await calls(roleDashboard)).filter(call => call.kind === 'signOut').length, 1,
                    `${roleName} profile-menu confirmation signs out exactly once`);
                await roleDashboard.close();
            }
            console.log('PASS customer, staff, and owner logout confirmation, cancellation, focus handling, centering, and sign-out');
        }
        if (process.env.LOGOUT_CONFIRMATION_ONLY === '1') {
            await runLogoutConfirmationTests();
            return;
        }
        if (process.env.ONBOARDING_SCHEMA_FALLBACK_ONLY === '1') {
            for (const role of ['customer', 'staff', 'admin']) {
                const page = await setup({ role, guardDashboard: true, missingOnboardingColumn: true });
                await page.locator('.cta-buttons [data-auth-open]').click();
                if (role !== 'customer') await page.locator('[data-auth-tab="admin"]').click();
                const panel = role === 'customer' ? 'login' : 'admin';
                const form = page.locator(`[data-auth-panel="${panel}"]`);
                await form.locator('input[type="email"]').fill('account@example.test');
                await form.locator('input[type="password"]').fill('Fixture2026!');
                await form.locator('button[type="submit"]').click();
                await page.locator('[data-auth-panel="verify"].is-active').waitFor();
                for (let i = 0; i < 6; i++) await page.locator('[data-otp-box]').nth(i).fill('123456'[i]);
                await page.locator('[data-auth-panel="verify"] button[type="submit"]').click();
                const destination = role === 'customer' ? '**/user_dashboard.html'
                    : role === 'admin' ? '**/owner_dashboard.html' : '**/staff_dashboard.html';
                await page.waitForURL(destination);
                try { await page.waitForFunction(() => window.inigosyncProfile?.id === 'fixture-user'); }
                catch (error) { throw new Error(`${role} dashboard did not become ready at ${page.url()}, calls=${JSON.stringify(await calls(page))}: ${error.message}`); }
                assert.equal(await page.evaluate(() => window.inigosyncProfile.role), role);
                assert.equal((await calls(page)).filter(call => call.kind === 'signOut').length, 0);
                await page.close();
            }
            const pendingStaff = await setup({ role: 'staff', status: 'pending', guardDashboard: true, missingOnboardingColumn: true });
            await pendingStaff.locator('.cta-buttons [data-auth-open]').click();
            await pendingStaff.locator('[data-auth-tab="admin"]').click();
            const pendingForm = pendingStaff.locator('[data-auth-panel="admin"]');
            await pendingForm.locator('input[type="email"]').fill('account@example.test');
            await pendingForm.locator('input[type="password"]').fill('Fixture2026!');
            await pendingForm.locator('button[type="submit"]').click();
            await pendingStaff.locator('[data-auth-panel="verify"].is-active').waitFor();
            for (let i = 0; i < 6; i++) await pendingStaff.locator('[data-otp-box]').nth(i).fill('123456'[i]);
            await pendingStaff.locator('[data-auth-panel="verify"] button[type="submit"]').click();
            await pendingStaff.waitForURL('**/staff_onboarding.html');
            await pendingStaff.waitForFunction(() => window.inigosyncProfile?.role === 'staff');
            assert.equal(await pendingStaff.locator('body').getAttribute('data-staff-onboarding-page') !== null, true);
            assert.equal((await calls(pendingStaff)).filter(call => call.kind === 'signOut').length, 0);
            await pendingStaff.close();
            console.log('PASS missing onboarding column preserves customer/admin/active-staff dashboards and keeps pending staff gated at onboarding');
            return;
        }
        if (process.env.AUTH_LOGIN_ERRORS_ONLY === '1') {
            const disabledOauth = await setup({ oauth: true, disabled: true });
            await disabledOauth.locator('[data-auth-notice]').waitFor({ state: 'visible' });
            assert.match(await disabledOauth.locator('[data-auth-notice]').innerText(), /disabled.*front desk/i);
            await disabledOauth.close();

            for (const [options, expected] of [
                [{ disabled: true }, /disabled.*front desk/i],
                [{ profileLoadError: true }, /could not load your account/i],
                [{ passwordProviderError: 'Internal provider token: do-not-display' }, /could not complete that request/i],
            ]) {
                const page = await setup(options);
                await page.locator('.cta-buttons [data-auth-open]').click();
                const form = page.locator('[data-auth-panel="login"]');
                await form.locator('[name="email"]').fill('account@example.test');
                await form.locator('[name="password"]').fill('Fixture2026!');
                await form.locator('button[type="submit"]').click();
                const error = page.locator('[data-auth-notice]');
                await error.waitFor({ state: 'visible' });
                const text = await error.innerText();
                assert.match(text, expected);
                assert.doesNotMatch(text, /Internal profile query detail|do-not-display|provider token/i);
                await page.close();
            }

            const oauthProviderFailure = await setup({ oauthReturn: true, sessionReadError: 'Internal session lookup detail', sessionReadDelay: 500 });
            assert.equal(await oauthProviderFailure.evaluate(() => document.documentElement.hasAttribute('data-auth-oauth-pending')), true,
                'Google return loading is visible before session restoration completes');
            await oauthProviderFailure.locator('[data-auth-notice]').waitFor({ state: 'visible' });
            const oauthErrorText = await oauthProviderFailure.locator('[data-auth-notice]').innerText();
            assert.match(oauthErrorText, /could not complete that request/i);
            assert.doesNotMatch(oauthErrorText, /Internal session lookup detail/);
            await oauthProviderFailure.close();

            const nativeDialogNotice = await setup();
            await nativeDialogNotice.evaluate(() => {
                const dialog = document.createElement('dialog');
                dialog.dataset.authNoticeFixture = '';
                document.body.appendChild(dialog);
                dialog.showModal();
                window.InigoAuthNotice.showError('Native dialog alert');
            });
            const topLayerNotice = nativeDialogNotice.locator('[data-auth-notice]');
            await topLayerNotice.waitFor({ state: 'visible' });
            assert.equal(await topLayerNotice.evaluate(el => el.parentElement?.matches('[data-auth-notice-fixture]')), true);
            assert.equal(await topLayerNotice.evaluate(el => el.classList.contains('is-in-modal')), true);
            await nativeDialogNotice.close();

            const persistedLockout = await setup();
            await persistedLockout.evaluate(email => {
                const normalized = email.trim().toLowerCase();
                let hash = 0x811c9dc5;
                for (let i = 0; i < normalized.length; i += 1) {
                    hash ^= normalized.charCodeAt(i);
                    hash = Math.imul(hash, 0x01000193);
                }
                localStorage.setItem(`inigosync-login-attempts:${(hash >>> 0).toString(36)}`, JSON.stringify({ failures: 5, lockedUntil: Date.now() + 120000 }));
            }, 'account@example.test');
            await persistedLockout.locator('.cta-buttons [data-auth-open]').click();
            const lockedForm = persistedLockout.locator('[data-auth-panel="login"]');
            await lockedForm.locator('[name="email"]').fill('account@example.test');
            const lockoutError = persistedLockout.locator('[data-auth-notice]');
            await lockoutError.waitFor({ state: 'visible' });
            const fixedLockoutText = 'Too many incorrect login attempts. Login is paused for 1 minute.';
            assert.equal(await lockoutError.innerText(), fixedLockoutText);
            const lockoutTimer = lockedForm.locator('[data-login-lockout]');
            assert.equal(await lockoutTimer.getAttribute('role'), 'status');
            assert.match(await lockoutTimer.innerText(), /Try again in/);
            assert.equal(await lockedForm.locator('button[type="submit"]').isDisabled(), true);
            await persistedLockout.waitForTimeout(1100);
            assert.equal(await lockoutError.innerText(), fixedLockoutText, 'the inline message stays fixed during the polite timer countdown');
            await persistedLockout.close();

            for (const role of ['staff', 'admin', 'customer']) {
                const page = await setup({ role });
                await page.locator('.cta-buttons [data-auth-open]').click();
                const panel = role === 'customer' ? 'admin' : 'login';
                if (panel === 'admin') await page.locator('[data-auth-tab="admin"]').click();
                const form = page.locator(`[data-auth-panel="${panel}"]`);
                await form.locator('input[type="email"]').fill('account@example.test');
                await form.locator('input[type="password"]').fill('Fixture2026!');
                await form.locator('button[type="submit"]').click();
                const roleError = page.locator('[data-auth-notice]');
                await roleError.waitFor({ state: 'visible' });
                if (role === 'customer') {
                    assert.match(await roleError.innerText(), /customer account.*customer Log In tab/i);
                } else {
                    assert.match(await roleError.innerText(), /cannot be used for customer.*Log in as Admin/i);
                }
                assert.equal(await roleError.getAttribute('role'), 'alert');
                assert((await calls(page)).some(call => call.kind === 'signOut'));
                await page.close();
            }
            console.log('PASS disabled/profile errors remain actionable, unknown Auth errors stay generic in OAuth/password flows, and persisted lockout uses a floating alert');
            return;
        }
        if (process.env.OAUTH_RETURN_ONLY === '1') {
            const page = await setup({ oauth: true, oauthReturn: true, provider: 'google', nativeEmailProof: true, sessionReadDelay: 1000 });
            assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-auth-oauth-pending')), true,
                'the loading state appears before the landing page can flash');
            assert.match(await page.evaluate(() => getComputedStyle(document.documentElement, '::before').content), /Signing you in/);
            await page.waitForURL('**/user_dashboard.html');
            assert(!(await calls(page)).some(call => call.kind === 'emailMfaVerify'),
                'OAuth native email proof continues directly without an app OTP prompt');
            await page.close();
            console.log('PASS Google return paints a pre-page loading state and routes directly to the dashboard');
            return;
        }
        if (process.env.PHONE_AVAILABILITY_ONLY === '1') {
            for (const [phoneMode, number, text, state, token] of [
                ['in_use', '09612654203', 'Existing', 'in_use', '--auth-verified-color'],
                ['available', '09981234567', 'Not found', 'available', '--color-alert-text'],
            ]) {
                const page = await setup({ phoneMode });
                const form = await firstStep(page, 'new@example.test');
                await form.locator('[data-signup-next]').click();
                await form.locator('[data-signup-step="2"].is-active').waitFor();
                const input = form.locator('[name="mobile"]');
                await input.fill(number);
                const status = page.locator('[data-signup-phone-availability-status]');
                await page.waitForFunction(expected => document.querySelector('[data-signup-phone-availability-status]').dataset.state === expected, state);
                await page.waitForTimeout(250); // Let the input's authored border-color transition finish.
                assert.equal(await status.innerText(), text);
                assert.equal(await status.evaluate(el => el.parentElement.classList.contains('signup-phone-label')), true);
                assert.equal(await status.evaluate(el => getComputedStyle(el).color), await status.evaluate((el, key) => {
                    const probe = document.createElement('span'); probe.style.color = `var(${key})`; el.append(probe);
                    const result = getComputedStyle(probe).color; probe.remove(); return result;
                }, token));
                assert.equal(await input.evaluate(el => getComputedStyle(el).borderTopColor), await input.evaluate((el, key) => {
                    const probe = document.createElement('span'); probe.style.color = `var(${key})`; el.parentElement.append(probe);
                    const result = getComputedStyle(probe).color; probe.remove(); return result;
                }, token));
                assert.equal(await form.locator('text=You can validate the number after confirming your email.').count(), 0);
                assert.equal(await input.getAttribute('required'), null);
                assert.equal((await calls(page)).find(call => call.kind === 'phoneCheck').data.phone_e164, `+63${number.slice(1)}`);
                await page.close();
            }
            console.log('PASS inline signup phone availability label, result and input colors, optionality, and anonymous number normalization');
            return;
        }
        if (process.env.TERMS_DIALOG_ONLY === '1') {
            const page = await setup({ emailConfirmation: true });
            await page.addStyleTag({ content: '.auth-modal, .auth-modal *, [data-terms-overlay], [data-terms-overlay] * { animation: none !important; transition: none !important; }' });
            await page.locator('.cta-buttons [data-auth-open]').click();
            await page.locator('[role="tab"][data-auth-tab="signup"]').click();
            const form = page.locator('[data-auth-panel="signup"]');
            await form.locator('[name="email"]').fill('customer@example.test');
            await form.locator('[name="password"]').fill('Fixture2026!');
            await form.locator('[data-signup-next]').click();
            await form.locator('[data-signup-step="2"].is-active').waitFor();
            const termsCheckbox = form.locator('[name="terms"]');
            const termsLink = form.locator('[data-terms-open]');
            const dialog = page.locator('[data-terms-overlay]');
            const createAccount = form.locator('button[type="submit"]');
            assert.equal(await createAccount.isDisabled(), true, 'Create Account stays disabled until both required names are entered');
            await form.locator('[name="surname"]').fill('Tester');
            assert.equal(await createAccount.isDisabled(), true, 'surname alone is not enough to enable Create Account');
            await form.locator('[name="firstname"]').fill('Customer');
            assert.equal(await createAccount.isDisabled(), false, 'surname and first name enable Create Account without a middle name');
            await form.locator('[name="firstname"]').fill('   ');
            assert.equal(await createAccount.isDisabled(), true, 'whitespace-only first name does not enable Create Account');
            await form.locator('[name="firstname"]').fill('Customer');

            await termsLink.click();
            await dialog.waitFor({ state: 'visible' });
            assert.equal(await dialog.locator('[data-terms-agree]').innerText(), 'Agree');
            assert.equal(await termsCheckbox.isChecked(), false);
            await dialog.locator('[data-terms-agree]').click();
            assert.equal(await termsCheckbox.isChecked(), true, 'Agree checks the signup Terms checkbox');
            assert.equal(await termsCheckbox.evaluate(el => document.activeElement === el), true, 'Agree returns focus to the checked checkbox');
            await dialog.waitFor({ state: 'hidden' });
            assert(!(await calls(page)).some(c => c.kind === 'signUp'), 'Agree does not submit signup');
            await termsCheckbox.uncheck();

            for (const dismiss of ['close button', 'backdrop', 'Escape']) {
                await createAccount.click();
                await dialog.waitFor({ state: 'visible' });
                if (dismiss === 'close button') await dialog.locator('.auth-terms-close').click();
                else if (dismiss === 'backdrop') await dialog.locator('.auth-terms-backdrop').click({ position: { x: 2, y: 2 } });
                else await page.keyboard.press('Escape');
                await dialog.waitFor({ state: 'hidden' });
                assert.equal(await termsCheckbox.isChecked(), false, `${dismiss} dismiss does not check an unchecked box`);
                assert.equal(await createAccount.evaluate(el => document.activeElement === el), true, `${dismiss} returns focus to Create Account`);
                assert(!(await calls(page)).some(c => c.kind === 'signUp'), `${dismiss} does not submit signup`);
            }
            assert.equal(await termsCheckbox.isChecked(), false, 'dismiss-only paths leave an unchecked box unchecked');
            await createAccount.click();
            await dialog.waitFor({ state: 'visible' });
            await dialog.locator('[data-terms-agree]').click();
            await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('fixture-calls') || '[]').filter(c => c.kind === 'signUp').length === 1);
            assert.equal(await termsCheckbox.isChecked(), true, 'Agree during Create Account checks Terms');
            assert.equal((await calls(page)).filter(c => c.kind === 'signUp').length, 1, 'Agree resumes the intended signup exactly once');
            await page.close();

            const noticePage = await setup();
            await noticePage.evaluate(() => {
                const notice = document.createElement('div');
                notice.className = 'auth-status';
                notice.dataset.authNotice = '';
                notice.hidden = true;
                const message = document.createElement('span');
                message.dataset.authNoticeMessage = '';
                notice.appendChild(message);
                const close = document.createElement('button');
                close.type = 'button';
                close.dataset.authNoticeClose = '';
                close.hidden = true;
                notice.appendChild(close);
                document.body.appendChild(notice);
            });
            await noticePage.locator('.cta-buttons [data-auth-open]').click();
            await noticePage.locator('[role="tab"][data-auth-tab="signup"]').click();
            const noticeForm = noticePage.locator('[data-auth-panel="signup"]');
            await noticeForm.locator('[name="email"]').fill('customer@example.test');
            await noticeForm.locator('[name="password"]').fill('Fixture2026!');
            await noticeForm.locator('[data-signup-next]').click();
            await noticeForm.locator('[data-signup-step="2"].is-active').waitFor();
            await noticeForm.locator('[name="terms"]').check();
            await noticeForm.evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
            const errorNotice = noticePage.locator('[data-auth-notice].is-error.is-visible');
            await errorNotice.waitFor({ state: 'visible' });
            assert.match(await errorNotice.locator('[data-auth-notice-message]').innerText(), /Enter your surname/);
            await noticeForm.locator('[name="surname"]').fill('Tester');
            await noticeForm.locator('[name="firstname"]').fill('Customer');
            await noticeForm.locator('[name="terms"]').uncheck();
            await noticeForm.locator('button[type="submit"]').click();
            const noticeDialog = noticePage.locator('[data-terms-overlay]');
            await noticeDialog.waitFor({ state: 'visible' });
            assert(await errorNotice.isVisible(), 'signup error notice remains visible behind Terms');
            await noticePage.keyboard.press('Tab');
            assert(await noticeDialog.locator('[data-terms-dialog]').evaluate(el => el.contains(document.activeElement)), 'Terms owns Tab while the auth error notice is visible');
            await noticePage.keyboard.press('Escape');
            await noticeDialog.waitFor({ state: 'hidden' });
            assert(await noticeForm.locator('[name="terms"]').isChecked() === false, 'Escape cancels pending signup with Terms unchecked');
            assert(await errorNotice.isVisible(), 'Escape dismisses Terms without dismissing the underlying error notice');
            assert(!(await calls(noticePage)).some(c => c.kind === 'signUp'), 'Terms keyboard dismissal does not submit signup');
            await noticePage.close();

            const failedTerms = await setup({ termsFailure: true });
            failedTerms.on('popup', popup => popup.close());
            await failedTerms.locator('.cta-buttons [data-auth-open]').click();
            await failedTerms.locator('[role="tab"][data-auth-tab="signup"]').click();
            const failedForm = failedTerms.locator('[data-auth-panel="signup"]');
            await failedForm.locator('[name="email"]').fill('customer@example.test');
            await failedForm.locator('[name="password"]').fill('Fixture2026!');
            await failedForm.locator('[data-signup-next]').click();
            await failedForm.locator('[data-signup-step="2"].is-active').waitFor();
            await failedForm.locator('[name="surname"]').fill('Tester');
            await failedForm.locator('[name="firstname"]').fill('Customer');
            const termsResponse = failedTerms.waitForResponse(response => response.url().includes('/Pages/terms.html'));
            await failedForm.locator('button[type="submit"]').click();
            assert.equal((await termsResponse).status(), 503, 'the inline Terms fetch failure enters the fallback path');
            await failedTerms.waitForTimeout(100);
            assert.equal(await failedForm.locator('[name="terms"]').isChecked(), false, 'failed Terms fetch leaves the checkbox unchecked');
            assert(!(await calls(failedTerms)).some(c => c.kind === 'signUp'), 'failed Terms fetch does not resume or submit signup');
            await failedTerms.close();
            console.log('PASS manual Agree only checks; Create Account resumes once after Agree; dismissals and Terms fetch failure cancel submission');
            return;
        }
        if (process.env.SIGNUP_EMAIL_ONLY === '1') {
            const page = await setup();
            await page.setViewportSize({ width: 320, height: 844 });
            await page.addStyleTag({ content: '.auth-modal, .auth-modal * { animation: none !important; transition: none !important; }' });
            await page.locator('.cta-buttons [data-auth-open]').click();
            await page.locator('[role="tab"][data-auth-tab="signup"]').click();
            const form = page.locator('[data-auth-panel="signup"]');
            const height = await form.evaluate(el => el.getBoundingClientRect().height);
            await form.locator('[name="email"]').fill('kikooborza@gmail.comk');
            await form.locator('[name="password"]').fill('Fixture2026!');
            await page.waitForFunction(() => document.querySelector('[data-signup-email-status]').dataset.state === 'check_spelling');
            assert.equal(await page.locator('[data-signup-email-status]').innerText(), 'Check email spelling');
            assert.equal(await form.locator('[name="email"]').getAttribute('aria-invalid'), 'true');
            assert(Math.abs(await form.evaluate(el => el.getBoundingClientRect().height) - height) < 1, '320px typo status does not resize the signup form');
            assert(await form.evaluate(el => el.scrollWidth <= el.clientWidth), '320px typo status does not overflow the signup form');
            await form.locator('[data-signup-next]').click();
            assert(await form.locator('[data-signup-step="1"]').evaluate(el => el.classList.contains('is-active')));
            assert(!(await calls(page)).some(c => ['emailCheck', 'signUp'].includes(c.kind)));

            await form.locator('[name="email"]').fill('member@gamil.com');
            await page.waitForFunction(() => document.querySelector('[data-signup-email-status]').dataset.state === 'check_spelling');
            assert.equal(await page.locator('[data-signup-email-status]').getAttribute('data-suggestion'), 'member@gmail.com');
            await form.locator('[data-signup-next]').click();
            assert.match(await page.locator('[data-auth-notice]').innerText(), /Did you mean member@gmail\.com\?/i,
                'a Gmail transposition warns with the precise correction before signup proceeds');
            assert(!(await calls(page)).some(c => c.kind === 'signUp'), 'a likely provider typo is never silently rewritten or submitted');

            await form.locator('[name="email"]').fill('member@community-center.example');
            await page.waitForFunction(() => document.querySelector('[data-signup-email-status]').dataset.state === 'available');

            await form.locator('[name="email"]').fill('member@gmail.com');
            await page.waitForFunction(() => document.querySelector('[data-signup-email-status]').dataset.state === 'available');
            await form.locator('[data-signup-next]').click();
            await form.locator('[data-signup-step="2"].is-active').waitFor();
            const remember = form.locator('[name="remember"]');
            assert.equal(await remember.evaluate(el => el.nextElementSibling.textContent), 'Remember me');
            assert.equal(await remember.evaluate(el => el.closest('[data-signup-step]').dataset.signupStep), '2');
            await form.locator('[name="surname"]').fill('Tester');
            await form.locator('[name="firstname"]').fill('Customer');
            await form.locator('[name="terms"]').check();
            await page.evaluate(() => {
                const email = document.querySelector('[data-auth-panel="signup"] [name="email"]');
                email.value = 'member@gmail.comk';
                email.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await form.locator('button[type="submit"]').click();
            await form.locator('[data-signup-step="1"].is-active').waitFor();
            assert(!(await calls(page)).some(c => c.kind === 'signUp'), 'final signup submit blocks a likely provider typo');
            await page.close();

            const googleSignup = await setup();
            await googleSignup.locator('.cta-buttons [data-auth-open]').click();
            await googleSignup.locator('[role="tab"][data-auth-tab="signup"]').click();
            const googleForm = googleSignup.locator('[data-auth-panel="signup"]');
            const rememberChoice = googleForm.locator('[name="remember"]');
            assert.equal(await googleForm.locator('[data-signup-step="1"]').evaluate(el => el.classList.contains('is-active')), true);
            assert.equal(await rememberChoice.isVisible(), false, 'Remember me stays on step 2 during signup OAuth');
            assert.equal(await rememberChoice.isChecked(), false, 'signup OAuth uses the unchecked default remember choice');
            await googleForm.locator('[data-google-btn] button').click();
            await googleSignup.waitForFunction(() => JSON.parse(sessionStorage.getItem('fixture-calls') || '[]').some(c => c.kind === 'oauth'));
            const googleCalls = await calls(googleSignup);
            assert.equal(googleCalls.find(c => c.kind === 'oauth').data.provider, 'google');
            assert(googleCalls.some(c => c.kind === 'rememberSessionChoice' && c.data.remember === false), 'Google signup starts with the unchecked remember-device choice');
            assert(!googleCalls.some(c => c.kind === 'signUp'), 'Google signup continues through OAuth rather than password signup');
            await googleSignup.close();
            console.log('PASS signup common-provider typo detection, 320px layout, Continue and final-submit gates, Remember me placement, and Google OAuth default');
            return;
        }
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
                const oauthPage = await setup({ oauth: true, role: 'customer', provider: 'google', nativeEmailProof: true, oauthRememberDevice: remember });
                await oauthPage.waitForURL('**/user_dashboard.html');
                assert.equal(await oauthPage.evaluate(() => sessionStorage.getItem('fixture-oauth-splash-seen')), '1',
                    'the OAuth return splash appears before the direct dashboard transition');
                assert.equal(Boolean(await oauthPage.evaluate(() => localStorage.getItem('inigosync-email-mfa-device:v1:fixture-user'))), false,
                    'native OAuth email proof does not create a remembered-email-MFA device');
                assert.equal(await oauthPage.evaluate(() => sessionStorage.getItem('inigosync-session-only')), remember ? null : '1');
                assert((await calls(oauthPage)).some(c => c.kind === 'rememberSessionChoice' && c.data.remember === remember));
                assert(!(await calls(oauthPage)).some(c => c.kind === 'emailMfaVerify'), 'Google OAuth completes without the app email-OTP gate');
                await oauthPage.close();
            }

            const uncheckedPage = await setup({ role: 'customer', trustedDeviceUserId: 'fixture-user' });
            const uncheckedSecret = 'b'.repeat(64);
            await uncheckedPage.evaluate(secret => localStorage.setItem('inigosync-email-mfa-device:v1:fixture-user', secret), uncheckedSecret);
            await uncheckedPage.locator('.cta-buttons [data-auth-open]').click();
            const uncheckedForm = uncheckedPage.locator('[data-auth-panel="login"]');
            await uncheckedForm.locator('[name="email"]').fill('account@example.test');
            await uncheckedForm.locator('[name="password"]').fill('Fixture2026!');
            await uncheckedForm.locator('button[type="submit"]').click();
            await uncheckedPage.waitForURL('**/user_dashboard.html');
            const uncheckedCalls = await calls(uncheckedPage);
            const uncheckedBegin = uncheckedCalls.find(c => c.kind === 'function' && c.data?.name === 'email-mfa' && c.data?.body?.action === 'begin');
            assert.equal(uncheckedBegin?.data?.body?.remember, false, 'the user can leave Remember me unchecked');
            assert.equal(uncheckedBegin?.data?.body?.device_secret, uncheckedSecret, 'the existing device secret is sent for server validation');
            assert(!(uncheckedCalls).some(c => c.kind === 'emailMfaVerify'), 'a valid remembered device skips email verification when unchecked');
            assert.equal(await uncheckedPage.evaluate(() => localStorage.getItem('inigosync-email-mfa-device:v1:fixture-user')), uncheckedSecret,
                'successful unchecked login preserves the existing device secret for later sign-ins');
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
            const customerLoginError = failedPassword.locator('[data-auth-notice]');
            await customerLoginError.waitFor({ state: 'visible' });
            assert.match(await customerLoginError.innerText(), /incorrect email or password/i);
            assert.equal(await customerLoginError.getAttribute('role'), 'alert');
            const customerErrorLayout = await failedPassword.evaluate(() => {
                const notice = document.querySelector('[data-auth-notice]');
                const card = document.querySelector('.auth-modal');
                return { outsideCard: !card.contains(notice), position: getComputedStyle(notice).position,
                    noticeBottom: notice.getBoundingClientRect().bottom, cardTop: card.getBoundingClientRect().top };
            });
            assert.equal(customerErrorLayout.outsideCard, true, 'customer login errors float outside the auth card');
            assert.equal(customerErrorLayout.position, 'fixed', 'customer login errors do not affect form layout');
            assert(customerErrorLayout.noticeBottom < customerErrorLayout.cardTop, 'customer login error sits above the modal card');
            await failedPasswordForm.locator('[name="password"]').fill('try-again');
            await customerLoginError.waitFor({ state: 'hidden' });
            assert(!(await calls(failedPassword)).some(c => c.kind === 'rememberSessionChoice'));
            assert.equal(await failedPassword.evaluate(() => localStorage.getItem('sb-xrlwtnwamboucihsamrr-auth-token')), 'existing-persistent-session');
            assert.equal(await failedPassword.evaluate(() => sessionStorage.getItem('inigosync-session-only')), null);
            await failedPassword.close();

            for (const role of ['staff', 'admin']) {
                for (const viewport of [{ width: 762, height: 835 }, { width: 390, height: 844 }]) {
                    const failedAdminPassword = await setup({ role, passwordError: true });
                    await failedAdminPassword.setViewportSize(viewport);
                    await failedAdminPassword.addStyleTag({ content: '.auth-modal, .auth-modal * { animation:none!important; transition:none!important; }' });
                    await failedAdminPassword.locator('.cta-buttons [data-auth-open]').click();
                    await failedAdminPassword.locator('[data-auth-tab="admin"]').click();
                    const adminForm = failedAdminPassword.locator('[data-auth-panel="admin"]');
                    await adminForm.locator('[name="admin-email"]').fill('account@example.test');
                    await adminForm.locator('[name="admin-password"]').fill('wrong-password');
                    const headerOffsetBefore = await failedAdminPassword.locator('.auth-modal h2').evaluate(el => el.getBoundingClientRect().top - el.closest('.auth-modal').getBoundingClientRect().top);
                    const naturalCardTopBefore = await failedAdminPassword.locator('.auth-modal').evaluate(el => el.getBoundingClientRect().top);
                    await adminForm.locator('button[type="submit"]').click();
                    const adminError = failedAdminPassword.locator('[data-auth-notice]');
                    await adminError.waitFor({ state: 'visible' });
                    assert.match(await adminError.innerText(), /incorrect email or password/i);
                    assert.equal(await adminError.getAttribute('role'), 'alert');
                    const layout = await failedAdminPassword.evaluate(() => {
                        const notice = document.querySelector('[data-auth-notice]');
                        const card = document.querySelector('.auth-modal');
                        const heading = card.querySelector('h2');
                        return { outsideCard: !card.contains(notice), position: getComputedStyle(notice).position,
                            alertBottom: notice.getBoundingClientRect().bottom, cardTop: card.getBoundingClientRect().top,
                            headerOffset: heading.getBoundingClientRect().top - card.getBoundingClientRect().top,
                            reserved: document.querySelector('.auth-overlay').classList.contains('has-floating-auth-notice') };
                    });
                    assert.equal(layout.outsideCard, true, `${viewport.width}px ${viewport.height}px: admin/staff alert is outside the card`);
                    assert.equal(layout.position, 'fixed', 'admin/staff alert remains viewport-positioned');
                    assert(layout.alertBottom + 8 <= layout.cardTop,
                        `${viewport.width}px ${viewport.height}px: alert is fully above the card (alert bottom ${layout.alertBottom}, card top ${layout.cardTop})`);
                    assert.equal(layout.headerOffset, headerOffsetBefore, 'floating error placement does not reflow the form inside the card');
                    const shouldReserveSpace = naturalCardTopBefore < layout.alertBottom + 12;
                    assert.equal(layout.reserved, shouldReserveSpace, 'clearance matches the natural card position');
                    for (let i = 0; i < 2; i += 1) {
                        await failedAdminPassword.setViewportSize({ width: viewport.width + 1, height: viewport.height });
                        await failedAdminPassword.setViewportSize(viewport);
                        const resizedLayout = await failedAdminPassword.evaluate(() => {
                            const notice = document.querySelector('[data-auth-notice]');
                            const card = document.querySelector('.auth-modal');
                            return { alertBottom: notice.getBoundingClientRect().bottom, cardTop: card.getBoundingClientRect().top,
                                reserved: document.querySelector('.auth-overlay').classList.contains('has-floating-auth-notice') };
                        });
                        assert(resizedLayout.alertBottom + 8 <= resizedLayout.cardTop,
                            `${viewport.width}x${viewport.height}: alert/card separation survives resize ${i + 1}`);
                        assert.equal(resizedLayout.reserved, shouldReserveSpace, 'resize does not oscillate the clearance class');
                    }
                    await failedAdminPassword.locator('[data-auth-tab="login"]').click();
                    await adminError.waitFor({ state: 'hidden' });
                    await failedAdminPassword.waitForFunction(() => !document.querySelector('.auth-overlay').classList.contains('has-floating-auth-notice'));
                    await failedAdminPassword.close();
                }
            }

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
            await signupForm.locator('[data-signup-next]').click();
            assert.equal(await signupForm.locator('[name="remember"]').evaluate(el => el.closest('[data-signup-step]').dataset.signupStep), '2');
            assert.equal(await signupForm.locator('[name="remember"]').evaluate(el => el.nextElementSibling.textContent), 'Remember me');
            await signupForm.locator('[name="remember"]').check();
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
            await signupChoiceForm.locator('[data-signup-next]').click();
            assert.equal(await signupChoiceForm.locator('[name="remember"]').evaluate(el => el.closest('[data-signup-step]').dataset.signupStep), '2');
            await signupChoiceForm.locator('[name="remember"]').check();
            await signupChoiceForm.locator('[name="remember"]').uncheck();
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
                for (const [email, label] of [['taken@example.test', 'Not available'], ['new@example.test', 'Available'], ['person@gmail.comk', 'Check email spelling']]) {
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
        const typo = await setup();
        const typoForm = await firstStep(typo, 'kikooborza@gmail.comk');
        await typo.waitForFunction(() => document.querySelector('[data-signup-email-status]').dataset.state === 'check_spelling');
        assert.equal(await typo.locator('[data-signup-email-status]').innerText(), 'Check email spelling');
        assert.equal(await typoForm.locator('[name="email"]').getAttribute('aria-invalid'), 'true');
        await typoForm.locator('[data-signup-next]').click();
        assert(await typoForm.locator('[data-signup-step="1"]').evaluate(el => el.classList.contains('is-active')));
        assert.match(await typo.locator('[data-auth-notice]').innerText(), /possible provider-domain typo/i);
        assert(!(await calls(typo)).some(c => ['emailCheck', 'signUp'].includes(c.kind)), 'a likely provider typo never reaches availability lookup or account creation');
        await typo.close();
        const submitTypo = await setup();
        const submitTypoForm = await firstStep(submitTypo, 'customer@example.test');
        await submitTypoForm.locator('[data-signup-next]').click();
        await submitTypoForm.locator('[name="surname"]').fill('Tester');
        await submitTypoForm.locator('[name="firstname"]').fill('Customer');
        await submitTypoForm.locator('[name="terms"]').check();
        await submitTypo.evaluate(() => {
            const email = document.querySelector('[data-auth-panel="signup"] [name="email"]');
            email.value = 'customer@gmail.comk';
            email.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await submitTypoForm.locator('button[type="submit"]').click();
        await submitTypoForm.locator('[data-signup-step="1"].is-active').waitFor();
        assert(!(await calls(submitTypo)).some(c => c.kind === 'signUp'), 'final form submission rechecks the email and blocks likely provider typos');
        await submitTypo.close();
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
        async function secondStep(page) {
            const form = await firstStep(page, 'new@example.test');
            await form.locator('[data-signup-next]').click();
            await form.locator('[data-signup-step="2"].is-active').waitFor();
            return form;
        }
        for (const [phoneMode, number, text, state] of [
            ['in_use', '09171234567', 'Already in use', 'in_use'],
            ['available', '09981234567', 'Valid · available', 'available'],
        ]) {
            const page = await setup({ phoneMode });
            const form = await secondStep(page);
            await form.locator('[name="mobile"]').fill(number);
            await page.waitForFunction(expected => document.querySelector('[data-signup-phone-availability-status]').dataset.state === expected, state);
            assert.equal(await page.locator('[data-signup-phone-availability-status]').innerText(), text);
            assert.equal(await page.locator('[data-signup-phone-availability-status]').evaluate(el => el.parentElement.classList.contains('signup-phone-label')), true,
                'phone availability appears beside the field label');
            assert.equal(await form.locator('text=You can validate the number after confirming your email.').count(), 0,
                'signup phone lookup is not presented as requiring email confirmation');
            assert.equal((await calls(page)).filter(call => call.kind === 'phoneCheck')[0].data.phone_e164, `+63${number.slice(1)}`);
            const color = await page.locator('[data-signup-phone-availability-status]').evaluate(el => getComputedStyle(el).color);
            assert.equal(color, await page.locator('[data-signup-phone-availability-status]').evaluate((el, key) => {
                const probe = document.createElement('span');
                probe.style.color = `var(${key})`;
                el.append(probe);
                const resolved = getComputedStyle(probe).color;
                probe.remove();
                return resolved;
            }, state === 'available' ? '--auth-verified-color' : '--color-alert-text'));
            const inputBorder = await form.locator('[name="mobile"]').evaluate(el => getComputedStyle(el).borderTopColor);
            assert.equal(inputBorder, await form.locator('[name="mobile"]').evaluate((el, key) => {
                const probe = document.createElement('span');
                probe.style.color = `var(${key})`;
                el.parentElement.append(probe);
                const resolved = getComputedStyle(probe).color;
                probe.remove();
                return resolved;
            }, state === 'available' ? '--auth-verified-color' : '--color-alert-text'));
            assert.equal(await form.locator('[name="mobile"]').getAttribute('required'), null, 'phone remains optional');
            await page.close();
        }
        const partialPhone = await setup();
        const partialForm = await secondStep(partialPhone);
        await partialForm.locator('[name="mobile"]').fill('0917');
        await partialPhone.waitForTimeout(700);
        assert.equal((await calls(partialPhone)).filter(call => call.kind === 'phoneCheck').length, 0, 'incomplete numbers are never queried');
        await partialForm.locator('[name="mobile"]').fill('');
        assert.equal((await calls(partialPhone)).filter(call => call.kind === 'phoneCheck').length, 0, 'empty optional numbers are never queried');
        await partialPhone.close();
        for (const [phoneMode, message, state] of [['rate_limited', 'Wait 1 min', 'rate_limited'], ['error', 'Try again', 'error']]) {
            const page = await setup({ phoneMode });
            const form = await secondStep(page);
            await form.locator('[name="mobile"]').fill('09171234567');
            await page.waitForFunction(expected => document.querySelector('[data-signup-phone-availability-status]').dataset.state === expected, state);
            assert.equal(await page.locator('[data-signup-phone-availability-status]').innerText(), message);
            await page.close();
        }
        const stalePhone = await setup({ phoneMode: 'slow' });
        const stalePhoneForm = await secondStep(stalePhone);
        await stalePhoneForm.locator('[name="mobile"]').fill('09171234567');
        await stalePhone.waitForFunction(() => JSON.parse(sessionStorage.getItem('fixture-calls') || '[]').some(c => c.kind === 'phoneCheck'));
        await stalePhoneForm.locator('[name="mobile"]').fill('09981234567');
        await stalePhone.waitForFunction(() => document.querySelector('[data-signup-phone-availability-status]').dataset.state === 'available');
        await stalePhone.waitForTimeout(1000);
        assert.equal(await stalePhone.locator('[data-signup-phone-availability-status]').innerText(), 'Valid · available', 'a stale phone response cannot overwrite the current number result');
        await stalePhone.close();
        async function signup(page, phone = '', remember = false) {
            await page.locator('.cta-buttons [data-auth-open]').click();
            await page.locator('[role="tab"][data-auth-tab="signup"]').click();
            const form = page.locator('[data-auth-panel="signup"]');
            await form.locator('[name="email"]').fill('customer@example.test');
            await form.locator('[name="password"]').fill('Fixture2026!');
            await form.locator('[data-signup-next]').click();
            if (remember) await form.locator('[name="remember"]').check();
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
        assert.match(await disabled.locator('[data-auth-notice]').innerText(), /Contact the front desk/);
        await disabled.close();
        const disabledPassword = await setup({ disabled: true });
        await disabledPassword.locator('.cta-buttons [data-auth-open]').click();
        const disabledPasswordForm = disabledPassword.locator('[data-auth-panel="login"]');
        await disabledPasswordForm.locator('[name="email"]').fill('account@example.test');
        await disabledPasswordForm.locator('[name="password"]').fill('Fixture2026!');
        await disabledPasswordForm.locator('button[type="submit"]').click();
        const disabledPasswordError = disabledPassword.locator('[data-auth-notice]');
        await disabledPasswordError.waitFor({ state: 'visible' });
        assert.match(await disabledPasswordError.innerText(), /disabled.*front desk/i);
        await disabledPassword.close();
        const profileLoadFailure = await setup({ profileLoadError: true });
        await profileLoadFailure.locator('.cta-buttons [data-auth-open]').click();
        const profileFailureForm = profileLoadFailure.locator('[data-auth-panel="login"]');
        await profileFailureForm.locator('[name="email"]').fill('account@example.test');
        await profileFailureForm.locator('[name="password"]').fill('Fixture2026!');
        await profileFailureForm.locator('button[type="submit"]').click();
        const profileFailureError = profileLoadFailure.locator('[data-auth-notice]');
        await profileFailureError.waitFor({ state: 'visible' });
        assert.match(await profileFailureError.innerText(), /could not load your account/i);
        assert.doesNotMatch(await profileFailureError.innerText(), /Internal profile query detail/);
        await profileLoadFailure.close();
        const providerFailure = await setup({ passwordProviderError: 'Internal provider token: do-not-display' });
        await providerFailure.locator('.cta-buttons [data-auth-open]').click();
        const providerFailureForm = providerFailure.locator('[data-auth-panel="login"]');
        await providerFailureForm.locator('[name="email"]').fill('account@example.test');
        await providerFailureForm.locator('[name="password"]').fill('Fixture2026!');
        await providerFailureForm.locator('button[type="submit"]').click();
        const providerFailureError = providerFailure.locator('[data-auth-notice]');
        await providerFailureError.waitFor({ state: 'visible' });
        assert.match(await providerFailureError.innerText(), /could not complete that request/i);
        assert.doesNotMatch(await providerFailureError.innerText(), /do-not-display|provider token/i);
        await providerFailure.close();
        const persistedLockout = await setup();
        await persistedLockout.evaluate(email => {
            const normalized = email.trim().toLowerCase();
            let hash = 0x811c9dc5;
            for (let i = 0; i < normalized.length; i += 1) {
                hash ^= normalized.charCodeAt(i);
                hash = Math.imul(hash, 0x01000193);
            }
            localStorage.setItem(`inigosync-login-attempts:${(hash >>> 0).toString(36)}`, JSON.stringify({ failures: 5, lockedUntil: Date.now() + 120000 }));
        }, 'account@example.test');
        await persistedLockout.locator('.cta-buttons [data-auth-open]').click();
        const lockedForm = persistedLockout.locator('[data-auth-panel="login"]');
        await lockedForm.locator('[name="email"]').fill('account@example.test');
        const lockoutError = persistedLockout.locator('[data-auth-notice]');
        await lockoutError.waitFor({ state: 'visible' });
        assert.equal(await lockoutError.innerText(), 'Too many incorrect login attempts. Login is paused for 1 minute.');
        const firstLockoutText = await lockoutError.innerText();
        const lockoutTimer = lockedForm.locator('[data-login-lockout]');
        assert.equal(await lockoutTimer.getAttribute('role'), 'status');
        assert.match(await lockoutTimer.innerText(), /Try again in/);
        assert.equal(await lockedForm.locator('button[type="submit"]').isDisabled(), true);
        await persistedLockout.waitForTimeout(1100);
        assert.equal(await lockoutError.innerText(), firstLockoutText, 'the fixed inline error is not reannounced as the timer counts down');
        await persistedLockout.close();
        const customer = await setup(
            { oauth: true, provider: 'google', nativeEmailProof: true },
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
        assert.match(await rejectedOauthSession.locator('[data-auth-notice]').innerText(), /could not complete that request/i);
        assert.doesNotMatch(await rejectedOauthSession.locator('[data-auth-notice]').innerText(), /Session lookup failed/);
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
            const roleError = page.locator('[data-auth-notice]');
            await roleError.waitFor({ state: 'visible' });
            if (role === 'customer') {
                assert.match(await roleError.innerText(), /customer account.*customer Log In tab/i);
            } else {
                assert.match(await roleError.innerText(), /cannot be used for customer.*Log in as Admin/i);
            }
            assert.equal(await roleError.getAttribute('role'), 'alert');
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
        assert(rememberedCalls.some(call => call.kind === 'function' && call.data?.body?.action === 'begin'), 'password login starts the server-bound email-MFA challenge');
        assert.equal(rememberedCalls.some(call => call.kind === 'signOut'), false, 'the primary password session remains bound to the challenge');
        assert.equal(Boolean(await rememberedLogin.evaluate(async () => (await sb.auth.getSession()).data.session)), true, 'the password session remains active while email proof is pending');
        for (let i = 0; i < 6; i++) await rememberedLogin.locator('[data-otp-box]').nth(i).fill(String(i + 1));
        await rememberedLogin.locator('[data-auth-panel="verify"] button[type="submit"]').click();
        await rememberedLogin.waitForURL('**/user_dashboard.html');
        assert((await calls(rememberedLogin)).some(call => call.kind === 'emailMfaVerify' && call.data?.remember === true),
            'the server-bound MFA verification receives the selected Remember me choice');
        await rememberedLogin.close();

        const trustedLogin = await setup({ role: 'customer', trustedDeviceUserId: 'fixture-user' });
        await trustedLogin.evaluate(() => localStorage.setItem('inigosync-email-mfa-device:v1:fixture-user', 'a'.repeat(64)));
        await passwordLogin(trustedLogin, 'login', true);
        await trustedLogin.waitForURL('**/user_dashboard.html');
        assert(!(await calls(trustedLogin)).some(c => c.kind === 'emailMfaVerify'), 'a server-validated fresh same-account trust marker skips the repeat OTP');
        await trustedLogin.close();

        const uncheckedLogin = await setup({ role: 'customer', trustedDeviceUserId: 'fixture-user' });
        await uncheckedLogin.evaluate(() => localStorage.setItem('inigosync-email-mfa-device:v1:fixture-user', 'b'.repeat(64)));
        await passwordLogin(uncheckedLogin);
        await uncheckedLogin.waitForURL('**/user_dashboard.html');
        const uncheckedCalls = await calls(uncheckedLogin);
        const uncheckedBegin = uncheckedCalls.find(call => call.kind === 'function' && call.data?.body?.action === 'begin');
        assert.equal(uncheckedBegin?.data?.body?.remember, false, 'unchecked choice does not create new trust');
        assert.equal(uncheckedBegin?.data?.body?.device_secret, 'b'.repeat(64), 'existing server-validated trust remains available when Remember me is unchecked');
        assert(!(uncheckedCalls).some(call => call.kind === 'emailMfaVerify'));
        await uncheckedLogin.close();

        const otherAccount = await setup({ role: 'customer', userId: 'other-user' });
        await otherAccount.evaluate(() => localStorage.setItem('inigosync-email-mfa-device:v1:fixture-user', 'c'.repeat(64)));
        await passwordLogin(otherAccount, 'login', true);
        await otherAccount.locator('[data-auth-panel="verify"].is-active').waitFor();
        const otherAccountBegin = (await calls(otherAccount)).find(call => call.kind === 'function' && call.data?.body?.action === 'begin');
        assert.notEqual(otherAccountBegin?.data?.body?.device_secret, 'c'.repeat(64),
            'a stored secret for another user is never presented as this user’s trust proof');
        assert.equal(await otherAccount.evaluate(() => localStorage.getItem('inigosync-email-mfa-device:v1:other-user')),
            otherAccountBegin?.data?.body?.device_secret,
            'Remember me creates a distinct secret under the current account id');
        await otherAccount.close();

        for (const role of ['staff', 'admin']) {
            const page = await setup({ role });
            await passwordLogin(page, 'admin', true);
            await page.locator('[data-auth-panel="verify"].is-active').waitFor();
            for (let i = 0; i < 6; i++) await page.locator('[data-otp-box]').nth(i).fill(String(i + 1));
            await page.locator('[data-auth-panel="verify"] button[type="submit"]').click();
            await page.waitForURL(role === 'staff' ? '**/staff_dashboard.html' : '**/owner_dashboard.html');
            assert((await calls(page)).some(call => call.kind === 'emailMfaVerify' && call.data?.remember === true),
                `${role} password login submits the selected Remember me choice to the server`);
            await page.close();
        }

        // Reproduce a staged deploy where the app includes the onboarding
        // guard but the live profiles table has not received that column yet.
        // Existing customer/admin and legacy active-staff sessions must reach
        // their dashboards; pending staff must remain inside the onboarding gate.
        for (const role of ['customer', 'staff', 'admin']) {
            const page = await setup({ role, guardDashboard: true, missingOnboardingColumn: true });
            await passwordLogin(page, role === 'customer' ? 'login' : 'admin');
            await page.locator('[data-auth-panel="verify"].is-active').waitFor();
            for (let i = 0; i < 6; i++) await page.locator('[data-otp-box]').nth(i).fill('123456'[i]);
            await page.locator('[data-auth-panel="verify"] button[type="submit"]').click();
            const destination = role === 'customer' ? '**/user_dashboard.html'
                : role === 'admin' ? '**/owner_dashboard.html' : '**/staff_dashboard.html';
            await page.waitForURL(destination);
            await page.waitForFunction(() => window.inigosyncProfile?.id === 'fixture-user');
            assert.equal(await page.evaluate(() => window.inigosyncProfile.role), role,
                `${role} profile fallback lets the valid session reach its dashboard`);
            assert((await calls(page)).filter(call => call.kind === 'signOut').length === 0,
                `${role} is not signed out because the optional onboarding column is absent`);
            await page.close();
        }

        const signupOtp = await setup({ emailConfirmation: true, emailMfaNoSendOnResend: true });
        await signup(signupOtp, '', true);
        await signupOtp.locator('[data-auth-panel="verify"].is-active').waitFor();
        assert.equal(await signupOtp.locator('[data-auth-panel="signup"] [name="remember"]').isChecked(), true);
        assert.equal(await signupOtp.locator('[data-auth-panel="verify"] [data-verify-heading]').innerText(), 'Verify your email', 'signup always keeps its first email confirmation step');
        assert.match(await signupOtp.locator('[data-otp-timer]').innerText(), /^Resend available in (?:60|5\d)s$/, 'signup resend waits for Supabase Auth’s default per-email cooldown');
        assert((await calls(signupOtp)).some(c => c.kind === 'signUp'));
        await signupOtp.evaluate(() => {
            const resend = document.querySelector('[data-otp-resend]');
            resend.disabled = false;
            resend.click();
        });
        await signupOtp.waitForFunction(() => document.querySelector('[data-auth-notice]').textContent === 'A new sign-up code was sent. Check your inbox.');
        assert.match(await signupOtp.locator('[data-otp-timer]').innerText(), /^Resend available in (?:60|5\d)s$/, 'successful signup resend reports the request and restarts the full cooldown');
        assert.equal(await signupOtp.locator('[data-otp-resend]').isDisabled(), true);
        assert((await calls(signupOtp)).some(c => c.kind === 'resend' && c.data.type === 'signup'));
        assert.equal((await calls(signupOtp)).find(call => call.kind === 'resend')?.data?.email, 'customer@example.test',
            'signup resend targets the exact address shown for the pending confirmation');
        for (let i = 0; i < 6; i++) await signupOtp.locator('[data-otp-box]').nth(i).fill(String(i + 1));
        await signupOtp.locator('[data-auth-panel="verify"] button[type="submit"]').click();
        await signupOtp.locator('[data-auth-panel="verify"] [data-verify-heading]').filter({hasText:"Confirm it's you"}).waitFor();
        assert.match(await signupOtp.locator('[data-auth-notice]').innerText(), /email is confirmed.*separate 6-digit sign-in code/i, 'signup confirmation is clearly distinguished from the separate sign-in OTP');
        assert((await calls(signupOtp)).some(c => c.kind === 'function' && c.data?.body?.action === 'begin'), 'signup confirmation continues through the required second email-verification gate');
        await signupOtp.evaluate(() => {
            const resend = document.querySelector('[data-otp-resend]');
            resend.disabled = false;
            resend.click();
        });
        await signupOtp.waitForFunction(() => document.querySelector('[data-auth-notice]').textContent.includes('A sign-in code was sent recently'));
        assert.match(await signupOtp.locator('[data-otp-timer]').innerText(), /^Resend available in (?:60|5\d)s$/, 'database-throttled sign-in resend keeps the full cooldown');
        assert.equal(await signupOtp.locator('[data-otp-resend]').isDisabled(), true);
        assert(!/A new sign-in code was sent/.test(await signupOtp.locator('[data-auth-notice]').innerText()), 'database-throttled post-signup MFA resend does not claim a new code was sent');
        for (let i = 0; i < 6; i++) await signupOtp.locator('[data-otp-box]').nth(i).fill(String(i + 1));
        await signupOtp.locator('[data-auth-panel="verify"] button[type="submit"]').click();
        await signupOtp.waitForURL('**/user_dashboard.html');
        assert((await calls(signupOtp)).some(call => call.kind === 'rememberSessionChoice' && call.data?.remember === true),
            'confirmed signup retains the selected Remember me session choice');
        await signupOtp.close();

        const failedPostSignupMfa = await setup({ emailConfirmation: true, emailMfaBeginError: true });
        await signup(failedPostSignupMfa);
        await failedPostSignupMfa.locator('[data-auth-panel="verify"].is-active').waitFor();
        for (let i = 0; i < 6; i++) await failedPostSignupMfa.locator('[data-otp-box]').nth(i).fill(String(i + 1));
        await failedPostSignupMfa.locator('[data-auth-panel="verify"] button[type="submit"]').click();
        await failedPostSignupMfa.locator('[data-auth-panel="verify"] [data-verify-heading]').filter({hasText:"Confirm it's you"}).waitFor();
        assert.match(await failedPostSignupMfa.locator('[data-auth-notice]').innerText(), /email is confirmed, but we could not send the separate sign-in code/i);
        assert.match(await failedPostSignupMfa.locator('[data-otp-timer]').innerText(), /^Resend available in (?:60|5\d)s$/);
        await failedPostSignupMfa.waitForFunction(() => {
            const loading = document.querySelector('.inigo-loading-overlay');
            return loading?.hidden === true && !loading.hasAttribute('data-open');
        });
        assert.equal(await failedPostSignupMfa.locator('.inigo-loading-overlay').evaluate(el => el.hidden && !el.hasAttribute('data-open')), true,
            'failed initial MFA delivery clears the blocking loading overlay so the retry UI is usable');
        assert.equal((await calls(failedPostSignupMfa)).filter(call => call.kind === 'function' && call.data?.body?.action === 'begin').length, 1);
        assert.equal(Boolean(await failedPostSignupMfa.evaluate(async () => (await sb.auth.getSession()).data.session)), true,
            'the validated signup session is preserved for the second-step retry');
        assert.equal((await calls(failedPostSignupMfa)).filter(call => call.kind === 'resend').length, 0,
            'failed second-step delivery must not resend a consumed signup confirmation OTP');
        assert.equal(await failedPostSignupMfa.url().includes('user_dashboard.html'), false,
            'failed second-step delivery does not complete sign-in');
        for (let i = 0; i < 6; i++) await failedPostSignupMfa.locator('[data-otp-box]').nth(i).fill(String(i + 1));
        await failedPostSignupMfa.locator('[data-auth-panel="verify"] button[type="submit"]').click();
        await failedPostSignupMfa.waitForFunction(() => document.querySelector('[data-auth-notice]').textContent.includes('no sign-in code has been sent yet'));
        assert.equal((await calls(failedPostSignupMfa)).filter(call => call.kind === 'function' && call.data?.body?.action === 'verify').length, 0,
            'Verify cannot submit with an empty challenge id after a failed begin');
        assert.equal((await calls(failedPostSignupMfa)).filter(call => call.kind === 'emailMfaVerify').length, 0,
            'no code can be rejected against a nonexistent challenge');
        await failedPostSignupMfa.evaluate(() => {
            const resend = document.querySelector('[data-otp-resend]');
            resend.disabled = false;
        });
        await failedPostSignupMfa.locator('[data-otp-resend]').click();
        await failedPostSignupMfa.waitForFunction(() => document.querySelector('[data-auth-notice]').textContent === 'A new sign-in code was sent. Check your inbox.');
        assert.equal((await calls(failedPostSignupMfa)).filter(call => call.kind === 'function' && call.data?.body?.action === 'begin').length, 2,
            'retry starts a fresh server-bound MFA challenge');
        assert.equal((await calls(failedPostSignupMfa)).filter(call => call.kind === 'resend').length, 0);
        for (let i = 0; i < 6; i++) await failedPostSignupMfa.locator('[data-otp-box]').nth(i).fill(String(i + 1));
        await failedPostSignupMfa.locator('[data-auth-panel="verify"] button[type="submit"]').click();
        await failedPostSignupMfa.waitForURL('**/user_dashboard.html');
        await failedPostSignupMfa.close();

        const confirmedSignupNativeProof = await setup({ emailConfirmation: true, nativeEmailProof: true });
        await signup(confirmedSignupNativeProof);
        await confirmedSignupNativeProof.locator('[data-auth-panel="verify"].is-active').waitFor();
        for (let i = 0; i < 6; i++) await confirmedSignupNativeProof.locator('[data-otp-box]').nth(i).fill(String(i + 1));
        await confirmedSignupNativeProof.locator('[data-auth-panel="verify"] button[type="submit"]').click();
        await confirmedSignupNativeProof.waitForURL('**/user_dashboard.html');
        assert.equal((await calls(confirmedSignupNativeProof)).filter(call => call.kind === 'function' && call.data?.body?.action === 'begin').length, 1);
        assert(!(await calls(confirmedSignupNativeProof)).some(call => call.kind === 'emailMfaVerify'),
            'the confirmed signup email code is not followed by a duplicate sign-in email code');
        await confirmedSignupNativeProof.close();

        const rateLimitedResend = await setup({ emailConfirmation: true, resendErrorCode: 'over_email_send_rate_limit' });
        await signup(rateLimitedResend);
        await rateLimitedResend.locator('[data-auth-panel="verify"].is-active').waitFor();
        await rateLimitedResend.evaluate(() => {
            const resend = document.querySelector('[data-otp-resend]');
            resend.disabled = false;
            resend.click();
        });
        await rateLimitedResend.waitForFunction(() => document.querySelector('[data-auth-notice]').textContent.includes('Too many attempts'));
        assert.match(await rateLimitedResend.locator('[data-otp-timer]').innerText(), /^Resend available in (?:60|5\d)s$/, 'rate-limited resend enforces a full wait before another request');
        assert.equal(await rateLimitedResend.locator('[data-otp-resend]').isDisabled(), true);
        await rateLimitedResend.close();

        const throttledLoginResend = await setup({ emailMfaNoSendOnResend: true });
        await passwordLogin(throttledLoginResend);
        await throttledLoginResend.locator('[data-auth-panel="verify"].is-active').waitFor();
        await throttledLoginResend.evaluate(() => {
            const resend = document.querySelector('[data-otp-resend]');
            resend.disabled = false;
            resend.click();
        });
        await throttledLoginResend.waitForFunction(() => document.querySelector('[data-auth-notice]').textContent.includes('A code was sent recently'));
        assert.match(await throttledLoginResend.locator('[data-otp-timer]').innerText(), /^Resend available in (?:60|5\d)s$/, 'database-throttled login resend does not claim a code was sent and enforces the full cooldown');
        assert.equal(await throttledLoginResend.locator('[data-otp-resend]').isDisabled(), true);
        assert.equal((await calls(throttledLoginResend)).filter(c => c.kind === 'function' && c.data?.body?.action === 'begin').length, 2);
        await throttledLoginResend.close();

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
            await page.waitForFunction(() => document.querySelector('[data-signup-phone-status]').textContent.includes('available for this account'));
            const currentCalls = await calls(page);
            const validationCall = currentCalls.find(c => c.kind === 'function');
            assert.equal(validationCall.data.name, 'validate-contact-phone');
            assert.deepEqual(validationCall.data.body, { phone: '09171234567' });
            const profileWrite = currentCalls.find(c => c.kind === 'profileWrite');
            assert.deepEqual(profileWrite.data, { contact_num: '+639171234567' });
            assert.equal(Object.hasOwn(profileWrite.data, 'phone_verified'), false);
            assert.match(await page.locator('[data-signup-phone-status]').innerText(), /available for this account/);
            await page.locator('[data-signup-phone-skip]').click();
            await page.waitForURL('**/user_dashboard.html');
            await page.close();
        }

        for (const validationReason of ['invalid', 'in_use']) {
            const page = await setup({ validationReason }); await signup(page, '09171234567');
            await page.locator('[data-signup-phone-validate]').click();
            await page.locator('[data-auth-notice]').waitFor({ state: 'visible' });
            if (validationReason === 'in_use') assert.match(await page.locator('[data-auth-notice]').innerText(), /already linked to another account/i);
            assert(!(await calls(page)).some(c => c.kind === 'profileWrite'), validationReason);
            await page.locator('[data-signup-phone-skip]').click();
            await page.waitForURL('**/user_dashboard.html'); await page.close();
        }
        for (const validationError of ['rate limit', 'availability unavailable']) {
            const page = await setup({ validationError, validationStatus: validationError === 'rate limit' ? 429 : 503 });
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
        assert.equal((await calls(dashboard)).filter(c => c.kind === 'function').length, 1, 'one valid changed number triggers one automatic database check');
        await dashboard.locator('[data-dash-mobile-validate]').click();
        await dashboard.locator('[data-dash-confirm-modal]').waitFor({ state: 'visible' });
        assert.equal((await calls(dashboard)).filter(c => c.kind === 'profileWrite' && Object.hasOwn(c.data, 'contact_num')).length, 0, 'validated phone waits for save confirmation');
        await dashboard.locator('[data-dash-confirm-accept]').click();
        await dashboard.waitForFunction(() => JSON.parse(sessionStorage.getItem('fixture-calls') || '[]').some(c => c.kind === 'profileWrite'));
        const dashboardCalls = await calls(dashboard);
        assert.deepEqual(dashboardCalls.find(c => c.kind === 'function').data, { name: 'validate-contact-phone', body: { phone: '09171234567', purpose: 'contact' } });
        assert.deepEqual(dashboardCalls.find(c => c.kind === 'profileWrite' && Object.hasOwn(c.data, 'contact_num')).data, { contact_num: '09171234567' });
        assert.equal(dashboardCalls.filter(c => c.kind === 'function').length, 1, 'saving consumes the proof from the completed database check');
        assert.match(await dashboard.locator('[data-dash-mobile-status]').innerText(), /Saved contact number/);
        await mobileInput.fill('09171234567');
        await dashboard.waitForFunction(() => document.querySelector('[data-dash-mobile-status]').textContent.includes('available for this account'));
        assert.equal((await calls(dashboard)).filter(c => c.kind === 'function').length, 1, 'recent same-number check is reused');

        await dashboard.locator('[data-dash-settings-emergency-number]').fill('09171234567');
        await dashboard.waitForFunction(() => document.querySelector('[data-dash-emergency-status]').textContent.includes('Valid Philippine mobile number'));
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

        const rejectedDashboard = await setupDashboard({ validationReason: 'in_use' });
        await rejectedDashboard.locator('[data-dash-nav="settings"]').first().click();
        await rejectedDashboard.locator('[data-dash-personal-edit]').click();
        await rejectedDashboard.locator('[data-dash-settings-mobile]').fill('09171234567');
        await rejectedDashboard.waitForFunction(() => document.querySelector('[data-dash-mobile-status]').textContent.includes('already linked'));
        assert(!(await calls(rejectedDashboard)).some(c => c.kind === 'profileWrite'));
        await rejectedDashboard.close();

        await runLogoutConfirmationTests();

        console.log('PASS signup and customer contact number validation: no unproved signup metadata, format and database availability required, failures do not save, and recent results avoid duplicate checks');
        console.log('PASS early email checks: taken/available, edit recovery, stale responses, network failure, rate limit and final-signup races');
        console.log('PASS OAuth role/disabled rejections, customer OAuth, email-confirmed and immediate signup, optional/invalid number, validation failure, and no SMS or Auth phone OTP');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
