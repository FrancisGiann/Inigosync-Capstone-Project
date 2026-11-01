import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20261101180500_staff_scheduled_walkin_timein.sql', import.meta.url), 'utf8');
const section = (start, end) => {
    const from = migration.indexOf(start);
    const to = end ? migration.indexOf(end, from + start.length) : migration.length;
    assert.ok(from >= 0 && to > from, `Missing SQL section: ${start}`);
    return migration.slice(from, to);
};

test('staff booking Time-In opens 30 minutes before start while manual walk-in Time-In is rejected', () => {
    const cash = section('create function public.staff_collect_cash_and_check_in(', 'alter function public.prepare_paymongo_balance_checkout(');
    assert.match(cash, /if p_source <> 'booking'/);
    assert.match(cash, /now\(\)<v_start-interval '30 minutes'/);
    assert.match(cash, /p\.role in \('staff','admin'\) and p\.status='active'/);
    assert.match(cash, /return internal\.staff_collect_cash_and_check_in\(p_source,p_id\)/);
    assert.match(migration, /revoke all on function internal\.staff_collect_cash_and_check_in\(text,bigint\)\s+from public,anon,authenticated,service_role/);
    assert.match(migration, /grant execute on function public\.staff_collect_cash_and_check_in\(text,bigint\)\s+to authenticated/);

    const qr = section('create function public.prepare_paymongo_balance_checkout(', 'alter function public.staff_record_time_out(');
    assert.match(qr, /now\(\)<v_start-interval '30 minutes'/);
    assert.match(qr, /return internal\.prepare_paymongo_balance_checkout\(p_source,p_id,p_staff_id\)/);
    assert.match(migration, /revoke all on function internal\.prepare_paymongo_balance_checkout\(text,bigint,uuid\)\s+from public,anon,authenticated,service_role/);
});

test('paid walk-ins time in only during their scheduled slot and before-start Time-Out is guarded', () => {
    const trigger = section('create or replace function internal.auto_time_in_paid_staff_walkin()', 'create or replace function internal.auto_time_in_due_paid_walkins()');
    assert.match(trigger, /new\.time_date<=now\(\) and new\.end_at>now\(\)/);
    assert.match(trigger, /new\.checked_in_at\s*:=\s*now\(\)/);
    assert.match(trigger, /current_setting\('inigosync\.auto_walkin_start',true\)/);
    assert.match(trigger, /raise exception 'Order-backed walk-in attendance requires trusted scheduled settlement'/);

    const due = section('create or replace function internal.auto_time_in_due_paid_walkins()', 'create or replace function public.process_due_attendance()');
    assert.match(due, /w\.time_date<=now\(\) and w\.end_at>now\(\)/);
    assert.match(due, /w\.checked_in_at is null and w\.checked_out_at is null/);
    assert.match(due, /w\.payment_id=o\.payment_id/);
    assert.match(due, /'timed_in','walkin'/);
    assert.match(due, /'automatic_time_in',true/);
    assert.match(due, /w\.end_at<=now\(\)/);
    assert.doesNotMatch(due, /status='unattended'/);

    const schedule = section('create or replace function public.process_due_attendance()');
    assert.ok(schedule.indexOf('auto_time_in_due_paid_walkins()') < schedule.indexOf('auto_time_out_reservations()'));
    assert.match(schedule, /internal\.cancel_no_show_bookings\(\)/);

    const timeOut = section('create function public.staff_record_time_out(', 'create or replace function internal.auto_time_in_paid_staff_walkin()');
    assert.match(timeOut, /if v_start is not null and now\(\)<v_start/);
    assert.match(timeOut, /return internal\.staff_record_time_out\(p_source,p_id\)/);
    assert.match(migration, /revoke all on function internal\.staff_record_time_out\(text,bigint\)\s+from public,anon,authenticated,service_role/);
});
