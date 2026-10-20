// Focused landing-page browser checks for the saved three-review projection.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        async function openLanding(reviews, fail = false) {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
            page.setDefaultTimeout(10000);
            await page.route(/^https:\/\//, route => route.abort());
            await page.route('**/Config/supabaseClient.js', route => route.fulfill({
                contentType: 'application/javascript',
                body: `window.sb={from(table){let options={};const chain={select(){return chain},order(key,orderOptions){options={key,ascending:orderOptions.ascending};return chain},limit(){return chain},then(resolve,reject){if(table==='public_featured_booking_reviews'&&${fail})return Promise.reject(new Error('fixture failure')).then(resolve,reject);let data=table==='public_featured_booking_reviews'?${JSON.stringify(reviews)}:[];if(options.key)data=data.slice().sort((a,b)=>options.ascending?a[options.key]-b[options.key]:b[options.key]-a[options.key]);return Promise.resolve({data,error:null}).then(resolve,reject)}};return chain}};`,
            }));
            await page.goto('http://127.0.0.1:4178/index.html', { waitUntil: 'domcontentloaded' });
            return page;
        }

        const sample = await openLanding([
            { display_order: 2, rating: 4, comment: 'Second selected review', created_at: '2026-09-18T10:00:00Z' },
            { display_order: 1, rating: 5, comment: 'First selected review', created_at: '2026-09-20T10:00:00Z' },
            { display_order: 3, rating: 3, comment: 'Third selected review', created_at: '2026-09-16T10:00:00Z' },
        ]);
        await sample.waitForFunction(() => document.querySelectorAll('[data-onsite-review-grid] .testimonial-card').length === 3);
        const cardText = await sample.locator('[data-onsite-review-grid]').innerText();
        assert.ok(cardText.indexOf('First selected review') < cardText.indexOf('Second selected review'));
        assert.ok(cardText.indexOf('Second selected review') < cardText.indexOf('Third selected review'));
        assert.equal(await sample.locator('[data-onsite-review-grid] .testimonial-card').count(), 3);
        await sample.close();

        const empty = await openLanding([]);
        await empty.locator('.onsite-review-placeholder').waitFor({ state: 'visible' });
        assert.match(await empty.locator('.onsite-review-placeholder').innerText(), /No featured reviews yet[\s\S]*after the owner chooses them/);
        await empty.close();

        const failed = await openLanding([], true);
        await failed.waitForFunction(() => document.querySelector('[data-onsite-reviews-status]')?.textContent === 'Customer reviews are temporarily unavailable.');
        assert.equal(await failed.locator('[data-onsite-review-grid] .testimonial-card').count(), 0);
        await failed.close();
        console.log('PASS featured review order, empty selection, and unavailable state on landing page');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
