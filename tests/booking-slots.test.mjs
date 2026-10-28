import test from 'node:test';
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { runInNewContext } from 'node:vm';
    import { spawnSync } from 'node:child_process';
    const source = readFileSync(new URL('../includes/bookingSlots.js', import.meta.url), 'utf8');
    const sandbox = { window: {} };
    runInNewContext(source, sandbox);
    const slots = sandbox.window.InigoBookingSlots;
    test('splits selected hours into separate contiguous cart ranges', () => {    assert.deepEqual(JSON.parse(JSON.stringify(slots.groupConsecutiveHours([9, 8, 12, 11, 9, -1, 24, 15.5]))), [        { startHour: 8, endHourExclusive: 10, hours: [8, 9] },        { startHour: 11, endHourExclusive: 13, hours: [11, 12] },    ]);
    });

test('maps facility-local hours and midnight boundaries correctly on a non-Manila device timezone', () => {    /* The browser helper is a plain script;
    run it in a separate Node realm under Los Angeles time and assert its UTC result is still Manila time. */    const result = spawnSync(process.execPath, ['-e', `      const fs = require('node:fs');
    const vm = require('node:vm');
    const w={};
    vm.runInNewContext(fs.readFileSync('includes/bookingSlots.js','utf8'),{window:w});
    process.stdout.write(JSON.stringify([w.InigoBookingSlots.localDateHourToIso('2026-03-10',8),w.InigoBookingSlots.localDateHourToIso(w.InigoBookingSlots.nextDate('2026-03-10'),0)]));
    `], { encoding: 'utf8', env: { ...process.env, TZ: 'America/Los_Angeles' } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['2026-03-10T00:00:00.000Z', '2026-03-10T16:00:00.000Z']);
    assert.equal(slots.localDateHourToIso('2026-03-10', 24), '2026-03-10T16:00:00.000Z');
    });

test('booking picker is wired to authoritative availability and keeps checkout server-owned', () => {    const html = readFileSync(new URL('../Pages/user_dashboard.html', import.meta.url), 'utf8');
    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(html, /data-dash-book-sports/);
    assert.match(html, /data-dash-book-courts/);
    assert.match(html, /data-dash-book-slots/);
    assert.match(dashboard, /data-dash-book-select-all aria-label="Select the earliest continuous available block on each selected date"/, 'one select-all control chooses one continuous block per date');
    assert.match(html, /data-dash-calendar-popup/);
    assert.doesNotMatch(html, /type="date"[^>]*data-dash-book-date/);
    assert.match(dashboard, /bookingSelectedDates\.has\(date\)[\s\S]*?bookingSelectedDates\.delete\(date\)/, 'calendar clicks toggle dates in place');
    assert.match(html, /data-dash-book-step="1"[\s\S]*?data-dash-book-step="2"[\s\S]*?data-dash-book-step="3"[\s\S]*?data-dash-book-step="4"[\s\S]*?data-dash-book-step="5"/);
    assert.match(html, /aria-label="Booking progress"[\s\S]*?data-dash-book-progress-step="5"/);
    assert.equal((html.match(/Step \d of 5/g) || []).length, 5);
    assert.match(html, /Add more/);
    assert.doesNotMatch(html, /Add selected times to cart|Review your cart|Booking cart/);
    assert.doesNotMatch(html, /data-dash-book-cart-bar|data-dash-book-cart-proceed/);
    assert.match(html, /data-dash-book-submit/);
    assert.match(html, /<script src="\.\.\/includes\/bookingSlots\.js"><\/script>[\s\S]*?<script src="\.\.\/includes\/Dashboard\.js"><\/script>/);
    assert.match(dashboard, /bookingAvailabilityByDate\.get\(date\)/);
    assert.match(dashboard, /getForDate\(date, \{ force: forceRules \}\)/);
    assert.match(dashboard, /groupConsecutiveHours\(hours\)/);
    assert.doesNotMatch(dashboard, /bookingCart\.length[^\n]*(?:>=|>)\s*8|bookingSelectedDates\.size\s*>=\s*8|up to eight/i, 'schedule and cart selection have no eight-item cap');
    assert.doesNotMatch(html, /Up to eight booking items/i);
    assert.match(dashboard, /event\.key === 'Escape'/);
    assert.match(dashboard, /renderCourtChoices\(courts\)/);
    assert.match(dashboard, /goToBookStep\(4\)/);
    assert.match(dashboard, /functions\.invoke\('paymongo-checkout'/);
    assert.doesNotMatch(dashboard, /\.from\(['"]booking['"]\)\s*\.insert/);
    });

test('schedule slot rendering distinguishes selected, available, booked, and elapsed states accessibly', () => {    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = dashboard.indexOf('function renderTimePickers() {');
    const end = dashboard.indexOf('\n    async function refreshTimePickers', start);
    assert.ok(start >= 0 && end > start, 'schedule rendering function is present');
    const date = '2099-10-26'; const rules = { authoritative: true, isClosed: false, openHour: 8, closeHour: 12 }; const rows = { ok: true, rows: [{ time_date: '2099-10-26T12:00:00.000Z', end_at: '2099-10-26T13:00:00.000Z', court_unit: 'Court 1' }] }; const globalCheckbox = { indeterminate: false }; const context = { Date: class TestDate extends Date { static now() { return new Date('2099-10-26T10:30:00.000Z').getTime(); } }, bookingSelectedDates: new Set([date]), bookingSelectionsByDate: new Map([[date, [8]]]), hoursRangeForRules(rules) { return Array.from({ length: rules.closeHour - rules.openHour }, (_, index) => rules.openHour + index); }, bookingTimeWindow(row) { return { start: new Date(row.time_date), end: new Date(new Date(row.time_date).getTime() + 3600000) }; }, bookingWindowsOverlap(a, b) { return a.start < b.end && b.start < a.end; }, courtUnitsOverlap() { return true; }, bookingAvailabilityByDate: new Map([[date, { rules, bookings: rows, walkins: rows }]]), bookSlotsGrid: { innerHTML: '', querySelectorAll(selector) { return selector.includes('data-indeterminate') ? [globalCheckbox] : []; } },        bookSelectAllSlots: null,        bookSlotStatus: { textContent: '' },        bookAddButton: { disabled: true },        bookingState: { court: 'Basketball', unitId: 'unit-1', date, selectedHours: [8], startHour: 8, endHour: 9, unit: 'Court 1' },        bookingRules: rules,        slotGridBookings: rows,        slotGridWalkins: rows,        isSlotHourInBookingCart: () => false,        window: {            escapeHtml: (value) => String(value),            InigoBookingSlots: { localDateHourToIso(date, hour) { const mappedHour = hour === 8 ? 11 : hour === 9 ? 12 : hour === 10 ? 9 : hour === 11 ? 13 : hour; return new Date(`${date}T${String(mappedHour).padStart(2, '0')}:00:00Z`).toISOString(); } }, InigoBusinessHours: { formatHourRangeLabelShort: (hour) => `${hour}:00–${hour + 1}:00` },        },        bookingCartSaving: false,        slotGridLoading: false,        plainSummaryBackMode: false,        bookingCart: [],    };
    runInNewContext(`${dashboard.slice(start, end)}\nglobalThis.render = renderTimePickers;
    `, context);
    context.render();
    assert.ok(context.bookSlotsGrid.innerHTML.includes('data-dash-book-slot="2099-10-26:8"') && context.bookSlotsGrid.innerHTML.includes('aria-pressed="true"'), 'selected hours render within the matching date section');
    assert.ok(context.bookSlotsGrid.innerHTML.includes('class="dash-book-slot is-booked"'), 'booked hours stay unavailable in their date group');
    assert.ok(context.bookSlotsGrid.innerHTML.includes('class="dash-book-slot is-past"'), 'elapsed hours stay unavailable in their date group');
    assert.match(context.bookSlotsGrid.innerHTML, /<button[^>]*class="dash-book-slot is-booked"[\s\S]*?<span class="dash-book-slot-state" aria-hidden="true">Unavailable<\/span>/);
    assert.match(context.bookSlotsGrid.innerHTML, /<button[^>]*class="dash-book-slot is-past"[\s\S]*?<span class="dash-book-slot-state" aria-hidden="true">Unavailable<\/span>/);
    assert.equal(context.bookAddButton.disabled, false, 'available selected hours still enable the existing booking action');
    assert.match(context.bookSlotsGrid.innerHTML, /data-dash-book-select-all aria-label="Select the earliest continuous available block on each selected date"/);
    assert.match(context.bookSlotsGrid.innerHTML, /Select continuous available times/);
    assert.equal(globalCheckbox.indeterminate, true, 'manual partial selection sets the native indeterminate state');
    context.bookingSelectionsByDate.set(date, [8, 9]); context.bookingState.selectedHours = [8, 9]; context.render();
    assert.match(context.bookSlotsGrid.innerHTML, /data-dash-book-select-all[^>]* checked/, 'selecting the earliest continuous block checks the global control even when a later block is available');
    context.bookingAvailabilityByDate.clear(); context.slotGridLoading = true; context.render();
    assert.match(context.bookSlotsGrid.innerHTML, /data-dash-book-select-all[^>]*disabled/, 'the global control is disabled while availability is unresolved');
    });

test('availability refresh trims a selected run at its first blocker', () => {
    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = dashboard.indexOf('function renderTimePickers() {');
    const end = dashboard.indexOf('\n    async function refreshTimePickers', start);
    const date = '2099-10-26';
    const rules = { authoritative: true, isClosed: false, openHour: 8, closeHour: 12 };
    const rows = { ok: true, rows: [{ time_date: `${date}T09:00:00.000Z`, end_at: `${date}T10:00:00.000Z`, court_unit: 'Court 1' }] };
    const context = {
        Date: class TestDate extends Date { static now() { return new Date('2099-10-26T06:00:00.000Z').getTime(); } },
        bookingSelectedDates: new Set([date]), bookingSelectionsByDate: new Map([[date, [8, 9, 10, 11]]]),
        hoursRangeForRules: () => [8, 9, 10, 11],
        bookingTimeWindow: (row) => ({ start: new Date(row.time_date), end: new Date(row.end_at) }),
        bookingWindowsOverlap: (a, b) => a.start < b.end && b.start < a.end,
        courtUnitsOverlap: () => true,
        bookingAvailabilityByDate: new Map([[date, { rules, bookings: rows, walkins: { ok: true, rows: [] } }]]),
        isSlotHourInBookingCart: () => false,
        bookingState: { court: 'Basketball', unitId: 'unit-1', unit: 'Court 1', date, selectedHours: [8, 9, 10, 11] },
        bookSlotsGrid: { innerHTML: '', querySelectorAll: () => [] }, bookSlotStatus: { textContent: '' }, bookAddButton: { disabled: true },
        slotGridLoading: false, bookingCartSaving: false, bookingCart: [], plainSummaryBackMode: false,
        window: { escapeHtml: String, InigoBookingSlots: { localDateHourToIso: (day, hour) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`).toISOString() }, InigoBusinessHours: { formatHourRangeLabelShort: (hour) => `${hour}:00–${hour + 1}:00` } },
    };
    runInNewContext(`${dashboard.slice(start, end)}\nglobalThis.render = renderTimePickers;`, context);
    context.render();
    assert.deepEqual(Array.from(context.bookingSelectionsByDate.get(date)), [8], 'hours after an unavailable interior hour are removed from the pending run');
});

test('global select all selects eligible slots across dates and clears all pending selections', () => {
    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = dashboard.indexOf('function setBookingDaySelection(date, hours) {');
    const end = dashboard.indexOf('function selectedBookingCartItem', start);
    assert.ok(start >= 0 && end > start, 'global select-all handler is present');
    const calls = [];
    const dateA = '2099-10-26';
    const dateB = '2099-10-27';
    const listeners = {};
    const checkbox = { checked: true, disabled: false };
    const slotControls = [
        { dataset: { dashBookSlot: `${dateA}:8` }, disabled: false },
        { dataset: { dashBookSlot: `${dateA}:9` }, disabled: false },
        { dataset: { dashBookSlot: `${dateA}:10` }, disabled: true }, // booked
        { dataset: { dashBookSlot: `${dateA}:11` }, disabled: false }, // later available block
        { dataset: { dashBookSlot: `${dateB}:10` }, disabled: false },
        { dataset: { dashBookSlot: `${dateB}:11` }, disabled: true }, // elapsed
    ];
    const context = {
        bookingSelectedDates: new Set([dateA, dateB]),
        bookingSelectionsByDate: new Map([[dateA, [8]], [dateB, [11]]]),
        bookingState: { date: dateA, selectedHours: [8], startHour: 8, endHour: 8 },
        bookSlotsGrid: { addEventListener(type, callback) { listeners[type] = callback; }, querySelectorAll() { return slotControls; } },
        slotGridLoading: false,
        window: { InigoBookingSlots: { groupConsecutiveHours(hours) { return slots.groupConsecutiveHours(hours); } } },
        renderTimePickers() { calls.push('render'); }, updateSummary() { calls.push('summary'); },
    };
    runInNewContext(dashboard.slice(start, end), context);
    const change = (checked) => listeners.change({ target: { closest(selector) { return selector === '[data-dash-book-select-all]' ? { ...checkbox, checked } : null; } } });
    change(true);
    assert.deepEqual(Array.from(context.bookingSelectionsByDate.get(dateA)), [8, 9], 'select all stops at the blocked hour and skips a later available run');
    assert.deepEqual(Array.from(context.bookingSelectionsByDate.get(dateB)), [10]);
    change(false);
    assert.deepEqual(Array.from(context.bookingSelectionsByDate.get(dateA)), []);
    assert.deepEqual(Array.from(context.bookingSelectionsByDate.get(dateB)), []);
    assert.deepEqual(calls, ['render', 'summary', 'render', 'summary']);
});

test('manual schedule selection fills contiguous hours, stops at blockers, and trims without gaps', () => {
    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = dashboard.indexOf('function setBookingDaySelection(date, hours) {');
    const end = dashboard.indexOf('function selectedBookingCartItem', start);
    assert.ok(start >= 0 && end > start, 'manual schedule handler is present');
    const setup = (date, selected, blocked = []) => {
        const listeners = {};
        const controls = Array.from({ length: 6 }, (_, index) => 8 + index).map((hour) => ({
            dataset: { dashBookSlot: `${date}:${hour}` }, disabled: blocked.includes(hour),
        }));
        const context = {
            bookingSelectionsByDate: new Map([[date, [...selected]]]), bookingSelectedDates: new Set([date]),
            bookingState: { date, selectedHours: [...selected], startHour: selected[0] ?? null, endHour: selected.at(-1) ?? null },
            bookSlotsGrid: { addEventListener(type, callback) { listeners[type] = callback; }, querySelectorAll() { return controls; } },
            bookSlotStatus: { textContent: '' }, slotGridLoading: false,
            window: { InigoBookingSlots: { groupConsecutiveHours(hours) { return slots.groupConsecutiveHours(hours); } } },
            renderTimePickers() {}, updateSummary() {},
        };
        runInNewContext(dashboard.slice(start, end), context);
        const click = (hour) => listeners.click({ target: { closest(selector) {
            return selector === '[data-dash-book-slot]' ? controls.find((control) => control.dataset.dashBookSlot === `${date}:${hour}`) : null;
        } } });
        return { context, click };
    };
    const date = '2099-10-26';
    const fill = setup(date, [8]); fill.click(11);
    assert.deepEqual(Array.from(fill.context.bookingSelectionsByDate.get(date)), [8, 9, 10, 11], 'clicking a later hour fills every available hour in between');
    const blocked = setup(date, [8], [10]); blocked.click(11);
    assert.deepEqual(Array.from(blocked.context.bookingSelectionsByDate.get(date)), [8, 9], 'extension stops before the first unavailable hour');
    assert.match(blocked.context.bookSlotStatus.textContent, /first unavailable hour/);
    const trim = setup(date, [8, 9, 10]); trim.click(9);
    assert.deepEqual(Array.from(trim.context.bookingSelectionsByDate.get(date)), [8], 'clicking a selected interior hour keeps only the earlier contiguous portion');
    const otherDate = '2099-10-27';
    const dates = setup(date, [8]);
    dates.context.bookingSelectionsByDate.set(otherDate, [10]);
    assert.deepEqual(Array.from(dates.context.bookingSelectionsByDate.get(date)), [8]);
    assert.deepEqual(Array.from(dates.context.bookingSelectionsByDate.get(otherDate)), [10], 'date selections remain independent');
});

test('Add more clears empty visited days before starting a fresh date draft', () => {
    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = dashboard.indexOf('function resetBookingDatesForFreshDraft() {');
    const end = dashboard.indexOf('// Overview availability', start);
    assert.ok(start >= 0 && end > start, 'fresh draft date reset helper is present');
    const dates = Array.from({ length: 8 }, (_, index) => '2099-10-' + String(20 + index).padStart(2, '0'));
    const context = {
        bookDate: { value: dates[7] },
        bookingState: { date: dates[7], selectedHours: [8], startHour: 8, endHour: 8 },
        bookingSelectedDates: new Set(dates),
        bookingSelectionsByDate: new Map(dates.map((date) => [date, []])),
        bookingAvailabilityByDate: new Map(dates.map((date) => [date, { rules: { authoritative: true } }])),
    };
    const code = dashboard.slice(start, end) + '\nglobalThis.reset = resetBookingDatesForFreshDraft;';
    runInNewContext(code, context);
    context.reset();
    assert.deepEqual(Array.from(context.bookingSelectedDates), [dates[7]]);
    assert.deepEqual(Array.from(context.bookingSelectionsByDate.keys()), [dates[7]]);
    assert.equal(context.bookingSelectionsByDate.get(dates[7]).length, 0);
    assert.equal(context.bookingAvailabilityByDate.size, 0);
    assert.match(dashboard, /resetBookingDatesForFreshDraft\(\)/, 'Add more starts a fresh date draft');
});

test('midnight availability refresh removes expired selected dates and keeps active date selected', () => {
    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = dashboard.indexOf('function refreshVisibleBookingAvailability() {');
    const end = dashboard.indexOf("document.addEventListener('inigosync:booking-rules-updated'", start);
    assert.ok(start >= 0 && end > start, 'midnight availability reconciliation is present');
    const expired = '2099-10-25'; const today = '2099-10-26'; const future = '2099-10-27'; const calls = [];
    const context = {
        document: { visibilityState: 'visible', querySelector() { return { classList: { contains: () => true } }; } },
        window: { InigoBookingSlots: { groupConsecutiveHours(hours) { return slots.groupConsecutiveHours(hours); } } },
        bookingState: { court: 'Basketball', unitId: 'unit-1', date: expired, selectedHours: [8], startHour: 8, endHour: 8 },
        bookingSelectedDates: new Set([expired, today, future]),
        bookingSelectionsByDate: new Map([[expired, [8]], [today, [9]], [future, [10]]]),
        bookingAvailabilityByDate: new Map([[expired, {}], [today, {}], [future, {}]]),
        bookDate: { value: expired, min: '' }, todayDateInputValue: () => today,
        renderBookingCalendar() { calls.push('calendar'); }, refreshTimePickers(force) { calls.push(['refresh', force]); },
    };
    runInNewContext(dashboard.slice(start, end), context);
    context.refreshVisibleBookingAvailability();
    assert.deepEqual(Array.from(context.bookingSelectedDates), [today, future]);
    assert.deepEqual(Array.from(context.bookingSelectionsByDate.keys()), [today, future]);
    assert.deepEqual(Array.from(context.bookingAvailabilityByDate.keys()), [today, future]);
    assert.equal(context.bookingState.date, today);
    assert.equal(context.bookDate.value, today);
    assert.deepEqual(Array.from(context.bookingState.selectedHours), [9]);
    assert.deepEqual(calls, ['calendar', ['refresh', true]]);
});

test('calendar date clicks stay inside the popup when rendering detaches the clicked day', () => {
    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = dashboard.indexOf("bookingCalendarPopup?.addEventListener('click', (event) => {");
    const end = dashboard.indexOf("document.addEventListener('keydown'", start);
    assert.ok(start >= 0 && end > start, 'calendar popup event handlers are present');
    const target = { connected: true, disabled: false, dataset: { dashCalendarDate: '2099-10-29' }, closest() { return this; }, matches(selector) { return selector === '[data-dash-calendar-date]'; } };
    let calendarClick; let documentClick; let stopped = false;
    const popup = { hidden: false, addEventListener(type, callback) { if (type === 'click') calendarClick = callback; } };
    const context = {
        bookingCalendarPopup: popup, bookingCalendarTrigger: { setAttribute() {}, addEventListener() {} },
        bookingSelectedDates: new Set(['2099-10-28']), bookingSelectionsByDate: new Map([['2099-10-28', []]]), bookingAvailabilityByDate: new Map(),
        bookingState: { date: '2099-10-28', selectedHours: [], startHour: null, endHour: null }, editingBookingCartKey: null,
        bookDate: { value: '2099-10-28' }, window: { InigoBookingSlots: { groupConsecutiveHours: () => [] }, addEventListener() {} },
        renderBookingCalendar() { target.connected = false; }, positionBookingCalendar() {}, refreshTimePickers() {}, updateSummary() {},
        document: { addEventListener(type, callback) { if (type === 'click') documentClick = callback; } },
    };
    runInNewContext(dashboard.slice(start, end), context);
    calendarClick({ target, stopPropagation() { stopped = true; } });
    if (!stopped) documentClick({ target });
    assert.equal(stopped, true);
    assert.equal(target.connected, false, 'the selected calendar button was replaced during rendering');
    assert.equal(popup.hidden, false, 'the bubbling outside-click handler does not close the popup');
    assert.deepEqual(Array.from(context.bookingSelectedDates), ['2099-10-28', '2099-10-29']);
});

test('schedule keeps day groups separate and flattens their contiguous runs with dates', () => {
    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = dashboard.indexOf('function bookingRunsByDate(selectedByDate) {');
    const end = dashboard.indexOf('if (bookSlotsGrid) {', start);
    assert.ok(start >= 0 && end > start, 'date-aware cart run grouping is present');
    const context = { window: { InigoBookingSlots: { groupConsecutiveHours(hours) { return slots.groupConsecutiveHours(hours); } } } };
    runInNewContext(dashboard.slice(start, end), context);
    const runs = context.bookingRunsByDate(new Map([
        ['2099-10-26', [8, 9, 11]],
        ['2099-10-27', [10, 11]],
    ]));
    assert.deepEqual(JSON.parse(JSON.stringify(runs)), [
        { date: '2099-10-26', run: { startHour: 8, endHourExclusive: 10, hours: [8, 9] } },
        { date: '2099-10-26', run: { startHour: 11, endHourExclusive: 12, hours: [11] } },
        { date: '2099-10-27', run: { startHour: 10, endHourExclusive: 12, hours: [10, 11] } },
    ]);
    assert.ok(dashboard.includes('const rulesByDate = new Map()'), 'checkout builds date-specific opening rules for all cart items');
    assert.ok(dashboard.includes('bookingRangeFitsRules(item, rulesByDate.get(item.date))'), 'checkout validates every item against its own day');
    assert.ok(dashboard.includes('bookingAvailabilityByDate.get(date)'), 'Schedule keeps availability cached by date');
});

test('cart hours are unavailable for the same unit and date, while the item being edited stays selectable', () => {    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = dashboard.indexOf('function isSlotHourInBookingCart(hour, date = bookingState.date) {');
    const end = dashboard.indexOf('\n    async function refreshTimePickers', start);
    assert.ok(start >= 0 && end > start, 'cart-aware schedule rendering is present');
    const date = '2099-10-26'; const rules = { authoritative: true, isClosed: false, openHour: 8, closeHour: 12 }; const rows = { ok: true, rows: [{ time_date: '2099-10-26T09:00:00.000Z', end_at: '2099-10-26T10:00:00.000Z', court_unit: 'Court 1' }] }; const context = { bookingSelectedDates: new Set([date]), bookingSelectionsByDate: new Map([[date, []]]), bookingAvailabilityByDate: new Map([[date, { rules, bookings: rows, walkins: rows }]]), hoursRangeForRules(rules) { return Array.from({ length: rules.closeHour - rules.openHour }, (_, index) => rules.openHour + index); }, bookingTimeWindow(row) { return { start: new Date(row.time_date), end: new Date(new Date(row.time_date).getTime() + 3600000) }; }, bookingWindowsOverlap(a, b) { return a.start < b.end && b.start < a.end; }, courtUnitsOverlap() { return true; }, bookSlotsGrid: { innerHTML: '' },        bookSelectAllSlots: { checked: false, indeterminate: false, disabled: false },        bookSlotStatus: { textContent: '' },        bookAddButton: { disabled: true },        bookingState: { court: 'Basketball', unit: 'Court 1', unitId: 'unit-1', date, selectedHours: [], startHour: null, endHour: null },        bookingRules: { authoritative: true, isClosed: false },        slotGridBookings: { ok: true, rows: [] },        slotGridWalkins: { ok: true, rows: [] },        bookingHoursRange: () => [8, 9, 10, 11],        slotHourStatus: (hour) => ({ 8: 'available', 9: 'booked', 10: 'past', 11: 'available' })[hour],        findBookCourt: () => ({ id: 'listing-1' }),        sameCourtName: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),        window: {            escapeHtml: (value) => String(value),            InigoBookingSlots: { localDateHourToIso(date, hour) { return new Date(`${date}T${String(hour).padStart(2, '0')}:00:00Z`).toISOString(); } }, InigoBusinessHours: { formatHourRangeLabelShort: (hour) => `${hour}:00–${hour + 1}:00` },        },        bookingCartSaving: false,        slotGridLoading: false,        plainSummaryBackMode: false,        editingBookingCartKey: null,        bookingCart: [            { key: 'cart-1', listingId: 'listing-1', unitId: 'unit-1', date: '2099-10-26', startHour: 11, endHour: 11 },            { key: 'other-date', listingId: 'listing-1', unitId: 'unit-1', date: '2099-10-27', startHour: 8, endHour: 8 },            { key: 'other-unit', listingId: 'listing-1', unitId: 'unit-2', date: '2099-10-26', startHour: 8, endHour: 8 },        ],    };
    runInNewContext(`${dashboard.slice(start, end)}\nglobalThis.render = renderTimePickers;
    `, context);
    context.render();
    assert.ok(context.bookSlotsGrid.innerHTML.includes('class="dash-book-slot is-in-cart"'), 'cart hours stay unavailable in their date group');
    assert.ok(context.bookSlotsGrid.innerHTML.includes('class="dash-book-slot is-booked"'));
    assert.match(context.bookSlotsGrid.innerHTML, /dash-book-slot is-available[^>]*aria-label="8:00–9:00, Available"/);
    context.editingBookingCartKey = 'cart-1';
    context.bookingState.selectedHours = [11];
    context.render();
    assert.match(context.bookSlotsGrid.innerHTML, /dash-book-slot is-available is-selected[^>]*aria-label="11:00–12:00, Selected" aria-pressed="true"/);
    assert.equal(context.bookingState.selectedHours.includes(11), true, 'editing item retains its own selected hour');
    });

test('step 2 renders only selected-sport listings, and a chosen unit resolves its rate and preview', () => {    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const between = (startText, endText) => {        const start = dashboard.indexOf(startText);
    const end = dashboard.indexOf(endText, start);
    assert.ok(start >= 0 && end > start, `expected dashboard block: ${startText}`);
    return dashboard.slice(start, end).trim();
    };
    const snippets = [        between('function sportKey(court) {', '\n    function renderSportChoices'),        between('function paintBookPreview(court, unitIndexOverride) {', '\n    // Looks up bookingState.court'),        between('function syncBookPreviewFromState() {', '\n    if (bookUnitSelect)'),        between('if (bookUnitSelect) {\n        bookUnitSelect.addEventListener(\'change\'', '\n    let bookingModalTrigger'),        between('function renderCourtChoices(courts) {', '\n    if (bookSportGrid) bookSportGrid.addEventListener'),        between('bookCourtGrid?.addEventListener(\'change\'', '\n    // Replaces the "Loading courts…" placeholder'),        between('if (bookSelect) {\n        bookSelect.addEventListener(\'change\'', '\n    if (bookDate)'),    ];
    const courts = [        { id: 'court-badminton', name: 'Badminton Court 1', sportName: 'Badminton', sportSlug: 'badminton', rate: 300, rateUnit: '/hr', imageUrl: null },        { id: 'court-tennis', name: 'Tennis Court 1', sportName: 'Tennis', sportSlug: 'lawn-tennis', rate: 500, rateUnit: '/hr', imageUrl: 'https://example.test/tennis.jpg' },    ];
    const unitsByCourt = {        'Badminton Court 1': [{ id: 'unit-b1', label: 'Court 1', rate: 350, rateDay: 300, rateNight: 400, rateUnit: '/hr' }],        'Tennis Court 1': [{ id: 'unit-t1', label: 'Court 1', rate: 500, rateDay: 500, rateNight: 500, rateUnit: '/hr' }],    };
    const listeners = new Map();
    const bookingState = { court: '', sport: '', rate: null, rateUnit: '/hr', rateDay: null, rateNight: null, unit: null, unitId: null, sportSlug: 'badminton' };
    const context = {        window: {            escapeHtml: (value) => String(value),            InigoCourtsData: {                resolveCourtUnits: (court) => ({ units: unitsByCourt[court.name] || [] }),                monogramFor: () => 'BD',                rateHint: (court) => `₱${court.rate}/hr`,            },        },        document: { activeElement: null },        bookingState,        bookCourtsCache: courts,        bookSelectedUnitIndex: 0,        bookCourtGrid: { innerHTML: '', addEventListener: (type, callback) => listeners.set(`grid:${type}`, callback), querySelectorAll: () => [] },        bookSelect: {            value: '', selectedOptions: [],            addEventListener(type, callback) { listeners.set(`select:${type}`, callback);
    },            dispatchEvent() {                const selectedCourt = courts.find((court) => court.name === this.value);
    this.selectedOptions = [{ dataset: { sport: selectedCourt.sportName, rate: String(selectedCourt.rate), rateUnit: selectedCourt.rateUnit } }];
    listeners.get('select:change')({});
    },        },        bookUnitPreview: { hidden: true },        bookUnitPreviewMedia: { innerHTML: '', querySelector: () => null },        bookUnitPreviewCaption: { textContent: '' },        bookUnitWrap: { hidden: true },        bookUnitLabel: { textContent: '' },        bookUnitSelect: {            innerHTML: '', value: '', disabled: false,            addEventListener(type, callback) { listeners.set(`unit:${type}`, callback);
    },            dispatchEvent() { listeners.get('unit:change')({});
    },        },        courtPhotoMarkup: (unit, _monogram, alt) => `<img alt="${alt}" data-image="${unit.imageUrl || ''}">`,        findBookCourt(name) { return courts.find((court) => court.name === name) || null;
    },        bookSportChoiceKey: (court) => court.name.toLowerCase(),        bookSelectedUnitIndex: 0,        resetTimeSelectionAndRender() {},        updateSummary() {},        Event: class Event { constructor(type) { this.type = type;
    } },    };
    runInNewContext(snippets.join('\n'), context);
    context.renderCourtChoices(courts.filter((court) => context.bookSportChoiceKey(court) === bookingState.sportSlug));
    assert.match(context.bookCourtGrid.innerHTML, /Badminton Court 1/);
    assert.doesNotMatch(context.bookCourtGrid.innerHTML, /Tennis Court 1/);
    assert.match(context.bookCourtGrid.innerHTML, /type="radio" name="dash-book-court-unit"/);
    assert.match(context.bookCourtGrid.innerHTML, /<img alt="Badminton Court 1 — Court 1" data-image=""/);
    assert.match(context.bookCourtGrid.innerHTML, /₱300\/hr/);
    const selectedCard = { dataset: { dashBookCourtCard: 'Badminton Court 1', dashBookUnitId: 'unit-b1' } };
    const selectedRadio = { checked: true, disabled: false, value: 'unit-b1', closest: () => selectedCard };
    listeners.get('grid:change')({ target: { closest: () => selectedRadio } });
    assert.equal(bookingState.court, 'Badminton Court 1');
    assert.equal(bookingState.sport, 'Badminton');
    assert.equal(bookingState.unit, 'Court 1');
    assert.equal(bookingState.unitId, 'unit-b1');
    assert.equal(bookingState.rate, 350);
    assert.equal(bookingState.rateDay, 300);
    assert.equal(bookingState.rateNight, 400);
    assert.match(context.bookUnitPreviewMedia.innerHTML, /data-image=""/);
    assert.match(context.bookUnitPreviewCaption.textContent, /Badminton Court 1 · Court 1 · ₱300\/hr day · ₱400\/hr night/);
    });

test('selected court resolves unit and rates even without preview media, then availability uses that unit', () => {    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
    const paintStart = dashboard.indexOf('function paintBookPreview(court, unitIndexOverride) {');
    const paintEnd = dashboard.indexOf('\n    // Looks up bookingState.court', paintStart);
    assert.ok(paintStart >= 0 && paintEnd > paintStart, 'court preview/state resolver is present');
    const paintSource = dashboard.slice(paintStart, paintEnd).trim();
    const occupancyStart = dashboard.indexOf('function isSlotHourBooked(hour) {');
    const occupancyEnd = dashboard.indexOf('\n    function slotHourStatus', occupancyStart);
    assert.ok(occupancyStart >= 0 && occupancyEnd > occupancyStart, 'schedule availability lookup is present');
    const occupancySource = dashboard.slice(occupancyStart, occupancyEnd).trim();
    const units = [        { id: 'unit-1', label: 'Court 1', rate: 300, rateDay: 250, rateNight: 350, rateUnit: '/hr' },        { id: 'unit-2', label: 'Court 2', rate: 500, rateDay: 450, rateNight: 600, rateUnit: '/hr' },    ];
    const context = {        bookingState: { rateUnit: '/hr' },        bookSelectedUnitIndex: 0,        bookUnitPreview: { hidden: false },        bookUnitPreviewMedia: null,        bookUnitPreviewCaption: null,        bookUnitWrap: { hidden: false },        bookUnitSelect: { innerHTML: '' },        bookUnitLabel: { textContent: '' },        window: {            InigoCourtsData: { resolveCourtUnits: () => ({ pickerLabel: 'Court', units }), monogramFor: () => 'B' },            escapeHtml: String,        },        courtPhotoMarkup: () => '',        slotGridBookings: { ok: true, rows: [            { court_unit: 'Court 1', time_date: '2099-01-01T08:00:00Z', end_at: '2099-01-01T09:00:00Z' },            { court_unit: 'Court 2', time_date: '2099-01-01T08:00:00Z', end_at: '2099-01-01T09:00:00Z' },        ] },        slotGridWalkins: { ok: true, rows: [] },        bookingSlotWindow: () => ({ start: new Date('2099-01-01T08:00:00Z'), end: new Date('2099-01-01T09:00:00Z') }),        bookingWindowsOverlap: () => true,        bookingTimeWindow: (row) => ({ start: new Date(row.time_date), end: new Date(row.end_at) }),        courtUnitsOverlap: (a, b) => !a || !b || a === b,        Date,    };
    runInNewContext(`${paintSource}\n${occupancySource}\nglobalThis.resolve = paintBookPreview;
    globalThis.isBooked = isSlotHourBooked;
    `, context);
    context.bookingState.court = 'Badminton';
    context.resolve({ name: 'Badminton', rate: 900, rateUnit: '/hr' }, 1);
    assert.equal(context.bookingState.unit, 'Court 2');
    assert.equal(context.bookingState.unitId, 'unit-2');
    assert.equal(context.bookingState.rate, 500);
    assert.equal(context.bookingState.rateDay, 450);
    assert.equal(context.bookingState.rateNight, 600);
    assert.equal(context.bookUnitSelect.innerHTML.includes('selected'), true);
    context.bookingState.date = '2099-01-01';
    assert.equal(context.isBooked(8), true, 'step 3 availability checks occupancy for the resolved court unit');
    context.resolve(null);
    assert.equal(context.bookingState.unitId, null);
    assert.equal(context.bookingState.rate, null);
    });

test('booking controls accumulate two court units, remove a summary row, and submit the exact checkout items', async () => {    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const between = (startText, endText) => {        const start = dashboard.indexOf(startText);
    const end = dashboard.indexOf(endText, start);
    assert.ok(start >= 0 && end > start, `expected dashboard block: ${startText}`);
    return dashboard.slice(start, end).trim();
    };
    const snippets = [        between('function cancelBookingCartEdit() {', '\n    function formatDate'),        between('function selectedBookingCartItem(startHour, endHourExclusive, key = null) {', '\n    function bookingCartItemsConflict'),        between('function bookingCartItemsConflict(a, b) {', '\n    function renderBookingCart'),        between('function renderBookingCart() {', '\n    function removeBookingCartItem'),        between('function removeBookingCartItem(key) {', '\n    async function submitBookingCart'),        between('async function submitBookingCart() {', '\n    if (bookAddButton) {'),        between("if (bookAddButton) {\n        bookAddButton.addEventListener('click', async () => {", '\n    if (bookCartItemsEl)'),        between('if (bookCartItemsEl) {', '\n    bookingCartDetailsList?.addEventListener'),        between('function updateSummary() {', '\n    if (bookSlotsGrid)'),        between('function renderBookWizard() {', '\n    function goToBookStep'),        between('function goToBookStep(step) {', '\n    function openBookingCartDetails'),        between('paymentOptions.forEach((option) => {', '\n    // ------------------------------------------------------------------\n    // Step 3 — hourly slot availability'),        between("if (bookSubmit) {\n        bookSubmit.addEventListener('click', () => {", '\n    bookingFeeContinue?.addEventListener'),    ];
    class MockButton {        constructor() { this.listeners = new Map();
    this.disabled = false;
    this.textContent = '';
    this.isConnected = true;
    }        addEventListener(type, callback) { this.listeners.set(type, callback);
    }        async click(event = {}) { await this.listeners.get('click')?.(event);
    }        focus() { this.focused = true;
    }        getClientRects() { return [1];
    }    }    class MockList {        constructor() { this.listeners = new Map();
    this.innerHTML = '';
    }        addEventListener(type, callback) { this.listeners.set(type, callback);
    }        querySelectorAll() { return [];
    }        async clickRemove(key) {            const remove = new MockButton();
    remove.dataset = { dashBookCartRemove: key };
    await this.listeners.get('click')?.({ target: { closest: (selector) => selector === '[data-dash-book-cart-remove]' ? remove : null } });
    return remove;
    }    }    const courts = [        { id: 'listing-badminton', name: 'Badminton', sportName: 'Badminton', rate: 300, rateUnit: '/hr' },        { id: 'listing-tennis', name: 'Tennis', sportName: 'Tennis', rate: 500, rateUnit: '/hr' },    ];
    const unitsByCourt = {        Badminton: [{ id: 'unit-b1', label: 'Court 1', resourceIds: ['res-b1'], rate: 300, rateDay: 300, rateUnit: '/hr' }],        Tennis: [{ id: 'unit-t2', label: 'Court 2', resourceIds: ['res-t2'], rate: 500, rateDay: 500, rateUnit: '/hr' }],    };
    const bookingState = {        court: '', sport: '', unit: null, unitId: null, rate: null, rateUnit: '/hr', rateDay: null, rateNight: null,        date: '2099-01-01', selectedHours: [], startHour: null, endHour: null, paymentType: 'full', downpaymentPct: 50,    };
    const bookingCart = [];
    const currentSettings = { downpaymentPct: 50, nightRateStartsAt: null };
    const calls = [];
    const messages = [];
    const bookAddButton = new MockButton();
    const bookSubmit = new MockButton();
    const paymentTermsAccepted = { checked: false, focused: false, focus() { this.focused = true;
    },        addEventListener(type, callback) { this.changeListener = callback;
    } };
    const paymentTermsOpen = { focused: false, focus() { this.focused = true;
    }, addEventListener() {} };
    const paymentRadios = [];
    const paymentOptions = ['downpayment', 'full'].map((paymentType) => {        const radio = { dataset: { dashPayment: paymentType }, listeners: new Map(),            addEventListener(type, callback) { this.listeners.set(type, callback);
    } };
    paymentRadios.push(radio);
    let selected = false;
    return { radio, get selected() { return selected;
    },            querySelector: () => radio,            addEventListener(type, callback) { this.listener = callback;
    },            classList: {                remove: () => { selected = false;
    },                add: () => { selected = true;
    },            },        };
    });
    const paymentNextButton = new MockButton();
    const bookCartItemsEl = new MockList();
    const removeCancel = new MockButton();
    const removeConfirm = new MockButton();
    const removeDescription = { textContent: '' };
    const bookingRemoveConfirmation = {        hidden: true,        listeners: new Map(),        addEventListener(type, callback) { this.listeners.set(type, callback);
    },        querySelector(selector) { return selector === '[data-dash-book-remove-cancel]' ? removeCancel : null;
    },    };
    const bookCartCountEl = { textContent: '' };
    const bookCartEmpty = { hidden: false };
    const panels = Array.from({ length: 5 }, (_, i) => ({ dataset: { dashBookStep: String(i + 1) }, hidden: true, classList: { toggle() {} } }));
    const progress = Array.from({ length: 5 }, (_, i) => ({ dataset: { dashBookProgressStep: String(i + 1) }, classList: { toggle() {} }, removeAttribute() {}, setAttribute() {} }));
    const scheduleSummary = { textContent: '' };
    const nextCourtButton = new MockButton();
    const returnSummaryButtons = [new MockButton(), new MockButton(), new MockButton()];
    const document = {        querySelector(selector) {            if (selector === '[data-dash-book-schedule-summary]') return scheduleSummary;
    if (selector === '[data-dash-book-next="3"]') return nextCourtButton;
    if (selector === '[data-dash-book-payment-next]') return paymentNextButton;
    return null;
    },        querySelectorAll(selector) {            if (selector === '[data-dash-book-progress-step]') return progress;
    if (selector === '[data-dash-book-edit-cancel]') return returnSummaryButtons;
    return [];
    },    };
    const context = {        document,        Date,        Set,        Map,        Number,        String,        console,        bookingState,        bookingCart,        bookingSelectedDates: new Set([bookingState.date]), bookingSelectionsByDate: new Map([[bookingState.date, []]]), bookingAvailabilityByDate: new Map([[bookingState.date, { rules: { authoritative: true, openHour: 8, closeHour: 24 }, bookings: { ok: true, rows: [] }, walkins: { ok: true, rows: [] } }]]),        bookCourtsCache: courts,        bookSelectedUnitIndex: 0,        bookingCartSeq: 0,        editingBookingCartKey: null,        addingBookingFromSummary: false,        plainSummaryBackMode: false,        bookingCartSaving: false,        slotGridLoading: false,        bookingCartBar: null,        bookingCartDetailsModal: null,        bookingCartDetailsList: null,        bookingCartDetailsDialog: null,        bookingRemoveConfirmation,        bookingRemoveConfirmationDialog: { querySelectorAll: () => [removeCancel, removeConfirm] },        bookingRemoveConfirmationDescription: removeDescription,        handleBookingDialogKeydown() {},        formatDate: date => date,        bookCartItemsEl,        updateSummary() {},        bookingNavButton: null,        bookingRules: { authoritative: true, openHour: 8, closeHour: 24 },        slotGridBookings: { ok: true, rows: [] },        slotGridWalkins: { ok: true, rows: [] },        bookAddButton,        bookSubmit,        bookCartPanel: { hidden: true },        bookCartItemsEl,        bookCartCountEl,        bookCartEmpty,        bookStepPanels: panels,        bookWizardStep: 1,        summaryPayment: { textContent: '' },        summaryGross: { textContent: '' },        summaryTotal: { textContent: '' },        downpaymentDesc: { textContent: '' },        paymentModeHint: { textContent: '' },        paymentOptions,        paymentTermsAccepted,        paymentTermsOpen,        paymentTermsDialog: null,        paymentTermsAgree: null,        paymentTermsDecline: null,        paymentTermsStatus: null,        paymentTermsDialogAgreed: false,        paymentTermsReturnFocus: null,        paymentAcceptanceSignature: null,        paymentReceiptItems: null,        summaryBalance: null,        openBookingFeeConfirmation: (...args) => calls.push(['fee-confirmation', ...args]),        bookingPaymentModal: null,        closeBookingPayment() {},        findBookCourt(name) { return courts.find((court) => court.name === name) || null;
    },        bookSportChoiceKey: (court) => court.name.toLowerCase(),        formatDate: (date) => date,        formatDateForServer: (date) => date,        courtUnitsOverlap: (a, b) => !a || !b || a === b,        bookingHourlyAmount: (hours) => Number(bookingState.rateDay) * hours,        bookingRangeFitsRules: (item, rules) => rules.authoritative && item.startHour >= rules.openHour && item.endHour + 1 <= rules.closeHour,        refreshTimePickers: async () => {},        renderTimePickers() {},        paintBookPreview() {},        renderCourtChoices() {},        fetchDayOccupancy: async () => ({ ok: true, rows: [] }),        window: {            escapeHtml: (value) => String(value),            InigoCourtsData: {                resolveCourtUnits: (court) => ({ units: unitsByCourt[court.name] || [] }),                getCourts: async () => courts,            },            InigoAppSettings: { getSettings: async () => currentSettings },            InigoBookingSlots: {                groupConsecutiveHours(hours) { return slots.groupConsecutiveHours(hours);
    },                localDateHourToIso(date, hour) { return `${date}T${String(hour).padStart(2, '0')}:00:00Z`;
    },            },            InigoBusinessHours: {                formatHourLabel: (hour) => `${hour}:00`,                getForDate: async () => ({ authoritative: true, openHour: 8, closeHour: 24 }),            },            InigoToast: { show: (message, error) => messages.push({ message, error: Boolean(error) }) },            inigosyncProfile: { role: 'customer' },            sb: { functions: { invoke: async (...args) => { calls.push(args);
    return { data: { checkout_url: 'https://checkout.paymongo.com/test' }, error: null };
    } } },            location: { assign: (url) => calls.push(['redirect', url]) },        },        setTimeout,    };
    const script = `${snippets.join('\n')}\nglobalThis.finishCheckout = submitBookingCart;
    globalThis.refreshSummary = updateSummary;
    globalThis.cancelEdit = cancelBookingCartEdit;
    globalThis.goToStep = goToBookStep;
    `;
    runInNewContext(script, context);
    paymentRadios[0].listeners.get('change')();
    assert.equal(bookingState.paymentType, 'downpayment', 'native radio change updates the selected payment method for keyboard and AT users');
    assert.equal(paymentTermsAccepted.checked, false, 'changing payment requires fresh terms acceptance');
    assert.equal(paymentOptions[0].selected, true);
    paymentRadios[1].listeners.get('change')();
    assert.equal(bookingState.paymentType, 'full');
    assert.equal(paymentOptions[1].selected, true);
    const choose = (court, unit, rate, hours) => {        bookingState.court = court;
    bookingState.sport = court;
    bookingState.unit = unit.label;
    bookingState.unitId = unit.id;
    bookingState.rate = rate;
    bookingState.rateDay = rate;
    bookingState.rateNight = null;
    bookingState.rateUnit = '/hr';
    bookingState.selectedHours = hours;
    context.refreshSummary();
    };
    choose('Badminton', unitsByCourt.Badminton[0], 300, [8, 9]);
    await bookAddButton.click();
    choose('Tennis', unitsByCourt.Tennis[0], 500, [8, 9]);
    await bookAddButton.click();
    assert.equal(bookingCart.length, 2, JSON.stringify(messages));
    assert.deepEqual(bookingCart.map((item) => [item.sport, item.court, item.unitId]), [        ['Badminton', 'Badminton', 'unit-b1'], ['Tennis', 'Tennis', 'unit-t2'],    ]);
    assert.equal(bookCartCountEl.textContent, '2 items');
    assert.equal(returnSummaryButtons[0].hidden, true, 'existing cart items alone do not show Back to summary');
    assert.equal(paymentNextButton.disabled, false, 'summary enables the payment step once bookings exist');
    bookSubmit.disabled = true;
    context.goToStep(4);
    assert.equal(bookSubmit.disabled, true, 'wizard navigation preserves the acceptance-aware submit state from updateSummary');
    assert.equal(bookSubmit.disabled, true, 'navigation leaves the acceptance-aware disabled state intact');
    const removeButton = await bookCartItemsEl.clickRemove(bookingCart[0].key);
    assert.equal(bookingRemoveConfirmation.hidden, false, 'removing a summary row first opens the confirmation dialog');
    assert.match(removeDescription.textContent, /Badminton.*2099-01-01.*8:00–10:00/, 'confirmation identifies the selected court, date, and time');
    await bookingRemoveConfirmation.listeners.get('click')({ target: { closest: selector => selector === '[data-dash-book-remove-cancel]' ? removeCancel : null } });
    assert.equal(bookingCart.length, 2, 'Cancel leaves every cart item untouched');
    assert.equal(removeButton.focused, true, 'Cancel restores focus to the originating Remove control');
    await bookCartItemsEl.clickRemove(bookingCart[0].key);
    await bookingRemoveConfirmation.listeners.get('click')({ target: { closest: selector => selector === '[data-dash-book-remove-confirm]' ? removeConfirm : null } });
    assert.equal(bookingCart.length, 1, 'the summary remove action updates the accumulated selections');
    assert.equal(bookingCart[0].sport, 'Tennis', 'Confirm removes the item named by the prompt');
    assert.equal(bookCartCountEl.textContent, '1 item', 'confirmation refreshes the summary count');
    assert.equal(paymentNextButton.disabled, false, 'the payment step stays enabled when another booking remains');
    choose('Badminton', unitsByCourt.Badminton[0], 300, [10, 11]);
    await bookAddButton.click();
    const callsBeforeUnacceptedSubmit = calls.length;
    await bookSubmit.click();
    assert.equal(calls.length, callsBeforeUnacceptedSubmit, 'the payment button does not open fee confirmation without acceptance');
    assert.equal(paymentTermsOpen.focused, true, 'the visible terms control receives focus when acceptance is missing');
    await context.finishCheckout();
    assert.equal(calls.some(([name]) => name === 'paymongo-checkout'), false, 'direct submit also refuses unaccepted terms');
    paymentTermsAccepted.checked = true;
    paymentTermsAccepted.changeListener();
    assert.equal(bookSubmit.disabled, false, 'acceptance change enables the current checkout');
    await bookSubmit.click();
    assert.equal(calls.at(-1)[0], 'fee-confirmation', 'accepted terms enable the confirmation step');
    await context.finishCheckout();
    const invoke = calls.find(([name]) => name === 'paymongo-checkout');
    assert.ok(invoke, 'checkout uses the existing PayMongo function');
    assert.deepEqual(JSON.parse(JSON.stringify(invoke[1])), {        body: {            terms_acceptance: { accepted: true, version: 'customer-booking-v1' },            payment_option: 'full',            items: [                { listing_id: 'listing-tennis', unit_id: 'unit-t2', starts_at: '2099-01-01T08:00:00Z', ends_at: '2099-01-01T10:00:00Z', rate_quantity: 1 },                { listing_id: 'listing-badminton', unit_id: 'unit-b1', starts_at: '2099-01-01T10:00:00Z', ends_at: '2099-01-01T12:00:00Z', rate_quantity: 1 },            ],        },    });
    currentSettings.downpaymentPct = 40;
    bookingState.paymentType = 'downpayment';
    choose('Badminton', unitsByCourt.Badminton[0], 300, [12]);
    await bookAddButton.click();
    assert.equal(bookingState.downpaymentPct, 40, 'adding a booking refreshes the deposit setting before displaying payment');
    assert.equal(context.summaryTotal.textContent, '₱760.00', 'due-now total uses the refreshed deposit percentage');
    bookingCart.splice(0, bookingCart.length, ...Array.from({ length: 7 }, (_, index) => ({ key: `seed-${index}` })));
    choose('Badminton', unitsByCourt.Badminton[0], 300, [12, 14]);
    await bookAddButton.click();
    assert.equal(bookingCart.length, 7, 'disjoint ranges are rejected by the one-continuous-range-per-date rule');
    assert.match(messages.at(-1).message, /one continuous time range per date/);
    bookingCart.push({ key: 'seed-7' });
    context.editingBookingCartKey = 'seed-0';
    choose('Badminton', unitsByCourt.Badminton[0], 300, [12, 13]);
    assert.equal(bookAddButton.disabled, false, 'an existing booking remains editable when the cart has eight items');
    await bookAddButton.click();
    assert.equal(bookingCart.length, 8, 'saving an edit replaces the item without increasing the cart size');
    assert.equal(bookingCart[0].key, 'seed-0', 'the replacement keeps its stable cart key');
    assert.equal(bookingCart[0].unitId, 'unit-b1');
    context.editingBookingCartKey = 'seed-1';
    context.cancelEdit();
    assert.equal(context.editingBookingCartKey, null);
    assert.equal(bookingCart.length, 8, 'cancelling an edit preserves the existing bookings');
    assert.equal(context.bookWizardStep, 4, 'cancelling returns to the summary');
    context.addingBookingFromSummary = true;
    bookingState.selectedHours = [15];
    context.refreshSummary();
    assert.equal(returnSummaryButtons[0].hidden, false, 'Back to summary appears while adding from the summary');
    assert.equal(returnSummaryButtons[0].textContent, 'Back to summary');
    context.cancelEdit();
    assert.equal(returnSummaryButtons[0].hidden, true, 'Back to summary hides when the add flow ends');
    assert.equal(bookingCart.length, 8, 'returning from an add-another draft also preserves the cart');
    assert.equal(bookingState.selectedHours.length, 0, 'the abandoned draft hours are cleared');
    context.plainSummaryBackMode = true;
    context.bookWizardStep = 3;
    context.refreshSummary();
    assert.equal(bookAddButton.disabled, false, 'plain Back navigation enables Review booking with no hours selected');
    const cartBeforePlainReturn = bookingCart.map((item) => item.key);
    await bookAddButton.click();
    assert.equal(context.bookWizardStep, 4, 'Review booking returns to the existing summary');
    assert.deepEqual(bookingCart.map((item) => item.key), cartBeforePlainReturn, 'plain forward navigation does not add or replace cart entries');
    assert.equal(context.plainSummaryBackMode, false, 'the plain return mode ends at the summary');
    assert.ok(returnSummaryButtons.every((button) => button.hidden), 'plain return navigation keeps edit and add cancellation controls hidden');
    bookingCart.splice(0, bookingCart.length, ...Array.from({ length: 9 }, (_, index) => ({
        key: `ready-${index}`, listingId: `listing-${index}`, unitId: `unit-${index}`, estimatedTotal: 100,
        sport: 'Badminton', court: `Court ${index + 1}`, unit: `Lane ${index + 1}`, date: '2099-01-01',
        startHour: 8, endHour: 9,
    })));
    context.bookingCartSaving = false;
    context.refreshSummary();
    paymentTermsAccepted.checked = true;
    context.refreshSummary();
    assert.equal(bookSubmit.disabled, false, 'a valid cart with nine bookings can proceed to payment');
    await bookSubmit.click();
    assert.equal(calls.at(-1)[0], 'fee-confirmation', 'nine valid cart items reach the payment confirmation step');
    });

test('working-time changes refresh visible customer and staff availability views', () => {    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8'); const staff = readFileSync(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8'); const owner = readFileSync(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8'); const businessHours = readFileSync(new URL('../includes/businessHours.js', import.meta.url), 'utf8'); assert.match(owner, /notifyRulesUpdated\?\.\(\)/, 'successful owner saves publish a rules update'); assert.match(businessHours, /addEventListener\('storage'/, 'other tabs receive the local-storage update'); assert.match(dashboard, /addEventListener\('inigosync:booking-rules-updated'/); assert.match(dashboard, /addEventListener\('visibilitychange', refreshVisibleBookingAvailability\)/); assert.match(dashboard, /refreshTimePickers\(true\)/, 'the customer forces a date-rule refresh'); assert.match(dashboard, /setInterval\(refreshVisibleBookingAvailability, 60000\)/, 'active customer booking availability polls once a minute'); assert.match(dashboard, /bookDate\.min = today;[\s\S]*?if \(bookingState\.date < today\)[\s\S]*?bookingState\.date = today/, 'the customer date minimum and selection roll forward after Manila midnight'); assert.match(staff, /addEventListener\('inigosync:booking-rules-updated', refreshVisibleWalkinSlots\)/); assert.match(staff, /addEventListener\('visibilitychange', refreshVisibleWalkinSlots\)/); assert.match(staff, /getForDate\(rulesDate, \{ force: forceRules \}\)/); assert.match(staff, /setInterval\(refreshVisibleWalkinSlots, 60000\)/, 'active walk-in availability polls once a minute'); assert.match(staff, /addEventListener\('inigosync:booking-rules-updated', refreshVisibleCourtSchedule\)/); assert.match(staff, /setInterval\(refreshVisibleCourtSchedule, 60000\)/, 'the active staff schedule refreshes once a minute'); assert.match(staff, /scheduleDateInput\.min = today;[\s\S]*?if \(scheduleDate < today\)[\s\S]*?scheduleDate = today/, 'the schedule minimum and selection roll forward after Manila midnight'); const walkinRefresh = staff.match(/async function refreshWalkinTimeSlots\(forceRules = false\) \{([\s\S]*?)function refreshVisibleWalkinSlots/); assert.ok(walkinRefresh, 'walk-in refresh function is present'); assert.match(walkinRefresh[1], /const businessRules = window\.InigoBusinessHours[\s\S]*?await window\.InigoBusinessHours\.getForDate\(rulesDate, \{ force: forceRules \}\)[\s\S]*?if \(mySeq !== walkinRequestSeq\) return;\s*/,        'stale rules responses are discarded before shared state is updated'); assert.match(walkinRefresh[1], /const occupancyRes = await fetchWalkinOccupancyForCourt\(courtName\);\s*if \(mySeq !== walkinRequestSeq\) return;\s*/,        'stale occupancy responses are discarded before shared state is updated'); assert.match(walkinRefresh[1], /const hoursForDay =/,        'hours are calculated locally until the request is current'); assert.match(walkinRefresh[1], /renderWalkinTimeSlots\(\);\s*if \(dateChangeMessage && occupancyRes\.ok && !businessRules\.isClosed && walkinOpenWindowsEl\) walkinOpenWindowsEl\.textContent = dateChangeMessage/,        'the date-change notice is applied after verified slots render'); assert.match(walkinRefresh[1], /if \(walkinSelectionDate !== rulesDate\)[\s\S]*?walkinState\.selectedHours = \[\][\s\S]*?walkinState\.startHour = null[\s\S]*?walkinState\.endHour = null/,        'the midnight date change clears the current time selection'); assert.match(staff, /walkinSelectionDate !== todayDateInputValue\(\) \|\| !walkinState\.court[\s\S]*?return null; /,        'a stale date selection cannot be turned into a new-date order line'); });
