// No real users, credentials, emails or SMS: provider responses are deterministic fixtures.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
function mockClient(options) {
    const user = { id: 'fixture-user', identities: [{ provider: 'email' }] };
    let session = options.oauth || options.dashboard ? { user } : null;
    const record = (kind, data) => {
        const calls = JSON.parse(sessionStorage.getItem('fixture-calls') || '[]');
        calls.push({ kind, data }); sessionStorage.setItem('fixture-calls', JSON.stringify(calls));
    };
    if (options.oauth) sessionStorage.setItem('inigosync-oauth-pending', '1');
    window.InigoAuthStorage = { setRememberSession() {} };
    window.sb = {
        rpc: (name, data) => {
            if (name === 'record_account_session_event') {
                record('accountSessionEvent', data);
                return Promise.resolve({ data: true, error: null });
            }
            return { abortSignal: async () => {
            record('emailCheck', data);
            if (data.email_address === 'slow@example.test') await new Promise(resolve => setTimeout(resolve, 900));
            if (options.emailMode === 'error') return { error: { message: 'Network error' } };
            return { data: options.emailMode === 'rate_limited' ? 'rate_limited' : ['taken@example.test', 'slow@example.test'].includes(data.email_address) ? 'taken' : 'available' };
            } };
        },
        auth: {
            getSession: async () => ({ data: { session } }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            signOut: async () => { record('signOut'); session = null; return {}; },
            signInWithPassword: async () => { session = { user }; return { data: { user, session } }; },
            signInWithOtp: async data => { record('emailOtp', data); return {}; },
            signUp: async data => {
                record('signUp', data);
                if (options.registrationRace === 'error') return { data: {}, error: { code: 'user_already_exists', message: 'Already registered' } };
                if (options.registrationRace === 'identities') return { data: { user: { ...user, identities: [] }, session: null } };
                session = options.emailConfirmation ? null : { user }; return { data: { user, session } };
            },
            updateUser: async data => {
                record('updateUser', data);
                return {};
            },
            verifyOtp: async data => {
                record('verifyOtp', data);
                if (data.type === 'signup') { session = { user }; return {}; }
                return data.token === '123456' ? {} : { error: { message: 'Token expired' } };
            },
            getUser: async () => ({ data: { user } }),
            signInWithOAuth: async data => { record('oauth', data); return { error: { message: 'Fixture stopped redirect' } }; }
        },
        functions: {
            invoke: async (name, args) => {
                record('function', { name, body: args?.body });
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
                update(data) { record('profileWrite', data); write = true; return query; },
                upsert: async data => { record('sessionWrite', data); return {}; },
                single: async () => write ? { data: { id: user.id } } : profile(),
                maybeSingle: async () => write ? { data: { id: user.id } } : profile(),
                then(resolve, reject) { return Promise.resolve(write ? { data: null, error: null } : { data: [], error: null }).then(resolve, reject); }
            };
            return query;
        }
    };
    function profile() {
        return { data: { id: user.id, role: options.role || 'customer', status: options.disabled ? 'disabled' : 'active', contact_num: options.contactNum || null, contact_num_validated: options.contactNumValidated || false, contact_num_validated_at: options.contactNumValidatedAt || null } };
    }
}
(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        async function setup(options = {}) {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
            page.setDefaultTimeout(10000);
            await page.route(/^https:\/\//, r => r.abort());
            await page.route('**/Config/supabaseClient.js', r => r.fulfill({ contentType: 'application/javascript', body: `(${mockClient})(${JSON.stringify(options)})` }));
            await page.route('**/includes/landingPage.js', r => r.fulfill({ contentType: 'application/javascript', body: '' }));
            await page.route('https://elfsightcdn.com/**', r => r.abort());
            await page.route('**/*dashboard.html', r => r.fulfill({ contentType: 'text/html', body: '<h1>Dashboard fixture</h1>' }));
            await page.goto('http://127.0.0.1:4178/index.html', { waitUntil: 'domcontentloaded' });
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
        const taken = await setup();
        const takenForm = await firstStep(taken, 'Taken@Example.test');
        await taken.waitForFunction(() => document.querySelector('[data-signup-email-status]').textContent.includes('Not available'));
        await taken.screenshot({ path: require('node:path').join(require('node:os').tmpdir(), 'inigosync-email-taken.png') });
        await takenForm.locator('[data-signup-next]').click();
        assert(await takenForm.locator('[data-signup-step="1"]').evaluate(el => el.classList.contains('is-active')));
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
        async function signup(page, phone = '') {
            await page.locator('.cta-buttons [data-auth-open]').click();
            await page.locator('[role="tab"][data-auth-tab="signup"]').click();
            const form = page.locator('[data-auth-panel="signup"]');
            await form.locator('[name="email"]').fill('customer@example.test');
            await form.locator('[name="password"]').fill('Fixture2026!');
            await form.locator('[data-signup-next]').click();
            await form.locator('[name="surname"]').fill('Tester');
            await form.locator('[name="firstname"]').fill('Customer');
            await form.locator('[name="mobile"]').fill(phone);
            await form.locator('[name="terms"]').check();
            await form.locator('button[type="submit"]').click();
        }
        for (const role of ['admin', 'staff']) {
            const page = await setup({ oauth: true, role });
            await page.locator('[data-auth-access-error]').waitFor({ state: 'visible' });
            assert.match(await page.locator('[data-auth-access-error]').innerText(), /cannot be used for customer/);
            assert((await calls(page)).some(c => c.kind === 'signOut'));
            assert(!(await calls(page)).some(c => ['profileWrite', 'sessionWrite'].includes(c.kind)));
            assert(await page.evaluate(async () => !(await sb.auth.getSession()).data.session));
            await page.close();
        }
        const disabled = await setup({ oauth: true, disabled: true });
        await disabled.locator('[data-auth-access-error]').waitFor({ state: 'visible' });
        assert.match(await disabled.locator('[data-auth-access-error]').innerText(), /disabled/);
        await disabled.close();
        const customer = await setup({ oauth: true });
        await customer.waitForURL('**/user_dashboard.html');
        const customerSessionEvents = (await calls(customer)).filter(call => call.kind === 'accountSessionEvent');
        assert.deepEqual(customerSessionEvents.map(call => call.data), [{ p_kind: 'sign_in', p_reason: 'app_login' }], 'successful authentication records sign-in through the server-derived account session RPC without a client actor ID');
        await customer.close();
        for (const role of ['staff', 'admin', 'customer']) {
            const page = await setup({ role });
            await page.locator('.cta-buttons [data-auth-open]').click();
            const panel = role === 'customer' ? 'admin' : 'login';
            if (panel === 'admin') await page.locator('[data-auth-tab="admin"]').click();
            const form = page.locator(`[data-auth-panel="${panel}"]`);
            await form.locator('input[type="email"]').fill('account@example.test');
            await form.locator('input[type="password"]').fill('Fixture2026!');
            await form.locator('button[type="submit"]').click();
            await page.locator('[data-auth-access-error]').waitFor({ state: 'visible' });
            assert(!(await calls(page)).some(c => ['emailOtp', 'sessionWrite'].includes(c.kind)));
            assert((await calls(page)).some(c => c.kind === 'signOut'));
            await page.close();
        }
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
            assert.match(await page.locator('[data-signup-error-for="email"]').innerText(), /already registered/);
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
            await page.waitForFunction(() => document.querySelector('[data-signup-phone-status]').textContent.length > 0);
            assert(!(await calls(page)).some(c => c.kind === 'profileWrite'), validationReason);
            await page.locator('[data-signup-phone-skip]').click();
            await page.waitForURL('**/user_dashboard.html'); await page.close();
        }
        for (const validationError of ['budget exceeded', 'provider unavailable']) {
            const page = await setup({ validationError, validationStatus: validationError === 'budget exceeded' ? 429 : 503 });
            await signup(page, '09171234567');
            await page.locator('[data-signup-phone-validate]').click();
            await page.waitForFunction(() => document.querySelector('[data-signup-phone-status]').textContent.includes('unavailable') || document.querySelector('[data-signup-phone-status]').textContent.includes('budget'));
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

        const dashboard = await setupDashboard();
        await dashboard.locator('[data-dash-nav="settings"]').first().click();
        const mobileInput = dashboard.locator('[data-dash-settings-mobile]');
        await mobileInput.fill('09171234567');
        await dashboard.locator('[data-dash-mobile-validate]').click();
        await dashboard.waitForFunction(() => (JSON.parse(sessionStorage.getItem('fixture-calls') || '[]').filter(c => c.kind === 'function').length) === 1);
        await dashboard.waitForFunction(() => JSON.parse(sessionStorage.getItem('fixture-calls') || '[]').some(c => c.kind === 'profileWrite'));
        const dashboardCalls = await calls(dashboard);
        assert.deepEqual(dashboardCalls.find(c => c.kind === 'function').data, { name: 'validate-contact-phone', body: { phone: '09171234567' } });
        assert.deepEqual(dashboardCalls.find(c => c.kind === 'profileWrite').data, { contact_num: '+639171234567' });
        assert.equal(dashboardCalls.filter(c => c.kind === 'function').length, 1, 'one click must cause exactly one provider lookup');
        assert.match(await dashboard.locator('[data-dash-mobile-status]').innerText(), /does not confirm ownership/);
        await dashboard.locator('[data-dash-mobile-validate]').click();
        await dashboard.waitForFunction(() => document.querySelector('[data-dash-mobile-status]').textContent.includes('already validated'));
        assert.equal((await calls(dashboard)).filter(c => c.kind === 'function').length, 1, 'unchanged number must not use provider quota');
        await dashboard.close();

        const rejectedDashboard = await setupDashboard({ validationReason: 'inactive' });
        await rejectedDashboard.locator('[data-dash-nav="settings"]').first().click();
        await rejectedDashboard.locator('[data-dash-settings-mobile]').fill('09171234567');
        await rejectedDashboard.locator('[data-dash-mobile-validate]').click();
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
