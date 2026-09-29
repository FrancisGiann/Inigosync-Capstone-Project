// Real touch hit testing: never force the close-button action.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        await page.route('https://elfsightcdn.com/**', r => r.abort());
        await page.goto('http://127.0.0.1:4178/index.html');
        for (const width of [320, 390, 480, 768]) {
            await page.setViewportSize({ width, height: 844 });
            for (const theme of ['light', 'dark']) {
                await page.evaluate(t => ThemeController.set(t), theme);
                for (const panel of ['login', 'signup']) {
                    const opener = page.locator('.cta-buttons [data-auth-open]');
                    await opener.tap();
                    await page.locator(`[role="tab"][data-auth-tab="${panel}"]`).tap();
                    const close = page.locator('[data-auth-close]');
                    assert(await close.evaluate(el => {
                        const r = el.getBoundingClientRect();
                        return r.width >= 44 && r.height >= 44 &&
                            el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
                    }), `Close button obstructed: ${width}, ${theme}, ${panel}`);
                    await close.tap();
                    await page.waitForFunction(() => document.querySelector('[data-auth-overlay]').hidden);
                    assert(await page.locator('body').evaluate(el => !el.classList.contains('auth-lock')));
                    assert(await opener.evaluate(el => document.activeElement === el));
                }
            }
        }
        console.log('PASS mobile login/signup X: real taps, 4 widths, both themes, scroll unlock and focus restoration');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
