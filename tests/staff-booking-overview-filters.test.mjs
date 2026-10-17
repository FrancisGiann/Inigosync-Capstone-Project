import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = (await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const html = await readFile(new URL('../Pages/staff_dashboard.html', import.meta.url), 'utf8');
const start = source.indexOf('    const overviewTableBody = document.querySelector(');
const end = source.indexOf('    // Fetches with select(\'*\')', start);
assert.ok(start >= 0 && end > start, 'Overview filter implementation is present');
const overviewFilterSource = source.slice(start, end);
const listenerStart = source.indexOf('    [overviewSearchInput, overviewSportSelect, overviewDateInput].forEach((control) => {');
const listenerEnd = source.indexOf('\n\n    // Revision S2', listenerStart);
assert.ok(listenerStart >= 0 && listenerEnd > listenerStart, 'Overview filter change listeners are present');
const overviewFilterListenerSource = source.slice(listenerStart, listenerEnd);

function filterHarness({ query = '', sport = '', date = '' } = {}) {
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
    const controls = {
        '[data-staff-table="overview"] tbody': body,
        '[data-staff-pagination="overview"]': { addEventListener() {} },
        '[data-staff-overview-search]': { value: query, addEventListener() {} },
        '[data-staff-overview-sport]': { value: sport, innerHTML: '', addEventListener() {} },
        '[data-staff-overview-date]': { value: date, addEventListener(event, handler) { if (event === 'change') this.onChange = handler; } },
    };
    const context = {
        document: { querySelector: selector => controls[selector] || null },
        testRows: rows,
        overviewTableBody: body,
        staffHasOverviewAction: row => row.actionable,
        staffOverviewIdLabel: row => `B-${row.customerName}`,
        renderOverviewRow: row => ({ dataset: {}, source: row }),
        renderStaffTablePagination() {},
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
        window: {
            escapeHtml: value => String(value),
            InigoStaffPagination: { paginateRows: rows => ({ rows, page: 1 }) },
        },
    };
    runInNewContext(`${overviewFilterSource}\noverviewRows = globalThis.testRows; ${overviewFilterListenerSource}\nglobalThis.renderRows = renderFilteredOverview; globalThis.actionEntries = overviewActionEntries; globalThis.renderSports = renderOverviewSportOptions;`, context);
    return { context, body, children, rows, dateInput: controls['[data-staff-overview-date]'], searchInput: controls['[data-staff-overview-search]'], sportSelect: controls['[data-staff-overview-sport]'] };
}

test('Overview defaults the calendar date to today and filters by the selected calendar date', () => {
    const { context, children, dateInput } = filterHarness();
    assert.equal(dateInput.value, '2026-10-08');
    context.renderRows();
    assert.deepEqual(children.map(row => row.source.customerName), ['Ari', 'Bea', 'Cam'], 'all times on today are shown');
    dateInput.value = '2026-10-09';
    dateInput.onChange();
    assert.deepEqual(children.map(row => row.source.customerName), ['Dee']);
});

test('Overview combines customer, sport, and date filters on actionable rows only', () => {
    const { context, children, body } = filterHarness({ query: 'b-ari', sport: 'Tennis', date: '2026-10-08' });
    context.renderRows();
    assert.equal(children.length, 1);
    assert.equal(children[0].source.customerName, 'Ari');
    assert.equal(children[0].dataset.rowIndex, '1', 'action index still maps to the original merged row');
    assert.equal(body.innerHTML, '');
});

test('Overview sport options come from actionable rows and retain a still-available selection', () => {
    const { context, sportSelect } = filterHarness({ sport: 'Tennis' });
    context.renderSports(context.actionEntries());
    assert.match(sportSelect.innerHTML, /value="">All sports/);
    assert.match(sportSelect.innerHTML, /value="Badminton">Badminton/);
    assert.match(sportSelect.innerHTML, /value="Tennis">Tennis/);
    assert.doesNotMatch(sportSelect.innerHTML, /Hidden/);
    assert.equal(sportSelect.value, 'Tennis');
});

test('Overview reports filtered empty results and leaves filter values available for refresh renders', () => {
    const { context, body, dateInput, searchInput, sportSelect } = filterHarness({ query: 'nobody', sport: 'Tennis', date: '2026-10-08' });
    context.renderRows();
    assert.match(body.innerHTML, /No actionable bookings match these filters/);
    assert.equal(searchInput.value, 'nobody');
    assert.equal(sportSelect.value, 'Tennis');
    assert.equal(dateInput.value, '2026-10-08');
    context.renderRows();
    assert.match(body.innerHTML, /No actionable bookings match these filters/);
});

test('Overview has no time-of-day filter control or filter logic', () => {
    assert.match(html, /<input type="date"[^>]*data-staff-overview-date/);
    assert.doesNotMatch(html, /data-staff-overview-time|Any time|Morning|Afternoon|Evening/);
    assert.doesNotMatch(source, /data-staff-overview-time|overviewMatchesTime|overviewHour\(/);
});

test('Overview shows the unfiltered empty state when no rows have an available action', () => {
    const { context, body, rows } = filterHarness();
    rows.forEach(row => { row.actionable = false; });
    context.renderRows();
    assert.match(body.innerHTML, /No bookings need an action right now/);
});
