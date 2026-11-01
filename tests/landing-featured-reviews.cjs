// Focused browser checks for featured reviews, rating filters, and carousel navigation.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const allReviews = [
            ...Array.from({ length: 8 }, (_, i) => ({ rating: i % 5 + 1, comment: i === 0 ? null : i === 2 ? `Third selected review with a deliberately long comment that should be clipped in the card preview. ${'More public feedback. '.repeat(12)}` : `Public review ${i + 1}`, is_sample: i === 0 || i === 2, created_at: `2026-09-${String(20 - i).padStart(2, '0')}T10:00:00Z`, display_name: `Public Name ${i + 1} R.` })),
            { rating: 4, comment: 'Second selected review', created_at: '2026-09-18T10:00:00Z' },
        ];
        async function openLanding(reviews, fail = false) {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
            page.setDefaultTimeout(10000);
            await page.route(/^https:\/\//, route => route.abort());
            await page.route('**/Config/supabaseClient.js', route => route.fulfill({
                contentType: 'application/javascript',
                body: `window.sb={from(table){let options={};const chain={select(){return chain},order(key,orderOptions){options.key=key;options.ascending=orderOptions.ascending;return chain},eq(key,value){options.filter=[key,value];return chain},range(start,end){options.range=[start,end];return chain},then(resolve,reject){if(table==='public_featured_customer_reviews'&&${fail})return Promise.reject(new Error('fixture failure')).then(resolve,reject);let data=table==='public_featured_customer_reviews'?${JSON.stringify(reviews)}:${JSON.stringify(allReviews)};if(options.filter)data=data.filter(row=>Number(row[options.filter[0]])===Number(options.filter[1]));if(options.key)data=data.slice().sort((a,b)=>options.ascending?(a[options.key]>b[options.key]?1:-1):(a[options.key]<b[options.key]?1:-1));if(options.range)data=data.slice(options.range[0],options.range[1]+1);return Promise.resolve({data,error:null}).then(resolve,reject)}};return chain}};`,
            }));
            await page.goto('http://127.0.0.1:4178/index.html', { waitUntil: 'domcontentloaded' });
            return page;
        }

        const sample = await openLanding([
            { display_order: 2, rating: 4, comment: 'Second selected review', display_name: 'Second Name S.', created_at: '2026-09-18T10:00:00Z' },
            { display_order: 1, rating: 5, comment: 'First selected review', is_sample: true, display_name: 'Jaim3 R.', created_at: '2026-09-20T10:00:00Z' },
            { display_order: 3, rating: 3, comment: `Third selected review with a deliberately long comment that should be clipped in the card preview. ${'More public feedback. '.repeat(12)}`, is_sample: true, display_name: 'Third Name T.', created_at: '2026-09-16T10:00:00Z' },
        ]);
        await sample.waitForFunction(() => document.querySelector('[data-onsite-review-grid]')?.textContent.includes('First selected review'));
        assert.equal(await sample.locator('[data-onsite-review-grid] .testimonial-card').count(), 1, 'Mobile shows one featured review at a time');
        assert.equal(await sample.locator('[data-review-rating]').count(), 5);
        assert.equal(await sample.getByRole('button', { name: 'Show featured reviews' }).getAttribute('aria-pressed'), 'true');
        assert.equal(await sample.locator('[data-review-mode]').count(), 0);
        assert.equal(await sample.locator('[data-review-rating-filter]').count(), 0);
        assert.equal(await sample.locator('[data-review-load-more]').count(), 0);
        assert.match(await sample.locator('[data-onsite-review-grid]').innerText(), /Jaim3 R\./, 'the account name is shown as the review attribution');
        assert.doesNotMatch(await sample.locator('[data-onsite-review-grid]').innerText(), /Sample review/, 'sample rows have no repeated label inside cards');
        assert.match(await sample.locator('.onsite-reviews-intro').innerText(), /generated presentation content/, 'the section intro discloses generated presentation content');
        assert.equal(await sample.locator('.onsite-review-read-more:visible').count(), 0, 'short comments do not show Read more');
        await sample.getByRole('button', { name: 'Show older reviews' }).click();
        await sample.waitForFunction(() => document.querySelector('[data-onsite-review-grid]')?.textContent.includes('Second selected review'));
        assert.equal(await sample.getByRole('button', { name: 'Show newer reviews' }).isEnabled(), true);
        await sample.getByRole('button', { name: 'Show newer reviews' }).click();
        await sample.waitForFunction(() => document.querySelector('[data-onsite-review-grid]')?.textContent.includes('First selected review'));
        await sample.getByRole('button', { name: 'Show older reviews' }).click();
        await sample.waitForFunction(() => document.querySelector('[data-onsite-review-grid]')?.textContent.includes('Second selected review'));
        await sample.getByRole('button', { name: 'Show older reviews' }).click();
        await sample.waitForFunction(() => document.querySelector('[data-onsite-review-grid]')?.textContent.includes('Third selected review'));
        await sample.getByRole('button', { name: 'Read more' }).click();
        assert.equal(await sample.locator('.onsite-review-dialog').isVisible(), true, 'long comments open a centered dialog');
        assert.match(await sample.locator('.onsite-review-dialog').innerText(), /Third Name T\.[\s\S]*More public feedback\./);
        assert.doesNotMatch(await sample.locator('.onsite-review-dialog').innerText(), /Sample review/, 'the full-review dialog has no repeated sample label');
        await sample.getByRole('button', { name: 'Close full review' }).click();
        assert.equal(await sample.locator('.onsite-review-dialog').isVisible(), false, 'the X button closes the dialog');
        await sample.getByRole('button', { name: 'Show older reviews' }).click();
        await sample.getByRole('button', { name: 'Show older reviews' }).click();
        await sample.waitForFunction(() => document.querySelector('[data-onsite-review-grid]')?.textContent.includes('Public review 1'));
        assert.doesNotMatch(await sample.locator('[data-onsite-review-grid]').innerText(), /Private name/);
        assert.match(await sample.locator('[data-onsite-review-grid]').innerText(), /No written comment\./, 'A rating-only public review remains visible with a neutral comment fallback');
        assert.doesNotMatch(await sample.locator('[data-onsite-review-grid]').innerText(), /Sample review/, 'sample rows have no repeated label while browsing all reviews');
        await sample.getByRole('button', { name: 'Show 4-star reviews' }).click();
        await sample.waitForFunction(() => document.querySelector('[data-onsite-review-grid]')?.textContent.includes('Second selected review'));
        assert.ok(await sample.locator('[data-onsite-review-grid] .testimonial-card').count() <= 3);
        assert.match(await sample.locator('[data-onsite-review-grid]').innerText(), /Second selected review/, 'Filtered results include matching featured reviews');
        await sample.getByRole('button', { name: 'Show older reviews' }).click();
        await sample.waitForFunction(() => document.querySelector('[data-onsite-review-grid]')?.textContent.includes('Public review 4'));
        assert.match(await sample.locator('[data-onsite-review-grid]').innerText(), /Public review 4/);
        await sample.getByRole('button', { name: 'Show 4-star reviews' }).click();
        await sample.waitForFunction(() => document.querySelector('[data-onsite-review-grid]')?.textContent.includes('First selected review'));
        assert.match(await sample.locator('[data-onsite-review-grid]').innerText(), /First selected review/);
        await sample.close();

        const empty = await openLanding([]);
        await empty.locator('.onsite-review-placeholder').waitFor({ state: 'visible' });
        assert.match(await empty.locator('.onsite-review-placeholder').innerText(), /No featured reviews yet[\s\S]*star ratings above/);
        await empty.close();

        const failed = await openLanding([], true);
        await failed.waitForFunction(() => document.querySelector('[data-onsite-reviews-status]')?.textContent.includes('Featured reviews are temporarily unavailable.'));
        assert.equal(await failed.locator('[data-onsite-review-grid] .testimonial-card').count(), 0);
        await failed.close();
        console.log('PASS featured review order, empty selection, and unavailable state on landing page');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
