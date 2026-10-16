import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadCourtsFallback() {
    const context = vm.createContext({
        console,
        setTimeout,
        clearTimeout,
        window: {},
    });
    for (const file of ['includes/courts-data.js', 'includes/courtsData.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
    }
    return context.window.InigoCourtsData;
}

function loadScheduleRowsForSport(resolveCourtUnits) {
    const source = fs.readFileSync(path.join(root, 'includes/staff_dashboard.js'), 'utf8');
    const match = source.match(/function scheduleRowsForSport\(sportSlug, courts\) \{[\s\S]*?\n    \}/);
    assert.ok(match, 'staff dashboard contains scheduleRowsForSport');
    const context = vm.createContext({
        window: {
            InigoCourtsData: {
                resolveCourtUnits,
            },
        },
    });
    vm.runInContext(`${match[0]}\nglobalThis.scheduleRowsForSport = scheduleRowsForSport;`, context);
    return context.scheduleRowsForSport;
}

test('schedule sport options and rows keep Ten-Pin separate from Duckpin in fallback mode', async () => {
    const data = loadCourtsFallback();
    const [sports, courts] = await Promise.all([data.getSports(), data.getCourts()]);
    const bowlingSports = sports.filter((sport) => sport.slug.startsWith('bowling-'));
    assert.deepEqual(Array.from(bowlingSports, (sport) => [sport.slug, sport.name]), [
        ['bowling-duckpin', 'Bowling — Duckpin'],
        ['bowling-tenpin', 'Bowling — Ten-Pin'],
    ]);

    const duckpin = courts.find((court) => court.slug === 'bowling-duckpin');
    const tenpin = courts.find((court) => court.slug === 'bowling-tenpin');
    assert.equal(duckpin.sportSlug, 'bowling-duckpin');
    assert.equal(duckpin.rateUnit, '/set');
    assert.equal(tenpin.sportSlug, 'bowling-tenpin');
    assert.equal(tenpin.sportName, 'Bowling — Ten-Pin');
    assert.equal(tenpin.rateUnit, '/set');

    const scheduleRowsForSport = loadScheduleRowsForSport(data.resolveCourtUnits);
    const tenpinRows = scheduleRowsForSport('bowling-tenpin', courts);
    assert.equal(tenpinRows.length, 12);
    assert.ok(tenpinRows.every((row) => row.court.slug === 'bowling-tenpin'));
    assert.equal(scheduleRowsForSport('bowling-duckpin', courts).length, 8);
});
