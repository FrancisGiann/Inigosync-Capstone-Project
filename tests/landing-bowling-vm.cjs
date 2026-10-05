// Dependency-free regression check for the public landing page's Bowling cards.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../includes/landingPage.js'), 'utf8');
const start = source.indexOf('function normalizeCourtFromDb(row) {');
const end = source.indexOf('\nfunction formatUnitRate(', start);
assert(start >= 0 && end > start, 'landing normalization and grouping functions are present');

const context = vm.createContext({ window: { escapeHtml: value => String(value) }, console });
vm.runInContext('function normalizeUnitImages() { return []; }\n' + source.slice(start, end), context);

// The live rows currently embed the wrong shared sport slug, so card identity
// must come from each configured court slug instead.
const rows = [
    { id: 'duckpin', slug: 'bowling-duckpin', name: 'Bowling — Duckpin', quantity: 8, unit: 'lanes', sport: { slug: 'bowling-duckpin', name: 'Bowling' } },
    { id: 'tenpin', slug: 'bowling-tenpin', name: 'Bowling — Ten-Pin', quantity: 12, unit: 'lanes', sport: { slug: 'bowling-duckpin', name: 'Bowling' } },
];
const cards = context.mergeCourtsBySport(rows.map(row => context.normalizeCourtFromDb(row)));

assert.equal(cards.length, 2, 'Duckpin and Ten-Pin render as distinct cards');
assert.equal(cards[0].sportSlug, 'bowling-duckpin');
assert.equal(cards[1].sportSlug, 'bowling-tenpin');
assert.equal(cards[0].quantity, 8);
assert.equal(cards[1].quantity, 12);

console.log('PASS Bowling landing cards split by court slug despite a shared incorrect embedded sport slug');
