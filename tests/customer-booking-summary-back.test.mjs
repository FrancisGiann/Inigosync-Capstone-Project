import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('summary Back returns to Step 3 without entering edit mode or changing the cart', () => {
    const start = dashboard.indexOf("document.querySelectorAll('[data-dash-book-next], [data-dash-book-back]')");
    const end = dashboard.indexOf('\n    if (bookCartItemsEl)', start);
    assert.ok(start >= 0 && end > start, 'booking navigation handler is present');

    let clickHandler;
    const calls = [];
    const backButton = {
        dataset: { dashBookBack: '3' },
        addEventListener(type, handler) {
            assert.equal(type, 'click');
            clickHandler = handler;
        },
    };
    const bookingCart = [{ key: 'first' }, { key: 'edited-middle' }, { key: 'last' }];
    const restoreCalls = [];
    const context = {
        document: { querySelectorAll: () => [backButton] },
        bookingCart,
        bookingSummaryBackKey: 'edited-middle',
        bookingState: { court: '', unitId: null },
        restoreBookingCartSelection: (...args) => restoreCalls.push(args),
        goToBookStep: (...args) => calls.push(['step', ...args]),
    };

    runInNewContext(dashboard.slice(start, end), context);
    clickHandler();
    assert.deepEqual(restoreCalls, [[bookingCart[1]]], 'an empty transient selection is restored for navigation');
    assert.deepEqual(calls, [['step', '3']]);
    assert.deepEqual(bookingCart.map((item) => item.key), ['first', 'edited-middle', 'last']);

    calls.length = 0;
    restoreCalls.length = 0;
    context.bookingState = { court: 'Badminton', unitId: 'unit-1' };
    clickHandler();
    assert.deepEqual(restoreCalls, [], 'a current court selection is retained');
    assert.deepEqual(calls, [['step', '3']]);

    calls.length = 0;
    restoreCalls.length = 0;
    context.bookingState = { court: '', unitId: null };
    context.bookingSummaryBackKey = 'removed-item';
    clickHandler();
    assert.deepEqual(restoreCalls, [[bookingCart[2]]], 'a removed remembered item falls back to the last remaining cart item');
    assert.deepEqual(calls, [['step', '3']]);

    calls.length = 0;
    restoreCalls.length = 0;
    context.bookingCart = [];
    clickHandler();
    assert.deepEqual(calls, [['step', '3']], 'empty cart navigation keeps the normal step behavior');
    assert.deepEqual(restoreCalls, []);
});

test('backward wizard steps remain reachable after the add-another selection was cleared', () => {
    const start = dashboard.indexOf('function renderBookWizard() {');
    const end = dashboard.indexOf('\n    function openBookingCartDetails', start);
    assert.ok(start >= 0 && end > start, 'wizard navigation functions are present');
    const steps = Array.from({ length: 5 }, (_, index) => ({
        dataset: { dashBookStep: String(index + 1) },
        hidden: false,
        classList: { toggle() {} },
    }));
    const context = {
        bookStepPanels: steps,
        bookWizardStep: 4,
        bookingState: { court: '', unitId: null, sportSlug: '' },
        bookingCart: [{ key: 'item' }],
        bookingCartSaving: false,
        bookSubmit: { disabled: false },
        document: {
            querySelectorAll: () => [],
            querySelector: () => null,
        },
        findBookCourt: () => null,
        formatDate: () => '',
        updateSummary() {},
        renderBookingCart() {},
        globalThis: null,
    };
    context.globalThis = context;
    runInNewContext(`${dashboard.slice(start, end)}\nglobalThis.goToBookStepForTest = goToBookStep;`, context);

    context.goToBookStepForTest(3);
    assert.equal(context.bookWizardStep, 3);
    context.goToBookStepForTest(2);
    assert.equal(context.bookWizardStep, 2);
    context.goToBookStepForTest(1);
    assert.equal(context.bookWizardStep, 1);
});
