const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { answerQuestion } = require('../includes/landing-chat.js');

const courts = [
    { name: 'Basketball', rate: '₱500/hr' },
    { name: 'Bowling', rate: 'See rates by type' }
];

const sports = answerQuestion('sports', { courts });
assert.match(sports.text, /Current sports and rates shown in Courts & Pricing \(2\): Basketball — ₱500\/hr; Bowling — See rates by type/);

const updated = answerQuestion('sports', { courts: [...courts, { name: 'Badminton', rate: 'Rate TBA' }] });
assert.match(updated.text, /\(3\)/);
assert.match(updated.text, /Badminton/);

const unavailable = answerQuestion('sports', { failed: true, courts });
assert.match(unavailable.text, /unavailable right now/);
assert.doesNotMatch(unavailable.text, /Basketball|₱500/);

const location = answerQuestion('location');
assert.match(location.text, /Brgy\. Bocohan, Lucena City, Quezon/);
assert.equal(location.links[1].href, 'https://www.google.com/maps/dir/?api=1&destination=Inigo%27s%20Sports%20Center%20Lucena&destination_place_id=ChIJYWSThmFMvTMRnoWVEJzixOY');

const booking = answerQuestion('booking');
assert.match(booking.text, /Log in or create a customer account before continuing to payment/);
assert.equal(booking.links[0].href, '#courts');
assert.match(answerQuestion('cart').text, /one sport and court booking at a time/);
assert.match(answerQuestion('payment').text, /You must log in or create a customer account before payment/);

const fallback = answerQuestion('not-a-known-question');
assert.match(fallback.text, /Choose a question below/);

const landingHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const creditPage = path.join(__dirname, '..', 'Pages', 'asset-credits.html');
assert.match(landingHtml, /class="landing-chat-attribution"[^>]*>[\s\S]*?href="Pages\/asset-credits\.html"/);
assert.equal(fs.existsSync(creditPage), true, 'Landing chat attribution target exists');
assert.match(fs.readFileSync(creditPage, 'utf8'), /3D Sports Basket Ball Game Asset PBR Model/);

console.log('PASS deterministic FAQ uses current courts and verified venue details; landing chat links to the 3D model attribution');
