// Focused browser checks for the owner dashboard's media usage thresholds.
// Run `node scripts/preview.cjs`, then:
//   $env:PLAYWRIGHT_MODULE='C:\path\to\node_modules\playwright'; node tests/owner-storage-usage.cjs
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

function installSupabaseFixture() {
    const createQuery = () => {
        const query = {
            select() { return query; },
            eq() { return query; },
            neq() { return query; },
            is() { return query; },
            in() { return query; },
            gte() { return query; },
            gt() { return query; },
            lte() { return query; },
            lt() { return query; },
            order() { return query; },
            limit() { return query; },
            range() { return query; },
            abortSignal() { return query; },
            insert() { return query; },
            update() { return query; },
            delete() { return query; },
            upsert() { return query; },
            single() { return Promise.resolve({ data: null, error: null }); },
            maybeSingle() { return Promise.resolve({ data: null, error: null }); },
            then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); },
        };
        return query;
    };
    window.SUPABASE_URL = 'https://owner-storage-qa.invalid';
    window.sb = {
        from: () => createQuery(),
        rpc: async () => ({ data: [], error: null }),
        storage: {
            from: () => ({
                list: async prefix => {
                    if (window.__mediaUnavailable) return { data: null, error: { message: 'Storage unavailable' } };
                    return { data: prefix ? [] : window.__mediaEntries, error: null };
                },
                upload: async () => ({ data: { path: 'qa/photo.jpg' }, error: null }),
                remove: async () => ({ error: null }),
                getPublicUrl: path => ({ data: { publicUrl: `https://owner-storage-qa.invalid/${path}` } }),
            }),
        },
        functions: { invoke: async () => ({ data: null, error: { message: 'Not configured in this fixture' } }) },
        auth: {
            getSession: async () => ({ data: { session: { access_token: 'qa-token', user: { id: 'qa-owner', email: 'owner@example.test' } } } }),
            getUser: async () => ({ data: { user: { id: 'qa-owner', email: 'owner@example.test', identities: [] } } }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            signOut: async () => ({}),
        },
    };
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 360, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    await page.addInitScript(() => {
        window.__mediaEntries = [];
        window.__mediaUnavailable = false;
        window.Chart = class Chart {
            constructor(canvas, config) {
                this.data = config.data;
                this.options = config.options;
                if (canvas.matches('[data-admin-perf-chart]')) window.__ownerStorageChart = this;
            }
            update() {}
        };
        window.Chart.defaults = { font: {}, color: '' };
    });
    await page.route(/^https:\/\//, route => route.abort());
    await page.route('**/Config/supabaseClient.js', route => route.fulfill({
        contentType: 'application/javascript',
        body: `(${installSupabaseFixture.toString()})();`,
    }));
    await page.route('**/includes/authGuard.js', route => route.fulfill({
        contentType: 'application/javascript',
        body: `window.inigosyncProfile={id:'qa-owner',role:'admin',status:'active',full_name:'QA Owner',email:'owner@example.test'};document.addEventListener('DOMContentLoaded',()=>{window.InigoLoading?.hide();document.documentElement.classList.remove('inigo-auth-pending');document.dispatchEvent(new CustomEvent('inigosync:profile-ready',{detail:window.inigosyncProfile}));});`,
    }));
    await page.route('**/includes/loadingOverlay.js', route => route.fulfill({
        contentType: 'application/javascript',
        body: `window.InigoLoading={show(){},hide(){}};window.InigoToast={show(){}};`,
    }));
    await page.route('**/includes/courts-data.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.route('**/includes/courtsData.js', route => route.fulfill({
        contentType: 'application/javascript',
        body: `window.InigoCourtsData={getCourts:async()=>[],getSports:async()=>[],invalidateCourts(){},monogramFor:()=>'',slugify:s=>s,rateHint:()=>null};`,
    }));

    try {
        await page.goto('http://127.0.0.1:4178/Pages/owner_dashboard.html', { waitUntil: 'domcontentloaded' });
        const storageRow = page.locator('[data-admin-perf-list] .admin-perf-item').filter({ hasText: 'Photo storage used' });
        await storageRow.waitFor();

        const referenceBytes = 1_000_000_000;
        const cases = [
            { label: '0%', bytes: 0, status: 'good', pill: 'Low use', used: '0 B' },
            { label: '25%', bytes: referenceBytes * 0.25, status: 'neutral', pill: 'Moderate', used: '250 MB' },
            { label: '50%', bytes: referenceBytes * 0.5, status: 'warn', pill: 'High use', used: '500 MB' },
            { label: '70%', bytes: referenceBytes * 0.7, status: 'problem', pill: 'Very high', used: '700 MB' },
            { label: '100%', bytes: referenceBytes, status: 'problem', pill: 'Very high', used: '1 GB' },
            { label: '125%', bytes: referenceBytes * 1.25, status: 'problem', pill: 'Very high' },
        ];
        const cssToken = {
            good: '--color-court-green', neutral: '--color-ink-faint',
            warn: '--color-perf-warn', problem: '--color-alert',
        };

        for (const item of cases) {
            await page.evaluate(bytes => {
                window.__mediaUnavailable = false;
                window.__mediaEntries = bytes ? [{ name: 'qa-photo.jpg', metadata: { size: bytes } }] : [];
            }, item.bytes);
            await page.locator('[data-admin-perf-run]').click();
            await page.waitForFunction(expected => {
                const row = [...document.querySelectorAll('[data-admin-perf-list] .admin-perf-item')]
                    .find(candidate => candidate.textContent.includes('Photo storage used'));
                return row?.querySelector('.admin-perf-pill')?.textContent.trim() === expected;
            }, item.pill);

            assert.equal(await storageRow.locator('.admin-perf-dot').getAttribute('class').then(value => value.split(' ').at(-1)), `admin-perf-dot-${item.status}`, `${item.label} dot`);
            assert.equal(await storageRow.locator('.admin-perf-pill').getAttribute('class').then(value => value.split(' ').at(-1)), `admin-perf-pill-${item.status}`, `${item.label} status`);
            assert.equal(await storageRow.locator('.admin-perf-bar > div').getAttribute('class').then(value => value.split(' ').at(-1)), `admin-perf-bar-fill-${item.status}`, `${item.label} bar`);
            assert.match(await storageRow.locator('.admin-perf-item-value').innerText(), new RegExp(`${item.label.replace('%', '\\.0%')}|${item.label}`));
            if (item.used) assert.match(await storageRow.locator('.admin-perf-item-value').innerText(), new RegExp(`${item.used} of 1 GB reference`));

            const color = await page.evaluate(token => {
                const probe = document.createElement('span');
                probe.style.backgroundColor = `var(${token})`;
                document.body.appendChild(probe);
                const resolved = getComputedStyle(probe).backgroundColor;
                probe.remove();
                return { resolved, tokenValue: getComputedStyle(document.documentElement).getPropertyValue(token).trim() };
            }, cssToken[item.status]);
            const actual = await storageRow.locator('.admin-perf-bar > div').evaluate(element => getComputedStyle(element).backgroundColor);
            assert.equal(actual, color.resolved, `${item.label} bar color`);
            const pillColor = await storageRow.locator('.admin-perf-pill').evaluate(element => getComputedStyle(element).color);
            assert.equal(pillColor, color.resolved, `${item.label} status color`);
            const dotColor = await storageRow.locator('.admin-perf-dot').evaluate(element => getComputedStyle(element).backgroundColor);
            assert.equal(dotColor, color.resolved, `${item.label} dot color`);
            const chartColor = await page.evaluate(() => {
                const chart = window.__ownerStorageChart;
                const index = chart.data.labels.indexOf('Photo storage used');
                return chart.data.datasets[0].backgroundColor[index];
            });
            assert.equal(chartColor, color.tokenValue, `${item.label} chart color`);
            assert.equal(await storageRow.locator('[role="progressbar"]').getAttribute('aria-valuetext'), `${Number(item.label.replace('%', '')).toFixed(1)}% of the 1 GB reference`);
            assert.equal(await storageRow.locator('[role="progressbar"]').getAttribute('aria-valuenow'), String(Math.min(100, Number(item.label.replace('%', '')))), `${item.label} progress value cap`);
        }

        await page.evaluate(() => { window.__mediaUnavailable = true; });
        await page.locator('[data-admin-perf-run]').click();
        await page.waitForFunction(() => [...document.querySelectorAll('[data-admin-perf-list] .admin-perf-item')]
            .find(row => row.textContent.includes('Photo storage used'))?.querySelector('.admin-perf-pill')?.textContent.trim() === 'Unavailable');
        assert.equal(await storageRow.locator('.admin-perf-dot').getAttribute('class').then(value => value.split(' ').at(-1)), 'admin-perf-dot-neutral');
        assert.equal(await storageRow.locator('.admin-perf-bar').count(), 0, 'unavailable storage should not imply a measured amount');
        assert.deepEqual(errors, [], 'owner dashboard has no uncaught errors');
        console.log('PASS owner photo storage thresholds: 0%, 25%, 50%, 70%, 100%, above 100%, unavailable');
    } finally {
        await page.close();
        await browser.close();
    }
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
