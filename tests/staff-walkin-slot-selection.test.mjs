import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');
const inCartStatusStart = source.lastIndexOf('    function walkinSlotStatus(hour) {');
const inCartStatusEnd = source.indexOf('\n    function renderWalkinTimeSlots()', inCartStatusStart);
assert.ok(inCartStatusStart >= 0 && inCartStatusEnd > inCartStatusStart, 'staff slot status function is present');
const start = source.indexOf('function renderWalkinTimeSlots() {');
const end = source.indexOf('\n    async function refreshWalkinTimeSlots(', start);
assert.ok(start >= 0 && end > start, 'staff slot renderer is present');
const renderer = source.slice(start, end);

function makePicker(blockedHours = []) {
    const handlers = new Map();
    const hours = [8, 9, 10, 11, 12];
    const blocked = new Set(blockedHours);
    const checkbox = {
        checked: false,
        indeterminate: false,
        addEventListener(type, handler) { if (type === 'change') this.changeHandler = handler; },
        focus() { grid.activeElement = this; },
    };
    let slots = [];
    const grid = {
        activeElement: null,
        _innerHTML: '',
        get innerHTML() { return this._innerHTML; },
        set innerHTML(value) {
            this._innerHTML = value;
            handlers.clear();
            checkbox.checked = /data-staff-walkin-select-continuous[^>]*\schecked(?:\s|>)/.test(value);
            checkbox.indeterminate = /data-staff-walkin-select-continuous[^>]*data-indeterminate="true"/.test(value);
            slots = hours.map((hour) => ({
                dataset: { staffWalkinHour: String(hour) },
                addEventListener(type, handler) { if (type === 'click') handlers.set(hour, handler); },
                focus() { grid.activeElement = this; },
            }));
        },
        querySelector(selector) {
            return selector === '[data-staff-walkin-select-continuous]' ? checkbox : null;
        },
        querySelectorAll(selector) {
            if (selector === '[data-indeterminate="true"]') return checkbox.indeterminate ? [checkbox] : [];
            if (selector === '[data-staff-walkin-hour]') return slots;
            return [];
        },
    };
    const state = { court: { name: 'Court 1' }, selectedHours: [], startHour: null, endHour: null };
    const status = { textContent: '' };
    const context = {
        walkinHourGrid: grid,
        walkinOpenWindowsEl: status,
        walkinCurrentRangeEl: { textContent: '' },
        walkinBusinessRules: { authoritative: true, isClosed: false },
        walkinBookings: { ok: true },
        walkinWalkins: { ok: true },
        walkinHoursForDay: hours,
        walkinSelectionDate: '2099-01-01',
        walkinState: state,
        walkinSlotStatus: (hour) => blocked.has(hour) ? 'unavailable' : 'open',
        todayDateInputValue: () => '2099-01-01',
        walkinTimeRangeLabel: () => '',
        updateWalkinSummary() {},
        renderWalkinWizard() {},
        window: {
            escapeHtml: String,
            InigoBusinessHours: { formatHourLabel: (hour) => `${hour}:00` },
        },
    };
    runInNewContext(`${renderer}\nrenderWalkinTimeSlots();`, context);
    return {
        grid,
        state,
        status,
        checkbox,
        click(hour) {
            assert.ok(!blocked.has(hour), 'the test only clicks selectable slots');
            const handler = handlers.get(hour);
            assert.ok(handler, `click handler exists for ${hour}`);
            handler();
        },
        toggleContinuous(checked) {
            assert.ok(checkbox.changeHandler, 'continuous-selection change handler exists');
            checkbox.checked = checked;
            checkbox.changeHandler({ currentTarget: checkbox });
        },
    };
}

test('staff walk-in fills a continuous range when a later hour is clicked', () => {
    const picker = makePicker();
    picker.click(8);
    picker.click(11);
    assert.deepEqual(Array.from(picker.state.selectedHours), [8, 9, 10, 11]);
    assert.equal(picker.state.startHour, 8);
    assert.equal(picker.state.endHour, 11);
});

test('staff walk-in stops before unavailable time and trims selected ranges', () => {
    const picker = makePicker([10]);
    picker.click(8);
    picker.click(12);
    assert.deepEqual(Array.from(picker.state.selectedHours), [8, 9]);
    assert.match(picker.status.textContent, /first unavailable hour/);
    picker.click(8);
    assert.deepEqual(Array.from(picker.state.selectedHours), []);
    picker.click(11);
    assert.deepEqual(Array.from(picker.state.selectedHours), [11]);
});

test('staff continuous-selection checkbox reflects partial selection and selects the earliest open block', () => {
    const picker = makePicker([10]);
    picker.click(9);
    assert.deepEqual(Array.from(picker.state.selectedHours), [9]);
    assert.equal(picker.checkbox.indeterminate, true, 'a manual partial selection sets the checkbox indeterminate');
    assert.equal(picker.grid.activeElement?.dataset?.staffWalkinHour, '9', 'slot focus is restored after rerender');

    picker.toggleContinuous(true);
    assert.deepEqual(Array.from(picker.state.selectedHours), [8, 9]);
    assert.equal(picker.checkbox.checked, true);
    assert.equal(picker.checkbox.indeterminate, false);
    assert.equal(picker.grid.activeElement, picker.checkbox, 'checkbox focus is restored after rerender');

    picker.toggleContinuous(false);
    assert.deepEqual(Array.from(picker.state.selectedHours), []);
    assert.equal(picker.checkbox.checked, false);
});

test('staff schedule legend matches available, selected, in-summary, and unavailable slot states', () => {
    const picker = makePicker();
    assert.match(picker.grid.innerHTML, /aria-label="Time slot key"/);
    assert.match(picker.grid.innerHTML, />Available<\/span>/);
    assert.match(picker.grid.innerHTML, />Selected<\/span>/);
    assert.match(picker.grid.innerHTML, />In summary<\/span>/);
    assert.match(picker.grid.innerHTML, />Unavailable<\/span>/);
});

test('staff slot status reserves matching order lines and permits the line currently being edited', () => {
    const statusSource = source.slice(inCartStatusStart, inCartStatusEnd);
    const state = {
        court: { name: 'Tennis' }, unit: 'Court 1', items: [{
            court: 'Tennis', unit: 'Court 1', startsAt: '1970-01-01T00:00:00.000Z', endsAt: '1970-01-01T00:01:00.000Z',
        }],
    };
    const context = {
        walkinState: state, editingWalkinItemIndex: null,
        isWalkinHourPast: () => false,
        hourWindow: () => ({ start: new Date(0), end: new Date(60_000) }),
        todayDateInputValue: () => '1970-01-01',
        sameCourtName: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
        courtUnitsOverlap: (a, b) => !a || !b || String(a).toLowerCase() === String(b).toLowerCase(),
        windowsOverlap: (a, b) => a.start < b.end && b.start < a.end,
        walkinBookings: { rows: [] }, walkinWalkins: { rows: [] },
    };
    runInNewContext(`${statusSource}\nglobalThis.slotStatus = walkinSlotStatus;`, context);
    assert.equal(context.slotStatus(0), 'in-cart', 'matching current order line is shown as In summary');
    context.editingWalkinItemIndex = 0;
    assert.equal(context.slotStatus(0), 'open', 'editing its own line does not block its selected time');
});
