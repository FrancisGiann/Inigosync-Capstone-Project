import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../Pages/user_dashboard.html', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../Style/Dashboard.css', import.meta.url), 'utf8');
const step2 = html.slice(html.indexOf('data-dash-book-step="2"'), html.indexOf('data-dash-book-step="3"'));
const step3 = html.slice(html.indexOf('data-dash-book-step="3"'), html.indexOf('data-dash-book-step="4"'));

test('customer date and live schedule controls are in Step 3', () => {
    assert.doesNotMatch(step2, /data-dash-book-date|type="date"/);
    assert.match(step3, /data-dash-book-date/);
    assert.match(step3, /data-dash-book-slots/);
    assert.match(step3, /for="dash-book-date"[^>]*>Choose a date/);
    assert.match(step3, /aria-describedby="dash-book-date-hint"/);
    assert.match(step3, /data-dash-book-slot-status role="status" aria-live="polite"/);
    assert.match(step3, /dash-book-slot-legend/);
    assert.match(dashboard, /class="dash-book-slot is-\$\{status\}[^"]*"[^>]*aria-label=/, 'slot buttons expose a text state as well as visual state');
    assert.match(dashboard, /dash-book-slot-state/);
    assert.match(dashboard, /aria-pressed="\$\{selected\}"/);
    assert.match(css, /\.dash-book-slot\.is-selected/);
    assert.match(css, /\.dash-book-slot\.is-booked, \.dash-book-slot\.is-past/);
    assert.match(css, /\.dash-book-slot:focus-visible/);
    assert.match(css, /@media \(max-width: 640px\)[\s\S]*?\.dash-book-slot-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test('court choices render one image card per unit with unit rates and listing ratings', () => {
    const listingRenderer = dashboard.slice(dashboard.indexOf('function renderCourtChoices('), dashboard.indexOf('function selectBookCourtUnit('));
    const sportSelection = dashboard.slice(dashboard.indexOf("if (bookSportGrid) bookSportGrid.addEventListener"), dashboard.indexOf('bookCourtGrid?.addEventListener'));
    assert.match(listingRenderer, /courtPhotoMarkup/);
    assert.match(listingRenderer, /court\.rating\.toFixed\(1\)/);
    assert.match(listingRenderer, /court\.description/);
    assert.match(listingRenderer, /courts\.flatMap/);
    assert.match(listingRenderer, /type="radio" name="dash-book-court-unit"/);
    assert.match(listingRenderer, /\$\{selected \? ' checked' : ''\}/);
    assert.match(sportSelection, /bookSelect\.value = ''/);
    assert.match(sportSelection, /paintBookPreview\(null\)/);
    assert.match(step2, /data-dash-book-unit-select/);
    assert.doesNotMatch(step2, /data-dash-book-unit-preview/);

    const bookCourtGrid = { innerHTML: '' };
    const context = {
        bookCourtGrid,
        bookingState: { court: 'Table Tennis', unitId: 'table-2' },
        sportKey: (court) => court.sportSlug || 'sport',
        window: {
            escapeHtml: (value) => String(value ?? ''),
            InigoCourtsData: {
                resolveCourtUnits: (court) => ({ units: court.bookableUnits }),
                monogramFor: () => 'T',
            },
        },
        courtPhotoMarkup: (unit, monogram, alt) => unit.imageUrl
            ? `<img src="${unit.imageUrl}" alt="${alt}">`
            : `<span>${monogram}</span>`,
    };
    runInNewContext(`${listingRenderer}\nglobalThis.render = renderCourtChoices;`, context);
    const tableTennis = { name: 'Table Tennis', quantity: 2, unit: 'tables', description: 'Tournament grade', rating: 4.7, bookableUnits: [
        { id: 'table-1', label: 'Table 1', imageUrl: '/table-1.jpg', rateDay: 250, rateNight: 300, rateUnit: '/hr' },
        { id: 'table-2', label: 'Table 2', imageUrl: '/table-2.jpg', rateDay: 350, rateNight: 350, rateUnit: '/hr' },
    ] };
    context.render([tableTennis]);
    assert.equal((bookCourtGrid.innerHTML.match(/data-dash-book-court-card=/g) || []).length, 2);
    assert.match(bookCourtGrid.innerHTML, /src="\/table-1\.jpg"/);
    assert.match(bookCourtGrid.innerHTML, /src="\/table-2\.jpg"/);
    assert.match(bookCourtGrid.innerHTML, /₱250\/hr day · ₱300\/hr night/);
    assert.match(bookCourtGrid.innerHTML, /₱350\/hr/);
    assert.match(bookCourtGrid.innerHTML, /Listing rating 4\.7 out of 5/);
    assert.match(bookCourtGrid.innerHTML, /listing rating/);
    assert.match(bookCourtGrid.innerHTML, /data-dash-book-unit-id="table-2"><input class="dash-book-court-radio" type="radio" name="dash-book-court-unit"[^>]*checked/);
    assert.match(dashboard, /bookCourtGrid\?\.addEventListener\('change'/, 'native radio changes support mouse and keyboard selection');
    assert.match(bookCourtGrid.innerHTML, /Tournament grade/);

    const selectionStart = dashboard.indexOf('function selectBookCourtUnit(');
    const selectionEnd = dashboard.indexOf('\n    if (bookSportGrid)', selectionStart);
    const selectedState = { court: '', unitId: null };
    const units = tableTennis.bookableUnits;
    const unitSelect = {
        value: '',
        dispatchEvent() { selectedState.unitId = units[Number(this.value)]?.id || null; },
    };
    const courtSelect = {
        value: '',
        dispatchEvent() { selectedState.court = this.value; selectedState.unitId = null; },
    };
    const selectionContext = {
        bookSelect: courtSelect,
        bookUnitSelect: unitSelect,
        bookingState: selectedState,
        findBookCourt: (name) => name === tableTennis.name ? tableTennis : null,
        window: { InigoCourtsData: { resolveCourtUnits: (court) => ({ units: court.bookableUnits }) } },
        Event: function Event() {},
    };
    runInNewContext(`${dashboard.slice(selectionStart, selectionEnd)}\nglobalThis.select = selectBookCourtUnit;`, selectionContext);
    assert.equal(selectionContext.select('Table Tennis', 'table-2'), true);
    assert.equal(selectedState.court, 'Table Tennis');
    assert.equal(selectedState.unitId, 'table-2');
    assert.equal(unitSelect.value, '1');
});

test('sport step uses radio choices and advances only from the enabled Next button', () => {
    const sportRenderer = dashboard.slice(dashboard.indexOf('function renderSportChoices()'), dashboard.indexOf('function renderCourtChoices('));
    const sportSelectionStart = dashboard.indexOf('if (bookSportGrid) bookSportGrid.addEventListener');
    const sportSelectionEnd = dashboard.indexOf('bookCourtGrid?.addEventListener', sportSelectionStart);
    const sportSelection = dashboard.slice(sportSelectionStart, sportSelectionEnd);
    const stepOne = html.slice(html.indexOf('data-dash-book-step="1"'), html.indexOf('data-dash-book-step="2"'));
    assert.match(stepOne, /role="radiogroup"/);
    assert.match(stepOne, /data-dash-book-sport-next disabled>Next</);
    assert.match(stepOne, /data-dash-book-edit-cancel hidden>Cancel edit/);
    assert.match(sportRenderer, /type="radio" name="dash-book-sport"/);
    assert.match(sportRenderer, /nextSportButton\.disabled = !bookingState\.sportSlug/);
    assert.match(sportSelection, /addEventListener\('change'/);
    assert.doesNotMatch(sportSelection, /goToBookStep\(2\)/, 'choosing a sport keeps the wizard on Step 1');
    assert.match(dashboard, /nextStep === 2 && !bookingState\.sportSlug/);
    assert.match(dashboard, /data-dash-book-sport-next/);
});

test('owner unit cards sort their presentation while retaining original draft indexes for actions', () => {
    const owner = readFileSync(new URL('../includes/owner-courts.js', import.meta.url), 'utf8');
    const renderStart = owner.indexOf('function renderUnits() {');
    const renderEnd = owner.indexOf('\n        async function cropDraftPhoto', renderStart);
    const renderer = owner.slice(renderStart, renderEnd);
    assert.match(renderer, /units\.map\(\(unit, draftIndex\) => \(\{ \.\.\.unit, draftIndex \}\)\)/);
    assert.match(renderer, /const index = unit\.draftIndex/);
    assert.match(renderer, /data-ioc-unit-label="\$\{index\}"/);
    assert.match(renderer, /data-ioc-rate-day="\$\{index\}"/);
    assert.match(renderer, /data-ioc-unit-file="\$\{index\}"/);
    assert.match(renderer, /data-ioc-add-maintenance="\$\{index\}"/);
    assert.match(renderer, /displayUnits\.forEach\(\(unit\) => updateUnitPhotoPreview\(unit, unit\.draftIndex\)\)/);
});

test('Step 3 and adding times require a concrete selected unit id', () => {
    assert.match(dashboard, /nextCourtButton\.disabled = !bookingState\.court \|\| !bookingState\.unitId/);
    assert.match(dashboard, /nextStep === 3 && \(!bookingState\.court \|\| !bookingState\.unitId\)/);
    assert.match(dashboard, /!bookingState\.court \|\| !bookingState\.unitId \|\| !bookingState\.date/);
    assert.match(dashboard, /bookingState\.unitId = unit\?\.id \|\| null/);
});

test('selected court preview caption names the unit and the schedule summary avoids duplicate sport text', () => {
    const paintStart = dashboard.indexOf('function paintBookPreview(court, unitIndexOverride) {');
    const paintEnd = dashboard.indexOf('\n    // Looks up bookingState.court', paintStart);
    const wizardStart = dashboard.indexOf('function renderBookWizard() {');
    const wizardEnd = dashboard.indexOf('\n    function goToBookStep', wizardStart);
    assert(paintStart >= 0 && paintEnd > paintStart);
    assert(wizardStart >= 0 && wizardEnd > wizardStart);

    const previewCaption = { textContent: '' };
    const scheduleSummary = { textContent: '' };
    const nextButton = { disabled: true };
    const paymentButton = { disabled: true };
    const court = { id: 'listing-1', name: 'Badminton', sportName: 'Badminton', rateUnit: '/hr' };
    const bookingState = { court: 'Badminton', sport: 'Badminton', unit: 'Court 6', unitId: 'unit-6', date: '2099-10-26' };
    const context = {
        bookingState,
        bookSelectedUnitIndex: 0,
        bookUnitPreview: { hidden: false },
        bookUnitPreviewMedia: { innerHTML: '', querySelector: () => null },
        bookUnitPreviewCaption: previewCaption,
        bookUnitWrap: { hidden: false },
        bookUnitLabel: { textContent: '' },
        bookUnitSelect: { innerHTML: '', disabled: false },
        courtPhotoMarkup: () => '<img data-dash-book-photo>',
        window: {
            escapeHtml: (value) => String(value),
            InigoCourtsData: {
                resolveCourtUnits: () => ({ pickerLabel: 'Choose a court', units: [{ id: 'unit-6', label: 'Court 6', imageUrl: '/court-6.jpg', rateDay: 350, rateNight: 350, rateUnit: '/hr' }] }),
                monogramFor: () => 'B',
            },
        },
        bookStepPanels: [],
        bookWizardStep: 3,
        bookingCart: [],
        bookingCartSaving: false,
        findBookCourt: () => court,
        formatDate: () => 'Oct 26, 2099',
        document: {
            querySelectorAll: () => [],
            querySelector(selector) {
                if (selector === '[data-dash-book-schedule-summary]') return scheduleSummary;
                if (selector === '[data-dash-book-next="3"]') return nextButton;
                if (selector === '[data-dash-book-payment-next]') return paymentButton;
                return null;
            },
        },
    };
    runInNewContext(`${dashboard.slice(paintStart, paintEnd)}\n${dashboard.slice(wizardStart, wizardEnd)}\nglobalThis.paint = paintBookPreview; globalThis.render = renderBookWizard;`, context);
    context.paint(court, 0);
    assert.match(previewCaption.textContent, /Badminton · Court 6/);
    context.render();
    assert.equal(scheduleSummary.textContent, 'Badminton · Court 6 · Oct 26, 2099');
});

test('Step 4 keeps add-booking in the card header and exposes edit controls with an accurate breakdown', () => {
    const step4 = html.slice(html.indexOf('data-dash-book-step="4"'), html.indexOf('data-dash-book-step="5"'));
    assert.match(step4, /dash-book-cart-head[^]*data-dash-book-new>Add another sport or court/);
    assert.doesNotMatch(step4.slice(step4.indexOf('dash-book-flow-actions')), /data-dash-book-new/);
    assert.match(dashboard, /data-dash-book-cart-edit/);
    assert.match(dashboard, /bookingItemRateBreakdown\(item\)/);
    assert.match(dashboard, /bookingCart\[index\] = additions\[0\]/, 'an edit replaces the selected item in place');
    assert.match(dashboard, /bookingCart\.filter\(\(item\) => item\.key !== editingBookingCartKey\)/, 'overlap checks exclude only the item being edited');
    assert.match(dashboard, /getCourts\(\{ force: true \}\)/, 'current court rates are loaded before save and checkout');
    assert.match(dashboard, /Live availability could not be verified/);
    assert.match(dashboard, /window\.sb\.functions\.invoke\('paymongo-checkout'/, 'the server checkout remains authoritative');
});

test('cart quotes use the configured day and night rates and identify their real components', () => {
    const quoteStart = dashboard.indexOf('function quoteCartItem(item) {');
    const quoteEnd = dashboard.indexOf('\n    function applyCurrentUnitPricing', quoteStart);
    const breakdownStart = dashboard.indexOf('function bookingItemRateBreakdown(item) {');
    const breakdownEnd = quoteStart;
    const context = {};
    runInNewContext(`${dashboard.slice(quoteStart, quoteEnd)}\n${dashboard.slice(breakdownStart, breakdownEnd)}\nglobalThis.quote = quoteCartItem; globalThis.breakdown = bookingItemRateBreakdown;`, context);
    const mixed = { startHour: 19, endHour: 21, rateDay: 200, rateNight: 300, rateUnit: '/hr', nightRateStartsAt: '20:00' };
    assert.equal(context.quote(mixed), 800);
    assert.equal(context.breakdown({ ...mixed, hours: 3, estimatedTotal: 800 }), '1h day × ₱200.00/hr + 2h night × ₱300.00/hr');
    assert.equal(context.quote({ startHour: 10, endHour: 11, rateDay: 150, rateNight: null, rateUnit: '/set' }), 300);
});
