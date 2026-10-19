import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const chartSource = await readFile(new URL('../event/chart.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261001191136_owner_income_dashboard.sql', import.meta.url), 'utf8');
const reportMigration = await readFile(new URL('../supabase/migrations/20261019184938_owner_income_report_periods.sql', import.meta.url), 'utf8');
const dashboardHtml = await readFile(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8');
const dashboardCss = await readFile(new URL('../Style/owner_dashboard.css', import.meta.url), 'utf8');
const dashboardScript = await readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');

function aggregateAt(isoNow, rows) {
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : [isoNow])); }
        static now() { return new Date(isoNow).getTime(); }
    }
    const context = {
        Date: FixedDate, Intl, Number, String, Object, Array, Math, console,
        document: { addEventListener() {} }, window: {},
    };
    runInNewContext(`${chartSource}\nglobalThis.__aggregate = aggregateBookingRows; globalThis.__data = () => CHART_DATA;`, context);
    context.__aggregate(rows);
    return context.__data();
}

function loadDashboardHelpers() {
    const context = {
        window: { addEventListener() {} },
        document: { addEventListener() {} },
        console,
    };
    runInNewContext(`${dashboardScript}\nglobalThis.__helpers = { buildAdminPerfGroups };`, context);
    return context.__helpers;
}

test('booking trends and status share Manila calendar periods and count future eligible bookings', () => {
    const data = aggregateAt('2026-10-01T02:00:00Z', [
        { time_date: '2026-09-27T15:59:59Z', status: 'confirmed', amount_paid: 100 }, // Sunday, Sep 27 in Manila
        { time_date: '2026-09-27T16:00:00Z', status: 'confirmed', amount_paid: 100 }, // Monday, Sep 28 in Manila
        { time_date: '2026-10-04T15:59:59Z', status: 'confirmed', amount_paid: 100 }, // Future Sunday bucket in Manila
        { time_date: '2026-10-04T16:00:00Z', status: 'pending', amount_paid: 0 }, // Future pending reservation is excluded
    ]);
    assert.equal(data.week.labels.length, 7);
    assert.deepEqual(Array.from(data.week.values), [1, 0, 0, 0, 0, 0, 1]);
    assert.equal(data.week.total, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(data.week.status)), { booked: 2, completed: 0, no_show: 0 });
    assert.equal(data.week.unit, 'bookings per day · this calendar week');
    assert.equal(data.month.labels.length, 12);
    assert.deepEqual(Array.from(data.month.values.slice(0, 8)), Array(8).fill(0));
    assert.equal(data.month.values[8], 2);
    assert.equal(data.month.values[9], 1);
    assert.equal(data.month.total, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(data.month.status)), { booked: 3, completed: 0, no_show: 0 });
    assert.equal(data.month.labels[0], 'Jan');
    assert.equal(data.month.labels[11], 'Dec');
    assert.equal(data.month.periods[0], 'January 2026');
    assert.equal(data.month.periods[11], 'December 2026');
    assert.equal(data.month.unit, 'bookings per month · this calendar year');
});

test('booking trends use the current calendar decade and include all its years', () => {
    const data = aggregateAt('2026-10-01T02:00:00Z', [
        { time_date: '2026-01-01T00:00:00Z', status: 'completed' },
        { time_date: '2026-10-01T00:00:00Z', status: 'confirmed', amount_paid: 40 },
        { time_date: '2026-11-01T00:00:00Z', status: 'confirmed', amount_paid: 50 },
    ]);
    assert.equal(data.year.labels.length, 10);
    assert.equal(data.year.labels[0], '2020');
    assert.equal(data.year.labels[9], '2029');
    assert.equal(data.year.values[0], 0);
    assert.equal(data.year.values[6], 3, 'current and future scheduled bookings in the current decade remain included');
    assert.equal(data.year.values[7], 0);
    assert.equal(data.year.values[9], 0);
    assert.equal(data.year.total, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(data.year.status)), { booked: 2, completed: 1, no_show: 0 });
    assert.equal(data.year.unit, 'bookings per year · this calendar decade');
    assert.equal(data.year.periods[0], '2020');
    assert.equal(data.year.periods[6], '2026');
});

test('booking trend report includes selected range, explicit periods, and only loaded chart data', () => {
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : ['2026-10-01T02:00:00Z'])); }
        static now() { return new Date('2026-10-01T02:00:00Z').getTime(); }
    }
    const context = {
        Date: FixedDate, Intl, Number, String, Object, Array, Math, console,
        document: { addEventListener() {} }, window: {},
    };
    runInNewContext(`${chartSource}\nglobalThis.__aggregate = aggregateBookingRows; globalThis.__report = buildBookingReport; globalThis.__chartLabel = bookingChartAccessibleLabel; globalThis.__data = () => CHART_DATA; globalThis.__ready = value => { chartDataAvailable = value; };`, context);
    context.__aggregate([{ time_date: '2026-09-28T01:00:00Z', status: 'confirmed', amount_paid: 20 }]);
    assert.equal(context.__report('week'), null, 'export data is unavailable until a successful fetch completes');
    context.__ready(true);
    const report = context.__report('week', new Date('2026-10-01T02:00:00Z'));
    assert.equal(report.rangeName, 'Weekly');
    assert.match(report.periodLabel, /September 28, 2026/);
    assert.equal(report.total, 1);
    assert.equal(report.takeaway, 'Busiest day: Mon · 1 booking.');
    assert.equal(context.__chartLabel(context.__data().week, 'week'), 'Booking trends for this week: 1 booking. Busiest day: Mon · 1 booking.');
    assert.equal(report.barMeaning, 'Each bar shows bookings on one day.');
    assert.equal(report.generatedDate, 'October 1, 2026');
    assert.equal(report.rows.length, 7);
    assert.equal(report.rows[0].period, 'September 28, 2026');
    assert.equal(report.rows[0].bookings, 1);

    const monthly = context.__report('month', new Date('2026-10-01T02:00:00Z'));
    assert.equal(monthly.periodLabel, 'Calendar year 2026');
    assert.equal(monthly.rows.length, 12);
    assert.equal(monthly.rows[0].period, 'January 2026');
    assert.equal(monthly.rows[11].period, 'December 2026');
    assert.equal(monthly.takeaway, 'Busiest month: Sep · 1 booking.');
    assert.equal(monthly.barMeaning, 'Each bar shows bookings in one month.');

    const yearly = context.__report('year', new Date('2026-10-01T02:00:00Z'));
    assert.equal(yearly.periodLabel, 'Calendar decade 2020–2029');
    assert.equal(yearly.rows.length, 10);
    assert.equal(yearly.rows[0].period, '2020');
    assert.equal(yearly.rows[9].period, '2029');
    assert.equal(yearly.takeaway, 'Busiest year: 2026 · 1 booking.');
    assert.equal(yearly.barMeaning, 'Each bar shows bookings in one year.');
});

test('booking trend takeaway explains a zero-booking range', () => {
    const context = {
        Date, Intl, Number, String, Object, Array, Math, console,
        document: { addEventListener() {} }, window: {},
    };
    runInNewContext(`${chartSource}\nglobalThis.__aggregate = aggregateBookingRows; globalThis.__report = buildBookingReport; globalThis.__ready = value => { chartDataAvailable = value; };`, context);
    context.__aggregate([]);
    context.__ready(true);
    const report = context.__report('month', new Date('2026-10-01T02:00:00Z'));
    assert.equal(report.total, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(report.status.counts)), { booked: 0, completed: 0, no_show: 0 });
    assert.equal(report.status.summary, 'No bookings this period.');
    assert.equal(report.takeaway, 'No bookings this period.');
    assert.equal(report.barMeaning, 'Each bar shows bookings in one month.');
});

test('single-status booking summaries spell out the full share', () => {
    const context = { Object, Math, Number, String, Array, document: { addEventListener() {} } };
    runInNewContext(`${chartSource}\nglobalThis.__summary = buildStatusReport;`, context);
    const report = context.__summary({ status: { booked: 0, completed: 0, no_show: 3 } });
    assert.equal(report.summary, 'All 3 bookings were no-shows.');
});

test('booking status pie leaves percentages to hover and separates nonzero slices', () => {
    const pieRoot = { innerHTML: '' };
    const context = {
        Object, Math, Number, String, Array,
        document: { addEventListener() {}, querySelector: () => pieRoot },
    };
    runInNewContext(`${chartSource}\nglobalThis.__renderStatus = renderStatusReport;`, context);
    context.__renderStatus({ status: { booked: 1, completed: 0, no_show: 2 } });
    assert.doesNotMatch(pieRoot.innerHTML, /67% No-show|admin-status-pie-share/);
    assert.match(pieRoot.innerHTML, /<p class="admin-status-takeaway" aria-live="polite">Most: No-show\.<\/p>/,
        'the status takeaway renders in its own full-width summary row');
    assert.doesNotMatch(pieRoot.innerHTML, /admin-status-summary[^<]*<p/,
        'the status takeaway is not duplicated beside the total');
    assert.match(pieRoot.innerHTML, /var\(--color-bg-card\) [\d.]+deg [\d.]+deg/,
        'card-colored separators distinguish adjacent pie slices');
    assert.match(pieRoot.innerHTML, /Booking status distribution: Booked 1, Completed 0, No-show 2\./);

    context.__renderStatus({ status: { booked: 0, completed: 0, no_show: 3 } });
    assert.doesNotMatch(pieRoot.innerHTML, /100% No-show|admin-status-pie-share/,
        'a single-color pie does not display a persistent percentage');
    context.__renderStatus({ status: { booked: 2, completed: 2, no_show: 0 } });
    assert.doesNotMatch(pieRoot.innerHTML, /Tie · 50% each|admin-status-pie-share/,
        'tied statuses do not display a persistent percentage');
    context.__renderStatus({ status: { booked: 500, completed: 1, no_show: 499 } });
    const tinySlice = pieRoot.innerHTML.match(/var\(--color-ink-faint\) ([\d.]+)deg ([\d.]+)deg/);
    assert.ok(tinySlice, 'the one-in-a-thousand status keeps a pie slice');
    assert.ok(Number(tinySlice[2]) > Number(tinySlice[1]), 'the tiny slice remains visible');
    assert.ok(Math.abs((Number(tinySlice[2]) - Number(tinySlice[1])) - 0.36) < 0.001,
        'the tiny category retains its proportional 0.36 degree arc without separators');
});

test('booking status pie hover shows matching status, count, and percentage beside the pointer', () => {
    const listeners = {};
    const tooltip = { hidden: true, textContent: '', style: {}, offsetWidth: 120, offsetHeight: 30 };
    const pie = {
        dataset: { statusCounts: '1,0,2' },
        closest: () => pie,
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 120, height: 120 }),
        querySelector: () => tooltip,
        addEventListener: (name, callback) => { listeners[name] = callback; },
    };
    let markup = '';
    const root = {
        set innerHTML(value) { markup = value; },
        get innerHTML() { return markup; },
        querySelector: () => pie,
    };
    const context = {
        Object, Math, Number, String, Array,
        document: { addEventListener() {}, querySelector: () => root },
        window: { innerWidth: 500, innerHeight: 500 },
    };
    runInNewContext(`${chartSource}\nglobalThis.__renderStatus = renderStatusReport;`, context);
    context.__renderStatus({ status: { booked: 1, completed: 0, no_show: 2 } });
    const pointerAt = angle => {
        const radians = (angle - 90) * Math.PI / 180;
        return { target: pie, clientX: 70 + Math.cos(radians) * 50, clientY: 80 + Math.sin(radians) * 50 };
    };
    listeners.pointermove({ target: pie, clientX: 70, clientY: 140 });
    assert.equal(tooltip.textContent, 'No-show: 2 bookings (67%)');
    assert.equal(tooltip.hidden, false);
    assert.equal(tooltip.style.left, '84px');
    assert.equal(tooltip.style.top, '154px');
    listeners.pointerleave({ target: pie });
    assert.equal(tooltip.hidden, true);

    pie.dataset.statusCounts = '1,1,0';
    listeners.pointermove(pointerAt(178));
    assert.equal(tooltip.textContent, 'Booked: 1 booking (50%)');
    assert.equal(tooltip.hidden, false);
    listeners.pointermove(pointerAt(180));
    assert.equal(tooltip.hidden, true, 'the visible separator has no status tooltip');
    listeners.pointermove(pointerAt(182));
    assert.equal(tooltip.textContent, 'Completed: 1 booking (50%)');
    assert.equal(tooltip.hidden, false);
});

test('booking report exporters pass chart totals and period rows to both file formats', () => {
    const workbookSheets = []; let workbookFilename; const pdfCalls = [];
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : ['2026-10-01T02:00:00Z'])); }
        static now() { return new Date('2026-10-01T02:00:00Z').getTime(); }
    }
    class FakePdf {
        setFontSize() {} setFont() {}
        splitTextToSize(text) { return [text]; }
        text(...args) { pdfCalls.push(args); }
        addPage() { pdfCalls.push(['addPage']); }
        rect(...args) { pdfCalls.push(['rect', ...args]); }
        setFillColor() {}
        save(filename) { pdfCalls.push(['save', filename]); }
    }
    const context = {
        Date: FixedDate, Intl, Number, String, Object, Array, Math, console,
        document: { addEventListener() {}, querySelector: () => null },
        window: {
            XLSX: {
                utils: {
                    aoa_to_sheet: rows => ({ rows }),
                    book_new: () => ({}), book_append_sheet: (_book, sheet, name) => workbookSheets.push({ rows: sheet.rows, merges: sheet['!merges'], name }),
                },
                writeFile: (_book, filename) => { workbookFilename = filename; },
            },
            jspdf: { jsPDF: FakePdf },
        },
    };
    runInNewContext(`${chartSource}\nglobalThis.__aggregate = aggregateBookingRows; globalThis.__seedIncome = () => { CHART_DATA.week.paid[0] = 12.5; CHART_DATA.month.paid[0] = 25.5; CHART_DATA.year.paid[0] = 77.5; }; globalThis.__ready = value => { chartDataAvailable = value; }; globalThis.__range = range => { currentChartRange = range; }; globalThis.__export = exportBookingReport;`, context);
    context.__aggregate([{ time_date: '2026-10-01T02:00:00Z', status: 'confirmed', amount_paid: 20 }]);
    context.__seedIncome();
    context.__ready(true);
    context.__range('year');
    assert.equal(context.__export('xlsx'), true);
    assert.match(workbookFilename, /booking-report-all-periods-\d{4}-\d{2}-\d{2}\.xlsx/);
    assert.deepEqual(workbookSheets.map(sheet => sheet.name), ['Weekly Report', 'Monthly Report', 'Yearly Report']);
    const tableRows = sheet => {
        const header = sheet.rows.findIndex(row => row[0] === 'Period' && row[1] === 'Bookings');
        return sheet.rows.slice(header + 1, header + 1 + (sheet.name === 'Weekly Report' ? 7 : sheet.name === 'Monthly Report' ? 12 : 10));
    };
    const weeklyRows = tableRows(workbookSheets[0]);
    const monthlyRows = tableRows(workbookSheets[1]);
    assert.equal(weeklyRows.length, 7);
    assert.equal(monthlyRows.length, 12);
    assert.equal(weeklyRows.reduce((sum, row) => sum + row[1], 0), 1);
    assert.equal(monthlyRows.reduce((sum, row) => sum + row[1], 0), 1);
    assert.equal(weeklyRows[0][2], 12.5);
    assert.equal(monthlyRows[0][2], 25.5);
    assert.equal(weeklyRows[0][0], 'September 28, 2026');
    const workbookRows = workbookSheets[2].rows;
    assert.ok(workbookRows.some(row => row[0] === 'Booking Report'));
    assert.ok(workbookRows.some(row => row[0] === 'Range' && row[1] === 'Yearly'));
    assert.ok(workbookRows.some(row => row[0] === 'Period' && /^Calendar decade \d{4}–\d{4}$/.test(row[1])));
    assert.equal(workbookRows.filter(row => /^20\d{2}$/.test(row[0])).length, 10,
        'the yearly export includes all ten calendar years');
    assert.ok(workbookRows.some(row => row[0] === 'Total eligible bookings' && row[1] === 1));
    assert.ok(workbookRows.some(row => row[0] === 'Generated (Manila)' && row[1] === 'October 1, 2026'),
        'generated date uses the current Manila date instead of the map index as a timestamp');
    assert.ok(workbookRows.some(row => row[0] === 'Period' && row[1] === 'Bookings'));
    assert.equal(workbookRows.find(row => row[0] === 'Period' && row[1] === 'Bookings')[2], 'Received (PHP, payment date)');
    assert.ok(!workbookRows.flat().some(value => typeof value === 'string' && /graph|bar|recorded in this calendar period/i.test(value)));
    assert.ok(!workbookSheets.some(sheet => sheet.rows.flat().some(value => typeof value === 'string' && /[█·]/.test(value))));
    assert.ok(workbookRows.some(row => row[0] === 'Booking status' && row[1] === 'Count'));
    assert.ok(workbookRows.some(row => row[0] === 'Booked' && row[1] === 1));
    assert.ok(workbookRows.some(row => row[0] === 'Total eligible bookings' && row[1] === 1));
    assert.ok(workbookRows.some(row => row[0] === 'Total bookings' && row[1] === 1));
    assert.equal(context.__export('pdf'), true);
    assert.ok(pdfCalls.some(call => call[0] === 'Booking Report - Weekly'));
    assert.ok(pdfCalls.some(call => Array.isArray(call[0]) && /Sales use payment date/.test(call[0][0])));
    assert.ok(pdfCalls.some(call => call[0] === 'Bookings: 1     Received: PHP 12.50'));
    assert.ok(pdfCalls.some(call => Array.isArray(call[0]) && call[0][0].startsWith('Busiest year:')));
    assert.ok(pdfCalls.some(call => call[0] === 'Booking status'));
    assert.ok(pdfCalls.some(call => call[0] === 'Booked'));
    assert.ok(pdfCalls.some(call => Array.isArray(call[0]) && /This booking is confirmed/.test(call[0][0])));
    assert.ok(pdfCalls.some(call => call[0] === 'save' && call[1].endsWith('.pdf')));
    assert.equal(pdfCalls.filter(call => call[0] === 'addPage').length, 2);
    assert.equal(pdfCalls.filter(call => call[0] === 'rect').length, 29, 'PDF includes a bar graph for all 7 + 12 + 10 periods');
    assert.ok(!workbookRows.flat().some(value => typeof value === 'string' && /tax/i.test(value)));
});

test('loaded reports use payment ledger totals keyed by Manila payment period', async () => {
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : ['2026-10-01T02:00:00Z'])); }
        static now() { return new Date('2026-10-01T02:00:00Z').getTime(); }
    }
    const incomeCalls = [];
    const context = {
        Date: FixedDate, Intl, Number, String, Object, Array, Math, console,
        document: { addEventListener() {} },
        window: { sb: { rpc: async (name, args) => {
            if (name === 'owner_income_report') {
                incomeCalls.push(args);
                return { data: [{ bucket_start: args.p_from_at, income: 125.5 }], error: null };
            }
            return { data: [], error: null };
        } } },
    };
    runInNewContext(`${chartSource}\nglobalThis.__load = loadChartData; globalThis.__report = buildBookingReport;`, context);
    assert.equal(await context.__load(), true);
    assert.deepEqual(incomeCalls.map(call => call.p_bucket), ['day', 'month', 'year']);
    for (const range of ['week', 'month', 'year']) {
        const report = context.__report(range);
        assert.equal(report.totalPaid, 125.5);
        assert.equal(report.rows.reduce((sum, row) => sum + row.paid, 0), 125.5);
    }
});

test('New Year booking trend fetch covers the decade in bounded segments and completes the cross-year week', async () => {
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : ['2020-01-01T03:00:00Z'])); }
        static now() { return new Date('2020-01-01T03:00:00Z').getTime(); }
    }
    const requests = [];
    const context = {
        Date: FixedDate, Intl, Number, String, Object, Array, Math, console,
        document: { addEventListener() {} },
        window: { sb: { rpc: async (name, args) => { requests.push({ name, ...args }); return { data: name === 'owner_income_report' ? [{ bucket_start: args.p_from_at, income: 0 }] : [], error: null }; } } },
    };
    runInNewContext(`${chartSource}\nglobalThis.__loadChartData = loadChartData; globalThis.__isChartAvailable = () => chartDataAvailable;`, context);
    await context.__loadChartData();
    assert.equal(context.__isChartAvailable(), true, 'a successful empty result is valid loaded data');
    const bookingRequests = requests.filter(request => request.name === 'admin_booking_overview');
    assert.equal(bookingRequests.length, 11);
    assert.equal(requests.filter(request => request.name === 'owner_income_report').length, 3);
    const ranges = bookingRequests.map(request => [request.p_from_at, request.p_to_at]);
    assert.deepEqual(ranges[0], ['2019-12-29T16:00:00.000Z', '2019-12-31T16:00:00.000Z']);
    assert.deepEqual(ranges.slice(1), Array.from({ length: 10 }, (_, i) => [
        `${2020 + i - 1}-12-31T16:00:00.000Z`, `${2020 + i}-12-31T16:00:00.000Z`,
    ]));
    assert.ok(bookingRequests.every(request => Date.parse(request.p_to_at) - Date.parse(request.p_from_at) <= 366 * 86400000));
});

test('weekly chart retains all days and status across a calendar year boundary', async () => {
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : ['2026-12-30T02:00:00Z'])); }
        static now() { return new Date('2026-12-30T02:00:00Z').getTime(); }
    }
    const requests = [];
    const rows = [
            { time_date: '2026-12-27T16:30:00Z', status: 'confirmed', amount_paid: 10 },
            { time_date: '2026-12-30T16:00:00Z', status: 'completed', amount_paid: 10 },
            { time_date: '2026-12-31T16:00:00Z', status: 'no_show', amount_paid: 0 },
            { time_date: '2027-01-03T15:00:00Z', status: 'confirmed', amount_paid: 20 },
    ];
    const context = {
        Date: FixedDate, Intl, Number, String, Object, Array, Math, console,
        document: { addEventListener() {} },
        window: { sb: { rpc: async (name, args) => {
            requests.push({ name, ...args });
            if (name === 'owner_income_report') return { data: [{ bucket_start: args.p_from_at, income: 0 }], error: null };
            const from = Date.parse(args.p_from_at); const to = Date.parse(args.p_to_at);
            return { data: rows.filter(row => Date.parse(row.time_date) >= from && Date.parse(row.time_date) < to) };
        } } },
    };
    runInNewContext(`${chartSource}\nglobalThis.__loadChartData = loadChartData; globalThis.__data = () => CHART_DATA;`, context);
    assert.equal(await context.__loadChartData(), true);
    const bookingRequests = requests.filter(request => request.name === 'admin_booking_overview');
    assert.equal(bookingRequests.length, 10);
    assert.equal(requests.filter(request => request.name === 'owner_income_report').length, 3);
    assert.ok(bookingRequests.every(request => Date.parse(request.p_to_at) - Date.parse(request.p_from_at) <= 366 * 86400000));
    assert.equal(context.__data().week.total, 4);
    assert.deepEqual(Array.from(context.__data().week.values), [1, 0, 0, 1, 1, 0, 1]);
    assert.deepEqual(JSON.parse(JSON.stringify(context.__data().week.status)), { booked: 2, completed: 1, no_show: 1 });
});

test('last decade week fetches its 2030 tail and keeps yearly data within 2020–2029', async () => {
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : ['2029-12-31T03:00:00Z'])); }
        static now() { return new Date('2029-12-31T03:00:00Z').getTime(); }
    }
    const requests = [];
    const rows = [
        { source: 'online', id: 'last-day', time_date: '2029-12-31T02:00:00Z', status: 'confirmed', amount_paid: 10 },
        { source: 'online', id: 'next-year-complete', time_date: '2030-01-01T02:00:00Z', status: 'completed', amount_paid: 0 },
        { source: 'walkin', id: 'next-year-no-show', time_date: '2030-01-05T02:00:00Z', status: 'no_show', amount_paid: 0 },
    ];
    const context = {
        Date: FixedDate, Intl, Number, String, Object, Array, Math, console,
        document: { addEventListener() {} },
        window: { sb: { rpc: async (name, args) => {
            requests.push({ name, ...args });
            if (name === 'owner_income_report') return { data: [{ bucket_start: args.p_from_at, income: 0 }], error: null };
            const from = Date.parse(args.p_from_at); const to = Date.parse(args.p_to_at);
            return { data: rows.filter(row => Date.parse(row.time_date) >= from && Date.parse(row.time_date) < to) };
        } } },
    };
    runInNewContext(`${chartSource}\nglobalThis.__loadChartData = loadChartData; globalThis.__data = () => CHART_DATA;`, context);
    assert.equal(await context.__loadChartData(), true);
    assert.equal(requests.length, 14);
    assert.deepEqual(
        [requests.filter(request => request.name === 'admin_booking_overview').at(-1).p_from_at, requests.filter(request => request.name === 'admin_booking_overview').at(-1).p_to_at],
        ['2029-12-31T16:00:00.000Z', '2030-01-06T16:00:00.000Z'],
    );
    assert.ok(requests.filter(request => request.name === 'admin_booking_overview').every(request => Date.parse(request.p_to_at) - Date.parse(request.p_from_at) <= 366 * 86400000));
    assert.equal(context.__data().week.total, 3);
    assert.deepEqual(Array.from(context.__data().week.values), [1, 1, 0, 0, 0, 1, 0]);
    assert.deepEqual(JSON.parse(JSON.stringify(context.__data().week.status)), { booked: 1, completed: 1, no_show: 1 });
    assert.deepEqual(Array.from(context.__data().year.labels), ['2020', '2021', '2022', '2023', '2024', '2025', '2026', '2027', '2028', '2029']);
    assert.equal(context.__data().year.total, 1, 'the 2030 tail is excluded from decade totals');
    assert.deepEqual(JSON.parse(JSON.stringify(context.__data().year.status)), { booked: 1, completed: 0, no_show: 0 });
});

test('booking trend RPC failure keeps exports unavailable', async () => {
    const buttons = [{ disabled: false }, { disabled: false }, { disabled: false }];
    const context = {
        Date, Intl, Number, String, Object, Array, Math, console,
        document: { addEventListener() {}, querySelectorAll: () => buttons, querySelector: () => null },
        window: { sb: { rpc: async () => ({ data: null, error: new Error('denied') }) } },
    };
    runInNewContext(`${chartSource}\nglobalThis.__loadChartData = loadChartData; globalThis.__isChartAvailable = () => chartDataAvailable;`, context);
    assert.equal(await context.__loadChartData(), false);
    assert.equal(context.__isChartAvailable(), false);
    assert.ok(buttons.every(button => button.disabled));
});

test('payment ledger RPC failure keeps report exports unavailable', async () => {
    const buttons = [{ disabled: false }, { disabled: false }];
    const calls = [];
    const context = {
        Date, Intl, Number, String, Object, Array, Math, console,
        document: { addEventListener() {}, querySelectorAll: () => buttons, querySelector: () => null },
        window: { sb: { rpc: async name => {
            calls.push(name);
            return name === 'owner_income_report'
                ? { data: null, error: new Error('ledger unavailable') }
                : { data: [], error: null };
        } } },
    };
    runInNewContext(`${chartSource}\nglobalThis.__load = loadChartData; globalThis.__isAvailable = () => chartDataAvailable;`, context);
    assert.equal(await context.__load(), false);
    assert.equal(context.__isAvailable(), false);
    assert.equal(calls.filter(name => name === 'owner_income_report').length, 3);
    assert.ok(buttons.every(button => button.disabled));
});

test('stale booking report responses cannot replace the newest request', async () => {
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : ['2026-10-01T02:00:00Z'])); }
        static now() { return new Date('2026-10-01T02:00:00Z').getTime(); }
    }
    const pending = [];
    const context = {
        Date: FixedDate, Intl, Number, String, Object, Array, Math, console,
        document: { addEventListener() {} },
        window: { sb: { rpc: (name, args) => new Promise(resolve => pending.push({ resolve, name, args })) } },
    };
    runInNewContext(`${chartSource}\nglobalThis.__load = loadChartData; globalThis.__data = () => CHART_DATA;`, context);
    const oldRequest = context.__load();
    const currentRequest = context.__load();
    for (const { resolve } of pending.slice(10, 20)) resolve({ data: [{ time_date: '2026-10-01T00:00:00Z', status: 'completed' }], error: null });
    await new Promise(resolve => setImmediate(resolve));
    for (const { resolve, args } of pending.slice(20, 23)) resolve({ data: [{ bucket_start: args.p_from_at, income: 0 }], error: null });
    assert.equal(await currentRequest, true);
    for (const { resolve } of pending.slice(0, 10)) resolve({ data: [{ time_date: '2026-10-01T00:00:00Z', status: 'confirmed', amount_paid: 80 }], error: null });
    assert.equal(await oldRequest, false);
    assert.deepEqual(JSON.parse(JSON.stringify(context.__data().month.status)), { booked: 0, completed: 1, no_show: 0 });
});

test('income RPC requires an active owner and uses Manila payment-time ledger buckets', () => {
    assert.match(migration, /p\.role\s*=\s*'admin'\s+and coalesce\(p\.status, 'active'\) <> 'disabled'/i);
    assert.match(migration, /p_period is null or p_period not in \('day', 'month', 'year'\)/i);
    assert.match(migration, /pay\.created_at\s+at time zone 'Asia\/Manila'/i);
    assert.match(migration, /coalesce\(nullif\(pay\.base_minor, 0\)::numeric \/ 100, pay\.paid\)/i);
    assert.match(migration, /union\s+select w\.balance_payment_id/i);
    assert.match(migration, /union\s+select b\.balance_payment_id/i);
    assert.match(migration, /union\s+select o\.payment_id from internal\.staff_walkin_orders/i);
    assert.match(migration, /revoke all on function public\.owner_income_period\(text\) from public, anon/i);
});

test('all-period income RPC is owner-gated and includes linked online, walk-in, balance, and staff-order payments', () => {
    assert.match(reportMigration, /p\.role\s*=\s*'admin'\s+and coalesce\(p\.status, 'active'\) <> 'disabled'/i);
    assert.match(reportMigration, /p_bucket is null or p_bucket not in \('day', 'month', 'year'\)/i);
    assert.match(reportMigration, /v_local_to <> v_local_from \+ v_expected_span/i);
    assert.match(reportMigration, /p_bucket = 'day' and extract\(isodow from v_local_from\) <> 1/i);
    assert.match(reportMigration, /p_bucket = 'month' and \(extract\(month from v_local_from\) <> 1 or extract\(day from v_local_from\) <> 1\)/i);
    assert.match(reportMigration, /mod\(extract\(year from v_local_from\)::integer, 10\) <> 0/i);
    assert.match(reportMigration, /complete supported Manila calendar period/i);
    assert.match(reportMigration, /date_trunc\(p_bucket, pay\.created_at at time zone 'Asia\/Manila'\)/i);
    assert.match(reportMigration, /union select w\.balance_payment_id/i);
    assert.match(reportMigration, /union select b\.balance_payment_id/i);
    assert.match(reportMigration, /union select o\.payment_id from internal\.staff_walkin_orders/i);
    assert.match(reportMigration, /revoke all on function public\.owner_income_report\(timestamptz,timestamptz,text\) from public, anon/i);
    assert.match(reportMigration, /grant execute on function public\.owner_income_report\(timestamptz,timestamptz,text\) to authenticated/i);
});

test('owner income defaults to Month and replaces the bookings stat', () => {
    assert.match(dashboardHtml, /data-owner-income-range="month"[^>]*class="admin-pill-btn is-active"|class="admin-pill-btn is-active"[^>]*data-owner-income-range="month"/i);
    assert.match(dashboardHtml, /data-owner-income-total/);
    assert.match(dashboardHtml, /Total sales/);
    assert.doesNotMatch(dashboardHtml, /Income this month · Asia\/Manila|Amounts are before payment provider fees\./);
    assert.match(dashboardHtml, /data-admin-chart-export-toggle[^>]*aria-haspopup="menu"[^>]*disabled/);
    assert.match(dashboardHtml, /data-admin-chart-export="pdf" disabled/);
    assert.match(dashboardHtml, /data-admin-chart-export="xlsx" disabled/);
    assert.match(dashboardHtml, /data-admin-chart-takeaway/);
    assert.match(dashboardHtml, /id="adminBookingChart" role="img" aria-label=/);
    assert.equal((dashboardHtml.match(/data-admin-chart-range=/g) || []).length, 3);
    assert.equal((dashboardHtml.match(/data-admin-chart-export-toggle/g) || []).length, 1);
    assert.equal((dashboardHtml.match(/data-admin-chart-export-status/g) || []).length, 1);
    assert.match(dashboardHtml, /data-admin-chart-export-wrap[\s\S]*data-admin-chart-export-status[\s\S]*<\/div>/);
    assert.doesNotMatch(dashboardHtml, /data-admin-status-range=/);
    assert.match(dashboardHtml, /data-admin-status-breakdown/);
    assert.match(dashboardHtml, /data-admin-chart-export-toggle/);
    assert.doesNotMatch(dashboardHtml, /Pending and canceled bookings are excluded/);
    assert.equal((dashboardHtml.match(/class="admin-card admin-booking-report-card"/g) || []).length, 2);
    assert.ok(dashboardHtml.indexOf('admin-booking-toolbar') < dashboardHtml.indexOf('admin-booking-report-grid'));
    assert.match(dashboardCss, /\.admin-booking-report-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    assert.doesNotMatch(dashboardCss, /\.admin-status-report\s*\{[^}]*max-width:/s);
    assert.match(dashboardHtml, /admin-chart-export-toggle/);
    assert.match(dashboardCss, /\.admin-chart-exports\s*\{[^}]*position:\s*relative/s);
    assert.match(dashboardHtml, /xlsx-0\.20\.3/);
    assert.match(dashboardHtml, /jspdf@4\.2\.1/);
    assert.doesNotMatch(dashboardHtml, /data-admin-stat="bookings-month"|ownerIncomeChart/);
    assert.match(dashboardHtml, /data-admin-perf-chart[^>]*3 checks/i);
    assert.doesNotMatch(dashboardScript, /run 015_media_bucket\.sql/i);
});

test('booking report stacks two full-width chart cards inside an outer card', () => {
    assert.equal((dashboardHtml.match(/class="admin-card admin-booking-report-card"/g) || []).length, 2);
    assert.match(dashboardHtml, /<div class="admin-card admin-booking-report-shell">\s*<div class="admin-booking-toolbar">\s*<h2 class="admin-booking-report-title">Booking report<\/h2>\s*<div class="admin-booking-toolbar-controls">[\s\S]*?<\/div>\s*<\/div>\s*<div class="admin-booking-report-grid">[\s\S]*?<h3>Booking Trends<\/h3>[\s\S]*?<h3>Booking Status<\/h3>[\s\S]*?<\/div>\s*<\/div>/);
    assert.match(dashboardHtml, /admin-booking-report-grid[\s\S]*<h3>Booking Trends<\/h3>[\s\S]*<h3>Booking Status<\/h3>/);
    assert.equal((dashboardHtml.match(/data-admin-chart-range=/g) || []).length, 3);
    assert.equal((dashboardHtml.match(/data-admin-chart-export-toggle/g) || []).length, 1);
    assert.match(dashboardCss, /\.admin-booking-report-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    assert.match(dashboardCss, /\.admin-booking-report-shell\s*\{[^}]*min-width:\s*0/s);
    assert.match(dashboardCss, /\.admin-booking-report-title\s*\{[^}]*color:\s*var\(--color-ink\)/s);
    assert.match(dashboardCss, /\.admin-chart-takeaway\s*\{[^}]*color:\s*var\(--color-primary\)[^}]*font-size:\s*var\(--fs-sm\)[^}]*font-weight:\s*700[^}]*text-align:\s*center/s);
    assert.match(dashboardCss, /\.admin-status-takeaway\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*color:\s*var\(--color-primary\)[^}]*font-size:\s*var\(--fs-sm\)[^}]*font-weight:\s*700[^}]*text-align:\s*center/s);
    assert.doesNotMatch(dashboardCss, /\.admin-status-report\s*\{[^}]*max-width:/s);
    assert.match(dashboardCss, /\.admin-btn-chip-secondary\.admin-chart-export-toggle\s*\{[^}]*background:\s*var\(--color-primary\)/s);
    assert.match(dashboardCss, /\.admin-status-pie-share\s*\{[^}]*background:\s*var\(--color-bg-card\)/s);
    assert.match(dashboardCss, /\.admin-chart-exports\s*\{[^}]*position:\s*relative/s);
    assert.match(dashboardCss, /\.admin-chart-export-status\s*\{[^}]*position:\s*absolute/s);
});

test('website performance renders exactly three honest groups', () => {
    const { buildAdminPerfGroups } = loadDashboardHelpers();
    const [storage, speed, problems] = buildAdminPerfGroups({
        storage: { label: 'Storage', value: 'Not set up', status: 'neutral', pillText: 'Unavailable' },
        pageLoad: { label: 'Page loading time', value: '1.2 s', status: 'good', pillText: 'Good' },
        serverResponse: { label: 'Server response', value: '120 ms', status: 'good', pillText: 'Fast' },
        errorCount: 0,
        connection: { label: 'Internet connection', value: 'Not connected', status: 'problem', pillText: 'Check connection' },
    });
    assert.deepEqual(Array.from([storage.label, speed.label, problems.label]), ['Storage', 'Page speed', 'Problems / errors']);
    assert.equal(speed.status, 'good', 'connectivity is outside Page speed');
    assert.equal(problems.status, 'problem', 'connectivity is included in Problems / errors');
    assert.match(speed.details, /Page load 1\.2 s · Service response 120 ms/);

    const unavailable = buildAdminPerfGroups({
        storage,
        pageLoad: { status: 'neutral', value: '—' },
        serverResponse: { status: 'good', value: '120 ms' },
        errorCount: 0,
        connection: { value: 'Connected', status: 'good' },
    })[1];
    assert.equal(unavailable.value, 'Unavailable');
    assert.equal(unavailable.status, 'neutral');
    assert.match(unavailable.details, /Page load unavailable · Service response 120 ms/);
});

test('admin dashboard has no notification bell, menu, modal, or activity polling', () => {
    assert.doesNotMatch(dashboardHtml, /data-admin-notif|data-owner-notification-modal|data-owner-notification-detail/);
    assert.doesNotMatch(dashboardScript, /refreshOwnerActivityNotifications|data-admin-notif|data-owner-notification-modal/);
    assert.match(dashboardScript, /window\.InigoOwnerUI\.recordActivity\s*=\s*recordOwnerActivity/,
        'owner activity recording remains available to existing admin workflows');
    assert.match(dashboardScript, /owner_audit_trail/,
        'the separate audit trail remains connected');
});
