import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');
const start = source.indexOf('    function overviewActionEntries() {');
const end = source.indexOf('    // Fetches with select(\'*\')', start);
assert.ok(start >= 0 && end > start, 'Overview filter implementation is present');
const overviewFilterSource = source.slice(start, end);

function filterHarness({ query = '', sport = '', date = 'all', time = 'all' } = {}) {
    const rows = [
        { actionable: false, time_date: '2026-10-08T02:00:00Z', sports: 'Tennis', customerName: 'Hidden' },
        { actionable: true, time_date: '2026-10-08T02:00:00Z', sports: 'Tennis', customerName: 'Ari' }, // Manila morning, today
        { actionable: true, time_date: '2026-10-08T06:00:00Z', sports: 'Badminton', customerName: 'Bea' }, // Manila afternoon, today
        { actionable: true, time_date: '2026-10-08T10:00:00Z', sports: 'Tennis', customerName: 'Cam' }, // Manila evening, today
        { actionable: true, time_date: '2026-10-09T02:00:00Z', sports: 'Tennis', customerName: 'Dee' }, // Manila morning, tomorrow
    ];
    const children = [];
    const body = {
        set innerHTML(value) { this.html = value; children.length = 0; },
        get innerHTML() { return this.html; },
        appendChild(row) { children.push(row); },
    };
    const context = {
        overviewRows: rows,
        overviewTableBody: body,
        overviewSearchInput: { value: query },
        overviewSportSelect: { value: sport, innerHTML: '' },
        overviewDateSelect: { value: date },
        overviewTimeSelect: { value: time },
        staffHasOverviewAction: row => row.actionable,
        staffOverviewIdLabel: row => `B-${row.customerName}`,
        renderOverviewRow: row => ({ dataset: {}, source: row }),
        manilaDate: value => {
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
            }).formatToParts(value);
            const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
            return `${values.year}-${values.month}-${values.day}`;
        },
        todayDateInputValue: () => '2026-10-08',
        manilaDateTime: (day, hour) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00+08:00`),
        STAFF_TIME_ZONE: 'Asia/Manila',
        Intl,
        window: { escapeHtml: value => String(value) },
    };
    runInNewContext(`${overviewFilterSource}\nglobalThis.renderRows = renderFilteredOverview; globalThis.actionEntries = overviewActionEntries; globalThis.renderSports = renderOverviewSportOptions;`, context);
    return { context, body, children, rows };
}

test('Overview combines customer, sport, date, and time filters on actionable rows only', () => {
    const { context, children, body } = filterHarness({ query: 'b-ari', sport: 'Tennis', date: 'today', time: 'morning' });
    context.renderRows();
    assert.equal(children.length, 1);
    assert.equal(children[0].source.customerName, 'Ari');
    assert.equal(children[0].dataset.rowIndex, '1', 'action index still maps to the original merged row');
    assert.equal(body.innerHTML, '');
});

test('Overview date and time options select tomorrow morning rows', () => {
    const { context, children } = filterHarness({ date: 'tomorrow', time: 'morning' });
    context.renderRows();
    assert.deepEqual(children.map(row => row.source.customerName), ['Dee']);
});

test('Overview sport options come from actionable rows and retain a still-available selection', () => {
    const { context } = filterHarness({ sport: 'Tennis' });
    context.renderSports(context.actionEntries());
    assert.match(context.overviewSportSelect.innerHTML, /value="">All sports/);
    assert.match(context.overviewSportSelect.innerHTML, /value="Badminton">Badminton/);
    assert.match(context.overviewSportSelect.innerHTML, /value="Tennis">Tennis/);
    assert.doesNotMatch(context.overviewSportSelect.innerHTML, /Hidden/);
    assert.equal(context.overviewSportSelect.value, 'Tennis');
});

test('Overview reports filtered empty results and leaves filter values available for refresh renders', () => {
    const { context, body } = filterHarness({ query: 'nobody', sport: 'Tennis', date: 'today', time: 'evening' });
    context.renderRows();
    assert.match(body.innerHTML, /No actionable bookings match these filters/);
    assert.equal(context.overviewSearchInput.value, 'nobody');
    assert.equal(context.overviewSportSelect.value, 'Tennis');
    assert.equal(context.overviewDateSelect.value, 'today');
    assert.equal(context.overviewTimeSelect.value, 'evening');
    context.renderRows();
    assert.match(body.innerHTML, /No actionable bookings match these filters/);
});

test('Overview shows the unfiltered empty state when no rows have an available action', () => {
    const { context, body } = filterHarness();
    context.overviewRows.forEach(row => { row.actionable = false; });
    context.renderRows();
    assert.match(body.innerHTML, /No bookings need an action right now/);
});
