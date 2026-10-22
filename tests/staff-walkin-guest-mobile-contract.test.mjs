import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20261014043013_simplify_staff_guest_mobile_check.sql', import.meta.url), 'utf8');
const historicalMigration = await readFile(new URL('../supabase/migrations/20261014020728_reject_registered_guest_walkin_mobile.sql', import.meta.url), 'utf8');
const serviceMigration = await readFile(new URL('../supabase/migrations/20260930000532_staff_walkin_review_price_guard.sql', import.meta.url), 'utf8');
const edgeFunction = await readFile(new URL('../supabase/functions/validate-walkin-guest-phone/index.ts', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');
const dashboardHtml = await readFile(new URL('../Pages/staff_dashboard.html', import.meta.url), 'utf8');
const dashboardCss = await readFile(new URL('../Style/staff_dashboard.css', import.meta.url), 'utf8');
const publicCheckRpc = migration.match(/create or replace function public\.staff_guest_phone_is_registered[\s\S]*?\$\$;/)?.[0] || '';
const privateCheckRpc = migration.match(/create or replace function internal\.staff_guest_phone_is_registered[\s\S]*?\$\$;/)?.[0] || '';
const quotedRpc = migration.match(/create or replace function public\.staff_create_walkin_order_quoted[\s\S]*?\$\$;/)?.[0] || '';
const guestCheck = dashboard.match(/async function checkWalkinMobileAvailability\([\s\S]*?function scheduleWalkinMobileAvailabilityCheck/)?.[0] || '';

test('optional Guest phone uses format validation and an authorized exact lookup without public throttles', () => {
    assert.match(dashboard, /window\.validatePhMobile\?\.\(raw\)/);
    assert.match(dashboard, /window\.sb\.rpc\('staff_guest_phone_is_registered'/);
    assert.ok(guestCheck);
    assert.doesNotMatch(guestCheck, /validate-walkin-guest-phone|signup_phone_availability|phone_type|line_status|active Philippine mobile|provider/);
    assert.match(dashboard, /if \(!raw\)[\s\S]*?walkinState\.mobile = ''[\s\S]*?return true;/);
    assert.match(dashboard, /mobileAvailability === 'available'/);
    assert.match(dashboardHtml, /Optional · not registered/);
    assert.match(dashboard, /paintWalkinMobileStatus\('Already registered', 'in_use'\)/,
        'registered guest numbers are rejected and displayed as a denial');
    assert.match(dashboardCss, /data-state="available"/);
    assert.doesNotMatch(dashboardCss, /data-state="not_mobile"|data-state="inactive"|data-state="rate_limited"/);
    assert.match(publicCheckRpc, /security invoker[\s\S]*?select internal\.staff_guest_phone_is_registered\(p_phone\)/);
    assert.match(privateCheckRpc, /security definer[\s\S]*?set search_path = ''/);
    assert.match(privateCheckRpc, /p\.id = v_actor and p\.role in \('staff', 'admin'\) and p\.status = 'active'/);
    assert.match(privateCheckRpc, /pg_catalog\.regexp_replace\(p_phone, '\[\^0-9\]', '', 'g'\)/);
    assert.match(privateCheckRpc, /return exists \([\s\S]*?normalized_phone\.phone_e164 = v_phone_e164/);
    assert.match(migration, /revoke all on function internal\.staff_guest_phone_is_registered\(text\) from public, anon, authenticated/);
    assert.match(migration, /grant execute on function internal\.staff_guest_phone_is_registered\(text\) to authenticated/);
    assert.match(migration, /revoke all on function public\.staff_guest_phone_is_registered\(text\) from public, anon/);
    assert.match(migration, /grant execute on function public\.staff_guest_phone_is_registered\(text\) to authenticated/);
    assert.doesNotMatch(migration, /signup_phone_availability\(text\) to service_role/);
});

test('the final order RPC repeats the same Guest format and registration guard before insert', () => {
    assert.ok(quotedRpc);
    assert.match(quotedRpc, /select auth\.uid\(\)/);
    assert.match(quotedRpc, /p\.id = v_actor and p\.role in \('staff','admin'\) and p\.status = 'active'/);
    assert.match(quotedRpc, /if p_customer_id is null and p_guest_mobile is not null and btrim\(p_guest_mobile\) <> '' then/);
    assert.match(quotedRpc, /internal\.ph_mobile_to_e164\(p_guest_mobile\)/);
    assert.match(quotedRpc, /internal\.ph_mobile_to_e164\(p\.contact_num\) = v_guest_phone_e164/);
    assert.ok(quotedRpc.indexOf('This number is already registered.') < quotedRpc.indexOf('v_result := public.staff_create_walkin_order('));
    assert.match(quotedRpc, /v_quote := nullif\(p_items->v_index->>'quoted_minor',''\)::bigint/);
    assert.match(quotedRpc, /v_actual is distinct from v_quote/);
    assert.match(migration, /grant execute on function public\.staff_create_walkin_order_quoted\(uuid,text,text,jsonb,text\)\s+to authenticated,service_role/);
    assert.match(serviceMigration, /v_result:=public\.staff_create_walkin_order_quoted\(/);
    assert.match(migration, /drop function if exists public\.record_staff_walkin_phone_validation\(uuid,text\)/);
    assert.match(migration, /drop table if exists internal\.staff_walkin_phone_validation_proofs/);
    assert.match(historicalMigration, /record_staff_walkin_phone_validation/,
        'the already deployed migration remains untouched as historical migration history');
});

test('the retired deployed endpoint cannot call a provider or issue a validation proof', () => {
    assert.match(edgeFunction, /jsonCorsResponse\([\s\S]*?410/);
    assert.match(edgeFunction, /phoneValidationPreflight\(\)/);
    assert.doesNotMatch(edgeFunction, /createClient|validateWithAbstract|reserve_contact_phone_validation|record_staff_walkin_phone_validation|ABSTRACT_PHONE_VALIDATION_API_KEY/);
});
