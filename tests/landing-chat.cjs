const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { answerQuestion } = require('../includes/landing-chat.js');

const courts = [
    { name: 'Basketball', rate: '₱500/hr' },
    { name: 'Bowling', rate: 'See rates by type' }
];

const sports = answerQuestion('What sports are offered?', { courts });
assert.match(sports.text, /currently lists 2 sports: Basketball, Bowling/);

const prices = answerQuestion('How much does it cost?', { courts });
assert.match(prices.text, /Basketball — ₱500\/hr/);
assert.match(prices.text, /Bowling — See rates by type/);

const updated = answerQuestion('sports', { courts: [...courts, { name: 'Badminton', rate: 'Rate TBA' }] });
assert.match(updated.text, /currently lists 3 sports/);
assert.match(updated.text, /Badminton/);

const unavailable = answerQuestion('rates', { failed: true, courts });
assert.match(unavailable.text, /unavailable right now/);
assert.doesNotMatch(unavailable.text, /Basketball|₱500/);

const location = answerQuestion('Where can I find you?');
assert.match(location.text, /Brgy\. Bocohan, Diversion Road, Lucena City/);
assert.equal(location.links[1].href.startsWith('https://www.google.com/maps/dir/'), true);

const booking = answerQuestion('How do I book a court?');
assert.match(booking.text, /log in or create an account/);
assert.equal(booking.links[0].href, '#courts');
assert.match(answerQuestion('Where can I book a court?').text, /log in or create an account/);

const hours = answerQuestion('What are your operating hours?');
assert.match(hours.text, /can’t confirm current operating hours/);
assert.deepEqual(hours.links.map(link => link.href), ['tel:+639281546876', 'mailto:itsrosem8@gmail.com']);

const fallback = answerQuestion('Can you help with something else?');
assert.match(fallback.text, /I can help with booking/);

const landingHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const creditPage = path.join(__dirname, '..', 'Pages', 'asset-credits.html');
assert.match(landingHtml, /class="landing-chat-attribution"[^>]*>[\s\S]*?href="Pages\/asset-credits\.html"/);
assert.equal(fs.existsSync(creditPage), true, 'Landing chat attribution target exists');
assert.match(fs.readFileSync(creditPage, 'utf8'), /3D Sports Basket Ball Game Asset PBR Model/);

console.log('PASS deterministic FAQ uses current courts and verified venue details; landing chat links to the 3D model attribution');
