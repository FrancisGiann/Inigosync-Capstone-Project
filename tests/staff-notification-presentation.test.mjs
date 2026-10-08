import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../Pages/staff_dashboard.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../Style/staff_dashboard.css', import.meta.url), 'utf8');
const start = source.indexOf('    function staffNotificationCategoryLabel(value) {');
const end = source.indexOf('    async function loadStaffNotifications() {', start);
assert.ok(start >= 0 && end > start, 'Staff notification presentation helpers are present');
const helperSource = source.slice(start, end);

function render(item) {
    const context = { Date, Intl, String };
    runInNewContext(`${helperSource}\nglobalThis.render = renderStaffNotification; globalThis.label = staffNotificationCategoryLabel;`, context);
    const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    return { html: context.render(item, escape), label: context.label(item.category) };
}

test('staff notifications present title, summary, readable category, Manila timestamp, and read state', () => {
    const { html } = render({
        key: 'activity:4', title: 'Booking unattended', body: 'Bea · Tennis', category: 'unattended',
        created_at: '2026-10-06T01:35:00Z', href: '#booking-overview', read_at: null,
    });
    assert.match(html, /<strong>Booking unattended<\/strong><span>Bea · Tennis<\/span><small>Attendance · Oct 6, 2026, 9:35 AM · Unread<\/small>/);
    assert.match(html, /class="staff-notif-row staff-notif-persistent is-unread"/);
    assert.match(html, /data-staff-notif-select-row="activity:4"/);
    assert.match(html, /data-staff-notif-open/);
    assert.match(html, /data-staff-notif-href="#booking-overview"/);
});

test('staff notification menu keeps selection controls, one read action, and paginated rows', () => {
    assert.match(html, /<div class="staff-notif-menu-head"><span>Notifications<\/span><\/div>/);
    assert.match(html, /Select notifications[\s\S]*data-staff-notif-selected[\s\S]*data-staff-notif-select[\s\S]*data-staff-notif-mark-selected[^>]*>Mark as read<\/button>/);
    assert.doesNotMatch(html, /Mark all read|data-staff-notif-mark-all|data-staff-notif-unread/);
    assert.match(html, /data-staff-notif-pagination/);
    assert.match(css, /\.staff-notif-menu-head[^\n]*border-bottom/);
    assert.match(css, /\.staff-notif-selection[^\n]*grid/);
    assert.match(css, /\.staff-notif-select-row/);
    assert.match(css, /\.staff-notif-row\.is-selected/);
    assert.doesNotMatch(source, /staffNotifMarkAll|staff_mark_all_notifications_read/);
    assert.match(source, /applyStaffNotificationSelection/);
    assert.match(source, /staffNotifMarkSelected/);
});

test('staff notification category keys are translated to readable labels', () => {
    assert.equal(render({ category: 'arrival' }).label, 'Arrival');
    assert.equal(render({ category: 'payment_recorded' }).label, 'Payment');
    assert.equal(render({ category: 'walkin_created' }).label, 'Walk-in');
    assert.equal(render({ category: 'some_new_category' }).label, 'Some New Category');
});

test('staff notification content and links are escaped and missing dates are handled', () => {
    const { html } = render({
        key: 'x"><script>', title: '<Notice>', body: 'Hello <staff>', category: 'arrival',
        created_at: 'bad-date', href: '" onfocus="alert(1)', read_at: '2026-10-06T01:40:00Z',
    });
    assert.match(html, /&lt;Notice&gt;/);
    assert.match(html, /Hello &lt;staff&gt;/);
    assert.match(html, /Date unavailable · Read/);
    assert.match(html, /data-staff-notif-key="x&quot;&gt;&lt;script&gt;"/);
    assert.match(html, /data-staff-notif-href="&quot; onfocus=&quot;alert\(1\)"/);
    assert.match(html, /class="staff-notif-row staff-notif-persistent is-read"/);
});
