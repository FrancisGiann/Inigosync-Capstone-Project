import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('../includes/bookingSlots.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
runInNewContext(source, sandbox);
const slots = sandbox.window.InigoBookingSlots;

test('splits selected hours into separate contiguous cart ranges', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(slots.groupConsecutiveHours([9, 8, 12, 11, 9, -1, 24, 15.5]))), [
        { startHour: 8, endHourExclusive: 10, hours: [8, 9] },
        { startHour: 11, endHourExclusive: 13, hours: [11, 12] },
    ]);
});

test('maps facility-local hours and midnight boundaries correctly on a non-Manila device timezone', () => {
    // The browser helper is a plain script; run it in a separate Node realm
    // under Los Angeles time and assert its UTC result is still Manila time.
    const result = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs'); const vm = require('node:vm');
      const w={}; vm.runInNewContext(fs.readFileSync('includes/bookingSlots.js','utf8'),{window:w});
      process.stdout.write(JSON.stringify([w.InigoBookingSlots.localDateHourToIso('2026-03-10',8),w.InigoBookingSlots.localDateHourToIso(w.InigoBookingSlots.nextDate('2026-03-10'),0)]));
    `], { encoding: 'utf8', env: { ...process.env, TZ: 'America/Los_Angeles' } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['2026-03-10T00:00:00.000Z', '2026-03-10T16:00:00.000Z']);
    assert.equal(slots.localDateHourToIso('2026-03-10', 24), '2026-03-10T16:00:00.000Z');
});

test('booking picker is wired to authoritative availability and keeps checkout server-owned', () => {
    const html = readFileSync(new URL('../Pages/user_dashboard.html', import.meta.url), 'utf8');
    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
    assert.match(html, /data-dash-book-sports/);
    assert.match(html, /data-dash-booking-modal[^>]*hidden/);
    assert.match(html, /role="dialog" aria-modal="true"/);
    assert.match(html, /data-dash-book-slots/);
    assert.match(html, /data-dash-book-cart-proceed/);
    assert.match(html, /Proceed to Payment/);
    assert.doesNotMatch(html, /data-dash-book-court-choice[^>]*hidden/);
    assert.match(html, /data-dash-book-submit/);
    assert.match(html, /<script src="\.\.\/includes\/bookingSlots\.js"><\/script>[\s\S]*?<script src="\.\.\/includes\/Dashboard\.js"><\/script>/);
    assert.match(dashboard, /if \(!bookingRules\.authoritative\)/);
    assert.match(dashboard, /getForDate\(bookingState\.date, \{ force: forceRules \}\)/);
    assert.match(dashboard, /groupConsecutiveHours\(selectedHours\)/);
    assert.match(dashboard, /bookingCart\.length \+ runs\.length > 8/);
    assert.match(dashboard, /event\.key === 'Escape'/);
    assert.match(dashboard, /bookingModalTrigger/);
    assert.match(dashboard, /functions\.invoke\('paymongo-checkout'/);
    assert.doesNotMatch(dashboard, /\.from\(['"]booking['"]\)\s*\.insert/);
});

test('working-time changes refresh visible customer and staff availability views', () => {
    const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
    const staff = readFileSync(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');
    const owner = readFileSync(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');
    const businessHours = readFileSync(new URL('../includes/businessHours.js', import.meta.url), 'utf8');
    assert.match(owner, /notifyRulesUpdated\?\.\(\)/, 'successful owner saves publish a rules update');
    assert.match(businessHours, /addEventListener\('storage'/, 'other tabs receive the local-storage update');
    assert.match(dashboard, /addEventListener\('inigosync:booking-rules-updated'/);
    assert.match(dashboard, /addEventListener\('visibilitychange', refreshVisibleBookingAvailability\)/);
    assert.match(dashboard, /refreshTimePickers\(true\)/, 'the customer forces a date-rule refresh');
    assert.match(dashboard, /setInterval\(refreshVisibleBookingAvailability, 60000\)/, 'active customer booking availability polls once a minute');
    assert.match(dashboard, /bookDate\.min = today;[\s\S]*?if \(bookingState\.date < today\)[\s\S]*?bookingState\.date = today/, 'the customer date minimum and selection roll forward after Manila midnight');
    assert.match(staff, /addEventListener\('inigosync:booking-rules-updated', refreshVisibleWalkinSlots\)/);
    assert.match(staff, /addEventListener\('visibilitychange', refreshVisibleWalkinSlots\)/);
    assert.match(staff, /getForDate\(rulesDate, \{ force: forceRules \}\)/);
    assert.match(staff, /setInterval\(refreshVisibleWalkinSlots, 60000\)/, 'active walk-in availability polls once a minute');
    assert.match(staff, /addEventListener\('inigosync:booking-rules-updated', refreshVisibleCourtSchedule\)/);
    assert.match(staff, /setInterval\(refreshVisibleCourtSchedule, 60000\)/, 'the active staff schedule refreshes once a minute');
    assert.match(staff, /scheduleDateInput\.min = today;[\s\S]*?if \(scheduleDate < today\)[\s\S]*?scheduleDate = today/, 'the schedule minimum and selection roll forward after Manila midnight');

    const walkinRefresh = staff.match(/async function refreshWalkinTimeSlots\(forceRules = false\) \{([\s\S]*?)function refreshVisibleWalkinSlots/);
    assert.ok(walkinRefresh, 'walk-in refresh function is present');
    assert.match(walkinRefresh[1], /const businessRules = window\.InigoBusinessHours[\s\S]*?await window\.InigoBusinessHours\.getForDate\(rulesDate, \{ force: forceRules \}\)[\s\S]*?if \(mySeq !== walkinRequestSeq\) return;/,
        'stale rules responses are discarded before shared state is updated');
    assert.match(walkinRefresh[1], /const occupancyRes = await fetchWalkinOccupancyForCourt\(courtName\);\s*if \(mySeq !== walkinRequestSeq\) return;/,
        'stale occupancy responses are discarded before shared state is updated');
    assert.match(walkinRefresh[1], /const hoursForDay =/,
        'hours are calculated locally until the request is current');
    assert.match(walkinRefresh[1], /renderWalkinTimeSlots\(\);\s*if \(dateChangeMessage && occupancyRes\.ok && !businessRules\.isClosed && walkinOpenWindowsEl\) walkinOpenWindowsEl\.textContent = dateChangeMessage/,
        'the date-change notice is applied after verified slots render');
    assert.match(walkinRefresh[1], /if \(walkinSelectionDate !== rulesDate\)[\s\S]*?walkinState\.selectedHours = \[\][\s\S]*?walkinState\.startHour = null[\s\S]*?walkinState\.endHour = null/,
        'the midnight date change clears the current time selection');
    assert.match(staff, /walkinSelectionDate !== todayDateInputValue\(\) \|\| !walkinState\.court[\s\S]*?return null;/,
        'a stale date selection cannot be turned into a new-date order line');
});
