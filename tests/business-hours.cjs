const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'includes', 'businessHours.js'), 'utf8');

async function loadWithRpc(rpc) {
    const storageListeners = [];
    const dispatchedEvents = [];
    const storageWrites = [];
    const window = {
        sb: { rpc },
        addEventListener(type, listener) { if (type === 'storage') storageListeners.push(listener); },
        document: { dispatchEvent(event) { dispatchedEvents.push(event.type); } },
        localStorage: { setItem(key, value) { storageWrites.push({ key, value }); } },
    };
    vm.runInNewContext(source, {
        window, Intl, Date, Number, Map, console,
        CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
    });
    return { businessHours: window.InigoBusinessHours, storageListeners, dispatchedEvents, storageWrites };
}

(async () => {
    const calls = [];
    const testHours = await loadWithRpc(async (name, args) => {
        calls.push({ name, args });
        const dayRules = {
            '2026-09-28': { open_hour: 8, close_hour: 20 },
            '2026-09-29': { open_hour: 10, close_hour: 22 },
            '2026-09-30': { open_hour: 8, close_hour: 18 },
        };
        return { data: { ...dayRules[args.p_date], is_closed: false, grace_minutes: 45, timezone: 'Asia/Manila' }, error: null };
    });
    const hours = testHours.businessHours;

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
    hours.invalidateRules();
    await hours.getForDate('2026-09-29');
    assert.equal(calls.length, 2, 'invalidating rules forces the next same-day read to fetch fresh hours');
    hours.notifyRulesUpdated();
    assert.equal(testHours.storageWrites.at(-1).key, 'inigosync:booking-rules-updated', 'a successful save can signal other tabs');
    assert.deepEqual(testHours.dispatchedEvents, ['inigosync:booking-rules-updated'], 'a same-tab save emits the refresh event');
    await hours.getForDate('2026-09-29');
    assert.equal(calls.length, 3, 'a local save notification clears the cached rules');
    testHours.storageListeners[0]({ key: 'inigosync:booking-rules-updated' });
    await hours.getForDate('2026-09-29');
    assert.equal(calls.length, 4, 'a cross-tab storage signal clears the cached rules');
    assert.deepEqual(testHours.dispatchedEvents, ['inigosync:booking-rules-updated', 'inigosync:booking-rules-updated'], 'storage updates notify active dashboards');
    assert.equal((await hours.getForDate('2026-09-28')).closeHour, 20, 'the selected date before a schedule change retains its 8 PM close');
    assert.equal((await hours.getForDate('2026-09-29')).closeHour, 22, 'the effective date can extend availability to 10 PM');
    assert.equal((await hours.getForDate('2026-09-30')).closeHour, 18, 'a later date can shorten availability to 6 PM');

    const offline = (await loadWithRpc(async () => ({ data: null, error: new Error('offline') }))).businessHours;
    const fallback = await offline.getForDate('2026-09-29');
    assert.equal(fallback.openHour, 8);
    assert.equal(fallback.closeHour, 20);
    assert.equal(fallback.authoritative, false);
    console.log('PASS business hours: Manila date, date-specific rules, cache and fallback');
})().catch(error => { console.error(error); process.exitCode = 1; });
