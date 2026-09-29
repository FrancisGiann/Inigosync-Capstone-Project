const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'includes', 'businessHours.js'), 'utf8');

async function loadWithRpc(rpc) {
    const window = { sb: { rpc } };
    vm.runInNewContext(source, { window, Intl, Date, Number, Map, console });
    return window.InigoBusinessHours;
}

(async () => {
    const calls = [];
    const hours = await loadWithRpc(async (name, args) => {
        calls.push({ name, args });
        return { data: { open_hour: 10, close_hour: 22, is_closed: false, grace_minutes: 45, timezone: 'Asia/Manila' }, error: null };
    });

    assert.equal(hours.dateInManila(new Date('2026-09-28T17:00:00Z')), '2026-09-29');
    const first = await hours.getForDate('2026-09-29');
    assert.equal(first.openHour, 10);
    assert.equal(first.closeHour, 22);
    assert.equal(first.graceMinutes, 45);
    assert.equal(first.authoritative, true);
    await hours.getForDate('2026-09-29');
    assert.equal(calls.length, 1, 'same-day rules are cached');
    assert.equal(calls[0].name, 'booking_rules_for_date');
    assert.equal(calls[0].args.p_date, '2026-09-29');

    const offline = await loadWithRpc(async () => ({ data: null, error: new Error('offline') }));
    const fallback = await offline.getForDate('2026-09-29');
    assert.equal(fallback.openHour, 8);
    assert.equal(fallback.closeHour, 20);
    assert.equal(fallback.authoritative, false);
    console.log('PASS business hours: Manila date, date-specific rules, cache and fallback');
})().catch(error => { console.error(error); process.exitCode = 1; });
