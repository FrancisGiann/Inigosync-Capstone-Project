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
const listenerStart = source.indexOf('    [overviewSearchInput, overviewSportSelect, overviewTypeSelect, overviewDateInput].forEach((control) => {');
const listenerEnd = source.indexOf('\n\n    // Revision S2', listenerStart);
assert.ok(listenerStart >= 0 && listenerEnd > listenerStart, 'Overview filter change listeners are present');
const overviewFilterListenerSource = source.slice(listenerStart, listenerEnd);

function filterHarness({ query = '', sport = '', type = '', date = '' } = {}) {
    const rows = [
        { sourceType: 'booking', status: 'completed', time_date: '2026-10-07T02:00:00Z', sports: 'Bowling', customerName: 'Past' },
        { sourceType: 'booking', status: 'booked', inArrivalWindow: false, time_date: '2026-10-08T04:00:00Z', sports: 'Tennis', customerName: 'Expired' },
        { sourceType: 'booking', status: 'cancelled', time_date: '2026-10-08T08:00:00Z', sports: 'Tennis', customerName: 'Cancelled' },
        { sourceType: 'booking', status: 'unattended', time_date: '2026-10-08T08:00:00Z', sports: 'Tennis', customerName: 'No-show' },
        { sourceType: 'booking', status: 'booked', inArrivalWindow: true, time_date: '2026-10-08T06:00:00Z', sports: 'Tennis', customerName: 'Ari' }, // active arrival window
        { sourceType: 'booking', status: 'booked', inArrivalWindow: false, time_date: '2026-10-08T08:00:00Z', sports: 'Badminton', customerName: 'Bea' }, // Manila afternoon, today
        { sourceType: 'booking', status: 'booked', inArrivalWindow: false, time_date: '2026-10-08T10:00:00Z', sports: 'Tennis', customerName: 'Cam' }, // Manila evening, today
        { sourceType: 'booking', status: 'booked', inArrivalWindow: false, time_date: '2026-10-09T02:00:00Z', sports: 'Tennis', customerName: 'Dee' }, // Manila morning, tomorrow
        { sourceType: 'booking', status: 'inplay', time_date: '2026-10-08T05:00:00Z', sports: 'Tennis', customerName: 'Live' },
        { sourceType: 'walkin', status: 'booked', time_date: '2026-10-08T08:00:00Z', sports: 'Tennis', customerName: 'Staff walk-in' },
    ];
    const children = [];
    const body = {
        set innerHTML(value) { this.html = value; children.length = 0; },
        get innerHTML() { return this.html; },
        appendChild(row) { children.push(row); },
    };
    const documentListeners = {};
    let todayValue = '2026-10-08';
    const controls = {
        '[data-staff-table="overview"] tbody': body,
        '[data-staff-pagination="overview"]': { addEventListener() {} },
        '[data-staff-overview-search]': { value: query, addEventListener(event, handler) { if (event === 'input') this.onInput = handler; } },
        '[data-staff-overview-sport]': { value: sport, innerHTML: '', addEventListener() {} },
        '[data-staff-overview-type]': { value: type, addEventListener(event, handler) { if (event === 'change') this.onChange = handler; } },
        '[data-staff-overview-date]': { value: date ?? todayValue, min: '', addEventListener(event, handler) { this[`on${event[0].toUpperCase()}${event.slice(1)}`] = handler; } },
        '[data-staff-overview-clear]': { hidden: false, addEventListener(event, handler) { if (event === 'click') this.onClick = handler; } },
    };
    const context = {
        document: {
            hidden: false,
            querySelector: selector => controls[selector] || null,
            addEventListener(event, handler) { documentListeners[event] = handler; },
        },
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
        todayDateInputValue: () => todayValue,
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
    return { context, body, children, rows, dateInput: controls['[data-staff-overview-date]'], searchInput: controls['[data-staff-overview-search]'], sportSelect: controls['[data-staff-overview-sport]'], typeSelect: controls['[data-staff-overview-type]'], clearButton: controls['[data-staff-overview-clear]'], documentListeners, setToday(value) { todayValue = value; } };
}

test('Overview defaults to today and filters by an explicitly selected date and type', () => {
    const { context, children, dateInput, typeSelect, clearButton, searchInput } = filterHarness();
    assert.equal(dateInput.value, '2026-10-08', 'date filter starts on today in Manila');
    assert.equal(dateInput.min, '2026-10-08', 'native date picker cannot choose a date before the current Manila date');
    assert.equal(clearButton.hidden, true, 'Clear filters is hidden when controls match their defaults');
    searchInput.value = '   ';
    searchInput.onInput();
    assert.equal(clearButton.hidden, true, 'whitespace-only search does not count as an active filter');
    searchInput.value = 'Ari';
    searchInput.onInput();
    assert.equal(clearButton.hidden, false, 'a nonempty search shows Clear filters');
    searchInput.value = '';
    searchInput.onInput();
    assert.equal(clearButton.hidden, true);
    typeSelect.value = 'booking';
    typeSelect.onChange();
    assert.equal(clearButton.hidden, false, 'Booking is an active Type filter when All types is the default');
    typeSelect.value = '';
    typeSelect.onChange();
    assert.equal(clearButton.hidden, true);
    context.renderRows();
    assert.deepEqual(children.map(row => row.source.customerName), ['Ari', 'Bea', 'Cam', 'Live', 'Staff walk-in'], 'expired and terminal rows are omitted and the default date limits results to today');
    typeSelect.value = 'walkin';
    typeSelect.onChange();
    assert.equal(clearButton.hidden, false);
    assert.deepEqual(children.map(row => row.source.customerName), ['Staff walk-in']);
    typeSelect.value = '';
    typeSelect.onChange();
    assert.equal(clearButton.hidden, true);
    dateInput.value = '2026-10-08';
    dateInput.onChange();
    assert.equal(clearButton.hidden, true, 'selecting the default date does not activate Clear filters');
    assert.deepEqual(children.map(row => row.source.customerName), ['Ari', 'Bea', 'Cam', 'Live', 'Staff walk-in']);
    dateInput.value = '2026-10-09';
    dateInput.onChange();
    assert.deepEqual(children.map(row => row.source.customerName), ['Dee']);
    dateInput.value = '2026-10-07';
    dateInput.onChange();
    assert.equal(dateInput.value, '2026-10-08', 'typed or stale past dates are clamped to today');
    assert.deepEqual(children.map(row => row.source.customerName), ['Ari', 'Bea', 'Cam', 'Live', 'Staff walk-in']);
    dateInput.value = '';
    dateInput.onInput();
    assert.equal(dateInput.value, '', 'native Clear leaves the date filter blank');
    assert.equal(clearButton.hidden, false, 'a blank date differs from the default and exposes Clear filters');
    assert.deepEqual(children.map(row => row.source.customerName), ['Ari', 'Bea', 'Cam', 'Dee', 'Live', 'Staff walk-in'], 'blank date shows today and upcoming eligible bookings');
    dateInput.onFocus();
    dateInput.onPointerdown();
    assert.equal(dateInput.value, '', 'opening the picker does not refill an explicitly cleared date');
    clearButton.onClick();
    assert.equal(dateInput.value, '2026-10-08', 'Clear filters restores today after the date was explicitly cleared');
    assert.equal(clearButton.hidden, true, 'Clear filters hides itself immediately after resetting a cleared date');
});

test('Overview replaces an initially stale past date with today while retaining the minimum', () => {
    const { dateInput } = filterHarness({ date: '2026-10-07' });
    assert.equal(dateInput.min, '2026-10-08');
    assert.equal(dateInput.value, '2026-10-08');
});

test('Overview preserves a cleared date across refreshes and rolls the untouched default across Manila midnight', () => {
    const { dateInput, setToday, documentListeners, clearButton } = filterHarness();
    setToday('2026-10-09');
    dateInput.onFocus();
    assert.equal(dateInput.min, '2026-10-09');
    assert.equal(dateInput.value, '2026-10-09', 'picker interaction retains the current default date');

    dateInput.value = '2026-10-10';
    setToday('2026-10-11');
    documentListeners.visibilitychange();
    assert.equal(dateInput.min, '2026-10-11');
    assert.equal(dateInput.value, '2026-10-11', 'visibility return refreshes stale picker state');

    dateInput.value = '';
    dateInput.onInput();
    setToday('2026-10-12');
    documentListeners.visibilitychange();
    assert.equal(dateInput.min, '2026-10-12');
    assert.equal(dateInput.value, '', 'visibility return preserves an explicitly cleared date');
    assert.equal(clearButton.hidden, false, 'an explicitly cleared date remains an active filter setting');

    clearButton.onClick();
    assert.equal(dateInput.value, '2026-10-12', 'Clear filters restores the initial today default');
    setToday('2026-10-12');
    documentListeners.visibilitychange();
    assert.equal(dateInput.min, '2026-10-12');
    assert.equal(dateInput.value, '2026-10-12', 'the restored default tracks today');
    assert.equal(clearButton.hidden, true, 'the button is hidden at the default date');
    dateInput.value = '2026-10-12';
    dateInput.onChange();
    assert.equal(clearButton.hidden, true, 'today remains the default date after rollover');
    dateInput.value = '2026-10-13';
    dateInput.onChange();
    assert.equal(clearButton.hidden, false, 'a nondefault future date shows Clear filters');
    dateInput.onFocus({ type: 'focus' });
    dateInput.onPointerdown({ type: 'pointerdown' });
    assert.equal(dateInput.value, '2026-10-13', 'picker interaction preserves a current explicit future date');
});

test('Overview combines customer, sport, and date filters across eligible upcoming rows', () => {
    const { context, children, body } = filterHarness({ query: 'b-ari', sport: 'Tennis', date: '2026-10-08' });
    context.renderRows();
    assert.equal(children.length, 1);
    assert.equal(children[0].source.customerName, 'Ari');
    assert.equal(children[0].dataset.rowIndex, '4', 'action index still maps to the original merged row');
    assert.equal(body.innerHTML, '');
});

test('Overview keeps early checked-in booking and walk-in rows visible while they wait', () => {
    const { context, rows, children } = filterHarness();
    rows.push(
        { sourceType: 'booking', status: 'arrived', time_date: '2026-10-08T07:00:00Z', sports: 'Tennis', customerName: 'Early booking' },
        { sourceType: 'walkin', status: 'arrived', time_date: '2026-10-08T07:30:00Z', sports: 'Tennis', customerName: 'Early walk-in' },
    );
    context.renderRows();
    assert.deepEqual(
        children.filter(row => row.source.status === 'arrived').map(row => row.source.customerName),
        ['Early booking', 'Early walk-in'],
        'arrived rows remain visible without becoming actionable before their start time',
    );
});

test('Overview sport options come from eligible rows and retain a still-available selection', () => {
    const { context, sportSelect } = filterHarness({ sport: 'Tennis' });
    context.renderSports(context.entries());
    assert.match(sportSelect.innerHTML, /value="" disabled hidden>All sports/);
    assert.match(sportSelect.innerHTML, /value="Badminton">Badminton/);
    assert.match(sportSelect.innerHTML, /value="Tennis">Tennis/);
    assert.equal(sportSelect.value, 'Tennis');
});

test('Overview placeholders are not menu choices and Clear filters restores today defaults', () => {
    assert.match(html, /<button type="button" class="staff-overview-clear" data-staff-overview-clear hidden>/);
    assert.match(html, /<option value="" disabled hidden>All sports<\/option>/);
    assert.match(html, /<option value="" disabled hidden>All types<\/option>/);
    const { context, children, clearButton, dateInput, searchInput, sportSelect, typeSelect } = filterHarness({
        query: 'staff', sport: 'Tennis', type: 'walkin', date: '2026-10-08',
    });
    context.renderSports(context.entries());
    context.renderRows();
    assert.deepEqual(children.map(row => row.source.customerName), ['Staff walk-in']);
    clearButton.onClick();
    assert.equal(searchInput.value, '');
    assert.equal(sportSelect.value, '');
    assert.equal(typeSelect.value, '');
    assert.equal(dateInput.value, '2026-10-08');
    assert.equal(clearButton.hidden, true, 'reset restores the today date default and hides the button');
    assert.deepEqual(children.map(row => row.source.customerName), ['Ari', 'Bea', 'Cam', 'Live', 'Staff walk-in']);
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

test('Overview sorts actionable Time-In, actionable Time-Out, then no-action rows chronologically', () => {
    const start = source.indexOf('    function compareOverviewRows(a, b) {');
    const end = source.indexOf('\n\n    async function refreshBookingOverview()', start);
    assert.ok(start >= 0 && end > start, 'Overview comparator is present');
    const context = {
        staffDerivedStatus: row => row.status,
        staffCanTimeIn: row => Boolean(row.inArrivalWindow),
        rowWindow: row => ({ end: new Date(row.end_at) }),
        staffOverviewIdLabel: row => `${row.sourceType === 'walkin' ? 'W' : 'B'}-${row.id}`,
        Date,
    };
    runInNewContext(`${source.slice(start, end)}\nglobalThis.compareRows = compareOverviewRows;`, context);

    const rows = [
        { id: 10, sourceType: 'booking', status: 'booked', inArrivalWindow: true, time_date: '2026-11-02T08:00:00Z' },
        { id: 2, sourceType: 'booking', status: 'booked', time_date: '2026-11-02T06:00:00Z' },
        { id: 3, sourceType: 'booking', status: 'booked', time_date: '2026-11-02T06:00:00Z' },
        { id: 1, sourceType: 'walkin', status: 'inplay', time_date: '2026-11-02T04:00:00Z', end_at: '2026-11-02T07:00:00Z' },
        { id: 4, sourceType: 'booking', status: 'inplay', time_date: '2026-11-02T05:00:00Z', end_at: '2026-11-02T06:00:00Z' },
        { id: 8, sourceType: 'booking', status: 'booked', time_date: '2026-11-01T06:00:00Z' },
        { id: 7, sourceType: 'walkin', status: 'arrived', time_date: '2026-11-02T04:30:00Z' },
    ];
    rows.sort(context.compareRows);
    assert.deepEqual(rows.map(row => row.id), [10, 1, 4, 8, 7, 2, 3], 'Time-In rows precede Time-Out rows; waiting/no-action rows follow chronologically');
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
        staffExtensionAvailabilityCache: new Map(),
        staffDerivedStatus: row => row.status || 'booked',
        overviewRefreshGeneration: 0,
        compareOverviewRows: () => 0,
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
        { sourceType: 'booking', status: 'arrived', time_date: '2026-10-08T08:30:00Z' },
        { sourceType: 'walkin', status: 'booked', time_date: '2026-10-08T09:00:00Z' },
        { sourceType: 'booking', status: 'inplay', time_date: '2026-10-08T09:30:00Z' },
        { sourceType: 'booking', status: 'booked', time_date: '2026-10-09T00:00:00Z' },
    ]);
    assert.equal(stats['bookings-today'], 5);
    assert.equal(stats['walkins-today'], 1);
    assert.equal(stats['inplay-now'], 1, 'arrived bookings waiting for their scheduled start are excluded');
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

    const timeInStart = source.indexOf('    const TIME_IN_LEAD_MINUTES = 30;');
    const timeInEnd = source.indexOf('\n\n    // `walk_in_booking`', timeInStart);
    const RealDate = Date;
    class FixedDate extends RealDate { static now() { return RealDate.parse('2026-10-08T12:00:00Z'); } }
    const timeInContext = {
        Date: FixedDate,
        rowWindow: row => ({ end: new RealDate(row.end_at) }),
    };
    runInNewContext(`${source.slice(timeInStart, timeInEnd)}\nglobalThis.canTimeIn = staffCanTimeIn;`, timeInContext);
    assert.equal(timeInContext.canTimeIn({ sourceType: 'booking', time_date: '2026-10-07T12:00:00Z', end_at: '2026-10-07T13:00:00Z' }, 'booked'), false);
    assert.equal(timeInContext.canTimeIn({ sourceType: 'booking', time_date: '2026-10-08T12:30:01Z', end_at: '2026-10-08T13:00:00Z' }, 'booked'), false, 'Time-In stays closed until the 30-minute lead-in begins');
    assert.equal(timeInContext.canTimeIn({ sourceType: 'booking', time_date: '2026-10-08T12:30:00Z', end_at: '2026-10-08T13:00:00Z' }, 'booked'), true, 'booking Time-In opens exactly 30 minutes before the scheduled start');
    assert.equal(timeInContext.canTimeIn({ sourceType: 'walkin', time_date: '2026-10-08T12:30:00Z', end_at: '2026-10-08T13:00:00Z' }, 'booked'), false, 'walk-ins time in automatically at scheduled start');
});

test('Overview treats early check-in as arrived and keeps walk-ins non-actionable before automatic Time-In', () => {
    const statusStart = source.indexOf('    function staffDerivedStatus(row) {');
    const statusEnd = source.indexOf('\n\n    const STAFF_STATUS_LABELS', statusStart);
    assert.ok(statusStart >= 0 && statusEnd > statusStart);
    const RealDate = Date;
    class FixedDate extends RealDate { static now() { return RealDate.parse('2026-10-08T12:00:00Z'); } }
    const statusContext = { Date: FixedDate, rowWindow: row => ({ start: new RealDate(row.time_date), end: new RealDate(row.end_at) }) };
    runInNewContext(`${source.slice(statusStart, statusEnd)}\nglobalThis.deriveStatus = staffDerivedStatus;`, statusContext);
    const earlyRow = { status: 'booked', checked_in_at: '2026-10-08T11:40:00Z', time_date: '2026-10-08T12:30:00Z', end_at: '2026-10-08T13:30:00Z' };
    assert.equal(statusContext.deriveStatus(earlyRow), 'arrived');
    assert.equal(statusContext.deriveStatus({ ...earlyRow, time_date: '2026-10-08T12:00:00Z' }), 'inplay', 'the waiting row becomes in play at scheduled start');

    const actionStart = source.indexOf('    function staffActionCellHtml(row, status) {');
    const actionEnd = source.indexOf('\n\n    function staffHasOverviewAction', actionStart);
    const actionContext = {
        staffCanTimeIn: () => false,
        staffStatusLabel: status => status === 'arrived' ? 'Arrived · waiting' : 'Booked',
        window: { escapeHtml: value => String(value) },
    };
    runInNewContext(`${source.slice(actionStart, actionEnd)}\nglobalThis.renderAction = staffActionCellHtml;`, actionContext);
    assert.match(actionContext.renderAction({ sourceType: 'booking' }, 'booked'), /Booked/);
    assert.match(actionContext.renderAction({ sourceType: 'walkin' }, 'booked'), /Walk-in/);
    assert.doesNotMatch(actionContext.renderAction({ sourceType: 'walkin' }, 'booked'), /<button/);
    const waitingHtml = actionContext.renderAction({ sourceType: 'walkin' }, 'arrived');
    assert.match(waitingHtml, /Arrived · waiting/);
    assert.doesNotMatch(waitingHtml, /Time-Out|<button/);
});

test('Overview row renderer labels booking sources without throwing', () => {
    const rowStart = source.indexOf('    function renderOverviewRow(row) {');
    const rowEnd = source.indexOf('\n\n    async function refreshBookingOverview()', rowStart);
    assert.ok(rowStart >= 0 && rowEnd > rowStart, 'Overview row renderer is present');

    const context = {
        document: { createElement: () => ({ dataset: {}, innerHTML: '' }) },
        window: { escapeHtml: value => String(value) },
        staffDerivedStatus: row => row.status,
        timeInPaymentInfo: row => ({ balance: row.balance ?? null }),
        formatStaffPeso: value => `₱${value}`,
        staffOverviewIdLabel: row => row.sourceType === 'walkin' ? 'W-7' : 'B-9',
        formatOverviewTimeCell: () => '2:00 PM – 3:00 PM',
        staffActionCellHtml: () => '<span>In play</span>',
    };
    runInNewContext(`${source.slice(rowStart, rowEnd)}\nglobalThis.renderRow = renderOverviewRow;`, context);

    const walkin = context.renderRow({ sourceType: 'walkin', status: 'inplay', customerName: 'Paid walk-in' });
    const booking = context.renderRow({ sourceType: 'booking', status: 'booked', customerName: 'Eligible booking' });
    assert.match(walkin.innerHTML, /<td>Walk-in<\/td>/);
    assert.match(walkin.innerHTML, /Paid walk-in/);
    assert.match(booking.innerHTML, /<td>Booking<\/td>/);
    assert.match(booking.innerHTML, /Eligible booking/);
});

test('Overview shows the unfiltered empty state when there are no reservations', () => {
    const { context, body, rows } = filterHarness();
    rows.splice(0, rows.length);
    context.renderRows();
    assert.match(body.innerHTML, /No reservations found/);
});
