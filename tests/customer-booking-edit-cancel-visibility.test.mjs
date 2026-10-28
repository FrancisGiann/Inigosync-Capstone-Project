import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(new URL('../Style/Dashboard.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('summary and edit actions control visibility of the Step 1 return button', () => {
    const renderStart = dashboard.indexOf('function renderBookWizard() {');
    const renderEnd = dashboard.indexOf('\n    function goToBookStep', renderStart);
    const addStart = dashboard.indexOf("document.querySelector('[data-dash-book-new]')?.addEventListener('click'");
    const addEnd = dashboard.indexOf('\n    async function editBookingCartItem', addStart);
    assert.ok(renderStart >= 0 && renderEnd > renderStart, 'wizard renderer is present');
    assert.ok(addStart >= 0 && addEnd > addStart, 'add-another action handler is present');

    let addClick;
    const cancelButton = { hidden: false, textContent: '' };
    const addButton = { addEventListener: (type, handler) => { assert.equal(type, 'click'); addClick = handler; } };
    const context = {
        bookStepPanels: [],
        bookingState: { court: '', sport: '', unit: null, unitId: null, sportSlug: '', date: '' },
        bookingCart: [{ key: 'item-1' }],
        bookingCartSaving: false,
        editingBookingCartKey: null,
        addingBookingFromSummary: false,
        document: {
            querySelectorAll(selector) {
                if (selector === '[data-dash-book-edit-cancel]') return [cancelButton];
                return [];
            },
            querySelector(selector) {
                return selector === '[data-dash-book-new]' ? addButton : null;
            },
        },
        findBookCourt: () => null,
        formatDate: () => '',
        bookSelect: { value: '', disabled: false },
        paintBookPreview() {},
        renderSportChoices() {},
        resetTimeSelectionAndRender() {},
        resetBookingDatesForFreshDraft() {},
    };
    context.goToBookStep = () => context.renderWizard();

    const source = `${dashboard.slice(renderStart, renderEnd)}\n${dashboard.slice(addStart, addEnd)}\nglobalThis.renderWizard = renderBookWizard; globalThis.setEditing = (key) => { editingBookingCartKey = key; addingBookingFromSummary = false; };`;
    runInNewContext(source, context);

    context.renderWizard();
    assert.equal(cancelButton.hidden, true, 'the return button starts hidden before adding another item');
    assert.equal(cancelButton.textContent, 'Back to summary');

    addClick();
    assert.equal(cancelButton.hidden, false, 'the add-another action reveals the return button');
    assert.equal(cancelButton.textContent, 'Back to summary');

    context.setEditing('item-1');
    context.renderWizard();
    assert.equal(cancelButton.hidden, false, 'an active edit keeps its cancellation action visible');
    assert.equal(cancelButton.textContent, 'Cancel edit');

    assert.match(css, /\.dash-book-flow-actions \[data-dash-book-edit-cancel\]\[hidden\]\s*\{\s*display:\s*none\s*!important;/,
        'the hidden attribute must win over the ghost button display rule');
});
