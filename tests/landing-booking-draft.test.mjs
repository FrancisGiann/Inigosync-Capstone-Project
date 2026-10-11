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
    focus() { this.focused = true; }
}

class Select extends Element {
    set innerHTML(value) {
        this._html = value;
        this.value = value.match(/<option value="([^"]*)"/)?.[1] || '';
    }
    get innerHTML() { return this._html || ''; }
}

function makeGuestPage(initialDraft = null) {
    const fields = {
        '[data-landing-book-date]': Object.assign(new Element(), { value: '2099-01-01' }),
        '[data-landing-book-status]': new Element(),
        '[data-landing-book-slots]': new Element(),
        '[data-landing-book-add]': new Element(),
        '[data-landing-draft-cart]': new Element(),
        '[data-landing-draft-toggle]': new Element(),
        '[data-landing-draft-content]': new Element(),
        '[data-landing-draft-items]': new Element(),
        '[data-landing-draft-status]': new Element(),
        '[data-landing-draft-count]': new Element(),
        '[data-landing-draft-total]': new Element(),
        '[data-landing-draft-preview]': new Element(),
        '[data-landing-draft-details-count]': new Element(),
        '[data-landing-draft-details-total]': new Element(),
        '[data-landing-draft-continue]': new Element(),
        '[data-landing-draft-details-continue]': new Element(),
        '[data-landing-draft-details]': new Element(),
        '[data-landing-draft-clear]': new Element(),
        '[data-landing-book-back]': new Element(),
        '[data-landing-booking-dialog]': new Element(),
        '[data-landing-booking-selected-court]': new Element(),
        '[data-landing-booking-details]': new Element(),
    };
    const detailDialog = new Element();
    const cartArrow = new Element();
    fields['[data-landing-draft-toggle]'].querySelector = (selector) => selector === '[aria-hidden="true"]' ? cartArrow : null;
    const detailsFocusables = [new Element(), new Element()];
    const detailsModal = Object.assign(new Element(), { querySelector: (selector) => selector === '[role="dialog"]' ? detailDialog : null, querySelectorAll: () => [] });
    detailDialog.querySelectorAll = () => detailsFocusables;
    fields['[data-landing-draft-details-modal]'] = detailsModal;
    const detailCloseButtons = [new Element(), new Element()];
    const detailsCloseButtons = [new Element(), new Element()];
    const root = {
        hidden: true,
        classList: { add() {}, remove() {} },
        querySelector: (selector) => fields[selector] || null,
        querySelectorAll: (selector) => selector === '[data-landing-booking-close]' ? [new Element(), new Element()] : [],
    };
    const viewer = { hidden: true };
    const listeners = new Map();
    const dispatchedEvents = [];
    let authOverlayOpen = false;
    let courtViewerOpen = false;
    const authButton = Object.assign(new Element(), { clicks: 0, click() { this.clicks += 1; } });
    const globalFields = new Set([
        '[data-landing-draft-cart]', '[data-landing-draft-toggle]', '[data-landing-draft-content]', '[data-landing-draft-items]', '[data-landing-draft-status]', '[data-landing-draft-count]',
        '[data-landing-draft-total]', '[data-landing-draft-preview]', '[data-landing-draft-details-count]',
        '[data-landing-draft-details-total]', '[data-landing-draft-continue]', '[data-landing-draft-details-continue]',
        '[data-landing-draft-details]', '[data-landing-draft-clear]', '[data-landing-draft-details-modal]',
    ]);
    const document = {
        activeElement: null,
        body: { classList: { add() {}, remove() {} } },
        querySelector: (selector) => selector === '[data-court-viewer]' ? viewer
            : selector === '[data-landing-booking-modal]' ? root
            : globalFields.has(selector) ? fields[selector]
            : selector === '[data-auth-open="login"]' ? authButton
                : selector === '[data-auth-overlay][data-open]' && authOverlayOpen ? {} : null,
        querySelectorAll: (selector) => selector === '[data-landing-draft-details-close]' ? detailsCloseButtons : [],
        addEventListener(type, callback) { const list = listeners.get(type) || []; list.push(callback); listeners.set(type, list); },
        dispatchEvent(event) { dispatchedEvents.push(event); for (const callback of listeners.get(event.type) || []) callback(event); },
    };
    const stored = new Map(initialDraft ? [['inigosync:landing-booking-draft:v1', initialDraft]] : []);
    const sessionStorage = {
        setItem(key, value) { stored.set(key, value); },
        getItem(key) { return stored.get(key) || null; },
        removeItem(key) { stored.delete(key); },
    };
    const court = { id: 'listing-1', slug: 'basketball', name: 'Basketball', sportName: 'Basketball', rate: null, rateUnit: '/hr' };
    let rpcCalls = 0;
    const window = {
        sb: { rpc() { rpcCalls += 1; throw new Error('anonymous RPC should not be called'); }, from() { throw new Error('guest drafts must not write to tables'); }, functions: { invoke() { throw new Error('guest drafts must not invoke checkout'); } } },
        escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'),
        InigoBusinessHours: {
            OPEN_HOUR: 8,
            CLOSE_HOUR: 10,
            dateInManila: () => '2099-01-01',
            hoursRange: () => [8, 9],
            formatHourRangeLabelShort: (hour) => `${hour}-${hour + 1}`,
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
            resolveCourtUnits: () => ({ units: [{ id: 'unit-1', label: 'Court 1', resourceIds: ['resource-1'] }] }),
        },
    };
    runInNewContext(readFileSync(new URL('../includes/landing-booking.js', import.meta.url), 'utf8'), {
        window, document, sessionStorage,
        CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
        Date,
        Set,
        Map,
        console,
    });
    // Register the viewer key handler after landing-booking.js, matching the
    // page's script order. If Escape propagates after details closes, this
    // later handler would see the details modal hidden and close the viewer.
    document.addEventListener('keydown', (event) => {
        if (!courtViewerOpen || !detailsModal.hidden || authOverlayOpen) return;
        if (event.key === 'Escape') courtViewerOpen = false;
    });
    document.addEventListener('inigo:landing-booking-auth', () => { courtViewerOpen = false; });
    function dispatchKey(event) {
        event.immediatePropagationStopped = false;
        event.stopImmediatePropagation = () => { event.immediatePropagationStopped = true; };
        event.preventDefault ||= () => {};
        for (const callback of listeners.get('keydown') || []) {
            callback(event);
            if (event.immediatePropagationStopped) break;
        }
    }
    const startBooking = () => {
        document.dispatchEvent({ type: 'inigo:landing-court-open', detail: { court } });
        document.dispatchEvent({ type: 'inigo:landing-court-next', detail: { court, listing: court, unit: { id: 'unit-1', label: 'Court 1', resourceIds: ['resource-1'] }, unitIndex: 0 } });
    };
    return { fields, root, viewer, document, listeners, dispatchedEvents, sessionStorage, stored, authButton, court, detailsModal, detailDialog, detailsFocusables, dispatchKey, startBooking, setAuthOpen: (value) => { authOverlayOpen = value; }, setCourtViewerOpen: (value) => { courtViewerOpen = value; }, isCourtViewerOpen: () => courtViewerOpen, getRpcCalls: () => rpcCalls };
}

test('guest draft selection is provisional, locally conflict checked, and does not call Supabase', async () => {
    const page = makeGuestPage();
    await Promise.resolve();
    page.startBooking();
    page.setCourtViewerOpen(true);
    assert.equal(page.root.hidden, false, 'Next opens the separate date and time popup');

    assert.match(page.fields['[data-landing-book-status]'].textContent, /Provisional hours only/);
    assert.match(page.fields['[data-landing-book-slots]'].innerHTML, /data-landing-slot="8"/);
    assert.doesNotMatch(page.fields['[data-landing-book-slots]'].innerHTML, /Booked/);

    const slotButton = { disabled: false, dataset: { landingSlot: '8' } };
    await page.fields['[data-landing-book-slots]'].dispatch('click', { target: { closest: () => slotButton } });
    await page.fields['[data-landing-book-add]'].dispatch('click');
    assert.equal(page.root.hidden, true, 'Add to Cart closes the date and time popup');
    assert.equal(page.fields['[data-landing-draft-cart]'].hidden, false, 'the draft cart remains visible outside both popups');
    await page.fields['[data-landing-draft-toggle]'].dispatch('click');
    assert.equal(page.fields['[data-landing-draft-cart]'].dataset.collapsed, 'true');
    assert.equal(page.fields['[data-landing-draft-toggle]']['aria-expanded'], 'false');
    assert.equal(page.fields['[data-landing-draft-content]'].inert, true, 'hidden cart actions leave the keyboard order');
    await page.fields['[data-landing-draft-toggle]'].dispatch('click');
    assert.equal(page.fields['[data-landing-draft-cart]'].dataset.collapsed, 'false');
    assert.equal(page.fields['[data-landing-draft-toggle]']['aria-expanded'], 'true');
    assert.equal(page.fields['[data-landing-draft-content]'].inert, false);
    assert.match(page.fields['[data-landing-draft-items]'].innerHTML, /Basketball · Court 1/);
    assert.match(page.fields['[data-landing-draft-status]'].textContent, /Browser-only draft/);
    assert.match(page.fields['[data-landing-draft-count]'].textContent, /1 booking selected/);
    assert.equal(page.fields['[data-landing-draft-total]'].textContent, 'Rate TBA');
    assert.match(page.fields['[data-landing-draft-items]'].innerHTML, /Rate TBA/);
    assert.match(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /Login \/ Sign up to proceed payment/);
    const markup = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    assert.match(markup, /data-court-viewer[\s\S]*?data-landing-book-next[\s\S]*?data-landing-booking-modal/);
    assert.match(markup, /data-landing-booking-modal[\s\S]*?data-landing-draft-cart/);
    await page.fields['[data-landing-draft-details]'].dispatch('click', { currentTarget: page.fields['[data-landing-draft-details]'] });
    assert.equal(page.detailsModal.hidden, false, 'View details opens the cart review dialog');
    assert.equal(page.detailDialog.focused, true, 'opening the cart review moves focus into its dialog');
    page.document.activeElement = page.detailsFocusables[1];
    let tabPrevented = false;
    page.dispatchKey({ key: 'Tab', shiftKey: false, preventDefault() { tabPrevented = true; } });
    assert(tabPrevented, 'Tab wraps from the last cart dialog control to the first');
    assert.equal(page.detailsFocusables[0].focused, true);
    page.document.activeElement = page.detailsFocusables[0];
    tabPrevented = false;
    page.dispatchKey({ key: 'Tab', shiftKey: true, preventDefault() { tabPrevented = true; } });
    assert(tabPrevented, 'Shift+Tab wraps from the first cart dialog control to the last');
    assert.equal(page.detailsFocusables[1].focused, true);
    page.setAuthOpen(true);
    let escapePrevented = false;
    page.dispatchKey({ key: 'Escape', preventDefault() { escapePrevented = true; } });
    assert.equal(escapePrevented, false, 'the details dialog defers Escape while auth is the top modal');
    assert.equal(page.detailsModal.hidden, false);
    page.setAuthOpen(false);
    page.dispatchKey({ key: 'Escape' });
    assert.equal(page.detailsModal.hidden, true, 'Escape closes the cart review dialog');
    assert.equal(page.isCourtViewerOpen(), true, 'Escape does not propagate to the later court viewer handler');
    assert.equal(page.fields['[data-landing-book-add]'].disabled, true, 'an hour already in the local cart is no longer selectable');
    assert.match(page.fields['[data-landing-book-slots]'].innerHTML, /data-landing-slot="8"[^>]*disabled/);
    assert.match(page.fields['[data-landing-book-slots]'].innerHTML, /data-landing-slot="9" aria-pressed="false">/, 'a disjoint hour on the same unit remains selectable');
    assert.equal(page.getRpcCalls(), 0);
    assert.equal(page.stored.size, 1, 'the tab-scoped draft is persisted as soon as it is added');
    const ordinaryLoginPayload = JSON.parse(page.sessionStorage.getItem('inigosync:landing-booking-draft:v1'));
    assert.equal(ordinaryLoginPayload.items.length, 1, 'the header login path can transfer the draft without using Continue');
    page.authButton.click();
    assert.equal(page.sessionStorage.getItem('inigosync:landing-booking-draft:v1') !== null, true);

    await page.fields['[data-landing-draft-details]'].dispatch('click', { currentTarget: page.fields['[data-landing-draft-details]'] });
    await page.fields['[data-landing-draft-details-continue]'].dispatch('click');
    assert.equal(page.detailsModal.hidden, true, 'proceeding closes the cart details dialog');
    assert.equal(page.isCourtViewerOpen(), false, 'proceeding closes the court viewer before auth opens');
    assert(page.dispatchedEvents.some((event) => event.type === 'inigo:landing-booking-auth'), 'proceeding asks the court viewer to close before auth opens');
    const payload = JSON.parse(page.sessionStorage.getItem('inigosync:landing-booking-draft:v1'));
    assert.equal(payload.version, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(payload.items[0])), {
        listingSlug: 'basketball', court: 'Basketball', sport: 'Basketball', unit: 'Court 1',
        unitId: 'unit-1', resourceIds: ['resource-1'], date: '2099-01-01', hours: [8], rate: null, rateUnit: '/hr',
    });
    assert.equal(page.authButton.clicks, 2);
    assert.equal(page.getRpcCalls(), 0, 'guest draft handoff uses tab storage and does not call a database API');
});

test('removing or clearing a landing draft updates tab storage immediately', async () => {
    const page = makeGuestPage();
    await Promise.resolve();
    page.startBooking();
    const addHour = async (hour) => {
        const slotButton = { disabled: false, dataset: { landingSlot: String(hour) } };
        await page.fields['[data-landing-book-slots]'].dispatch('click', { target: { closest: () => slotButton } });
        await page.fields['[data-landing-book-add]'].dispatch('click');
    };

    await addHour(8);
    assert.ok(page.sessionStorage.getItem('inigosync:landing-booking-draft:v1'));
    const removeButton = { dataset: { landingDraftRemove: '0' } };
    await page.fields['[data-landing-draft-items]'].dispatch('click', { target: { closest: () => removeButton } });
    assert.equal(page.sessionStorage.getItem('inigosync:landing-booking-draft:v1'), null);

    await addHour(9);
    assert.ok(page.sessionStorage.getItem('inigosync:landing-booking-draft:v1'));
    await page.fields['[data-landing-draft-clear]'].dispatch('click');
    assert.equal(page.sessionStorage.getItem('inigosync:landing-booking-draft:v1'), null);
    assert.equal(page.fields['[data-landing-draft-cart]'].hidden, true);
});

test('a tab draft is restored after returning to the landing page', async () => {
    const firstPage = makeGuestPage();
    await Promise.resolve();
    firstPage.startBooking();
    const slotButton = { disabled: false, dataset: { landingSlot: '8' } };
    await firstPage.fields['[data-landing-book-slots]'].dispatch('click', { target: { closest: () => slotButton } });
    await firstPage.fields['[data-landing-book-add]'].dispatch('click');

    const reloadedPage = makeGuestPage(firstPage.sessionStorage.getItem('inigosync:landing-booking-draft:v1'));
    await Promise.resolve();
    reloadedPage.startBooking();
    assert.match(reloadedPage.fields['[data-landing-draft-items]'].innerHTML, /Basketball · Court 1/);
    assert.match(reloadedPage.fields['[data-landing-draft-status]'].textContent, /draft restored/i);
});

test('a restored tab draft older than 24 hours is discarded', () => {
    const stale = JSON.stringify({
        version: 1,
        createdAt: Date.now() - 25 * 60 * 60 * 1000,
        items: [{ listingSlug: 'basketball', court: 'Basketball', sport: 'Basketball', unit: 'Court 1', unitId: 'unit-1', resourceIds: ['resource-1'], date: '2099-01-01', hours: [8] }],
    });
    const page = makeGuestPage(stale);
    assert.equal(page.sessionStorage.getItem('inigosync:landing-booking-draft:v1'), null);
});

test('customer handoff rechecks authenticated occupancy and non-customer roles discard the staged draft', () => {
    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
    const guard = readFileSync(new URL('../includes/authGuard.js', import.meta.url), 'utf8');
    const auth = readFileSync(new URL('../includes/auth.js', import.meta.url), 'utf8');
    assert.match(dashboard, /landingDraftProfileReady = event\.detail\?\.role === 'customer'/);
    assert.match(dashboard, /await refreshTimePickers\(true\)/);
    assert.match(dashboard, /!slotGridBookings\.ok \|\| !slotGridWalkins\.ok/);
    assert.match(dashboard, /sessionStorage\.removeItem\('inigosync:landing-booking-draft:v1'\)/);
    assert.match(guard, /if \(profile\.role !== 'customer'\)[\s\S]*?sessionStorage\.removeItem\('inigosync:landing-booking-draft:v1'\)/);
    assert.match(auth, /customer:\s*'Pages\/user_dashboard\.html'/);
    assert.match(auth, /completeLogin\(\['customer'\], true\)/, 'signup proceeds through the same customer dashboard handoff');
    const landing = readFileSync(new URL('../includes/landingPage.js', import.meta.url), 'utf8');
    assert.match(landing, /inigo:landing-booking-back-to-court[\s\S]*?open\(court, bookingInvoker \|\| nextButton/,
        'returning from date selection preserves the original court-card focus target');
    assert.match(landing, /querySelector\('\[data-landing-draft-details-modal\]:not\(\[hidden\]\)'\)[\s\S]*?querySelector\('\[data-auth-overlay\]\[data-open\]'\)/,
        'the court viewer keyboard trap defers to the visible details and auth modals');
    assert.match(landing, /addEventListener\('inigo:landing-booking-auth', close\)/,
        'the booking handoff can close the viewer before auth opens');
    const landingBooking = readFileSync(new URL('../includes/landing-booking.js', import.meta.url), 'utf8');
    assert.match(landingBooking, /detailsModal\?\.hidden \|\| document\.querySelector\('\[data-auth-overlay\]\[data-open\]'\)/,
        'the details dialog key handler defers while the auth modal is open');
});
