import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const html = await readFile(new URL('../Pages/user_dashboard.html', import.meta.url), 'utf8');
const ownerHtml = await readFile(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../Style/Dashboard.css', import.meta.url), 'utf8');
const dashboard = (await readFile(new URL('../includes/Dashboard.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const ownerDashboard = await readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');
const upcomingSource = await readFile(new URL('../includes/dashboardUpcoming.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261004085347_customer_feedback.sql', import.meta.url), 'utf8');

const helperContext = { window: {} };
runInNewContext(upcomingSource, helperContext);
const upcoming = helperContext.window.InigoDashboardUpcoming;

test('upcoming preview returns only pending/confirmed future bookings, nearest first', () => {
    const now = Date.parse('2026-10-04T00:00:00Z');
    const rows = [
        { id: 'later', status: 'confirmed', time_date: '2026-10-06T10:00:00Z' },
        { id: 'cancelled', status: 'cancelled', time_date: '2026-10-04T10:00:00Z' },
        { id: 'past', status: 'confirmed', time_date: '2026-10-03T10:00:00Z' },
        { id: 'first', status: 'pending', time_date: '2026-10-04T01:00:00Z' },
        { id: 'complete', status: 'completed', time_date: '2026-10-04T02:00:00Z' },
        { id: 'invalid', status: 'confirmed', time_date: 'not-a-date' },
    ];
    assert.deepEqual(Array.from(upcoming.selectUpcomingReservations(rows, now), row => row.id), ['first', 'later']);
});

test('Show more reveals five at a time and stops at the result count', () => {
    assert.equal(upcoming.nextVisibleCount(5, 12, 5), 10);
    assert.equal(upcoming.nextVisibleCount(10, 12, 5), 12);
    assert.equal(upcoming.nextVisibleCount(5, 5, 5), 5);
});

test('customer bookings are loaded through an account-scoped query and retryable states are wired', () => {
    assert.match(dashboard, /\.from\('booking'\)[\s\S]*?\.eq\('customer_id',\s*window\.inigosyncProfile\.id\)/);
    assert.match(dashboard, /data-dash-upcoming-retry/);
    assert.match(dashboard, /renderUpcomingReservations\(null, true\)/);
    assert.match(html, /data-dash-upcoming-list[\s\S]*?Loading your reservations/);
    assert.match(html, /data-dash-upcoming-more[^>]*>Show more<\/button>/);
});

test('feedback schema remains private while owner reviews use the public booking-review projection', () => {
    assert.match(migration, /alter table public\.feedback enable row level security/i);
    assert.match(migration, /profile_id\s*=\s*\(select auth\.uid\(\)\)[\s\S]*?internal\.is_active_customer\(\(select auth\.uid\(\)\)\)/i);
    assert.match(migration, /feedback_customer_select_own[\s\S]*?using\s*\(profile_id\s*=\s*\(select auth\.uid\(\)\)\)/i);
    assert.match(migration, /feedback_staff_select_all[\s\S]*?public\.inigosync_is_staff_or_admin\(\)/i);
    assert.match(migration, /revoke all on public\.feedback from public, anon/i);
    assert.doesNotMatch(ownerDashboard, /\.from\('feedback'\)/);
    assert.match(dashboard, /\.from\('feedback'\)\.insert\([\s\S]*?profile_id:\s*window\.inigosyncProfile\.id/);
    assert.match(dashboard, /finally\s*\{\s*feedbackSubmitBtn\.disabled = false/);
});

class InteractionElement {
    constructor(value = '') {
        this.value = value;
        this.textContent = '';
        this.hidden = true;
        this.disabled = false;
        this.listeners = new Map();
        this.children = new Map();
    }
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    querySelector(selector) { return this.children.get(selector) || null; }
    querySelectorAll() { return []; }
    setAttribute() {}
    removeAttribute() {}
    focus() {}
    async dispatch(type, event = {}) {
        const dispatchEvent = { target: this, currentTarget: this, ...event };
        for (const listener of this.listeners.get(type) || []) await listener(dispatchEvent);
        return dispatchEvent;
    }
}

function extractBetween(source, start, end) {
    const startIndex = source.indexOf(start);
    assert.notEqual(startIndex, -1, `source start marker exists: ${start}`);
    const endIndex = source.indexOf(end, startIndex);
    assert.notEqual(endIndex, -1, `source end marker exists: ${end}`);
    return source.slice(startIndex, endIndex);
}

const feedbackEscapeHandler = extractBetween(
    dashboard,
    "    document.addEventListener('keydown', (e) => {\n        if (e.key === 'Escape' && feedbackIsOpen",
    '\n    if (feedbackSubmitBtn) {'
);
const feedbackSubmitHandler = extractBetween(
    dashboard,
    '    if (feedbackSubmitBtn) {',
    '\n    // ------------------------------------------------------------------\n\n    // Theme toggle'
);
const bookingReviewHandlers = extractBetween(
    dashboard,
    '    let bookingReviewClosePending = false;',
    '    // Receipts list only saved payment acknowledgments.'
);
const settingsConfirmationHandlers = extractBetween(
    dashboard,
    '    function closeSettingsConfirm(accepted) {',
    '    // A photo remains a local draft until the user presses Save and confirms.'
);

function makeConfirmationEscapeHarness(flow) {
    const confirmCancel = new InteractionElement();
    const confirmAccept = new InteractionElement();
    const confirmModal = new InteractionElement();
    const confirmDialog = new InteractionElement();
    const confirmText = new InteractionElement();
    confirmModal.children.set('[data-dash-confirm-cancel]', confirmCancel);
    confirmModal.children.set('[data-dash-confirm-accept]', confirmAccept);
    confirmModal.children.set('[data-dash-confirm-dialog]', confirmDialog);
    confirmDialog.children.set('[data-dash-confirm-cancel]', confirmCancel);
    confirmDialog.children.set('[data-dash-confirm-accept]', confirmAccept);
    const feedbackSubmitBtn = new InteractionElement();
    feedbackSubmitBtn.textContent = 'Send feedback';
    const feedbackMessageEl = new InteractionElement('My feedback draft');
    const feedbackOverlay = new InteractionElement();
    feedbackOverlay.hidden = false;
    const bookingReviewModal = new InteractionElement();
    bookingReviewModal.hidden = false;
    const reviewSubmitBtn = new InteractionElement();
    const reviewComment = new InteractionElement('My review draft');
    const reviewRating = new InteractionElement('5');
    const documentKeydownHandlers = [];
    const elements = new Map([
        ['[data-dash-confirm-modal]', confirmModal],
        ['#dashSettingsConfirmText', confirmText],
        ['[data-booking-review-submit]', reviewSubmitBtn],
        ['[data-booking-review-comment]', reviewComment],
        ['[data-booking-review-rating]', reviewRating],
    ]);
    const writes = [];
    const document = {
        addEventListener(type, listener) { if (type === 'keydown') documentKeydownHandlers.push(listener); },
        querySelector(selector) { return elements.get(selector) || null; },
        querySelectorAll() { return []; },
        contains() { return true; },
    };
    const context = {
        document,
        window: {
            sb: { from(table) { return { insert: async payload => { writes.push({ table, payload }); return { error: null }; } }; } },
            inigosyncProfile: { id: 'customer-1' },
            InigoToast: { show() {} },
            clearTimeout() {},
            setTimeout() { return 1; },
        },
        console,
        confirmModal,
        confirmDialog,
        confirmText,
        pendingConfirm: null,
        confirmReturnFocus: null,
        feedbackSubmitBtn,
        feedbackMessageEl,
        feedbackOverlay,
        feedbackDialog: new InteractionElement(),
        feedbackIsOpen: true,
        feedbackClosePending: false,
        feedbackSubmitPending: false,
        feedbackHideTimer: null,
        feedbackLastFocused: null,
        feedbackRating: null,
        FEEDBACK_CLOSE_DELAY_MS: 0,
        paintFeedbackStars() {},
        bookingReviewModal,
        bookingReviewSubmitPending: false,
        bookingReviewClosePending: false,
        activeReviewBookingId: 77,
    };
    runInNewContext(`${flow === 'feedback' ? feedbackEscapeHandler + feedbackSubmitHandler : bookingReviewHandlers}\n${settingsConfirmationHandlers}`, context);

    async function pressEscapeOnConfirmation() {
        const event = {
            key: 'Escape',
            defaultPrevented: false,
            propagationStopped: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.propagationStopped = true; },
        };
        for (const listener of confirmModal.listeners.get('keydown') || []) await listener(event);
        if (!event.propagationStopped) {
            for (const listener of documentKeydownHandlers) await listener(event);
        }
        return event;
    }

    return { confirmModal, confirmText, feedbackSubmitBtn, feedbackMessageEl, bookingReviewModal, reviewSubmitBtn, reviewComment, writes, pressEscapeOnConfirmation };
}

test('Escape declining feedback Save does not open a discard prompt or close the draft', async () => {
    const harness = makeConfirmationEscapeHarness('feedback');
    const submit = harness.feedbackSubmitBtn.dispatch('click');
    await Promise.resolve();
    assert.equal(harness.confirmText.textContent, 'Submit this feedback?');
    const escapeEvent = await harness.pressEscapeOnConfirmation();
    assert.equal(escapeEvent.propagationStopped, true, 'the active confirmation consumes Escape before it can reach editor handlers');
    await submit;
    assert.equal(harness.confirmModal.hidden, true, 'Escape dismisses the Save confirmation');
    assert.equal(harness.confirmText.textContent, 'Submit this feedback?', 'Escape does not replace it with a discard prompt');
    assert.equal(harness.feedbackMessageEl.value, 'My feedback draft', 'declining Save retains the draft');
    assert.equal(harness.writes.length, 0, 'declining Save does not persist feedback');
});

test('Escape declining booking-review Save does not open a discard prompt or close the draft', async () => {
    const harness = makeConfirmationEscapeHarness('booking-review');
    const submit = harness.reviewSubmitBtn.dispatch('click');
    await Promise.resolve();
    assert.equal(harness.confirmText.textContent, 'Publish this booking review?');
    const escapeEvent = await harness.pressEscapeOnConfirmation();
    assert.equal(escapeEvent.propagationStopped, true, 'the active confirmation consumes Escape before it can reach editor handlers');
    await submit;
    assert.equal(harness.confirmModal.hidden, true, 'Escape dismisses the Save confirmation');
    assert.equal(harness.confirmText.textContent, 'Publish this booking review?', 'Escape does not replace it with a discard prompt');
    assert.equal(harness.bookingReviewModal.hidden, false, 'declining Save keeps the editor open');
    assert.equal(harness.reviewComment.value, 'My review draft', 'declining Save retains the draft');
    assert.equal(harness.writes.length, 0, 'declining Save does not persist the review');
});

test('dashboard presentation controls remain scoped and remove obsolete overview/search actions', () => {
    assert.match(css, /\.dash-hero-image\s*\{[^}]*height:\s*185px;[^}]*object-fit:\s*contain/s);
    assert.match(css, /\.dash-hero-image\s*\{[^}]*width:\s*100%;[^}]*height:\s*185px;[^}]*object-fit:\s*contain/s);
    assert.match(css, /\.dash-hero-scrim\s*\{[^}]*height:\s*163px;[^}]*overflow:\s*hidden/s);
    assert.match(css, /\.dash-hero-title\s*\{[^}]*-webkit-line-clamp:\s*2/s);
    assert.match(css, /\.dash-hero-title\s*\{[^}]*line-height:\s*1\.2;[^}]*min-height:\s*2\.4em/s);
    assert.match(css, /\.dash-hero\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;/s);
    assert.match(css, /\.dash-hero\s*\{[^}]*margin-inline:\s*0;/s, 'featured carousel aligns to the same full-width content row as availability and reservations');
    assert.match(html, /dash-overview-lower[\s\S]*?data-dash-availability[\s\S]*?data-dash-upcoming-list/);
    assert.match(html, /<dialog[^>]*data-dash-availability-dialog[^>]*aria-labelledby=/);
    const availabilityDialog = html.match(/<dialog[^>]*data-dash-availability-dialog[\s\S]*?<\/dialog>/)?.[0] || '';
    assert.doesNotMatch(availabilityDialog, /Court listing|data-dash-availability-court/);
    assert.match(html, /dash-availability-card[\s\S]*?dash-card-head[\s\S]*?data-dash-availability-date/);
    assert.match(html, /data-dash-availability-photo/);
    assert.match(html, /data-dash-availability-unit/);
    assert.match(html, /data-dash-availability-selected-date/);
    assert.match(html, /data-dash-availability-change-date[^>]*aria-label="Change availability date">Change date/);
    assert.doesNotMatch(html.match(/<dialog[^>]*data-dash-availability-dialog[\s\S]*?<\/dialog>/)?.[0] || '', /data-dash-availability-date/);
    assert.match(html, /data-dash-availability-slots[^>]*role="list"/);
    assert.match(css, /\.dash-availability-dialog\s*\{[^}]*position:\s*fixed;[^}]*top:\s*50%;[^}]*left:\s*50%;[^}]*transform:\s*translate\(-50%,\s*-50%\);[^}]*overflow:\s*auto/s);
    assert.match(css, /\.dash-availability-dialog-head\s*\{[^}]*position:\s*sticky;[^}]*top:\s*-26px/);
    assert.match(css, /\.dash-availability-dialog-head\s*\{[^}]*background:\s*var\(--color-bg-card\)/);
    assert.match(css, /\.dash-hero\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*box-sizing:\s*border-box/s);
    assert.match(css, /\.dash-hero-slide\s*\{[^}]*flex:\s*0\s+0\s+calc\(\(100%\s*-\s*36px\)\s*\/\s*3\);[^}]*box-sizing:\s*border-box/s);
    assert.match(css, /\.dash-availability-unit-picker\s*\{[^}]*background:\s*var\(--color-bg-elevated\)/);
    assert.match(css, /\.dash-availability-slots-area\s*\{[^}]*background:\s*var\(--color-bg-elevated\)/);
    assert.match(css, /\.dash-availability-live-status\s*\{[^}]*color:\s*var\(--color-ink-dim\)/s);
    assert.match(css, /\.dash-availability-slot\.is-available span\s*\{[^}]*color:\s*var\(--color-court-green\)/);
    assert.match(css, /\.dash-availability-slot:not\(\.is-available\) span\s*\{[^}]*color:\s*var\(--color-alert-text\)/);
    assert.match(dashboard, /data-dash-availability-open/);
    assert.match(dashboard, /sportCover\(coverCourt\.sportSlug \|\| group\.key\)/);
    assert.match(dashboard, /fetchDayOccupancy\(court\.name, date\)/);
    assert.match(dashboard, /const today = todayDateInputValue\(\);\s*availabilityDateInput\.min = today;\s*if \(!availabilityDateInput\.value \|\| availabilityDateInput\.value < today\) availabilityDateInput\.value = today;/);
    assert.match(dashboard, /courtUnitsOverlap\(row\.court_unit, selectedUnit\.label\)/);
    assert.match(dashboard, /data-dash-availability-unit/);
    assert.match(dashboard, /overviewAvailabilityEntries = courts\.flatMap/);
    assert.match(dashboard, /multipleListings \? `\$\{court\.name\}\$\{duplicateNameSuffix\} · \$\{unit\.label\}` : unit\.label/);
    assert.match(dashboard, /const selectedEntry = overviewAvailabilityEntries\[Number\(availabilityUnitSelect\.value\)\]/);
    assert.match(dashboard, /if \(!res \|\| res\.error \|\| !Array\.isArray\(res\.data\)\)/);
    assert.match(dashboard, /The facility is closed on this date\. Use Change date to choose another date/);
    assert.match(dashboard, /availabilityReturnFocus = availabilityDateInput;\s*availabilityDialog\.close\(\)/);
    assert.match(dashboard, /if \(date < today\) \{\s*availabilityDateInput\.value = today/);
    assert.match(dashboard, /Active sports could not be loaded[\s\S]*?data-dash-availability-retry/);
    assert.match(html, /data-dash-hero-prev[\s\S]*?data-dash-hero-next/);
    assert.match(html, /data-dash-hero-pause[^>]*aria-label="Pause slideshow"/);
    assert.match(dashboard, /setTimeout\(\(\) => moveHeroNext\(true\), 5000\)/);
    assert.match(dashboard, /const multiple = heroContainer\.children\.length > 1;[\s\S]*?heroPause\.hidden = !multiple;[\s\S]*?heroPause\.disabled = !multiple/);
    assert.match(dashboard, /heroPause\?\.addEventListener\('click'/);
    assert.match(dashboard, /heroPause\.innerHTML = paused[\s\S]*?Play slideshow/);
    assert.match(dashboard, /court_occupancy[\s\S]*?data-dash-availability/);
    assert.match(dashboard, /inventoryLoadFailed/);
    assert.match(dashboard, /date !== todayDateInputValue\(\)[\s\S]*?localDateHourToIso\(date, hour\)\)\.getTime\(\) >= Date\.now\(\)/);
    assert.match(css, /\.dash-overview-lower\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.8fr\)/s);
    assert.match(css, /\.dash-availability-card,[\s\S]*?min-height:\s*360px/);
    assert.match(css, /\.dash-hero-container, \.dash-hero-slide, \.dash-hero-arrow, \.dash-hero-pause\s*\{\s*transition:\s*none/s);
    assert.doesNotMatch(html, /Book this slot|Search notifications|data-dash-notif-search|Review on Google/);
    assert.doesNotMatch(html, /data-dash-panel="overview"[\s\S]*?Courts section/);
    assert.match(dashboard, /dashTopbar\.classList\.add\('is-hidden'\)/);
    assert.match(dashboard, /dashTopbar\.classList\.remove\('is-hidden'\)/);
    assert.match(css, /prefers-reduced-motion/);
    assert.doesNotMatch(ownerHtml, /data-owner-direct-feedback|Direct customer feedback/);
    assert.match(ownerHtml, /data-featured-review-save/);
});

test('availability court-number picker aggregates listings with unique labels and retained context', () => {
    const renderStart = dashboard.indexOf('function renderOverviewAvailabilityUnits(group) {');
    const renderEnd = dashboard.indexOf('\n    function openOverviewAvailability', renderStart);
    assert(renderStart >= 0 && renderEnd > renderStart);
    const availabilityUnitSelect = { innerHTML: '', disabled: false };
    const first = { id: 'duckpin-id', name: 'Bowling', units: [{ label: 'Lane 1' }, { label: 'Lane 2' }] };
    const second = { id: 'tenpin-id', name: 'Bowling', units: [{ label: 'Lane 1' }] };
    const context = {
        availabilityUnitSelect,
        overviewAvailabilityEntries: [],
        window: {
            InigoCourtsData: { resolveCourtUnits: (court) => ({ units: court.units }) },
            escapeHtml: (value) => String(value),
        },
    };
    runInNewContext(`${dashboard.slice(renderStart, renderEnd)}\nglobalThis.render = renderOverviewAvailabilityUnits;`, context);
    context.render({ courts: [first, second] });
    assert.match(availabilityUnitSelect.innerHTML, /Bowling \(duckpin-id\) · Lane 1/);
    assert.match(availabilityUnitSelect.innerHTML, /Bowling \(tenpin-id\) · Lane 1/);
    assert.equal(context.overviewAvailabilityEntries.length, 3);
    assert.equal(context.overviewAvailabilityEntries[0].court, first);
    assert.equal(context.overviewAvailabilityEntries[2].court, second);
    assert.equal(availabilityUnitSelect.disabled, false);
});
