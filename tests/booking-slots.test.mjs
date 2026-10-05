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
