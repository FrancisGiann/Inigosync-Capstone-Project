import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const sharedSource = readFileSync(new URL('../includes/courtsData.js', import.meta.url), 'utf8');
const landingSource = readFileSync(new URL('../includes/landingPage.js', import.meta.url), 'utf8');

function loadSharedData() {
    const context = { window: {}, Intl, console, fetch: () => Promise.reject(new Error('unused')) };
    runInNewContext(sharedSource, context);
    return context.window.InigoCourtsData;
}

test('shared unit resolver naturally orders units and keeps each identity and rate attached', () => {
    const data = loadSharedData();
    const source = [
        { id: 'court-10', label: 'Court 10', rateDay: 1000 },
        { id: 'court-2', label: 'Court 2', rateDay: 200 },
        { id: 'court-1', label: 'Court 1', rateDay: 100 },
    ];
    const { units } = data.resolveCourtUnits({ unit: 'courts', bookableUnits: source });
    assert.deepEqual(units.map(({ id, label, rateDay }) => [id, label, rateDay]), [
        ['court-1', 'Court 1', 100],
        ['court-2', 'Court 2', 200],
        ['court-10', 'Court 10', 1000],
    ]);
    assert.deepEqual(source.map((unit) => unit.id), ['court-10', 'court-2', 'court-1'], 'sorting does not mutate loaded data');
    assert.deepEqual(data.sortCourtUnits([
        { id: 'b', label: 'Court 2' },
        { id: 'a', label: 'court 02' },
    ]).map((unit) => unit.id), ['a', 'b'], 'equivalent natural labels use a deterministic ID tie-break');
});

test('landing unit choices retain numeric order when photo rows arrive unsorted', () => {
    const start = landingSource.indexOf('function unitNoun(');
    const end = landingSource.indexOf('\nfunction normalizeEventFromDb', start);
    assert(start >= 0 && end > start, 'landing unit resolver is present');
    const units = runLandingResolver(landingSource.slice(start, end));
    assert.deepEqual(units, ['Court 1', 'Court 2', 'Court 3']);
});

function runLandingResolver(source) {
    const data = loadSharedData();
    const context = {
        UNIT_NOUN: { courts: 'Court' },
        window: { InigoCourtsData: data },
    };
    runInNewContext(`${source}\nglobalThis.resolve = resolveCourtUnits;`, context);
    return context.resolve({ unit: 'courts', quantity: 10, unitImages: [
        { label: 'Court 10', imageUrl: '/10.jpg' },
        { label: 'Court 2', imageUrl: '/2.jpg' },
        { label: 'Court 1', imageUrl: '/1.jpg' },
    ] }).units.slice(0, 3).map((unit) => unit.label).join('|').split('|');
}
