import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../Pages/user_dashboard.html', import.meta.url), 'utf8');
const js = await readFile(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../Style/Dashboard.css', import.meta.url), 'utf8');
const panel = html.match(/<section class="dash-panel" data-dash-panel="bookings">([\s\S]*?)<\/section>/)?.[1] || '';

test('My Bookings exposes an accessible manual search and status/date filters', () => {
  assert.match(panel, /role="search" aria-label="Search your bookings and visits"/);
  assert.match(panel, /type="search"[^>]*data-dash-booking-search maxlength="200"/);
  assert.match(panel, /<select[^>]*data-dash-booking-status/);
  assert.match(panel, /<input[^>]*type="date"[^>]*data-dash-booking-date/);
  assert.match(panel, /data-dash-booking-clear[^>]*Clear filters/);
  assert.match(panel, /option value="completed">Completed/);
  assert.match(panel, /option value="unattended">Unattended/);
  assert.match(panel, /option value="booked">Booked/);
  assert.match(panel, /option value="inplay">Ongoing/);
  assert.doesNotMatch(panel, /option value="(?:pending|confirmed|cancelled)"/);
  assert.match(panel, /<th>ID<\/th>[\s\S]*?<th>Source<\/th>[\s\S]*?<th>Court \/ Visit<\/th>[\s\S]*?<th>Date<\/th>[\s\S]*?<th>Time<\/th>[\s\S]*?<th>Amount<\/th>[\s\S]*?<th>Status<\/th>/);
});

test('booking filters match visible rendered values and are reapplied after each refresh', () => {
  assert.match(js, /row\.dataset\.customerBookingRow = ''/);
  assert.match(js, /row\.dataset\.bookingStatus = displayStatus/);
  assert.match(js, /row\.dataset\.bookingDate = bookingDateForRules\(booking\.time_date\)/);
  assert.match(js, /row\.textContent\.toLocaleLowerCase\(\)\.includes\(query\)/);
  assert.match(js, /row\.dataset\.bookingStatus === status/);
  assert.match(js, /row\.dataset\.bookingDate === date/);
  assert.match(js, /No bookings or visits match your search and filters/);
  const renderPosition = js.indexOf('(data || []).forEach((booking) => {', js.indexOf('async function refreshMyBookings'));
  const filterPosition = js.indexOf('applyMyBookingsFilters();', renderPosition);
  const walkinPosition = js.indexOf('walkins.forEach((visit) => {', renderPosition);
  assert.ok(filterPosition > walkinPosition, 'filters run after the newly rendered online bookings and walk-ins');
});

test('search, status, and date filters combine and keep clear filters visible only when active', () => {
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
    { textContent: 'Badminton Court 2 Jul 14 ₱100 Booked', dataset: { bookingStatus: 'booked', bookingDate: '2026-07-14' }, hidden: false },
    { textContent: 'Basketball Full Court Jul 12 ₱300 Booked', dataset: { bookingStatus: 'booked', bookingDate: '2026-07-12' }, hidden: false },
  ];
  const search = { value: 'badminton' };
  const status = { value: 'booked' };
  const date = { value: '2026-07-14' };
  const sourceFilter = { value: '' };
  const clearButton = { hidden: true };
  const body = {
    querySelectorAll: () => rows,
    querySelector: () => null,
    appendChild: () => {},
  };
  const fakeDocument = {
    createElement: () => ({ dataset: {}, hidden: false, innerHTML: '' }),
  };
  const run = new Function('bookingsTableBody', 'myBookingsSearch', 'myBookingsStatus', 'myBookingsDate', 'myBookingsSource', 'myBookingsClearButton', 'document', `${source}; return applyMyBookingsFilters;`)(body, search, status, date, sourceFilter, clearButton, fakeDocument);

  run();
  assert.deepEqual(rows.map((row) => row.hidden), [false, true]);
  assert.equal(clearButton.hidden, false);

  search.value = 'tennis';
  run();
  assert.deepEqual(rows.map((row) => row.hidden), [true, true]);
  assert.equal(clearButton.hidden, false);

  search.value = '';
  status.value = '';
  date.value = '';
  run();
  assert.deepEqual(rows.map((row) => row.hidden), [false, false]);
  assert.equal(clearButton.hidden, true);
});

test('booking controls stack cleanly on narrow screens', () => {
  assert.match(css, /\.dash-booking-filters \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /@media \(max-width: 420px\)[\s\S]*?\.dash-booking-filters \{ grid-template-columns: minmax\(0, 1fr\)/);
});
