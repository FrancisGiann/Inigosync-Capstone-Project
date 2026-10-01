import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const chartSource = await readFile(new URL('../event/chart.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261001030000_owner_income_dashboard.sql', import.meta.url), 'utf8');
const dashboardHtml = await readFile(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8');
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
    runInNewContext(`${dashboardScript}\nglobalThis.__helpers = { buildAdminPerfGroups, setOwnerActivitySeen, routeOwnerActivityOpen };`, context);
    return context.__helpers;
}

test('booking trends use Manila calendar week and current-month day buckets', () => {
    const data = aggregateAt('2026-10-01T02:00:00Z', [
        { time_date: '2026-09-27T15:59:59Z' }, // Sunday, Sep 27 in Manila
        { time_date: '2026-09-27T16:00:00Z' }, // Monday, Sep 28 in Manila
        { time_date: '2026-10-04T15:59:59Z' }, // Future Sunday bucket in Manila
        { time_date: '2026-10-04T16:00:00Z' }, // Future Monday bucket in Manila
    ]);
    assert.equal(data.week.labels.length, 7);
    assert.deepEqual(Array.from(data.week.values), [1, 0, 0, 0, 0, 0, 0]);
    assert.equal(data.week.total, 1);
    assert.equal(data.week.unit, 'bookings per day · this calendar week');
    assert.equal(data.month.labels.length, 31);
    assert.deepEqual(Array.from(data.month.values.slice(0, 1)), [0]);
    assert.ok(Array.from(data.month.values.slice(1)).every(value => value === 0));
    assert.equal(data.month.total, 0);
});

test('booking trends use year-to-date months and zero future month buckets', () => {
    const data = aggregateAt('2026-10-01T02:00:00Z', [
        { time_date: '2026-01-01T00:00:00Z' },
        { time_date: '2026-10-01T00:00:00Z' },
        { time_date: '2026-11-01T00:00:00Z' },
    ]);
    assert.equal(data.year.labels.length, 12);
    assert.equal(data.year.values[0], 1);
    assert.equal(data.year.values[9], 1);
    assert.deepEqual(Array.from(data.year.values.slice(10)), [0, 0]);
    assert.equal(data.year.total, 2);
    assert.equal(data.year.unit, 'bookings per month · this year');
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
    runInNewContext(`${chartSource}\nglobalThis.__loadChartData = loadChartData;`, context);
    await context.__loadChartData();
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.name === 'admin_booking_overview'));
    assert.deepEqual(requests.map(request => [request.p_from_at, request.p_to_at]), [
        ['2026-12-27T16:00:00.000Z', '2026-12-31T16:00:00.000Z'],
        ['2026-12-31T16:00:00.000Z', '2027-12-31T16:00:00.000Z'],
    ]);
    assert.ok(requests.every(request => Date.parse(request.p_to_at) - Date.parse(request.p_from_at) <= 366 * 86400000));
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
    assert.match(dashboardHtml, /Total income/);
    assert.doesNotMatch(dashboardHtml, /data-admin-stat="bookings-month"|ownerIncomeChart/);
    assert.match(dashboardHtml, /data-admin-perf-chart[^>]*3 checks/i);
    assert.doesNotMatch(dashboardScript, /run 015_media_bucket\.sql/i);
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

test('notification checkbox marks seen, recovers on failure, and never opens the modal', async () => {
    const { setOwnerActivitySeen, routeOwnerActivityOpen } = loadDashboardHelpers();
    const fixture = () => {
        const row = { dataset: { ownerActivityId: 'activity-7' }, classes: new Set(), classList: { add(name) { row.classes.add(name); } } };
        const checkbox = { checked: false, disabled: false, closest: () => row };
        return { row, checkbox };
    };

    const success = fixture();
    let persistedId; let refreshes = 0; let notices = 0;
    assert.equal(await setOwnerActivitySeen(success.checkbox, async id => { persistedId = id; return null; }, () => { refreshes++; }, () => { notices++; }), true);
    assert.equal(persistedId, 'activity-7');
    assert.equal(success.checkbox.checked, true);
    assert.equal(success.checkbox.disabled, true);
    assert.ok(success.row.classes.has('is-seen'));
    assert.equal(refreshes, 1);
    assert.equal(notices, 0);

    const failure = fixture();
    assert.equal(await setOwnerActivitySeen(failure.checkbox, async () => new Error('write failed'), () => {}, () => { notices++; }), false);
    assert.equal(failure.checkbox.checked, false);
    assert.equal(failure.checkbox.disabled, false);
    assert.equal(failure.row.classes.has('is-seen'), false);
    assert.equal(notices, 1);

    let opened = 0;
    assert.equal(routeOwnerActivityOpen({ closest: selector => selector === '[data-owner-activity-open]' ? null : failure.row }, () => { opened++; }), false);
    assert.equal(opened, 0, 'checkbox click must not open notification details');
    const row = { dataset: { ownerActivityId: 'activity-8' } };
    const openButton = { closest: selector => selector === '[data-owner-activity-id]' ? row : null };
    assert.equal(routeOwnerActivityOpen({ closest: selector => selector === '[data-owner-activity-open]' ? openButton : null }, id => { opened++; assert.equal(id, 'activity-8'); }), true);
    assert.equal(opened, 1, 'the separate open button still opens details');
});
