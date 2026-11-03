// Runtime browser coverage for staff setup. Run with `node scripts/preview.cjs`
// and PLAYWRIGHT_MODULE set as documented in docs/RESERVATION_RELIABILITY_RESULTS.md.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

function supabaseFixture(profile) {
    window.__onboardingQa = { updates: [], profile, currentAuthPassword: 'temporary-password' };
    const qa = window.__onboardingQa;
    window.SUPABASE_URL = 'https://qa.supabase.test';
    window.InigoPasswordVerifier = {
        verifyCurrentPassword: async ({ email, password, userId }) => {
            qa.verifiedPasswords = qa.verifiedPasswords || [];
            qa.verifiedPasswords.push(password);
            return email === 'staff@qa.test' && userId === profile.id && password === qa.currentAuthPassword;
        },
    };
    window.sb = {
        auth: {
            getSession: async () => ({ data: { session: { user: { id: profile.id, email: 'staff@qa.test' }, access_token: 'qa-access-token' } } }),
            updateUser: async ({ password }) => {
                qa.updates.push(password);
                qa.currentAuthPassword = password;
                return { error: null };
            },
            signOut: async () => ({ error: null }),
        },
        from(table) {
            const query = {
                select() { return query; }, eq() { return query; },
                single: async () => table === 'profiles' ? { data: profile, error: null } : { data: null, error: null },
                maybeSingle: async () => ({ data: null, error: null }), update() { return query; },
                then(resolve, reject) { return Promise.resolve({ data: null, error: null }).then(resolve, reject); },
            };
            return query;
        },
        rpc: async () => ({ data: null, error: null }),
    };
}

async function preparePage(browser, profile, requests = [], phoneChecks = []) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    if (process.env.STAFF_ONBOARDING_QA_THEME === 'dark') {
        await context.addInitScript(() => localStorage.setItem('inigosync-theme', 'dark'));
    }
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https:\/\//, route => route.abort());
    await page.route('**/Config/supabaseClient.js', route => route.fulfill({
        contentType: 'application/javascript', body: `(${supabaseFixture})(${JSON.stringify(profile)});`,
    }));
    await page.route('**/includes/emailMfa.js', route => route.fulfill({ contentType: 'application/javascript', body: 'window.InigoEmailMfa={check:async()=>({verified:true})};' }));
    await page.route('**/Pages/staff_dashboard.html', route => route.fulfill({ contentType: 'text/html', body: '<main><h1>Dashboard fixture</h1></main>' }));
    await page.route('**/functions/v1/validate-contact-phone', async route => {
        const payload = route.request().postDataJSON();
        phoneChecks.push(payload);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, normalized: '+639171234567', available: payload.purpose !== 'emergency' }) });
    });
    await page.route('**/functions/v1/complete-staff-onboarding', async route => {
        requests.push(route.request().postDataJSON());
        if (requests.length === 1) {
            await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Completion failed in fixture' }) });
            return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    });
    await page.goto('http://127.0.0.1:4178/Pages/staff_onboarding.html', { waitUntil: 'domcontentloaded' });
    return { context, page, errors };
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const profile = { id: 'qa-pending-staff', role: 'staff', status: 'pending', onboarding_complete: false };
        const requests = [], phoneChecks = [];
        const pending = await preparePage(browser, profile, requests, phoneChecks);
        try {
            const page = pending.page;
            await page.locator('[data-staff-onboarding-step="password"]:visible').waitFor();
            if (process.env.STAFF_ONBOARDING_QA_DIR) await page.screenshot({ path: path.join(process.env.STAFF_ONBOARDING_QA_DIR, 'progressive-password.png') });
            await page.locator('#staffSetupPassword').fill('Secure@123');
            await page.locator('#staffSetupConfirm').fill('Secure@123');
            await page.locator('[data-staff-onboarding-submit]').click();
            await page.locator('[data-staff-onboarding-step="name"]:visible').waitFor();
            if (process.env.STAFF_ONBOARDING_QA_DIR) await page.screenshot({ path: path.join(process.env.STAFF_ONBOARDING_QA_DIR, 'progressive-name.png') });
            assert.deepEqual(await page.evaluate(() => window.__onboardingQa.updates), [], 'Step 1 stores no password and makes no Auth change');

            await page.locator('[data-staff-onboarding-submit]').click();
            await page.getByRole('alert').getByText('first and last name').waitFor();
            assert.deepEqual(await page.evaluate(() => window.__onboardingQa.updates), [], 'invalid required details cannot update Auth');
            await page.locator('#staffSetupFirstName').fill('QA');
            await page.locator('#staffSetupLastName').fill('Staff');
            await page.locator('[data-staff-onboarding-submit]').click();
            await page.locator('[data-staff-onboarding-step="personal"]:visible').waitFor();
            if (process.env.STAFF_ONBOARDING_QA_DIR) await page.screenshot({ path: path.join(process.env.STAFF_ONBOARDING_QA_DIR, 'progressive-personal.png') });
            assert.deepEqual(await page.evaluate(() => window.__onboardingQa.updates), [], 'completing the name step does not update Auth');
            await page.locator('[data-staff-onboarding-submit]').click();
            await page.getByRole('alert').getByText('Enter your birthdate').waitFor();
            assert.deepEqual(await page.evaluate(() => window.__onboardingQa.updates), [], 'missing required personal details cannot update Auth');
            const adultCutoff = await page.locator('#staffSetupBirthdate').getAttribute('max');
            const underageDate = new Date(`${adultCutoff}T00:00:00Z`);
            underageDate.setUTCDate(underageDate.getUTCDate() + 1);
            await page.locator('#staffSetupBirthdate').fill(underageDate.toISOString().slice(0, 10));
            await page.locator('[data-staff-onboarding-submit]').click();
            await page.getByRole('alert').getByText('at least 18 years old').waitFor();
            assert.deepEqual(await page.evaluate(() => window.__onboardingQa.updates), [], 'an underage birthdate cannot update Auth');
            await page.locator('#staffSetupBirthdate').fill(adultCutoff);
            await page.locator('#staffSetupGender').selectOption('Prefer not to say');
            await page.locator('#staffSetupCivilStatus').selectOption('Single');
            await page.locator('#staffSetupAddress').fill('Lucena City');
            await page.locator('[data-staff-onboarding-submit]').click();
            await page.locator('[data-staff-onboarding-step="contact"]:visible').waitFor();
            if (process.env.STAFF_ONBOARDING_QA_DIR) await page.screenshot({ path: path.join(process.env.STAFF_ONBOARDING_QA_DIR, 'progressive-contact.png') });
            assert.deepEqual(await page.evaluate(() => window.__onboardingQa.updates), [], 'completing personal details does not update Auth');

            await page.locator('#staffSetupMobile').fill('09171234567');
            await page.getByText('Valid and available.').waitFor();
            assert.ok(phoneChecks.some(check => check.purpose === 'contact'), 'entered mobile is checked through the server validator');
            await page.locator('#staffSetupEmergencyNumber').fill('invalid');
            await page.locator('[data-staff-onboarding-emergency-status][data-state="invalid"]').waitFor();
            await page.locator('#staffSetupEmergencyNumber').fill('09171234567');
            await page.getByText('This number is already on file; it can still be used as an emergency contact.').waitFor();
            assert.ok(phoneChecks.some(check => check.purpose === 'emergency'), 'emergency mobile is checked before final submission');
            await page.locator('#staffSetupEmergencyNumber').fill('');
            await page.locator('[data-staff-onboarding-open-privacy]').click();
            await page.frameLocator('[data-staff-onboarding-privacy-modal] iframe').locator('#policy-content').waitFor();
            if (process.env.STAFF_ONBOARDING_QA_DIR) await page.screenshot({ path: path.join(process.env.STAFF_ONBOARDING_QA_DIR, 'progressive-privacy.png') });
            await page.locator('[data-privacy-disagree]').first().click();
            assert.equal(await page.locator('[data-staff-onboarding-privacy-checkbox]').isChecked(), false, 'X/Disagree never agrees');
            await page.locator('[data-staff-onboarding-submit]').click();
            await page.getByRole('alert').getByText('agree to the Privacy Policy').waitFor();
            assert.deepEqual(await page.evaluate(() => window.__onboardingQa.updates), [], 'missing consent cannot update Auth');

            await page.locator('[data-staff-onboarding-open-privacy]').click();
            await page.locator('[data-privacy-agree]').click();
            assert.equal(await page.locator('[data-staff-onboarding-privacy-checkbox]').isChecked(), true, 'Agree checks the required consent box');
            await page.locator('[data-staff-onboarding-open-privacy]').click();
            await page.locator('[data-privacy-disagree]').first().click();
            assert.equal(await page.locator('[data-staff-onboarding-privacy-checkbox]').isChecked(), false, 'X/Disagree also clears a previous agreement');
            await page.locator('[data-staff-onboarding-open-privacy]').click();
            await page.locator('[data-privacy-agree]').click();
            await page.locator('[data-staff-onboarding-submit]').click();
            await page.locator('.inigo-loading-overlay[data-open]').waitFor();
            await page.getByRole('alert').getByText('Completion failed in fixture').waitFor();
            assert.deepEqual(await page.evaluate(() => window.__onboardingQa.updates), ['Secure@123'], 'Auth update happens only on the final submission');
            assert.equal(await page.locator('[data-staff-onboarding-saving]').isHidden(), true, 'saving state clears after completion failure');

            await page.locator('[data-staff-onboarding-submit]').click();
            await page.getByRole('heading', { name: 'Setup complete' }).waitFor();
            assert.deepEqual(await page.evaluate(() => window.__onboardingQa.updates), ['Secure@123'], 'retry after completion failure verifies and reuses the saved password');
            assert.deepEqual(await page.evaluate(() => window.__onboardingQa.verifiedPasswords), ['Secure@123']);
            assert.equal(requests.length, 2, 'completion can be retried after endpoint failure');
            assert.deepEqual(requests[1], {
                first_name: 'QA', middle_name: '', last_name: 'Staff', contact_num: '+639171234567',
                birthdate: adultCutoff, address: 'Lucena City', gender: 'Prefer not to say', civil_status: 'Single',
                emergency_contact_name: '', emergency_contact_number: '', privacy_policy_accepted: true, password: 'Secure@123',
            });
            assert.deepEqual(pending.errors, [], 'pending onboarding has no browser errors');
        } finally { await pending.context.close(); }

        const active = await preparePage(browser, { id: 'qa-active-staff', role: 'staff', status: 'active', onboarding_complete: true });
        try {
            await active.page.getByRole('heading', { name: 'Dashboard fixture' }).waitFor();
            assert.deepEqual(active.errors, [], 'completed staff bypass onboarding without browser errors');
        } finally { await active.context.close(); }

        const mobile = await preparePage(browser, profile);
        try {
            await mobile.page.locator('[data-staff-onboarding-step="password"]:visible').waitFor();
            assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile onboarding has no horizontal overflow');
        } finally { await mobile.context.close(); }
        console.log('Staff onboarding browser flow passed (deferred password, required details, live phone validation, consent, retry, completed staff, mobile layout).');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
