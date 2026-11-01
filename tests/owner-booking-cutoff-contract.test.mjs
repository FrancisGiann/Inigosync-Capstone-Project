import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const owner = readFileSync(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261101160000_booking_slot_start_cutoff.sql', import.meta.url), 'utf8');

test('owner can save a separately validated 0–59 minute cutoff and see saved schedules', () => {
    assert.match(html, /<input[^>]*min="0" max="59"[^>]*data-owner-rules-cutoff/);
    assert.match(owner, /slotCutoffMinutes: bookingRulesCutoff\?\.value/);
    assert.match(owner, /const slotCutoffRaw = String\(bookingRulesCutoff\?\.value \?\? ''\)\.trim\(\);\s*if \(!slotCutoffRaw\) \{[\s\S]*?return;\s*\}\s*const slotCutoffMinutes = Number\(slotCutoffRaw\)/,
        'blank cutoff input is rejected before numeric conversion can turn it into zero');
    assert.match(owner, /slotCutoffMinutes < 0 \|\| slotCutoffMinutes > 59/);
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
