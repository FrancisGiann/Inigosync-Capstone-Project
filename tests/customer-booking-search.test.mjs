import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../Pages/user_dashboard.html', import.meta.url), 'utf8');
const js = await readFile(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../Style/Dashboard.css', import.meta.url), 'utf8');
const panel = html.match(/<section class="dash-panel" data-dash-panel="bookings">([\s\S]*?)<\/section>/)?.[1] || '';

test('My Bookings exposes an accessible manual search and status/date filters', () => {
  assert.match(panel, /role="search" aria-label="Search your bookings"/);
  assert.match(panel, /type="search"[^>]*data-dash-booking-search maxlength="200"/);
  assert.match(panel, /<select[^>]*data-dash-booking-status/);
  assert.match(panel, /<input[^>]*type="date"[^>]*data-dash-booking-date/);
  assert.match(panel, /data-dash-booking-count role="status" aria-live="polite"/);
});

test('booking filters match visible rendered values and are reapplied after each refresh', () => {
  assert.match(js, /row\.dataset\.customerBookingRow = ''/);
  assert.match(js, /row\.dataset\.bookingStatus = displayStatus/);
  assert.match(js, /row\.dataset\.bookingDate = bookingDateForRules\(booking\.time_date\)/);
  assert.match(js, /row\.textContent\.toLocaleLowerCase\(\)\.includes\(query\)/);
  assert.match(js, /row\.dataset\.bookingStatus === status/);
  assert.match(js, /row\.dataset\.bookingDate === date/);
  assert.match(js, /No bookings match your search and filters/);
  const renderPosition = js.indexOf('data.forEach((booking) => {', js.indexOf('async function refreshMyBookings'));
  const filterPosition = js.indexOf('applyMyBookingsFilters();', renderPosition);
  const listenerPosition = js.indexOf('bookingsTableBody.querySelectorAll(\'[data-dash-nav="receipts"]\')', renderPosition);
  assert.ok(filterPosition > renderPosition && filterPosition < listenerPosition, 'filters run on the newly rendered rows');
});

test('search, status, and date filters combine and report an empty result', () => {
  const start = js.indexOf('    function applyMyBookingsFilters() {');
  assert.notEqual(start, -1);
  let depth = 0;
  let end = start;
  for (; end < js.length; end += 1) {
    if (js[end] === '{') depth += 1;
    if (js[end] === '}') {
      depth -= 1;
      if (depth === 0) { end += 1; break; }
    }
  }
  const source = js.slice(start, end);
  const rows = [
    { textContent: 'Badminton Court 2 Jul 14 ₱100 Pending Details', dataset: { bookingStatus: 'pending', bookingDate: '2026-07-14' }, hidden: false },
    { textContent: 'Basketball Full Court Jul 12 ₱300 Confirmed Details', dataset: { bookingStatus: 'confirmed', bookingDate: '2026-07-12' }, hidden: false },
  ];
  const search = { value: 'badminton' };
  const status = { value: 'pending' };
  const date = { value: '2026-07-14' };
  const count = { textContent: '' };
  const body = {
    querySelectorAll: () => rows,
    querySelector: () => null,
    appendChild: () => {},
  };
  const fakeDocument = {
    createElement: () => ({ dataset: {}, hidden: false, innerHTML: '' }),
  };
  const run = new Function('bookingsTableBody', 'myBookingsSearch', 'myBookingsStatus', 'myBookingsDate', 'myBookingsCount', 'document', `${source}; return applyMyBookingsFilters;`)(body, search, status, date, count, fakeDocument);

  run();
  assert.deepEqual(rows.map((row) => row.hidden), [false, true]);
  assert.equal(count.textContent, 'Showing 1 of 2 bookings');

  search.value = 'tennis';
  run();
  assert.deepEqual(rows.map((row) => row.hidden), [true, true]);
  assert.equal(count.textContent, 'Showing 0 of 2 bookings');
});

test('booking controls stack cleanly on narrow screens', () => {
  assert.match(css, /\.dash-booking-filters \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /@media \(max-width: 420px\)[\s\S]*?\.dash-booking-filters \{ grid-template-columns: minmax\(0, 1fr\)/);
});
