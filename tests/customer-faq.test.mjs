import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { answerQuestion } = require('../includes/customer-faq.js');
const landingHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const customerHtml = readFileSync(new URL('../Pages/user_dashboard.html', import.meta.url), 'utf8');
const customerScript = readFileSync(new URL('../includes/customer-faq.js', import.meta.url), 'utf8');
const dashboardCss = readFileSync(new URL('../Style/Dashboard.css', import.meta.url), 'utf8');

test('customer FAQ matches landing FAQ question labels and dialog presentation', () => {
    const landingDialog = landingHtml.match(/<dialog class="landing-chat"[\s\S]*?<\/dialog>/)?.[0] || '';
    const customerDialog = customerHtml.match(/<section class="customer-faq-dialog"[\s\S]*?<\/section>/)?.[0] || '';
    const landingQuestions = [...landingDialog.matchAll(/data-chat-question="([^"]+)"[^>]*>([^<]+)</g)];
    const customerQuestions = [...customerDialog.matchAll(/data-customer-faq-question="([^"]+)"[^>]*>([^<]+)</g)];
    assert.deepEqual(
        customerQuestions.map(([, key, label]) => [key, label]),
        landingQuestions.map(([, key, label]) => [key, label])
    );
    assert.match(customerDialog, /Frequently asked questions/);
    assert.match(customerDialog, /Choose a question for quick answers about booking, payments, and your visit\./);
    assert.match(customerDialog, /Hi! Choose a question below\./);
    assert.match(customerHtml, /class="customer-faq-launcher-label">Help &amp; FAQ/);
    assert.match(customerScript, /window\.InigoCourtsData/);
});

test('customer sports answer uses current shared court rates and handles missing data', () => {
    const answer = answerQuestion('sports', {
        courts: [{ name: 'Basketball', sportName: 'Basketball', rate: 500 }],
        rateHint: court => `₱${court.rate}/hr`
    });
    assert.match(answer.text, /Current sports and rates \(1\): Basketball — ₱500\/hr/);
    assert.equal(answer.links[0].nav, 'booking');

    const empty = answerQuestion('sports', { courts: [] });
    assert.match(empty.text, /There are no active sports listed/);
    const failed = answerQuestion('sports', { failed: true });
    assert.match(failed.text, /unavailable right now/);
});

test('customer FAQ answers use dashboard navigation and landing FAQ policy and venue details', () => {
    assert.match(answerQuestion('booking').text, /Choose a sport and court/);
    assert.equal(answerQuestion('booking').links[0].href, '#booking');
    assert.match(answerQuestion('cart').text, /as many court bookings as you need/);
    assert.match(answerQuestion('payment').text, /PayMongo/);

    const records = answerQuestion('records');
    assert.deepEqual(records.links.map(link => link.nav), ['bookings', 'receipts']);
    assert.match(answerQuestion('policy').text, /30-minute grace period/);
    assert.equal(answerQuestion('policy').links[0].href, 'terms.html');
    assert.match(answerQuestion('location').text, /Brgy\. Bocohan, Lucena City, Quezon/);
    assert.match(answerQuestion('location').links[0].href, /^https:\/\/www\.google\.com\/maps\/dir/);
});

test('FAQ backdrop intercepts clicks and only current open sessions append async answers', () => {
    const overlayRule = dashboardCss.match(/\.customer-faq-overlay\s*\{([^}]+)\}/)?.[1] || '';
    const dialogRule = dashboardCss.match(/\.customer-faq-dialog\s*\{([^}]+)\}/)?.[1] || '';
    assert.match(overlayRule, /pointer-events:\s*auto/);
    assert.match(dialogRule, /pointer-events:\s*auto/);

    const { canAppendAsyncAnswer } = require('../includes/customer-faq.js');
    assert.equal(canAppendAsyncAnswer(4, 4, true), true);
    assert.equal(canAppendAsyncAnswer(4, 5, true), false, 'a closed-and-reopened modal invalidates the old fetch');
    assert.equal(canAppendAsyncAnswer(4, 4, false), false, 'a closed modal ignores its pending fetch');
});
