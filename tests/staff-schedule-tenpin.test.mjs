import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import pagination from '../includes/staffPagination.js';

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

test('staff schedule provides responsive time-window navigation and avoids table-level horizontal scrolling', () => {
    const html = fs.readFileSync(path.join(root, 'Pages/staff_dashboard.html'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'Style/staff_dashboard.css'), 'utf8');
    const js = fs.readFileSync(path.join(root, 'includes/staff_dashboard.js'), 'utf8');

    assert.match(html, /data-staff-schedule-hour-prev/);
    assert.match(html, /data-staff-schedule-hour-next/);
    assert.match(html, /<colgroup data-staff-schedule-columns><col class="staff-schedule-identity-column"><\/colgroup>/);
    assert.match(html, /data-staff-schedule-sport-filters/);
    assert.doesNotMatch(html, /data-staff-schedule-sport(?:[\s>]|")/);
    assert.match(html, /data-staff-schedule-search[\s\S]*?data-staff-schedule-date[\s\S]*?data-staff-schedule-sort/);
    assert.match(js, /scheduleHoursPerWindow\(scheduleWidth, allHours\.length\)/);
    assert.match(js, /scheduleTableWrap\.classList\.toggle\('is-narrow', scheduleWidth <= 560\)/);
    assert.match(js, /async function renderScheduleSportOptions\(\)\s*\{\s*if \(!window\.InigoCourtsData\) return;/);
    assert.doesNotMatch(js, /scheduleSportSelect/);
    assert.match(js, /nextScheduleHourOffset\(scheduleHourOffset, 1, scheduleHourPageSize, scheduleHourTotal\)/);
    assert.doesNotMatch(html, /data-staff-schedule-hour-label/);
    assert.match(js, /scheduleHourWindow\.hidden = !canNavigateHours/);
    assert.match(js, /aria-label="\$\{window\.escapeHtml\(timeLabel\)\}: \$\{window\.escapeHtml\(statusLabel\)\}"/);
    assert.match(css, /\.staff-schedule-table-wrap\s*\{\s*overflow-x:\s*hidden;/);
    assert.match(css, /\.staff-schedule-table\s*\{[^}]*min-width:\s*0;[^}]*table-layout:\s*fixed;/);
    assert.match(css, /\.staff-schedule-table th:first-child,[\s\S]*?\.staff-schedule-table td:first-child\s*\{[^}]*min-width:\s*0;/);
    assert.match(js, /columns\.innerHTML = `\s*<col class="staff-schedule-identity-column" style="width:\$\{identityColumnWidth\}px">/);
    assert.match(css, /\.staff-schedule-table col\.staff-schedule-identity-column \{ width: 230px; \}/);
    assert.match(css, /\.staff-schedule-identity-copy \{[^}]*flex-direction: column;[^}]*align-items: flex-start;/);
    assert.match(css, /\.staff-schedule-identity-copy strong \{[^}]*white-space: nowrap;/);
    assert.match(css, /\.staff-schedule-identity-copy small \{[^}]*white-space: nowrap;/);
    assert.match(css, /\.staff-schedule-table-wrap\.is-narrow \.staff-schedule-photo \{ display: none; \}/);
    assert.match(css, /@media \(max-width: 480px\) \{[\s\S]*?\.staff-schedule-tools \{ grid-template-columns: minmax\(0, 1fr\);/);
});

test('schedule hour window size reserves identity room and keeps narrow slots readable', () => {
    const source = fs.readFileSync(path.join(root, 'includes/staff_dashboard.js'), 'utf8');
    const identityMatch = source.match(/function scheduleIdentityColumnWidth\(containerWidth\) \{[\s\S]*?\n    \}/);
    const match = source.match(/function scheduleHoursPerWindow\(containerWidth, totalHours\) \{[\s\S]*?\n    \}/);
    assert.ok(identityMatch, 'staff schedule defines its responsive identity column width');
    assert.ok(match, 'staff schedule defines a measurable-width window sizing helper');
    const context = vm.createContext({});
    vm.runInContext(`${identityMatch[0]}\n${match[0]}\nglobalThis.scheduleIdentityColumnWidth = scheduleIdentityColumnWidth;\nglobalThis.scheduleHoursPerWindow = scheduleHoursPerWindow;`, context);

    assert.equal(context.scheduleIdentityColumnWidth(320), 190);
    assert.equal(context.scheduleIdentityColumnWidth(560), 190);
    assert.equal(context.scheduleIdentityColumnWidth(640), 230);
    assert.equal(context.scheduleIdentityColumnWidth(1200), 260);
    assert.equal(context.scheduleHoursPerWindow(320, 12), 2);
    assert.equal(context.scheduleHoursPerWindow(420, 12), 5);
    assert.equal(context.scheduleHoursPerWindow(640, 12), 8);
    assert.equal(context.scheduleHoursPerWindow(900, 12), 12);
    assert.equal(context.scheduleHoursPerWindow(320, 2), 2);
    assert.equal(context.scheduleHoursPerWindow(0, 12), 4);
});

test('schedule hour navigation advances by the visible window and clamps at both ends', () => {
    const source = fs.readFileSync(path.join(root, 'includes/staff_dashboard.js'), 'utf8');
    const match = source.match(/function nextScheduleHourOffset\(offset, direction, pageSize, totalHours\) \{[\s\S]*?\n    \}/);
    assert.ok(match, 'staff schedule defines bounded hour-window navigation');
    const context = vm.createContext({});
    vm.runInContext(`${match[0]}\nglobalThis.nextScheduleHourOffset = nextScheduleHourOffset;`, context);

    assert.equal(context.nextScheduleHourOffset(0, 1, 4, 12), 4);
    assert.equal(context.nextScheduleHourOffset(4, 1, 4, 12), 8);
    assert.equal(context.nextScheduleHourOffset(8, 1, 4, 12), 8);
    assert.equal(context.nextScheduleHourOffset(8, -1, 4, 12), 4);
    assert.equal(context.nextScheduleHourOffset(0, 1, 9, 12), 3);
    assert.equal(context.nextScheduleHourOffset(3, -1, 9, 12), 0);
    assert.equal(context.nextScheduleHourOffset(0, 1, 12, 12), 0);
});

test('court schedule pager keeps three numbered pages and signals hidden pages', () => {
    const script = fs.readFileSync(path.join(root, 'includes/staff_dashboard.js'), 'utf8');
    assert.match(script, /renderStaffPageNumbers\(schedulePageNumbers,[\s\S]*?\}, 3\);/);
    assert.deepEqual(pagination.pageNumbers(1, 4, 3), [1, 2, 3, 'gap']);
    assert.deepEqual(pagination.pageNumbers(3, 8, 3), ['gap', 2, 3, 4, 'gap']);
    assert.deepEqual(pagination.pageNumbers(8, 8, 3), ['gap', 6, 7, 8]);
    assert.deepEqual(pagination.pageNumbers(2, 3, 3), [1, 2, 3]);
    assert.deepEqual(pagination.pageNumbers(5, 10), [1, 'gap', 4, 5, 6, 'gap', 10], 'other staff pagers retain their existing layout');
});

test('empty and invalid schedule dates restore a valid selection before refresh', () => {
    const source = fs.readFileSync(path.join(root, 'includes/staff_dashboard.js'), 'utf8');
    const match = source.match(/function normalizeScheduleDate\(dateValue, fallbackDate, today\) \{[\s\S]*?\n    \}/);
    assert.ok(match, 'staff schedule defines date normalization for native date input values');
    const context = vm.createContext({ Date, Number, String });
    vm.runInContext(`${match[0]}\nglobalThis.normalizeScheduleDate = normalizeScheduleDate;`, context);

    assert.equal(context.normalizeScheduleDate('', '2026-11-02', '2026-10-30'), '2026-11-02', 'empty input retains the prior selected date');
    assert.equal(context.normalizeScheduleDate('2026-02-30', '2026-11-02', '2026-10-30'), '2026-11-02', 'an impossible date retains the prior selection');
    assert.equal(context.normalizeScheduleDate('2026-10-29', '2026-10-30', '2026-10-30'), '2026-10-30', 'past dates clamp to today');
    assert.equal(context.normalizeScheduleDate('2026-11-05', '2026-10-30', '2026-10-30'), '2026-11-05', 'valid future dates remain selected');
});

test('court schedule exposes only the requested three status categories', () => {
    const html = fs.readFileSync(path.join(root, 'Pages/staff_dashboard.html'), 'utf8');
    const js = fs.readFileSync(path.join(root, 'includes/staff_dashboard.js'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'Style/staff_dashboard.css'), 'utf8');
    const legend = html.match(/<div class="staff-legend" aria-label="Court schedule status legend">([\s\S]*?)<\/div>/)?.[1];
    const scheduleCells = js.match(/function scheduleCellInfo\([\s\S]*?function renderCourtSchedule\(/)?.[0];

    assert.ok(legend);
    assert.deepEqual([...legend.matchAll(/<span class="dot ([^"]+)"\><\/span>([^<]+)/g)].map(([, color, label]) => [color, label]), [
        ['available', 'Available'], ['booked', 'Booked'], ['maintenance', 'Maintenance'],
    ]);
    assert.ok(scheduleCells);
    assert.doesNotMatch(scheduleCells, /Temporarily held|cls: 'is-held'/);
    assert.match(js, /const statusLabel = info\.cls === 'is-open'[\s\S]*?'Available'[\s\S]*?'Maintenance'[\s\S]*?'Booked'/);
    assert.match(js, /aria-label="\$\{window\.escapeHtml\(timeLabel\)\}: \$\{window\.escapeHtml\(statusLabel\)\}"/);
    assert.doesNotMatch(css, /\.staff-schedule-cell\.is-held/);
});
