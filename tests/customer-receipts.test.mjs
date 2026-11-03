import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const html = await readFile(new URL('../Pages/user_dashboard.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../Style/Dashboard.css', import.meta.url), 'utf8');
const receiptCss = await readFile(new URL('../Style/paymentAcknowledgment.css', import.meta.url), 'utf8');
const receiptHelper = await readFile(new URL('../includes/paymentAcknowledgment.js', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20260930110844_customer_booking_payment_acknowledgments.sql', import.meta.url), 'utf8');
const walkinActivityMigration = await readFile(new URL('../supabase/migrations/20261028003238_customer_walkin_activity.sql', import.meta.url), 'utf8');
const receiptFilterSource = await readFile(new URL('../includes/customerReceipts.js', import.meta.url), 'utf8');
const receiptFilterContext = { window: {} };
runInNewContext(receiptFilterSource, receiptFilterContext);
const filterAcknowledgments = receiptFilterContext.window.InigoCustomerReceipts.filterAcknowledgments;
const sortAcknowledgments = receiptFilterContext.window.InigoCustomerReceipts.sortAcknowledgments;

test('receipts panel keeps payment sources behind receipt-number and payment-date filters', () => {
    assert.match(html, /Search receipt number[\s\S]*?data-dash-receipt-search/);
    assert.match(html, /Payment date[\s\S]*?data-dash-receipt-date/);
    assert.match(html, /Payment source[\s\S]*?All payments[\s\S]*?Online bookings[\s\S]*?Walk-ins/);
    assert.match(html, /Sort receipts[\s\S]*?Payment date: newest first[\s\S]*?Payment date: oldest first[\s\S]*?Receipt number: A–Z[\s\S]*?Receipt number: Z–A[\s\S]*?Amount: low to high[\s\S]*?Amount: high to low/);
    assert.match(html, /data-dash-panel="receipts">\s*<div class="dash-receipts-group">/);
    assert.match(html, /<div class="dash-receipt-filter-actions">\s*<label[^>]*>Search receipt number<input[^>]*data-dash-receipt-search[^>]*><\/label>\s*<button type="button" class="dash-receipt-clear" data-dash-receipt-clear hidden>Clear filters<\/button>\s*<\/div>\s*<div class="dash-receipt-filters">/);
    assert.doesNotMatch(html.match(/<section class="dash-panel" data-dash-panel="receipts">[\s\S]*?<\/section>/)?.[0] || '', /<h[1-6][^>]*>Receipts<\/h[1-6]>/);
    assert.match(html, /customerReceipts\.js[\s\S]*?Dashboard\.js/);
    assert.match(html, /paymentAcknowledgment\.js[\s\S]*?Dashboard\.js/);
    assert.match(html, /data-dash-receipts/);
    assert.doesNotMatch(html, /Online booking payments|Walk-in payments|data-dash-walkin-receipts|data-dash-booking-receipts/);
    assert.match(html, /<dialog[^>]*data-dash-receipt-dialog[^>]*aria-labelledby/);
    assert.match(html, /<button[^>]*data-dash-receipt-close[^>]*aria-label="Close payment acknowledgment"[^>]*>\s*<span aria-hidden="true">×<\/span>/);
    assert.match(html, /data-dash-receipt-dialog-content[^>]*><\/div>\s*<footer class="dash-receipt-dialog-footer">[\s\S]*?data-dash-receipt-download[\s\S]*?data-dash-receipt-print/);
    assert.match(dashboard, /Payment date<\/th>[\s\S]*?Payment source<\/th>[\s\S]*?Receipt number<\/th>[\s\S]*?Amount paid<\/th>[\s\S]*?Action<\/th>/);
    assert.match(dashboard, /const paymentSource = entry\.source === 'walkin' \? 'Walk-in' : 'Online';[\s\S]*?data-label="Payment source">\$\{paymentSource\}/);
    assert.match(dashboard, /sortAcknowledgments\(filtered, sortOrder\)/);
    assert.match(dashboard, /receiptSortInput\?\.addEventListener\('change', renderFilteredAcknowledgments\)/);
    assert.match(dashboard, /receiptClearButton\.hidden = !\(query \|\| paymentDate \|\| source !== 'all' \|\| sortOrder !== 'newest'\)/);
    assert.match(dashboard, /receiptClearButton\?\.addEventListener\('click', \(\) => \{[\s\S]*?receiptSearchInput\.value = '';[\s\S]*?receiptDateInput\.value = '';[\s\S]*?receiptSourceInput\.value = 'all';[\s\S]*?receiptSortInput\.value = 'newest';[\s\S]*?renderFilteredAcknowledgments\(\);/);
    assert.doesNotMatch(dashboard.match(/function renderReceiptTable\(entries\) \{[\s\S]*?\n    \}/)?.[0] || '', /Booking source|Payment for \/ reference|sport|court/i);
    assert.match(dashboard, /data-dash-receipt-view/);
    assert.match(dashboard, /renderPaymentAcknowledgment\(entry\)[\s\S]*?receiptDialog\.showModal\(\)/);
    assert.match(dashboard, /cardAttributes: `data-dash-receipt-card="\$\{safeKey\}"`,\s*\n\s*\}\);/);
    assert.match(dashboard, /receiptDownloadButton\?\.setAttribute\('data-dash-receipt-download'/);
    assert.match(dashboard, /receiptDialogContent\.innerHTML = ''[\s\S]*?activeReceiptOpener\.focus\(\)/);
    assert.match(dashboard, /\.dash-receipt-dialog \[data-dash-receipt-download\]/);
    assert.match(dashboard, /\.dash-receipt-dialog \[data-dash-receipt-print\]/);
    const receiptWiring = dashboard.match(/function wireReceiptDownloads\(\) \{[\s\S]*?\n    \}/)?.[0] || '';
    assert.equal((receiptWiring.match(/receiptDialogContent\?\.querySelector\('\[data-dash-receipt-card\]'\)/g) || []).length, 2,
        'both footer actions target the card rendered in the dialog content');
    assert.doesNotMatch(receiptWiring, /btn\.closest\('\.payment-ack-layout'\)/,
        'footer actions must not search for a layout ancestor they are outside of');
    assert.match(css, /\.dash-receipt-table\s*\{/);
    assert.match(css, /\.dash-receipt-table td \{ padding: 16px 16px;/);
    assert.match(css, /\.dash-receipt-filters\s*\{[^}]*repeat\(3, minmax\(0, 1fr\)\)/s);
    assert.match(css, /\.dash-receipt-filter-actions\s*\{[^}]*justify-content:\s*space-between/s);
    assert.match(css, /\.dash-receipt-clear\s*\{[^}]*background:\s*var\(--color-primary\)/s);
    assert.match(css, /\.dash-receipt-clear\[hidden\]\s*\{\s*visibility:\s*hidden/);
    assert.match(css, /\.dash-receipt-table th:last-child\s*\{\s*text-align:\s*left/);
    assert.match(css, /\.dash-receipt-table td:last-child\s*\{\s*text-align:\s*left/);
    assert.match(css, /\.dash-receipt-table\s*\{[^}]*table-layout:\s*fixed/s);
    assert.match(css, /@media \(max-width:\s*900px\)[\s\S]*?\.dash-receipt-filters \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
    assert.match(css, /\.dash-receipt-dialog-shell\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/s);
    assert.match(css, /\.dash-receipt-dialog-content\s*\{[^}]*overflow-y:\s*auto/s);
    assert.match(css, /\.dash-receipt-dialog-footer\s*\{/);
    assert.match(css, /@media \(max-width:\s*640px\)[\s\S]*?\.dash-receipt-table td::before/);
    assert.doesNotMatch(dashboard.match(/function renderReceiptTable\(entries\) \{[\s\S]*?\n    \}/)?.[0] || '', /Customer/);
    assert.match(css, /\.dash-receipts-group\s*\{[^}]*background:\s*var\(--color-bg-elevated\)/s);
    assert.match(css, /\.dash-receipt-filters\s*\{[^}]*grid-template-columns/s);
    assert.match(css, /@media \(max-width:\s*640px\)[\s\S]*?\.dash-receipt-filters\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
    assert.match(css, /:root\[data-theme="light"\]/);
    assert.match(receiptCss, /@page \{ size: auto; margin: 0; \}/);
    assert.match(receiptCss, /payment-ack-print-root\.payment-ack-measuring[\s\S]*?width: 47\.5mm;\s*padding: \.75mm/);
    assert.match(receiptCss, /payment-ack-measuring \.payment-ack-card\s*\{[^}]*width: 46mm;[^}]*max-width: 46mm/s);
    assert.match(receiptHelper, /@page \{ size: 58mm \$\{pageHeightMm\}mm; margin: 0; \}/);
    assert.match(receiptCss, /body\.payment-ack-printing > \.payment-ack-print-root\s*\{[^}]*width:\s*47\.5mm;[^}]*padding:\s*\.75mm;/s);
    assert.match(receiptCss, /body\.payment-ack-printing \.payment-ack-card\s*\{[^}]*width: 46mm;[^}]*max-width: 46mm/s);
    assert.match(receiptHelper, /const PRINT_LOCATION = 'Brgy\. Bocohan, Diversion Road, Lucena City, Quezon, Philippines'/);
    assert.match(receiptHelper, /class="payment-ack-address">\$\{escape\(PRINT_LOCATION\)\}/);
    assert.doesNotMatch(receiptHelper, /Printed|addPrintHeader|payment-ack-print-meta/);
    assert.match(receiptHelper, /Payment date/);
    assert.match(receiptCss, /payment-ack-meta-row > span, \.payment-ack-meta-row > strong\s*\{[^}]*overflow-wrap: anywhere/s);
    assert.match(receiptCss, /payment-ack-item-field > span, \.payment-ack-item-field > strong\s*\{[^}]*overflow-wrap: anywhere/s);
    assert.match(receiptCss, /body\.payment-ack-printing > :not\(\.payment-ack-print-root\)/);
    assert.match(receiptCss, /body\.payment-ack-printing\s*\{[^}]*min-height:\s*0 !important;[^}]*height:\s*auto !important;/s);
    assert.match(receiptCss, /body\.dash-body\.payment-ack-printing::before\s*\{[^}]*display:\s*none !important;/);
});

test('bookings and visits stay activity-focused and include only account-linked walk-ins', () => {
    assert.match(html, /My Bookings &amp; Visits/);
    assert.match(html, /data-dash-booking-source[\s\S]*?Online bookings[\s\S]*?Walk-ins/);
    assert.doesNotMatch(html.match(/data-dash-panel="bookings"[\s\S]*?data-dash-panel="receipts"/)?.[0] || '', /data-dash-nav="receipts"/);
    assert.match(dashboard, /customer_list_walkin_activity/);
    assert.match(dashboard, /row\.dataset\.bookingSource = 'walkin'/);
    assert.match(dashboard, /myBookingsSource\?\.value/);
    assert.match(walkinActivityMigration, /auth\.uid\(\)/);
    assert.match(walkinActivityMigration, /p\.role = 'customer' and p\.status = 'active'/);
    assert.match(walkinActivityMigration, /w\.walkin_order_id is not null and o\.customer_id = v_actor/);
    assert.match(walkinActivityMigration, /w\.walkin_order_id is null and w\.customer_id = v_actor/);
    assert.match(walkinActivityMigration, /revoke all on function public\.customer_list_walkin_activity[\s\S]*?from public,anon/);
});

test('booking receipts render only saved acknowledgment snapshots, preserving deposit and balance history', () => {
    assert.match(dashboard, /customer_get_booking_payment_acknowledgments/);
    assert.match(dashboard, /isMissingAcknowledgmentHistoryRpc\(error\)/);
    assert.match(dashboard, /get_payment_acknowledgment/);
    assert.match(dashboard, /history\.map\(normalizeSavedAcknowledgment\)/);
    assert.match(dashboard, /saved\.forEach\(acknowledgment => loadedAcknowledgments\.push/);
    assert.doesNotMatch(dashboard, /renderReceiptCard|normalizeReceipt/);
    assert.match(migration, /payment_history[\s\S]*?jsonb_agg\([\s\S]*?order by p\.created_at, p\.payment_id/i);
});

test('loading and failure messages do not present fabricated booking receipts', () => {
    assert.match(dashboard, /Loading payment acknowledgments from both sources/);
    assert.match(dashboard, /No payment acknowledgments match those filters/);
    assert.match(dashboard, /No payment acknowledgments yet/);
    assert.match(dashboard, /Walk-in payment acknowledgments could not be loaded; displayed results include online booking payments only/);
    assert.match(dashboard, /customer_list_walkin_acknowledgments/);
    assert.match(dashboard, /p_offset:\s*rows\.length[\s\S]*?p_limit:\s*pageSize/);
    assert.match(dashboard, /while \(rows\.length < totalCount\)/);
    assert.match(dashboard, /seen\.has\(key\)/);
    assert.match(dashboard, /dateInManila\(value\)/);
    assert.match(dashboard, /if \(generation !== receiptRenderGeneration\) return;[\s\S]*?receiptAcknowledgments = loadedAcknowledgments/);
    assert.doesNotMatch(dashboard, /Booking summary · Not proof of payment/);
});

test('source, receipt number, and payment date filters combine across booking and walk-in acknowledgments', () => {
    const entries = [
        { source: 'booking', searchIds: ['PA-102'], acknowledgment: { issued_at: '2026-10-03T16:30:00Z' } },
        { source: 'walkin', searchIds: ['PA-5502'], acknowledgment: { issued_at: '2026-10-04T16:00:00Z' } },
    ];
    const dateKey = value => value === entries[0].acknowledgment.issued_at ? '2026-10-04' : '2026-10-05';
    assert.equal(filterAcknowledgments(entries, { source: 'all' }, dateKey).length, 2);
    assert.deepEqual(Array.from(filterAcknowledgments(entries, { source: 'all', idQuery: 'PA-102', paymentDate: '2026-10-04' }, dateKey), entry => entry.source), ['booking']);
    assert.deepEqual(Array.from(filterAcknowledgments(entries, { source: 'walkin', idQuery: 'PA-5502', paymentDate: '2026-10-05' }, dateKey), entry => entry.source), ['walkin']);
    assert.deepEqual(Array.from(filterAcknowledgments(entries, { source: 'booking', idQuery: 'PA-5502', paymentDate: '2026-10-05' }, dateKey)), []);
    assert.deepEqual(Array.from(filterAcknowledgments(entries, { source: 'all', idQuery: 'missing', paymentDate: '2026-10-04' }, dateKey)), []);
    assert.deepEqual(Array.from(filterAcknowledgments(entries, { source: 'all', paymentDate: '2026-10-06' }, dateKey)), []);
});

test('receipt sorting supports both date directions, puts undated records last, and breaks ties by reference', () => {
    const entries = [
        { cardKey: 'booking-2-PA-2', acknowledgment: { receipt_number: 'PA-2', issued_at: '2026-10-04T16:00:00Z' } },
        { cardKey: 'walkin-3-PA-3', acknowledgment: { receipt_number: 'PA-3', issued_at: '2026-10-03T16:00:00Z' } },
        { cardKey: 'booking-1-PA-1', acknowledgment: { receipt_number: 'PA-1', issued_at: '2026-10-04T16:00:00Z' } },
        { cardKey: 'walkin-4-PA-4', acknowledgment: { receipt_number: 'PA-4', issued_at: 'invalid' } },
    ];
    assert.deepEqual(Array.from(sortAcknowledgments(entries, 'newest'), entry => entry.cardKey), [
        'booking-1-PA-1', 'booking-2-PA-2', 'walkin-3-PA-3', 'walkin-4-PA-4',
    ]);
    assert.deepEqual(Array.from(sortAcknowledgments(entries, 'oldest'), entry => entry.cardKey), [
        'walkin-3-PA-3', 'booking-1-PA-1', 'booking-2-PA-2', 'walkin-4-PA-4',
    ]);
});

test('receipt sorting supports natural receipt numbers and numeric amounts in both directions', () => {
    const entries = [
        { cardKey: 'booking-10', acknowledgment: { receipt_number: 'PA-10', total: '500.00' } },
        { cardKey: 'booking-2', acknowledgment: { receipt_number: 'PA-2', total: '120.00' } },
        { cardKey: 'walkin-3', acknowledgment: { receipt_number: 'PA-3', gross_minor: 18000 } },
        { cardKey: 'walkin-4', acknowledgment: { receipt_id: 'PA-4', total: 250 } },
        { cardKey: 'walkin-5', acknowledgment: { receipt_number: 'PA-5' } },
    ];
    assert.deepEqual(Array.from(sortAcknowledgments(entries, 'receipt-asc'), entry => entry.cardKey), [
        'booking-2', 'walkin-3', 'walkin-4', 'walkin-5', 'booking-10',
    ]);
    assert.deepEqual(Array.from(sortAcknowledgments(entries, 'receipt-desc'), entry => entry.cardKey), [
        'booking-10', 'walkin-5', 'walkin-4', 'walkin-3', 'booking-2',
    ]);
    assert.deepEqual(Array.from(sortAcknowledgments(entries, 'amount-asc'), entry => entry.cardKey), [
        'booking-2', 'walkin-3', 'walkin-4', 'booking-10', 'walkin-5',
    ]);
    assert.deepEqual(Array.from(sortAcknowledgments(entries, 'amount-desc'), entry => entry.cardKey), [
        'booking-10', 'walkin-4', 'walkin-3', 'booking-2', 'walkin-5',
    ]);
});

test('panel parser keeps Receipts, Profile, and Settings as siblings under main', () => {
    const mainStart = html.indexOf('<main class="dash-content">');
    const mainEnd = html.indexOf('</main>', mainStart);
    assert.ok(mainStart >= 0 && mainEnd > mainStart, 'customer content main is present');
    const source = html.slice(mainStart, mainEnd + '</main>'.length).replace(/<!--[\s\S]*?-->/g, '');
    const stack = [];
    const panelParents = new Map();
    const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    for (const match of source.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
        const token = match[0];
        const tag = match[1].toLowerCase();
        if (token.startsWith('</')) {
            assert.equal(stack.pop()?.tag, tag, `balanced ${tag} close tag`);
            continue;
        }
        const node = { tag, parent: stack.at(-1) || null };
        const panel = token.match(/\bdata-dash-panel="([^"]+)"/);
        if (tag === 'section' && panel) panelParents.set(panel[1], node.parent?.tag);
        if (!voidTags.has(tag) && !token.endsWith('/>')) stack.push(node);
    }
    assert.equal(stack.length, 0, 'main subtree is balanced');
    for (const panel of ['receipts', 'profile', 'settings']) assert.equal(panelParents.get(panel), 'main', `${panel} is a direct main child`);
    assert.match(html, /data-dash-panel="settings"[\s\S]*?data-dash-settings-save="password"/);
    assert.doesNotMatch(html, /<section class="dash-panel" data-dash-panel="settings">\s*<div class="dash-panel-head">/);
    assert.match(html, /<section class="dash-panel" data-dash-panel="settings">[\s\S]*?data-dash-settings-save="password"/);
    assert.match(dashboard, /panel\.classList\.toggle\('is-active', panel\.dataset\.dashPanel === name\)/);
    assert.match(css, /\.dash-panel\.is-active\s*\{\s*display:\s*flex/);
});

test('customer footer stays after every panel and FAQ label precedes its icon', () => {
    assert.match(html, /<main class="dash-content">[\s\S]*?<footer class="dash-footer" data-dash-footer>/);
    assert.doesNotMatch(dashboard, /dashFooter\.hidden|data-dash-footer/);
    assert.match(css, /\.dash-main\s*\{[^}]*min-height:\s*100vh/s);
    assert.match(css, /\.dash-content\s*\{[^}]*flex:\s*1 0 auto/s);
    assert.match(css, /\.dash-footer\s*\{[^}]*margin:\s*auto auto 24px/s);
    assert.match(html, /data-customer-faq-open[^>]*>[\s\S]*?customer-faq-launcher-label[\s\S]*?customer-faq-launcher-icon/);
});
