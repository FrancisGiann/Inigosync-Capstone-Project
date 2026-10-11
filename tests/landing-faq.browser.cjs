const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const preview = spawn(process.execPath, [path.join(root, 'scripts/preview.cjs')], { cwd: root, stdio: 'ignore' });

async function waitForPreview() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            const response = await fetch('http://127.0.0.1:4178/index.html');
            if (response.ok) return;
        } catch { /* The local preview is still starting. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Local preview did not start on port 4178');
}

(async () => {
    let browser;
    try {
        await waitForPreview();
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
        await page.goto('http://127.0.0.1:4178/index.html', { waitUntil: 'domcontentloaded' });
        const launcher = page.locator('[data-landing-chat-open]');
        assert.equal(await page.locator('.landing-chat form, .landing-chat input').count(), 0);
        assert.equal(await page.locator('.landing-chat-prompts [data-chat-question]').count(), 7);
        assert.equal(await page.locator('.floating-basketball-label').innerText(), 'Help & FAQ');
        const ballBounds = await launcher.boundingBox();
        assert(ballBounds && ballBounds.x >= 0 && ballBounds.y >= 0
            && ballBounds.x + ballBounds.width <= 390 && ballBounds.y + ballBounds.height <= 844,
        'basketball cue stays within the mobile viewport');

        await launcher.click();
        assert.equal(await page.locator('[data-landing-chat]').evaluate(dialog => dialog.open), true);
        assert.equal(await page.evaluate(() => document.activeElement?.dataset.chatQuestion), 'booking');
        await page.locator('[data-chat-question="booking"]').click();
        assert.match(await page.locator('[data-landing-chat-log]').innerText(), /browser-tab draft/);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('[data-landing-chat]').evaluate(dialog => dialog.open), false);
        assert.equal(await launcher.evaluate(button => button === document.activeElement), true);

        await launcher.click();
        await page.locator('[data-chat-question="records"]').click();
        assert.match(await page.locator('[data-landing-chat-log]').innerText(), /after you sign in/);
        await page.locator('[data-landing-chat-close]').click();
        assert.equal(await launcher.evaluate(button => button === document.activeElement), true);
        console.log('Landing FAQ browser check passed');
    } finally {
        await browser?.close();
        preview.kill();
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
