import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const chartSource = await readFile(new URL('../event/chart.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261001191136_owner_income_dashboard.sql', import.meta.url), 'utf8');
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
    assert.equal(data.month.labels.length, 31);
    assert.deepEqual(Array.from(data.month.values.slice(0, 1)), [0]);
    assert.equal(data.month.values[3], 1);
    assert.equal(data.month.total, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(data.month.status)), { booked: 1, completed: 0, no_show: 0 });
});

test('booking trends use the selected calendar year and include future eligible reservations', () => {
    const data = aggregateAt('2026-10-01T02:00:00Z', [
        { time_date: '2026-01-01T00:00:00Z', status: 'completed' },
        { time_date: '2026-10-01T00:00:00Z', status: 'confirmed', amount_paid: 40 },
        { time_date: '2026-11-01T00:00:00Z', status: 'confirmed', amount_paid: 50 },
    ]);
    assert.equal(data.year.labels.length, 12);
    assert.equal(data.year.values[0], 1);
    assert.equal(data.year.values[9], 1);
    assert.equal(data.year.values[10], 1, 'future scheduled bookings in the selected calendar year remain included');
    assert.equal(data.year.values[11], 0);
    assert.equal(data.year.total, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(data.year.status)), { booked: 2, completed: 1, no_show: 0 });
    assert.equal(data.year.unit, 'bookings per month · this year');
    assert.equal(data.year.periods[0], 'January 2026');
    assert.equal(data.year.periods[9], 'October 2026');
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
    assert.equal(report.barMeaning, 'Each bar shows bookings on one day.');
});

test('single-status booking summaries spell out the full share', () => {
    const context = { Object, Math, Number, String, Array, document: { addEventListener() {} } };
    runInNewContext(`${chartSource}\nglobalThis.__summary = buildStatusReport;`, context);
    const report = context.__summary({ status: { booked: 0, completed: 0, no_show: 3 } });
    assert.equal(report.summary, 'All 3 bookings were no-shows.');
});

test('booking status pie shows its leading share and separates nonzero slices', () => {
    const pieRoot = { innerHTML: '' };
    const context = {
        Object, Math, Number, String, Array,
        document: { addEventListener() {}, querySelector: () => pieRoot },
    };
    runInNewContext(`${chartSource}\nglobalThis.__renderStatus = renderStatusReport;`, context);
    context.__renderStatus({ status: { booked: 1, completed: 0, no_show: 2 } });
    assert.match(pieRoot.innerHTML, /admin-status-pie-share">67% No-show</);
    assert.match(pieRoot.innerHTML, /var\(--color-bg-card\) [\d.]+deg [\d.]+deg/,
        'card-colored separators distinguish adjacent pie slices');
    assert.match(pieRoot.innerHTML, /Booking status distribution: Booked 1, Completed 0, No-show 2\./);

    context.__renderStatus({ status: { booked: 0, completed: 0, no_show: 3 } });
    assert.match(pieRoot.innerHTML, /admin-status-pie-share">100% No-show</,
        'a single-color pie still states its full share on the chart');
    context.__renderStatus({ status: { booked: 2, completed: 2, no_show: 0 } });
    assert.match(pieRoot.innerHTML, /admin-status-pie-share">Tie · 50% each</,
        'tied statuses are labeled without implying a single leader');
    context.__renderStatus({ status: { booked: 500, completed: 1, no_show: 499 } });
    const tinySlice = pieRoot.innerHTML.match(/var\(--color-ink-faint\) ([\d.]+)deg ([\d.]+)deg/);
    assert.ok(tinySlice, 'the one-in-a-thousand status keeps a pie slice');
    assert.ok(Number(tinySlice[2]) > Number(tinySlice[1]), 'the tiny slice remains visible');
    assert.ok(Math.abs((Number(tinySlice[2]) - Number(tinySlice[1])) - 0.36) < 0.001,
        'the tiny category retains its proportional 0.36 degree arc without separators');
});

test('bar count labels show on weekly and yearly charts, and hide on the crowded monthly chart', () => {
    const labels = [];
    const context = {
        Object, Math, Number, String, Array,
        document: { documentElement: {}, addEventListener() {} },
        getComputedStyle: () => ({ getPropertyValue: () => '#222222' }),
    };
    runInNewContext(`${chartSource}\nglobalThis.__drawLabels = bookingValueLabelsPlugin.afterDatasetsDraw; globalThis.__range = range => { currentChartRange = range; };`, context);
    const fakeChart = {
        data: { datasets: [{ data: [0, 1] }] },
        chartArea: { top: 0, bottom: 100 },
        ctx: { save() {}, restore() {}, fillText: value => labels.push(value) },
        getDatasetMeta: () => ({ data: [{ x: 10, y: 100 }, { x: 30, y: 30 }] }),
    };
    context.__range('week');
    context.__drawLabels(fakeChart);
    assert.deepEqual(labels, ['0', '1']);
    context.__range('year');
    context.__drawLabels(fakeChart);
    assert.equal(labels.length, 4);
    context.__range('month');
    context.__drawLabels(fakeChart);
    assert.equal(labels.length, 4, 'monthly labels stay hidden to avoid crowding 31 bars');
});

test('booking report exporters pass chart totals and period rows to both file formats', () => {
    let workbookRows; let workbookFilename; const pdfCalls = [];
    class FakePdf {
        setFontSize() {} setFont() {}
        splitTextToSize(text) { return [text]; }
        text(...args) { pdfCalls.push(args); }
        addPage() {}
        save(filename) { pdfCalls.push(['save', filename]); }
    }
    const context = {
        Date, Intl, Number, String, Object, Array, Math, console,
        document: { addEventListener() {}, querySelector: () => null },
        window: {
            XLSX: {
                utils: {
                    aoa_to_sheet: rows => { workbookRows = rows; return { rows }; },
                    book_new: () => ({}), book_append_sheet() {},
                },
                writeFile: (_book, filename) => { workbookFilename = filename; },
            },
            jspdf: { jsPDF: FakePdf },
        },
    };
    runInNewContext(`${chartSource}\nglobalThis.__aggregate = aggregateBookingRows; globalThis.__ready = value => { chartDataAvailable = value; }; globalThis.__range = range => { currentChartRange = range; }; globalThis.__export = exportBookingReport;`, context);
    context.__aggregate([{ time_date: new Date().toISOString(), status: 'confirmed', amount_paid: 20 }]);
    context.__ready(true);
    context.__range('year');
    assert.equal(context.__export('xlsx'), true);
    assert.match(workbookFilename, /booking-report-year-\d{4}-\d{2}-\d{2}\.xlsx/);
    assert.ok(workbookRows.some(row => row[0] === 'Booking Report'));
    assert.ok(workbookRows.some(row => row[0] === 'Range' && row[1] === 'Yearly'));
    assert.ok(workbookRows.some(row => row[0] === 'Period' && /^Calendar year \d{4}$/.test(row[1])));
    assert.ok(workbookRows.some(row => row[0] === 'Total eligible bookings' && row[1] === 1));
    assert.ok(workbookRows.some(row => row[0] === 'Takeaway' && /Busiest/.test(row[1])));
    assert.ok(workbookRows.some(row => row[0] === 'Included reservations' && /Future paid confirmed reservations/.test(row[1])));
    assert.ok(workbookRows.some(row => row[0] === 'Generated (Manila)' && row[1]));
    assert.ok(workbookRows.some(row => row[0] === 'Period' && row[1] === 'Bookings'));
    assert.ok(workbookRows.some(row => row[0] === 'Booking status' && row[1] === 'Count'));
    assert.ok(workbookRows.some(row => row[0] === 'Booked' && row[1] === 1));
    assert.ok(workbookRows.some(row => row[0] === 'Total eligible bookings' && row[1] === 1));
    assert.ok(workbookRows.some(row => row[0] === 'Status takeaway' && /This booking is confirmed/.test(row[1])));
    assert.equal(context.__export('pdf'), true);
    assert.ok(pdfCalls.some(call => call[0] === 'Booking Report'));
    assert.ok(pdfCalls.some(call => Array.isArray(call[0]) && /Future paid confirmed reservations/.test(call[0][0])));
    assert.ok(pdfCalls.some(call => call[0] === 'Total eligible bookings: 1'));
    assert.ok(pdfCalls.some(call => Array.isArray(call[0]) && call[0][0].startsWith('Busiest month:')));
    assert.ok(pdfCalls.some(call => call[0] === 'Booking status'));
    assert.ok(pdfCalls.some(call => call[0] === 'Booked'));
    assert.ok(pdfCalls.some(call => Array.isArray(call[0]) && /This booking is confirmed/.test(call[0][0])));
    assert.ok(pdfCalls.some(call => call[0] === 'save' && call[1].endsWith('.pdf')));
});

test('New Year booking trend fetch splits at year start and keeps both requests within 366 days', async () => {
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : ['2027-01-01T03:00:00Z'])); }
        static now() { return new Date('2027-01-01T03:00:00Z').getTime(); }
    }
    const requests = [];
    const context = {
        Date: FixedDate, Intl, Number, String, Object, Array, Math, console,
        document: { addEventListener() {} },
        window: { sb: { rpc: async (name, args) => { requests.push({ name, ...args }); return { data: [], error: null }; } } },
    };
    runInNewContext(`${chartSource}\nglobalThis.__loadChartData = loadChartData; globalThis.__isChartAvailable = () => chartDataAvailable;`, context);
    await context.__loadChartData();
    assert.equal(context.__isChartAvailable(), true, 'a successful empty result is valid loaded data');
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.name === 'admin_booking_overview'));
    assert.deepEqual(requests.map(request => [request.p_from_at, request.p_to_at]), [
        ['2026-12-27T16:00:00.000Z', '2026-12-31T16:00:00.000Z'],
        ['2026-12-31T16:00:00.000Z', '2027-12-31T16:00:00.000Z'],
    ]);
    assert.ok(requests.every(request => Date.parse(request.p_to_at) - Date.parse(request.p_from_at) <= 366 * 86400000));
});

test('December calendar week fetch includes the next-year fragment and merges all week rows', async () => {
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : ['2026-12-30T02:00:00Z'])); }
        static now() { return new Date('2026-12-30T02:00:00Z').getTime(); }
    }
    const requests = [];
    const results = [
        { data: [
            { time_date: '2026-12-27T16:30:00Z', status: 'confirmed', amount_paid: 10 },
            { time_date: '2026-12-30T16:00:00Z', status: 'completed', amount_paid: 10 },
        ] },
        { data: [
            { time_date: '2026-12-31T16:00:00Z', status: 'no_show', amount_paid: 0 },
            { time_date: '2027-01-03T15:00:00Z', status: 'confirmed', amount_paid: 20 },
        ] },
    ];
    const context = {
        Date: FixedDate, Intl, Number, String, Object, Array, Math, console,
        document: { addEventListener() {} },
        window: { sb: { rpc: async (name, args) => { requests.push({ name, ...args }); return results[requests.length - 1]; } } },
    };
    runInNewContext(`${chartSource}\nglobalThis.__loadChartData = loadChartData; globalThis.__data = () => CHART_DATA;`, context);
    assert.equal(await context.__loadChartData(), true);
    assert.deepEqual(requests.map(({ p_from_at, p_to_at }) => [p_from_at, p_to_at]), [
        ['2025-12-31T16:00:00.000Z', '2026-12-31T16:00:00.000Z'],
        ['2026-12-31T16:00:00.000Z', '2027-01-03T16:00:00.000Z'],
    ]);
    assert.ok(requests.every(request => request.name === 'admin_booking_overview'));
    assert.ok(requests.every(request => Date.parse(request.p_to_at) - Date.parse(request.p_from_at) <= 366 * 86400000));
    assert.equal(context.__data().week.total, 4);
    assert.deepEqual(Array.from(context.__data().week.values), [1, 0, 0, 1, 1, 0, 1]);
    assert.deepEqual(JSON.parse(JSON.stringify(context.__data().week.status)), { booked: 2, completed: 1, no_show: 1 });
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

test('stale booking report responses cannot replace the newest request', async () => {
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : ['2026-10-01T02:00:00Z'])); }
        static now() { return new Date('2026-10-01T02:00:00Z').getTime(); }
    }
    const pending = [];
    const context = {
        Date: FixedDate, Intl, Number, String, Object, Array, Math, console,
        document: { addEventListener() {} },
        window: { sb: { rpc: () => new Promise(resolve => pending.push(resolve)) } },
    };
    runInNewContext(`${chartSource}\nglobalThis.__load = loadChartData; globalThis.__data = () => CHART_DATA;`, context);
    const oldRequest = context.__load();
    const currentRequest = context.__load();
    pending[1]({ data: [{ time_date: '2026-10-01T00:00:00Z', status: 'completed' }], error: null });
    assert.equal(await currentRequest, true);
    pending[0]({ data: [{ time_date: '2026-10-01T00:00:00Z', status: 'confirmed', amount_paid: 80 }], error: null });
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
    assert.match(dashboardHtml, /Pending and canceled bookings are excluded/);
    assert.equal((dashboardHtml.match(/class="admin-card admin-booking-report-card"/g) || []).length, 2);
    assert.ok(dashboardHtml.indexOf('admin-booking-toolbar') < dashboardHtml.indexOf('admin-booking-report-grid'));
    assert.match(dashboardCss, /\.admin-booking-report-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*540px\),\s*1fr\)\)/s);
    assert.doesNotMatch(dashboardCss, /\.admin-status-report\s*\{[^}]*max-width:/s);
    assert.match(dashboardHtml, /admin-chart-export-toggle/);
    assert.match(dashboardCss, /\.admin-chart-exports\s*\{[^}]*position:\s*relative/s);
    assert.match(dashboardHtml, /xlsx-0\.20\.3/);
    assert.match(dashboardHtml, /jspdf@4\.2\.1/);
    assert.doesNotMatch(dashboardHtml, /data-admin-stat="bookings-month"|ownerIncomeChart/);
    assert.match(dashboardHtml, /data-admin-perf-chart[^>]*3 checks/i);
    assert.doesNotMatch(dashboardScript, /run 015_media_bucket\.sql/i);
});

test('booking report uses one compact toolbar above two responsive cards', () => {
    assert.equal((dashboardHtml.match(/class="admin-card admin-booking-report-card"/g) || []).length, 2);
    assert.ok(dashboardHtml.indexOf('admin-booking-toolbar') < dashboardHtml.indexOf('admin-booking-report-grid'));
    assert.match(dashboardHtml, /admin-booking-toolbar">\s*<div class="admin-booking-toolbar-controls">/);
    assert.doesNotMatch(dashboardHtml, /admin-booking-toolbar">\s*<h[1-6]/);
    assert.match(dashboardHtml, /admin-booking-report-grid[\s\S]*<h3>Booking Trends<\/h3>[\s\S]*<h3>Booking Status<\/h3>/);
    assert.equal((dashboardHtml.match(/data-admin-chart-range=/g) || []).length, 3);
    assert.equal((dashboardHtml.match(/data-admin-chart-export-toggle/g) || []).length, 1);
    assert.match(dashboardCss, /\.admin-booking-report-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*540px\),\s*1fr\)\)/s);
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
