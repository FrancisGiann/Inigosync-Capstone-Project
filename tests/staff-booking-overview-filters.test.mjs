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
        { status: 'completed', time_date: '2026-10-07T02:00:00Z', sports: 'Bowling', customerName: 'Past' },
        { status: 'booked', inArrivalWindow: false, time_date: '2026-10-08T04:00:00Z', sports: 'Tennis', customerName: 'Expired' },
        { status: 'cancelled', time_date: '2026-10-08T08:00:00Z', sports: 'Tennis', customerName: 'Cancelled' },
        { status: 'unattended', time_date: '2026-10-08T08:00:00Z', sports: 'Tennis', customerName: 'No-show' },
        { status: 'booked', inArrivalWindow: true, time_date: '2026-10-08T06:00:00Z', sports: 'Tennis', customerName: 'Ari' }, // active arrival window
        { status: 'booked', inArrivalWindow: false, time_date: '2026-10-08T08:00:00Z', sports: 'Badminton', customerName: 'Bea' }, // Manila afternoon, today
        { status: 'booked', inArrivalWindow: false, time_date: '2026-10-08T10:00:00Z', sports: 'Tennis', customerName: 'Cam' }, // Manila evening, today
        { status: 'booked', inArrivalWindow: false, time_date: '2026-10-09T02:00:00Z', sports: 'Tennis', customerName: 'Dee' }, // Manila morning, tomorrow
        { status: 'inplay', time_date: '2026-10-08T05:00:00Z', sports: 'Tennis', customerName: 'Live' },
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
        staffOverviewIdLabel: row => `B-${row.customerName}`,
        staffDerivedStatus: row => row.status,
        staffCanTimeIn: row => Boolean(row.inArrivalWindow),
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
        Date: class FixedDate extends Date { static now() { return Date.parse('2026-10-08T06:00:00Z'); } },
        Intl,
        window: {
            escapeHtml: value => String(value),
            InigoStaffPagination: { paginateRows: rows => ({ rows, page: 1 }) },
        },
    };
    runInNewContext(`${overviewFilterSource}\noverviewRows = globalThis.testRows; ${overviewFilterListenerSource}\nglobalThis.renderRows = renderFilteredOverview; globalThis.entries = overviewEntries; globalThis.renderSports = renderOverviewSportOptions;`, context);
    return { context, body, children, rows, dateInput: controls['[data-staff-overview-date]'], searchInput: controls['[data-staff-overview-search]'], sportSelect: controls['[data-staff-overview-sport]'] };
}

test('Overview defaults to upcoming and in-play rows, then filters by the selected calendar date', () => {
    const { context, children, dateInput } = filterHarness();
    assert.equal(dateInput.value, '', 'date filter starts unset');
    context.renderRows();
    assert.deepEqual(children.map(row => row.source.customerName), ['Ari', 'Bea', 'Cam', 'Dee', 'Live'], 'expired and terminal rows are omitted');
    dateInput.value = '2026-10-08';
    dateInput.onChange();
    assert.deepEqual(children.map(row => row.source.customerName), ['Ari', 'Bea', 'Cam', 'Live']);
    dateInput.value = '2026-10-09';
    dateInput.onChange();
    assert.deepEqual(children.map(row => row.source.customerName), ['Dee']);
});

test('Overview combines customer, sport, and date filters across eligible upcoming rows', () => {
    const { context, children, body } = filterHarness({ query: 'b-ari', sport: 'Tennis', date: '2026-10-08' });
    context.renderRows();
    assert.equal(children.length, 1);
    assert.equal(children[0].source.customerName, 'Ari');
    assert.equal(children[0].dataset.rowIndex, '4', 'action index still maps to the original merged row');
    assert.equal(body.innerHTML, '');
});

test('Overview sport options come from eligible rows and retain a still-available selection', () => {
    const { context, sportSelect } = filterHarness({ sport: 'Tennis' });
    context.renderSports(context.entries());
    assert.match(sportSelect.innerHTML, /value="">All sports/);
    assert.match(sportSelect.innerHTML, /value="Badminton">Badminton/);
    assert.match(sportSelect.innerHTML, /value="Tennis">Tennis/);
    assert.equal(sportSelect.value, 'Tennis');
});

test('Overview reports filtered empty results and leaves filter values available for refresh renders', () => {
    const { context, body, dateInput, searchInput, sportSelect } = filterHarness({ query: 'nobody', sport: 'Tennis', date: '2026-10-08' });
    context.renderRows();
    assert.match(body.innerHTML, /No bookings match these filters/);
    assert.equal(searchInput.value, 'nobody');
    assert.equal(sportSelect.value, 'Tennis');
    assert.equal(dateInput.value, '2026-10-08');
    context.renderRows();
    assert.match(body.innerHTML, /No bookings match these filters/);
});

test('Overview has no time-of-day filter control or filter logic', () => {
    assert.match(html, /<input type="date"[^>]*data-staff-overview-date/);
    assert.doesNotMatch(html, /data-staff-overview-time|Any time|Morning|Afternoon|Evening/);
    assert.doesNotMatch(source, /data-staff-overview-time|overviewMatchesTime|overviewHour\(/);
});

test('Overview pages current and future booking rows without loading historical records', async () => {
    assert.match(source, /fetchOverviewBookings\(\)[\s\S]*?\.from\('booking'\)[\s\S]*?\.gte\('time_date', start\.toISOString\(\)\)[\s\S]*?\.order\('time_date', \{ ascending: true \}\)[\s\S]*?\.order\('booking_id', \{ ascending: true \}\)/);
    assert.match(source, /fetchOverviewWalkins\(\)[\s\S]*?\.from\('walk_in_booking'\)[\s\S]*?\.gte\('time_date', start\.toISOString\(\)\)[\s\S]*?\.order\('time_date', \{ ascending: true \}\)/);
    assert.doesNotMatch(source.slice(source.indexOf('    async function fetchOverviewBookings()'), source.indexOf('    // Include the date for every row')), /\.in\('status'|\.lt\('time_date'/);

    const start = source.indexOf('    async function fetchOverviewRows(buildQuery) {');
    const end = source.indexOf('\n\n    async function fetchOverviewBookings()', start);
    assert.ok(start >= 0 && end > start, 'paged Overview fetch helper is present');
    const context = { buildPageQuery: null };
    runInNewContext(`${source.slice(start, end)}\nglobalThis.fetchRows = fetchOverviewRows;`, context);
    const rows = Array.from({ length: 1201 }, (_, id) => ({ id }));
    const offsets = [];
    context.buildPageQuery = () => ({
        async range(from, to) {
            offsets.push([from, to]);
            return { data: rows.slice(from, to + 1), error: null };
        },
    });
    const result = await context.fetchRows(() => context.buildPageQuery());
    assert.equal(result.ok, true);
    assert.equal(result.rows.length, 1201);
    assert.deepEqual(offsets, [[0, 499], [500, 999], [1000, 1499]]);
});

test('Overview only fetches while active and ignores stale refresh results', async () => {
    const visibleStart = source.indexOf('    function isOverviewVisible() {');
    const visibleEnd = source.indexOf('\n\n    function overviewEntries()', visibleStart);
    const refreshStart = source.indexOf('    async function refreshBookingOverview() {');
    const refreshEnd = source.indexOf('\n\n    [overviewSearchInput', refreshStart);
    assert.ok(visibleStart >= 0 && visibleEnd > visibleStart);
    assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);

    const pending = [];
    let bookingFetches = 0;
    let renderCount = 0;
    const context = {
        document: {
            visibilityState: 'visible',
            querySelector: selector => selector === '[data-staff-panel="overview"]'
                ? { classList: { contains: value => value === 'is-active' } }
                : null,
        },
        window: { sb: {} },
        overviewTableBody: { innerHTML: '' },
        overviewPagination: {},
        overviewPage: 1,
        overviewRows: [],
        overviewRefreshGeneration: 0,
        fetchOverviewBookings: () => { bookingFetches += 1; return new Promise(resolve => pending.push(resolve)); },
        fetchOverviewWalkins: () => Promise.resolve({ ok: true, rows: [] }),
        mergeBookingRows: rows => rows.map(row => ({ ...row, sourceType: 'booking' })),
        fetchProfileNamesByIds: async () => new Map(),
        staffOverviewIdLabel: row => String(row.id),
        renderOverviewStats() {},
        overviewEntries: () => [],
        renderOverviewSportOptions() {},
        renderFilteredOverview() { renderCount += 1; },
        renderStaffTablePagination() {},
        console: { error() {} },
    };
    runInNewContext(`${source.slice(visibleStart, visibleEnd)}\n${source.slice(refreshStart, refreshEnd)}\nglobalThis.refresh = refreshBookingOverview;`, context);

    const first = context.refresh();
    const second = context.refresh();
    assert.equal(bookingFetches, 2);
    pending[1]({ ok: true, rows: [{ id: 'new' }] });
    await second;
    pending[0]({ ok: true, rows: [{ id: 'old' }] });
    await first;
    assert.deepEqual(context.overviewRows.map(row => row.id), ['new']);
    assert.equal(renderCount, 1, 'only the latest refresh updates the table');

    context.document.visibilityState = 'hidden';
    await context.refresh();
    assert.equal(bookingFetches, 2, 'hidden documents do not start another fetch');
    assert.match(source, /if \(name === 'overview'\) refreshBookingOverview\(\)/, 'activating Overview triggers a refresh');
});

test('Overview stats exclude cancelled bookings while retaining completed and unattended counts', () => {
    const start = source.indexOf('    function renderOverviewStats(rows) {');
    const end = source.indexOf('\n\n    function staffActionCellHtml', start);
    assert.ok(start >= 0 && end > start);
    const stats = {};
    const context = {
        todayRange: () => ({ start: new Date('2026-10-08T00:00:00Z'), end: new Date('2026-10-09T00:00:00Z') }),
        staffDerivedStatus: row => row.status,
        setStat: (key, value) => { stats[key] = value; },
        Date,
    };
    runInNewContext(`${source.slice(start, end)}\nglobalThis.renderStats = renderOverviewStats;`, context);
    context.renderStats([
        { sourceType: 'booking', status: 'booked', time_date: '2026-10-08T05:00:00Z' },
        { sourceType: 'booking', status: 'completed', time_date: '2026-10-08T06:00:00Z' },
        { sourceType: 'booking', status: 'unattended', time_date: '2026-10-08T07:00:00Z' },
        { sourceType: 'booking', status: 'cancelled', time_date: '2026-10-08T08:00:00Z' },
        { sourceType: 'walkin', status: 'booked', time_date: '2026-10-08T09:00:00Z' },
        { sourceType: 'booking', status: 'booked', time_date: '2026-10-09T00:00:00Z' },
    ]);
    assert.equal(stats['bookings-today'], 3);
    assert.equal(stats['walkins-today'], 1);
    assert.equal(stats['unattended-today'], 1);
});

test('Overview shows status text instead of actions for terminal rows and blocks expired Time-In', () => {
    const actionStart = source.indexOf('    function staffActionCellHtml(row, status) {');
    const actionEnd = source.indexOf('\n\n    function staffHasOverviewAction', actionStart);
    assert.ok(actionStart >= 0 && actionEnd > actionStart);
    const actionContext = {
        staffCanTimeIn: () => false,
        staffStatusLabel: status => status[0].toUpperCase() + status.slice(1),
        window: { escapeHtml: value => String(value) },
    };
    runInNewContext(`${source.slice(actionStart, actionEnd)}\nglobalThis.renderAction = staffActionCellHtml;`, actionContext);
    for (const status of ['cancelled', 'completed', 'unattended']) {
        const html = actionContext.renderAction({}, status);
        assert.match(html, new RegExp(status[0].toUpperCase() + status.slice(1)));
        assert.doesNotMatch(html, /<button/);
    }

    const timeInStart = source.indexOf('    const TIME_IN_LEAD_MINUTES = 15;');
    const timeInEnd = source.indexOf('\n\n    // `walk_in_booking`', timeInStart);
    const RealDate = Date;
    class FixedDate extends RealDate { static now() { return RealDate.parse('2026-10-08T12:00:00Z'); } }
    const timeInContext = {
        Date: FixedDate,
        rowWindow: row => ({ end: new RealDate(row.end_at) }),
    };
    runInNewContext(`${source.slice(timeInStart, timeInEnd)}\nglobalThis.canTimeIn = staffCanTimeIn;`, timeInContext);
    assert.equal(timeInContext.canTimeIn({ time_date: '2026-10-07T12:00:00Z', end_at: '2026-10-07T13:00:00Z' }, 'booked'), false);
    assert.equal(timeInContext.canTimeIn({ time_date: '2026-10-08T12:00:00Z', end_at: '2026-10-08T13:00:00Z' }, 'booked'), true);
});

test('Overview shows the unfiltered empty state when there are no bookings', () => {
    const { context, body, rows } = filterHarness();
    rows.splice(0, rows.length);
    context.renderRows();
    assert.match(body.innerHTML, /No bookings found/);
});
