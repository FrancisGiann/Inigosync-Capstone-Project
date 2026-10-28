import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');
const start = source.indexOf('function renderWalkinTimeSlots() {');
const end = source.indexOf('\n    async function refreshWalkinTimeSlots(', start);
assert.ok(start >= 0 && end > start, 'staff slot renderer is present');
const renderer = source.slice(start, end);

function makePicker(blockedHours = []) {
    const handlers = new Map();
    const hours = [8, 9, 10, 11, 12];
    const blocked = new Set(blockedHours);
    const grid = {
        innerHTML: '',
        querySelectorAll() {
            handlers.clear();
            return hours.map((hour) => ({
                dataset: { staffWalkinHour: String(hour) },
                addEventListener(type, handler) { if (type === 'click') handlers.set(hour, handler); },
            }));
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
        state,
        status,
        click(hour) {
            assert.ok(!blocked.has(hour), 'the test only clicks selectable slots');
            const handler = handlers.get(hour);
            assert.ok(handler, `click handler exists for ${hour}`);
            handler();
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
