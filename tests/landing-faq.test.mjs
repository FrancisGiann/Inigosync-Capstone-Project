import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { answerQuestion } = require('../includes/landing-chat.js');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../includes/landing-chat.js', import.meta.url), 'utf8');

test('landing help offers fixed FAQ choices and no free-text form', () => {
    const dialog = html.match(/<dialog class="landing-chat"[\s\S]*?<\/dialog>/)?.[0] || '';
    assert.match(dialog, /Frequently asked questions/);
    for (const key of ['booking', 'sports', 'cart', 'payment', 'records', 'policy', 'location']) {
        assert.match(dialog, new RegExp(`data-chat-question="${key}"`));
    }
    assert.doesNotMatch(dialog, /<form\b|<input\b|>Send</i);
    assert.doesNotMatch(script, /landing-chat-form|landingChatInput|requestSubmit|\.value\s*=|data-chat-prompt/);
    assert.match(html, /class="floating-basketball-label"[^>]*>Help &amp; FAQ/);
    assert.match(html, /aria-label="Open help and frequently asked questions"/);
});

test('public booking answers explain single provisional selections and required customer sign-in', () => {
    const booking = answerQuestion('booking').text;
    const cart = answerQuestion('cart').text;
    assert.match(booking, /one sport, court, date, and consecutive time range/);
    assert.match(booking, /does not reserve a court/);
    assert.match(booking, /customer account before continuing to payment/);
    assert.match(cart, /one sport and court booking at a time/);
    assert.match(cart, /customer account to continue/);
});

test('sports answer uses current rates and handles unavailable listings', () => {
    const current = answerQuestion('sports', { courts: [{ name: 'Basketball', rate: '₱500 /hr' }] });
    assert.match(current.text, /Basketball — ₱500 \/hr/);
    const unavailable = answerQuestion('sports', { loading: true, courts: [] });
    assert.match(unavailable.text, /unavailable right now/);
});

test('payment, records, policy, and location answers use project facts', () => {
    assert.match(answerQuestion('payment').text, /log in/);
    assert.match(answerQuestion('payment').text, /PayMongo/);
    assert.match(answerQuestion('records').text, /after you sign in/);
    assert.match(answerQuestion('records').text, /Receipts/);
    assert.match(answerQuestion('policy').text, /non-refundable/);
    assert.match(answerQuestion('policy').text, /30-minute grace period/);
    assert.match(answerQuestion('location').text, /Brgy\. Bocohan/);
    assert.equal(answerQuestion('policy').links[0].href, 'Pages/terms.html');
});
