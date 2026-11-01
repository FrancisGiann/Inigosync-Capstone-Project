import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20261101200000_staff_balance_settlement_attendance_boundary.sql', import.meta.url), 'utf8');
const source = (await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const originalSettlement = (await readFile(new URL('../supabase/migrations/20260929035830_staff_booking_rules_walkin_orders_attendance_receipts.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('verified PayMongo balance settlement leaves booking attendance for the explicit staff Time-In action', () => {
    assert.match(migration, /create or replace function internal\.keep_paymongo_balance_settlement_unchecked\(\)/);
    assert.match(migration, /\(select auth\.jwt\(\)->>'role'\)='service_role'/);
    assert.match(migration, /new\.balance_payment_method='PayMongo'/);
    assert.match(migration, /new\.balance_payment_id is distinct from old\.balance_payment_id/);
    assert.match(migration, /new\.amount_paid>=new\.amount_total/);
    assert.match(migration, /new\.checked_in_at:=old\.checked_in_at/);
    assert.match(migration, /before update on public\.booking\s+for each row execute function internal\.keep_paymongo_balance_settlement_unchecked\(\)/);
    assert.match(migration, /new\.action='collected_online_balance'[\s\S]*new\.entity_type='booking'[\s\S]*jsonb_build_object\('time_in_recorded',false\)/,
        'the audit event reports payment only when the saved booking remains unchecked');
    assert.doesNotMatch(migration, /create or replace function public\.record_paymongo_paid/,
        'settlement pricing, webhook idempotency, and existing no-show rules are not copied or rewritten');

    const returnBranchStart = source.indexOf("} else if (balanceReturnKind === 'return') {");
    const returnBranchEnd = source.indexOf('\n        }\n\n        refreshBookingOverview();', returnBranchStart);
    assert.ok(returnBranchStart >= 0 && returnBranchEnd > returnBranchStart, 'PayMongo return handler exists');
    const returnBranch = source.slice(returnBranchStart, returnBranchEnd);
    assert.match(returnBranch, /openTimeInModal\(result\.row\)/);
    assert.doesNotMatch(returnBranch, /staff_collect_cash_and_check_in|checked_in_at\s*=|checkedInAt\s*=/,
        'a confirmed payment return only opens the staff review modal');

    const settle = originalSettlement.slice(originalSettlement.indexOf('  if a.balance_id is not null then'), originalSettlement.indexOf('  -- Preserve support for a pending booking'));
    assert.match(settle, /v_late_balance:=v_balance_start is null or v_balance_end is null or v_balance_end<=now\(\)/);
    assert.match(settle, /now\(\)>v_balance_start\+make_interval\(mins=>coalesce\(v_grace,30\)\)/);
    assert.match(settle, /status=case when v_late_balance then 'unattended' else status end/);
});

test('paid walk-in auto-Time-In remains on-slot and accepts only its active staff/admin order owner or trusted service role', () => {
    assert.match(migration, /new\.walkin_order_id is not null and new\.checked_in_at is null/);
    assert.match(migration, /new\.time_date<=now\(\) and new\.end_at>now\(\)/);
    assert.match(migration, /o\.status='paid'\s+and o\.payment_id=new\.payment_id/);
    assert.match(migration, /p\.role in \('staff','admin'\) and p\.status='active'/);
    assert.match(migration, /o\.staff_id=\(select auth\.uid\(\)\)/);
    assert.match(migration, /\(select auth\.jwt\(\)->>'role'\)='service_role'/);
    assert.match(migration, /create trigger zzzzzzzz_walkin_audit_auto_time_in_paid_order/);
    assert.match(migration, /coalesce\(p\.role,'staff'\),'timed_in'/,
        'the scheduled walk-in job records the real owner role, including admin');
    assert.doesNotMatch(migration, /staff_record_time_in|staff_time_in_walkin/,
        'the manual walk-in Time-In policy is unchanged');
});
