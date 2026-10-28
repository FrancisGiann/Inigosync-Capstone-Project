import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

class Element {
    constructor() { this.listeners = new Map(); this.dataset = {}; this.value = ''; this.innerHTML = ''; this.textContent = ''; this.disabled = false; this.hidden = false; }
    addEventListener(type, callback) { const list = this.listeners.get(type) || []; list.push(callback); this.listeners.set(type, list); }
    setAttribute(name, value) { this[name] = value; }
    async dispatch(type, event = {}) { await Promise.all((this.listeners.get(type) || []).map((callback) => callback(event))); }
    replaceChildren() { this.innerHTML = ''; }
    querySelectorAll() { return []; }
    focus() { this.focused = true; }
}

function makeGuestPage(initialDraft = null, pricing = {}) {
    const fields = {
        '[data-landing-book-date]': Object.assign(new Element(), { value: '2099-01-01' }),
        '[data-landing-book-status]': new Element(),
        '[data-landing-book-slots]': Object.assign(new Element(), {
            querySelectorAll() { return [8, 9, 10, 11].map((hour) => ({ disabled: false, dataset: { landingSlot: String(hour) } })); },
        }),
        '[data-landing-book-continue]': new Element(),
        '[data-landing-book-back]': new Element(),
        '[data-landing-booking-dialog]': new Element(),
        '[data-landing-booking-selected-court]': new Element(),
        '[data-booking-summary-court]': new Element(),
        '[data-booking-summary-date]': new Element(),
        '[data-booking-summary-time]': new Element(),
        '[data-booking-summary-total]': new Element(),
    };
    const root = {
        hidden: true,
        classList: { add() {}, remove() {} },
        querySelector: (selector) => fields[selector] || null,
        querySelectorAll: () => [new Element(), new Element()],
    };
    const viewer = new Element();
    const listeners = new Map();
    const dispatchedEvents = [];
    const authButton = Object.assign(new Element(), { clicks: 0, click() { this.clicks += 1; } });
    const document = {
        activeElement: null,
        body: { classList: { add() {}, remove() {} } },
        querySelector: (selector) => selector === '[data-court-viewer]' ? viewer
            : selector === '[data-landing-booking-modal]' ? root
                : selector === '[data-auth-open="login"]' ? authButton : null,
        querySelectorAll: () => [],
        addEventListener(type, callback) { const list = listeners.get(type) || []; list.push(callback); listeners.set(type, list); },
        dispatchEvent(event) { dispatchedEvents.push(event); for (const callback of listeners.get(event.type) || []) callback(event); },
    };
    const stored = new Map(initialDraft ? [['inigosync:landing-booking-draft:v1', initialDraft]] : []);
    const sessionStorage = {
        setItem(key, value) { stored.set(key, value); },
        getItem(key) { return stored.get(key) || null; },
        removeItem(key) { stored.delete(key); },
    };
    const court = { id: 'listing-1', slug: 'basketball', name: 'Basketball', sportName: 'Basketball', rate: pricing.listingRate ?? null, rateUnit: '/hr' };
    let rpcCalls = 0;
    const window = {
        sb: { rpc() { rpcCalls += 1; throw new Error('anonymous RPC should not be called'); }, from() { throw new Error('guest drafts must not write to tables'); }, functions: { invoke() { throw new Error('guest drafts must not invoke checkout'); } } },
        escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'),
        InigoBusinessHours: {
            OPEN_HOUR: 8, CLOSE_HOUR: 12, dateInManila: () => '2099-01-01',
            hoursRange: () => [8, 9, 10, 11], formatHourRangeLabelShort: (hour) => `${hour}-${hour + 1}`,
        },
        InigoBookingSlots: {
            localDateHourToIso: (date, hour) => `${date}T${String(hour).padStart(2, '0')}:00:00.000Z`,
            groupConsecutiveHours(hours) {
                const sorted = [...new Set(hours)].sort((a, b) => a - b);
                const groups = [];
                for (const hour of sorted) {
                    const current = groups.at(-1);
                    if (current && current.endHourExclusive === hour) { current.endHourExclusive += 1; current.hours.push(hour); }
                    else groups.push({ startHour: hour, endHourExclusive: hour + 1, hours: [hour] });
                }
                return groups;
            },
        },
        InigoCourtsData: {
            getCourts: async () => [court],
            resolveCourtUnits: () => ({ units: [{ id: 'unit-1', label: 'Court 1', resourceIds: ['resource-1'],
                rateDay: pricing.rateDay ?? null, rateNight: pricing.rateNight ?? null, rateUnit: pricing.rateUnit || '/hr' }] }),
        },
    };
    runInNewContext(readFileSync(new URL('../includes/landing-booking.js', import.meta.url), 'utf8'), {
        window, document, sessionStorage,
        CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
        Date, Set, Map, console,
    });
    const startBooking = () => {
        root.hidden = false; // The shared viewer/dialog opens before it publishes its chosen court.
        document.dispatchEvent({ type: 'inigo:landing-court-selection', detail: {
            court, listing: court, unit: { id: 'unit-1', label: 'Court 1', resourceIds: ['resource-1'] }, unitIndex: 0,
        } });
    };
    const selectHour = async (hour) => {
        const slot = { disabled: false, dataset: { landingSlot: String(hour) } };
        await fields['[data-landing-book-slots]'].dispatch('click', { target: { closest: () => slot } });
    };
    return { fields, root, document, dispatchedEvents, sessionStorage, stored, authButton, court, startBooking, selectHour, getRpcCalls: () => rpcCalls };
}

function makeDashboardImporter({ payload, occupied = false }) {
    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
    const start = dashboard.indexOf('async function importLandingDraftCart() {');
    const end = dashboard.indexOf("\n    document.addEventListener('inigosync:profile-ready'", start);
    assert(start >= 0 && end > start, 'dashboard importer function is present');
    const importerSource = dashboard.slice(start, end).trim();
    const storage = new Map([['inigosync:landing-booking-draft:v1', JSON.stringify(payload)]]);
    const messages = [];
    const source = `
        const court = { id: 'court-1', slug: 'basketball', name: 'Basketball', sportName: 'Basketball', rate: 500, rateUnit: '/hr' };
        let landingDraftProfileReady = true, landingDraftCourtDataReady = true, landingDraftSettingsReady = true, landingDraftImportInFlight = false;
        let bookCourtsCache = [court];
        let bookingCart = [];
        let bookingState = { sportSlug: '', selectedHours: [], startHour: null, endHour: null };
        let bookingRules = null, slotGridBookings = { ok: true }, slotGridWalkins = { ok: true };
        let activePanel = null;
        const bookSelect = { value: '', disabled: true, innerHTML: '', dispatchEvent() {} };
        const bookCourtChoice = { hidden: true }, bookDate = { value: '', dispatchEvent() {} }, bookUnitSelect = { value: '' };
        const sessionStorage = { getItem: key => storage.get(key) || null, removeItem: key => storage.delete(key) };
        const window = {
            InigoCourtsData: { resolveCourtUnits: () => ({ units: [{ id: 'unit-1', label: 'Court 1' }] }), rateHint: () => '₱500 /hr' },
            InigoBookingSlots: { groupConsecutiveHours(hours) {
                const sorted = [...new Set(hours)].sort((a, b) => a - b), ranges = [];
                for (const hour of sorted) {
                    const last = ranges.at(-1);
                    if (last && last.endHourExclusive === hour) last.endHourExclusive += 1;
                    else ranges.push({ startHour: hour, endHourExclusive: hour + 1 });
                }
                return ranges;
            } },
            escapeHtml: value => String(value),
            InigoToast: { show: (message, error) => messages.push({ message, error: Boolean(error) }) },
        };
        const document = {};
        const Event = class {};
        const renderSportChoices = () => {};
        const bookSportChoiceKey = () => 'basketball';
        const isBowlingVariant = () => false;
        const todayDateInputValue = () => '2099-01-01';
        const paintBookPreview = () => {};
        const refreshTimePickers = async () => {
            bookingRules = { authoritative: true };
            if (${occupied}) bookingState.selectedHours = [];
        };
        const selectedBookingCartItem = (startHour, endHourExclusive) => ({ court: 'Basketball', unit: 'Court 1', date: bookDate.value, startHour, endHourExclusive });
        const bookingCartItemsConflict = () => false;
        const renderTimePickers = () => {};
        const updateSummary = () => {};
        const renderBookingCart = () => {};
        const setActivePanel = value => { activePanel = value; };
        ${importerSource}
        globalThis.runImporter = importLandingDraftCart;
        globalThis.readState = () => ({ bookingCart, bookingState, activePanel, messages, storedDraft: sessionStorage.getItem('inigosync:landing-booking-draft:v1') });
    `;
    const context = { storage, messages, console, Date, Set, Map, Number, JSON };
    runInNewContext(source, context);
    return { run: () => context.runImporter(), readState: () => context.readState() };
}

function applyActualAuthRoleCleanup(role, draftPresent = true) {
    const guard = readFileSync(new URL('../includes/authGuard.js', import.meta.url), 'utf8');
    const start = guard.indexOf("    if (profile.role !== 'customer') {");
    const end = guard.indexOf('\n    }', start) + '\n    }'.length;
    assert(start >= 0 && end > start, 'auth guard role cleanup block is present');
    const block = guard.slice(start, end);
    const storage = new Map(draftPresent ? [['inigosync:landing-booking-draft:v1', 'staged-booking']] : []);
    runInNewContext(block, {
        profile: { role },
        sessionStorage: { removeItem: key => storage.delete(key) },
    });
    return storage.has('inigosync:landing-booking-draft:v1');
}

test('landing booking hands off exactly one court and one contiguous time range to customer sign-in', async () => {
    const page = makeGuestPage();
    await Promise.resolve();
    page.startBooking();
    assert.equal(page.root.hidden, false);
    assert.match(page.fields['[data-landing-book-status]'].textContent, /Provisional hours only/);

    await page.selectHour(8);
    await page.selectHour(10);
    assert.equal(page.fields['[data-landing-book-continue]'].disabled, false, 'a distant end hour fills the continuous range');
    assert.match(page.fields['[data-landing-book-status]'].textContent, /3 provisional hours/);
    await page.selectHour(9);
    assert.match(page.fields['[data-booking-summary-time]'].textContent, /8-9/, 'clicking within the range trims it from that hour onward');
    await page.selectHour(10);
    await page.fields['[data-landing-book-continue]'].dispatch('click');

    assert.equal(page.root.hidden, true, 'continuing closes the date and time dialog');
    assert.equal(page.authButton.clicks, 1, 'login/signup is opened before checkout');
    assert(page.dispatchedEvents.some((event) => event.type === 'inigo:landing-booking-auth'));
    const payload = JSON.parse(page.sessionStorage.getItem('inigosync:landing-booking-draft:v1'));
    assert.equal(payload.version, 1);
    assert.equal(payload.items.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(payload.items[0])), {
        listingSlug: 'basketball', court: 'Basketball', sport: 'Basketball', unit: 'Court 1',
        unitId: 'unit-1', resourceIds: ['resource-1'], date: '2099-01-01', hours: [8, 9, 10], rate: null, rateUnit: '/hr',
    });
    assert.equal(page.getRpcCalls(), 0, 'guest selection uses tab storage and does not call a database API');
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    assert.match(html, /data-landing-book-continue disabled>Login \/ Sign up to continue/);
    assert.doesNotMatch(html, /Add to Cart|Draft booking cart|data-landing-draft-cart/);
});

test('booking summary avoids an estimate when selected unit day and night rates differ', async () => {
    const page = makeGuestPage(null, { listingRate: 500, rateDay: 800, rateNight: 1200, rateUnit: '/hr' });
    await Promise.resolve();
    page.startBooking();
    await page.selectHour(8);
    await page.selectHour(9);
    assert.equal(page.fields['[data-booking-summary-total]'].textContent, 'Confirmed after sign in',
        'unit schedule pricing takes precedence over a potentially misleading listing rate');
});

test('multi-item and expired legacy landing drafts are discarded', async () => {
    const item = { listingSlug: 'basketball', court: 'Basketball', sport: 'Basketball', unit: 'Court 1', unitId: 'unit-1', date: '2099-01-01', hours: [8] };
    const multi = makeGuestPage(JSON.stringify({ version: 1, createdAt: Date.now(), items: [item, item] }));
    assert.equal(multi.sessionStorage.getItem('inigosync:landing-booking-draft:v1'), null);
    const stale = makeGuestPage(JSON.stringify({ version: 1, createdAt: Date.now() - 25 * 60 * 60 * 1000, items: [item] }));
    assert.equal(stale.sessionStorage.getItem('inigosync:landing-booking-draft:v1'), null);
    await Promise.resolve();
});

test('dashboard import accepts one available customer booking and rejects occupied or multi-item drafts', async () => {
    const single = { version: 1, createdAt: Date.now(), items: [{
        listingSlug: 'basketball', court: 'Basketball', sport: 'Basketball', unit: 'Court 1',
        unitId: 'unit-1', date: '2099-01-01', hours: [8, 9],
    }] };
    const accepted = makeDashboardImporter({ payload: single });
    await accepted.run();
    const acceptedState = accepted.readState();
    assert.equal(acceptedState.bookingCart.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(acceptedState.bookingCart[0])), {
        court: 'Basketball', unit: 'Court 1', date: '2099-01-01', startHour: 8, endHourExclusive: 10,
    });
    assert.equal(acceptedState.activePanel, 'booking');
    assert.equal(acceptedState.storedDraft, null);
    assert.equal(acceptedState.messages.at(-1).error, false);

    const occupied = makeDashboardImporter({ payload: single, occupied: true });
    await occupied.run();
    const occupiedState = occupied.readState();
    assert.equal(occupiedState.bookingCart.length, 0, 'an occupied range never enters the customer booking list');
    assert.equal(occupiedState.storedDraft, null, 'the rejected handoff is discarded');
    assert.match(occupiedState.messages.at(-1).message, /Availability changed/);
    assert.equal(occupiedState.messages.at(-1).error, true);

    const multi = makeDashboardImporter({ payload: { ...single, items: [...single.items, single.items[0]] } });
    await multi.run();
    const multiState = multi.readState();
    assert.equal(multiState.bookingCart.length, 0);
    assert.equal(multiState.storedDraft, null, 'legacy multi-item handoff is rejected and removed');
    assert.equal(multiState.messages.at(-1).error, true);
});

test('auth guard preserves customer handoffs and discards them for staff and admin roles', () => {
    assert.equal(applyActualAuthRoleCleanup('customer'), true, 'customer handoff remains available for customer import');
    assert.equal(applyActualAuthRoleCleanup('staff'), false, 'staff handoff is removed');
    assert.equal(applyActualAuthRoleCleanup('admin'), false, 'admin handoff is removed');
});
