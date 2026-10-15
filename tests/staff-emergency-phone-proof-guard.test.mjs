import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20261014204018_staff_emergency_phone_proof_guard.sql', import.meta.url), 'utf8');
const phoneMigration = await readFile(new URL('../supabase/migrations/20261015000000_database_only_contact_phone_checks.sql', import.meta.url), 'utf8');
const edge = await readFile(new URL('../supabase/functions/validate-contact-phone/index.ts', import.meta.url), 'utf8');
const staff = await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');

function functionBody(name) {
    const match = migration.match(new RegExp(`create or replace function ${name.replaceAll('.', '\\.')}\\([^]*?as \\$\\$([\\s\\S]*?)\\$\\$;`, 'i'));
    assert.ok(match, `${name} exists in the migration`);
    return match[1];
}

test('staff emergency profile updates reject invalid and unproved changes, consuming a matching proof once', () => {
    const guard = functionBody('internal.guard_staff_emergency_phone_validation');
    assert.match(migration, /before update of emergency_contact_number on public\.profiles/i);
    assert.match(guard, /auth\.jwt\(\)\s*->>\s*'role'\s*,\s*''\s*\)\s*<>\s*'authenticated'/i);
    assert.match(guard, /auth\.uid\(\)\s+is distinct from new\.id/i);
    assert.match(guard, /old\.role\s+is distinct from\s+'staff'[\s\S]*?old\.status\s+is distinct from\s+'active'/i);
    assert.match(guard, /internal\.ph_mobile_to_e164\(new\.emergency_contact_number\)/i);
    assert.match(guard, /if\s+v_stored\s+is null\s+then[\s\S]*?errcode\s*=\s*'22023'/i,
        'invalid emergency values are rejected server-side');
    assert.match(guard, /new\.emergency_contact_number\s+is not distinct from old\.emergency_contact_number[\s\S]*?return new/i,
        'unchanged emergency values need no proof');
    assert.match(guard, /nullif\(btrim\(new\.emergency_contact_number\),\s*''\)\s+is null[\s\S]*?new\.emergency_contact_number\s*:=\s*null[\s\S]*?return new/i,
        'blank emergency values remain allowed');
    assert.match(guard, /internal\.ph_mobile_to_e164\(old\.emergency_contact_number\)\s*=\s*v_stored[\s\S]*?return new/i,
        'format-only changes to an equivalent saved number do not need another proof');
    assert.match(guard, /delete from internal\.contact_phone_validation_proofs[\s\S]*?proof\.purpose\s*=\s*'emergency'[\s\S]*?proof\.expires_at\s*>\s*now\(\)[\s\S]*?returning true into v_proof/i,
        'the trigger consumes only a matching, unexpired, purpose-specific proof');
    assert.match(guard, /if\s+v_proof\s+is distinct from\s+true\s+then[\s\S]*?errcode\s*=\s*'42501'/i,
        'missing or already-consumed proof fails closed');
    assert.match(guard, /new\.emergency_contact_number\s*:=\s*v_stored/i,
        'successful writes persist canonical E.164 values');
});

test('emergency duplicates are advisory while contact writes retain duplicate protection', () => {
    const guard = functionBody('internal.guard_staff_emergency_phone_validation');
    const proofConsumeAt = guard.indexOf('delete from internal.contact_phone_validation_proofs');

    assert.ok(proofConsumeAt >= 0, 'valid emergency updates still consume a matching proof');
    assert.doesNotMatch(guard, /v_duplicate|contact number is already in use|lock_profile_phone_numbers/i,
        'emergency duplicates do not block a shared family number');
    assert.match(phoneMigration, /select exists \([\s\S]*?p\.id <> new\.id[\s\S]*?contact number is already in use/i,
        'the contact-number write guard continues to block duplicates');
    assert.match(phoneMigration, /create or replace function public\.contact_phone_exists[\s\S]*?customer_private_details/i,
        'emergency advisory checks cover saved contact and emergency-number locations');
    const advisory = phoneMigration.split('create or replace function public.contact_phone_exists')[1]
        .split('create or replace function public.admin_phone_number_exists')[0];
    assert.doesNotMatch(advisory, /p\.id\s*<>\s*p_user_id|d\.user_id\s*<>\s*p_user_id/i,
        'already saved numbers on the requesting account also produce an advisory warning');
});

test('phone validation Edge Function only accepts supported purposes and records the matching proof', () => {
    assert.match(edge, /body\.purpose === undefined \? "contact" : body\.purpose/);
    assert.match(edge, /purpose !== "contact" && purpose !== "emergency"/);
    assert.match(edge, /purpose === "emergency" && !\["staff", "customer"\]\.includes\(profile\.role\)/);
    assert.match(edge, /reserve_contact_phone_check"\s*,\s*\{/);
    assert.match(edge, /record_contact_phone_validation"\s*,\s*\{[\s\S]*?p_purpose:\s*purpose/);
    assert.match(edge, /purpose === "emergency" \? "contact_phone_exists" : "contact_phone_in_use"/,
        'emergency duplicates are advisory while contact duplicates are blocked');
    assert.match(edge, /phoneInUse && purpose === "contact"/);
    assert.match(edge, /available: !phoneInUse/);
    assert.doesNotMatch(edge, /validateWithAbstract|ABSTRACT_PHONE_VALIDATION_API_KEY|line_status|phone_type/,
        'no paid provider or stale active/type claims remain');
    assert.doesNotMatch(edge, /json\(\{[^\n]*(profile\.id|contact_num)/,
        'responses do not expose profile IDs or saved numbers');
});

test('staff client requests emergency-purpose proof and protects exact mobile drafts across async checks', () => {
    const handlerStart = staff.indexOf("staffSettingsSaveProfileBtn.addEventListener('click'");
    const handlerEnd = staff.indexOf("staffSettingsCancelBtn?.addEventListener", handlerStart);
    const handler = staff.slice(handlerStart, handlerEnd);
    const confirmAt = handler.indexOf("await confirmStaffAction('Save these personal information changes?'");
    const captureAt = handler.indexOf('const mobileRaw = mobileInput ? mobileInput.value.trim() :', confirmAt);
    const validationAt = handler.indexOf("await window.sb.functions.invoke('validate-contact-phone'", captureAt);
    const mobileDraftCheck = handler.indexOf('latestMobileRaw !== mobileRaw', validationAt);
    const updateAt = handler.indexOf("window.sb.from('profiles').update(fullPatch)", mobileDraftCheck);
    assert.ok(confirmAt >= 0 && captureAt > confirmAt && validationAt > captureAt && mobileDraftCheck > validationAt && updateAt > mobileDraftCheck,
        'the current mobile draft is captured after confirmation and rechecked after the database check, before update');
    assert.match(handler, /body:\s*\{\s*phone:\s*mobileCheck\.normalized,\s*purpose:\s*'contact'\s*\}/);
    assert.match(staff, /body:\s*\{\s*phone:\s*localCheck\.normalized,\s*purpose:\s*'emergency'\s*\}/,
        'emergency validation requests the purpose-specific proof');
    assert.match(handler, /latestEmergencyNumber !== emergency_contact_number\s*\|\|\s*!ensureStaffEmergencyPhoneValidated\(\)/,
        'the emergency draft and fresh proof are also checked immediately before update');
});
