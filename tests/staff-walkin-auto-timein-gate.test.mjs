import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const finalMigration = await readFile(new URL('../supabase/migrations/20261101150000_staff_paid_walkin_direct_update_guard.sql', import.meta.url), 'utf8');
const creationMigration = await readFile(new URL('../supabase/migrations/20260929035830_staff_booking_rules_walkin_orders_attendance_receipts.sql', import.meta.url), 'utf8');

test('effective final paid walk-in time-in definition is limited to trusted settlement paths', () => {
    const autoStart = finalMigration.indexOf('create or replace function internal.auto_time_in_paid_staff_walkin()');
    const auditStart = finalMigration.indexOf('create or replace function internal.audit_auto_time_in_paid_staff_walkin()');
    const autoFunction = finalMigration.slice(autoStart, auditStart);
    const auditFunction = finalMigration.slice(auditStart);

    for (const functionSource of [autoFunction, auditFunction]) {
        assert.match(functionSource, /coalesce\(current_setting\('inigosync\.staff_walkin_rpc', true\), ''\) = 'on'/i);
        assert.match(functionSource, /\(select auth\.role\(\)\) = 'service_role'/i);
        assert.match(functionSource, /owner_order\.staff_id = \(select auth\.uid\(\)\)/i,
            'the authenticated RPC marker only authorizes the order owner');
        assert.match(functionSource, /owner_profile\.role = 'staff'[\s\S]*?owner_profile\.status = 'active'/i,
            'the authenticated marker requires an active staff profile');
    }

    assert.match(autoFunction, /new\.status = 'confirmed'[\s\S]*?new\.amount_paid >= new\.amount_total[\s\S]*?owner_order\.status = 'paid'/i);
    assert.match(autoFunction, /tg_op\s*=\s*'INSERT' or \(tg_op\s*=\s*'UPDATE' and old\.status\s*=\s*'pending'\)/i,
        'updates can only time in on verified pending-to-confirmed settlement');
    assert.match(autoFunction, /new\.checked_in_at is not null[\s\S]*?old\.checked_in_at is distinct from new\.checked_in_at[\s\S]*?raise exception[\s\S]*?using errcode = '42501'/i,
        'authenticated direct inserts or timestamp edits cannot forge attendance');
    assert.match(autoFunction, /new\.checked_in_at := now\(\)/i);
    assert.match(auditFunction, /old\.status <> 'pending'/i,
        'the audit event is also limited to pending-to-confirmed settlement');
    assert.match(auditFunction, /'timed_in'[\s\S]*?'automatic_time_in', true/i);
    assert.match(finalMigration, /revoke all on function internal\.auto_time_in_paid_staff_walkin\(\) from public, anon, authenticated/i);
    assert.match(finalMigration, /revoke all on function internal\.audit_auto_time_in_paid_staff_walkin\(\) from public, anon, authenticated/i);
});

test('trusted marker is set only inside the active-staff walk-in order RPC', () => {
    const createStart = creationMigration.indexOf('create or replace function public.staff_create_walkin_order(');
    const createEnd = creationMigration.indexOf('\n$$;', createStart);
    const createFunction = creationMigration.slice(createStart, createEnd);
    const markerIndex = createFunction.indexOf("perform set_config('inigosync.staff_walkin_rpc','on',true)");
    assert.ok(markerIndex > 0, 'staff order RPC sets the transaction-local trusted marker');
    assert.ok(createFunction.indexOf('v_actor is null or not exists(select 1 from public.profiles') < markerIndex,
        'active staff authorization runs before setting the marker');
    assert.ok(createFunction.indexOf("case when p_payment_method='cash' then 'paid' else 'awaiting_payment' end") < markerIndex,
        'the order payment state is decided before reservation creation');

    const settleStart = creationMigration.indexOf('create or replace function public.record_paymongo_paid(');
    const settleEnd = creationMigration.indexOf('\n$$;', settleStart);
    const settlement = creationMigration.slice(settleStart, settleEnd);
    assert.ok(settlement.indexOf("update internal.staff_walkin_orders set status='paid'") < settlement.indexOf("update public.walk_in_booking w set status='confirmed'"),
        'verified PayMongo settlement marks the order paid before confirming walk-ins');
    assert.match(creationMigration.slice(settleEnd, settleEnd + 250), /to service_role/i,
        'the settlement RPC is restricted to service role');
});
