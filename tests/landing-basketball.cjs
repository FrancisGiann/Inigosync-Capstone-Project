// Local regression: real GLB/WebGL, mocked business data and no paid widget views.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const out = path.join(require('node:os').tmpdir(), 'inigosync-basketball-qa');
fs.mkdirSync(out, { recursive: true });
(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        async function setup({ motion = 'no-preference', failure = false, webgl = true, touch = false } = {}) {
            const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: motion, hasTouch: touch, isMobile: touch });
            page.setDefaultTimeout(15000);
            await page.addInitScript(() => {
                const get = HTMLCanvasElement.prototype.getContext;
                HTMLCanvasElement.prototype.getContext = function (type, options) {
                    return get.call(this, type, type.startsWith('webgl') ? { ...options, preserveDrawingBuffer: true } : options);
                };
            });
            await page.route('https://elfsightcdn.com/**', r => r.abort());
            await page.route('**/maps/embed**', r => r.fulfill({ body: '' }));
            await page.route('**/rest/v1/**', r => r.fulfill({ json: [] }));
            if (failure) await page.route('**/basketball.glb', r => r.abort());
            if (!webgl) await page.addInitScript(() => {
                const get = HTMLCanvasElement.prototype.getContext;
                HTMLCanvasElement.prototype.getContext = function (type, ...args) { return type.startsWith('webgl') ? null : get.call(this, type, ...args); };
            });
            await page.goto('http://127.0.0.1:4178/Pages/Index.html', { waitUntil: 'load' });
            return page;
        }
        const page = await setup();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.waitForSelector('.floating-basketball canvas', { state: 'attached' });
        assert.equal(await page.locator('.hero-equipment').count(), 0);
        for (const width of [320, 390, 768, 1024, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            for (const theme of ['light', 'dark']) {
                await page.evaluate(t => { ThemeController.set(t); scrollTo(0, 0); }, theme);
                await page.waitForTimeout(400);
                const metrics = await page.evaluate(() => {
                    const o = document.querySelector('.floating-basketball'), r = o.getBoundingClientRect();
                    const hero = document.querySelector('.hero-content');
                    const before = hero.getBoundingClientRect().toJSON();
                    o.hidden = true;
                    const after = hero.getBoundingClientRect().toJSON();
                    o.hidden = false;
                    return { fixed: getComputedStyle(o).position, pointer: getComputedStyle(o).pointerEvents, width: r.width,
                        overflow: document.documentElement.scrollWidth > innerWidth, before, after,
                        target: getComputedStyle(document.querySelector('.footer-card a')).minHeight,
                        aria: o.getAttribute('aria-hidden') };
                });
                assert.equal(metrics.fixed, 'fixed'); assert.equal(metrics.pointer, 'none'); assert.equal(metrics.aria, 'true');
                assert.equal(metrics.width, width <= 360 ? 96 : width <= 768 ? 110 : 140); assert(!metrics.overflow);
                assert.deepEqual(metrics.before, metrics.after); assert.equal(metrics.target, '32px');
                await page.screenshot({ path: path.join(out, `hero-${width}-${theme}.png`) });
                await page.locator('.footer-grid').scrollIntoViewIfNeeded();
                await page.waitForTimeout(400);
                await page.screenshot({ path: path.join(out, `footer-${width}-${theme}.png`) });
                for (const selector of ['#home', '#courts', '#about', '.site-footer', '.footer-bottom']) {
                    await page.locator(selector).evaluate(el => scrollTo({ top: el.getBoundingClientRect().top + scrollY, behavior: 'instant' }));
                    await page.waitForTimeout(200);
                    assert(await page.locator('.floating-basketball').evaluate(el => {
                        const ball = el.getBoundingClientRect(), footer = document.querySelector('.footer-bottom').getBoundingClientRect();
                        const overlap = footer.left < ball.right && footer.right > ball.left && footer.top < ball.bottom && footer.bottom > ball.top;
                        return getComputedStyle(el).opacity === (overlap ? '0' : '1');
                    }), `Ball must clear footer credits at ${selector}, ${width}, ${theme}`);
                    if (selector.startsWith('.')) {
                        const active = await page.locator('.site-nav a.active').evaluateAll(links => links.map(a => a.getAttribute('href')));
                        assert(active.length > 0 && active.every(href => href === '#about'), `Footer must activate About: ${active}`);
                    }
                }
                await page.evaluate(() => scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'}));
                await page.waitForFunction(() => document.querySelector('.floating-basketball').classList.contains('is-obscured'));
            }
        }
        // GPU output changes while scrolling, and returns to the same pose in reverse.
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.evaluate(() => scrollTo({top:0,behavior:'instant'}));
        await page.waitForFunction(() => !document.querySelector('.floating-basketball').classList.contains('is-obscured'));
        async function pose(y) {
            await page.evaluate(y => scrollTo(0, y), y); await page.waitForTimeout(700);
            return page.locator('.floating-basketball canvas').evaluate(canvas => canvas.toDataURL());
        }
        const start = await pose(0), rotated = await pose(150), reversed = await pose(0);
        assert.notEqual(start, rotated, '3D rendering must change on scroll');
        assert.equal(start, reversed, 'Reverse scrolling must restore the pose');
        await pose(150);
        await page.setViewportSize({ width: 1024, height: 900 });
        await page.setViewportSize({ width: 1440, height: 900 });
        assert.equal(start, await pose(0), 'Resize midway through scrolling must preserve the starting pose');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const still = await pose(0), stillScrolled = await pose(150);
        assert.equal(still, stillScrolled, 'Reduced motion must keep the same pose');
        // The model stays visible over content while clicks pass through it.
        await page.evaluate(() => {
            const b = document.createElement('button'); b.id = 'overlap-probe'; b.textContent = 'Test';
            b.style.cssText = 'position:fixed;bottom:16px;right:16px;width:140px;height:140px';
            document.querySelector('main').append(b);
        });
        assert.equal(await page.locator('.floating-basketball').evaluate(el => getComputedStyle(el).opacity), '1');
        await page.locator('#overlap-probe').click();
        await page.locator('#overlap-probe').evaluate(el => el.remove());
        await page.waitForFunction(() => !document.querySelector('.floating-basketball').classList.contains('is-obscured'));
        await page.setViewportSize({ width: 390, height: 900 });
        await page.evaluate(() => scrollTo({top:0,behavior:'instant'}));
        await page.waitForFunction(() => !document.querySelector('.site-nav').classList.contains('is-hidden'));
        await page.locator('[data-landing-menu]').click();
        await page.waitForFunction(() => document.querySelector('.floating-basketball').classList.contains('is-obscured'));
        await page.keyboard.press('Escape');
        assert.deepEqual(errors, []);
        const touch = await setup({ touch: true });
        assert.equal(await touch.locator('.footer-card a').first().evaluate(el => getComputedStyle(el).minHeight), '44px');
        await touch.close();
        for (const options of [{ failure: true }, { webgl: false }]) {
            const fallback = await setup(options);
            await fallback.waitForTimeout(2500);
            assert.equal(await fallback.locator('.floating-basketball').count(), 0);
            assert(await fallback.locator('.hero-content').isVisible());
            await fallback.close();
        }
        console.log('PASS real model, five widths/both themes, no layout shift, scroll/reverse, reduced motion, overlap/menu, touch targets, asset and WebGL failure');
        console.log('Screenshots: ' + out);
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
