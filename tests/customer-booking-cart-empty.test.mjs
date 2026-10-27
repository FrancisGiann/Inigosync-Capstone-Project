import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('removing the final draft returns to fresh Step 1 and focuses a sport choice', () => {
    const start = dashboard.indexOf('function removeBookingCartItem(key) {');
    const end = dashboard.indexOf('\n    let pendingBookingCartRemoval', start);
    assert.ok(start >= 0 && end > start, 'cart removal function is present');

    const calls = [];
    const sportChoice = { focus: (...args) => calls.push(['focus', ...args]) };
    const context = {
        bookingCart: [{ key: 'last' }],
        bookingCartSaving: false,
        bookingCartDetailsModal: { hidden: true },
        bookingState: {
            sportSlug: 'basketball', court: 'Court A', sport: 'Basketball', rate: 200,
            unit: 'Unit 1', unitId: 'unit-1', selectedHours: [10], startHour: 10, endHour: 11,
        },
        editingBookingCartKey: 'last',
        addingBookingFromSummary: true,
        plainSummaryBackMode: true,
        bookingSummaryBackKey: 'last',
        bookAddButton: { textContent: 'Save changes' },
        bookSelect: { value: 'Court A', disabled: false },
        bookSportGrid: { querySelector: () => sportChoice },
        paintBookPreview: (value) => calls.push(['preview', value]),
        renderSportChoices: () => calls.push(['sports']),
        resetTimeSelectionAndRender: () => calls.push(['reset-time']),
        goToBookStep: (step) => calls.push(['step', step]),
        updateSummary: () => calls.push(['summary']),
        bookingNavButton: { focus: () => calls.push(['nav-focus']) },
    };

    runInNewContext(dashboard.slice(start, end), context);
    context.removeBookingCartItem('last');

    assert.equal(context.bookingCart.length, 0);
    assert.equal(context.editingBookingCartKey, null);
    assert.equal(context.addingBookingFromSummary, false);
    assert.equal(context.plainSummaryBackMode, false);
    assert.equal(context.bookingSummaryBackKey, null);
    assert.equal(context.bookingState.selectedHours.length, 0);
    assert.equal(context.bookingState.court, '');
    assert.equal(context.bookSelect.value, '');
    assert.equal(context.bookSelect.disabled, true);
    assert.equal(context.bookAddButton.textContent, 'Review booking');
    assert.ok(calls.some((call) => call[0] === 'step' && call[1] === 1));
    assert.ok(calls.some((call) => call[0] === 'focus' && call[1].preventScroll));
});

test('removing one item preserves the remaining summary flow', () => {
    const start = dashboard.indexOf('function removeBookingCartItem(key) {');
    const end = dashboard.indexOf('\n    let pendingBookingCartRemoval', start);
    const calls = [];
    const context = {
        bookingCart: [{ key: 'first' }, { key: 'last' }],
        bookingCartSaving: false,
        bookingCartDetailsModal: { hidden: true },
        bookingState: {},
        updateSummary: () => calls.push('summary'),
        goToBookStep: () => calls.push('step'),
    };

    runInNewContext(dashboard.slice(start, end), context);
    context.removeBookingCartItem('last');

    assert.deepEqual(context.bookingCart.map((item) => item.key), ['first']);
    assert.deepEqual(calls, ['summary']);
});
