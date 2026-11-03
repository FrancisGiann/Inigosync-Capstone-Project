import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const owner = readFileSync(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261101160000_booking_slot_start_cutoff.sql', import.meta.url), 'utf8');
const minuteRangeMigration = readFileSync(new URL('../supabase/migrations/20261102150000_booking_rule_minutes_range.sql', import.meta.url), 'utf8');

test('both minute inputs accept only ASCII whole digits from 0 through 59 and report invalid typing inline', async () => {
    const vm = await import('node:vm');
    function sourceFunction(name) {
        const helperStart = owner.indexOf(`function ${name}(`);
        const helperEnd = owner.indexOf('\n    }', helperStart) + '\n    }'.length;
        assert.ok(helperStart >= 0 && helperEnd > helperStart, `${name} is present`);
        return vm.runInNewContext(`(${owner.slice(helperStart, helperEnd)})`);
    }
    const parseMinutes = sourceFunction('parseBookingRuleMinutes');
    const guardInsertion = sourceFunction('guardBookingRuleMinuteInsertion');
    const guardPaste = sourceFunction('guardBookingRuleMinutePaste');
    const handleInput = sourceFunction('handleBookingRuleMinuteInput');
    const setMinuteValue = sourceFunction('setBookingRuleMinuteValue');

    for (const field of ['grace', 'cutoff']) {
        assert.match(html, new RegExp(`data-owner-rules-${field}[^>]*aria-describedby="ownerRules${field === 'grace' ? 'Grace' : 'Cutoff'}Error"`));
        assert.match(html, new RegExp(`data-owner-rules-${field}-error[^>]*role="alert"`));
        assert.match(owner, new RegExp(`installBookingRuleMinuteInput\\(bookingRules${field === 'grace' ? 'Grace' : 'Cutoff'},`),
            `${field} uses insertion and paste guards`);
    }

    for (const value of ['0', '9', '59']) {
        const input = { value, setAttribute(name, next) { this[name] = next; } };
        const error = { hidden: false };
        assert.equal(parseMinutes(input, error), Number(value));
        assert.equal(input['aria-invalid'], 'false');
        assert.equal(error.hidden, true);
    }
    for (const value of ['', '60', '3029', '89.96', '-1', '+1', '1e2', '１２', ' 5']) {
        const input = { value, setAttribute(name, next) { this[name] = next; } };
        const error = { hidden: true };
        assert.equal(parseMinutes(input, error), null, `${JSON.stringify(value)} must fail`);
        assert.equal(input['aria-invalid'], 'true');
        assert.equal(error.hidden, false);
    }

    for (const value of ['a', '.', '-', '+', 'e', '2.5', ' 4 ']) {
        const input = { value: '1', dataset: { lastValid: '1' }, setAttribute(name, next) { this[name] = next; } };
        const error = { hidden: true };
        let prevented = false;
        guardInsertion({ data: value, preventDefault() { prevented = true; } }, input, error);
        assert.equal(prevented, true, `beforeinput rejects ${JSON.stringify(value)}`);
        assert.equal(input.value, '1');
        assert.equal(error.hidden, false);
    }
    let digitPrevented = false;
    guardInsertion({ data: '7', preventDefault() { digitPrevented = true; } }, {}, { hidden: true });
    assert.equal(digitPrevented, false, 'ASCII digits remain typeable');

    for (const value of ['letters', '2.5', '+4', '-1', ' 5 ']) {
        const input = { value: '3', setAttribute(name, next) { this[name] = next; } };
        const error = { hidden: true };
        let prevented = false;
        guardPaste({ clipboardData: { getData: () => value }, preventDefault() { prevented = true; } }, input, error);
        assert.equal(prevented, true, `paste rejects ${JSON.stringify(value)}`);
        assert.equal(input.value, '3', 'malformed paste never replaces the current text');
        assert.equal(error.hidden, false);
    }

    for (const value of ['letters', '2.5']) {
        const fallbackInput = { value, dataset: { lastValid: '2' }, setAttribute(name, next) { this[name] = next; } };
        const fallbackError = { hidden: true };
        handleInput(fallbackInput, fallbackError);
        assert.equal(fallbackInput.value, '2', 'input fallback restores the last accepted text without numeric conversion');
        assert.equal(fallbackError.hidden, false);
    }

    for (const field of ['Grace', 'Cutoff']) {
        assert.match(owner, new RegExp(`setBookingRuleMinuteValue\\(bookingRules${field},`),
            `loading ${field.toLowerCase()} refreshes its fallback value`);
    }
    const loadedInput = { value: '', dataset: { lastValid: '' } };
    setMinuteValue(loadedInput, 35);
    assert.equal(loadedInput.value, '35');
    assert.equal(loadedInput.dataset.lastValid, '35', 'a loaded saved value survives a later input fallback');
});

test('minute validation runs before save and database rules cap grace and cutoff at 59', () => {
    assert.match(owner, /parseBookingRuleMinutes\(bookingRulesGrace, bookingRulesGraceError\)[\s\S]*?if \(graceMinutes === null\)[\s\S]*?parseBookingRuleMinutes\(bookingRulesCutoff, bookingRulesCutoffError\)[\s\S]*?if \(slotCutoffMinutes === null\)/);
    assert.match(owner, /p_grace_minutes: graceMinutes[\s\S]*?p_slot_cutoff_minutes: slotCutoffMinutes/);
    assert.match(minuteRangeMigration, /check \(grace_minutes between 0 and 59\)/);
    assert.match(minuteRangeMigration, /p_grace_minutes not between 0 and 59/);
    assert.match(minuteRangeMigration, /Existing booking rules contain grace values outside 0 to 59/);
    assert.match(minuteRangeMigration, /owner_save_booking_rules\(jsonb,integer,date\)/);
    assert.match(minuteRangeMigration, /owner_save_booking_rules\(jsonb,integer,integer,date\)/);
});

test('owner can save a separately validated 0–59 minute cutoff and see saved schedules', () => {
    assert.match(html, /<input type="text"[^>]*pattern="\[0-9\]\*"[^>]*data-owner-rules-cutoff/);
    assert.match(owner, /slotCutoffMinutes: bookingRulesCutoff\?\.value/);
    assert.match(owner, /parseBookingRuleMinutes\(bookingRulesCutoff, bookingRulesCutoffError\)[\s\S]*?if \(slotCutoffMinutes === null\)/,
        'blank and malformed cutoff input is rejected before saving');
    assert.match(owner, /p_slot_cutoff_minutes: slotCutoffMinutes/);
    assert.match(owner, /data-owner-rules-saved-cutoff/);
    assert.match(owner, /data-owner-rules-upcoming-cutoff/);
});

test('database migration backfills 10, bounds saved cutoffs, and leaves grace fields independent', () => {
    assert.match(migration, /add column if not exists slot_cutoff_minutes integer not null default 10/);
    assert.match(migration, /check \(slot_cutoff_minutes between 0 and 59\)/);
    assert.match(migration, /grant execute on function public\.booking_rules_for_date\(date\) to authenticated,service_role/,
        'the recreated shared reader preserves the existing service_role grant');
    assert.match(migration, /p_grace_minutes is null or p_grace_minutes not between 0 and 720 or p_slot_cutoff_minutes is null or p_slot_cutoff_minutes not between 0 and 59/);
    assert.match(migration, /booking_rule_sets\(effective_from,grace_minutes,slot_cutoff_minutes,created_by,updated_at\)/);
    assert.match(migration, /slot_cutoff_minutes=excluded\.slot_cutoff_minutes/);
    assert.match(migration, /grant execute on function public\.owner_save_booking_rules\(jsonb,integer,integer,date\) to authenticated,service_role/,
        'the new owner save overload preserves the legacy service_role grant');
    const legacySave = migration.slice(migration.lastIndexOf("v_definition:=pg_catalog.pg_get_functiondef('public.owner_save_booking_rules(jsonb,integer,date)'::regprocedure);"));
    assert.match(legacySave, /booking_rule_sets\(effective_from,grace_minutes,slot_cutoff_minutes,created_by,updated_at\)/);
    assert.match(legacySave, /values\(p_effective_from,p_grace_minutes,internal\.booking_slot_cutoff_for_date\(p_effective_from\),v_actor,now\(\)\)/,
        'legacy three-argument saves inherit the cutoff active on their effective date');
    assert.doesNotMatch(legacySave, /slot_cutoff_minutes=excluded\.slot_cutoff_minutes/,
        'legacy same-date updates do not overwrite an explicitly configured cutoff');
    assert.match(migration, /'v_start<=now\(\)\+interval ''2 minutes''',[\s\S]*?'v_start\+make_interval\(mins=>internal\.booking_slot_cutoff_for_date\(v_start_local::date\)\)<=now\(\)'/, 'checkout relies only on the configured cutoff for the start-time rule');
    assert.match(migration, /v_start\+make_interval\(mins=>internal\.booking_slot_cutoff_for_date\(v_start_local::date\)\)<=now\(\)/, 'staff walk-in order checks close at the exact configured boundary');
});
