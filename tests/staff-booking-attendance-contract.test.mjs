import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20260929035830_staff_booking_rules_walkin_orders_attendance_receipts.sql', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');

function functionBody(schema, name) {
    const escaped = `${schema}.${name}`.replaceAll('.', '\\.');
    const match = migration.match(new RegExp(`create or replace function ${escaped}\\([^]*?as \\$\\$([\\s\\S]*?)\\$\\$;`, 'i'));
    assert.ok(match, `${schema}.${name} exists in the migration`);
    return match[0];
}

const checkIn = functionBody('public', 'staff_collect_cash_and_check_in');
const timeOut = functionBody('public', 'staff_record_time_out');
const automaticTimeOut = functionBody('internal', 'auto_time_out_reservations');
const unattended = functionBody('internal', 'cancel_no_show_bookings');

test('Time-In is staff-gated and settles the complete balance before recording attendance', () => {
    assert.match(checkIn, /security definer set search_path = ''/i);
    assert.match(checkIn, /p\.role in \('staff','admin'\) and p\.status='active'/i);
    assert.match(checkIn, /v_due:=round\(v_total-v_paid,2\)/i);
    assert.match(checkIn, /if v_due>0 then[\s\S]*?insert into public\.payment[\s\S]*?values\(v_due,v_due,'Cash'/i);
    assert.match(checkIn, /if exists\(select 1 from internal\.paymongo_checkout_attempts[\s\S]*?a\.status in \('creating','ready','review'\)[\s\S]*?raise exception 'Online checkout is still open for this payment'/i);
    assert.ok(checkIn.indexOf('insert into public.payment') < checkIn.indexOf('set checked_in_at=now(),amount_paid=amount_total'),
        'any outstanding cash balance is recorded before check-in sets the reservation fully paid');
    assert.match(checkIn, /if v_total is null or v_paid is null or v_paid<0 or v_paid>v_total then[\s\S]*?raise exception 'Reservation cannot be checked in'/i);
    assert.match(migration, /revoke all on function public\.staff_collect_cash_and_check_in\(text,bigint\) from public,anon/i);
    assert.match(migration, /grant execute on function public\.staff_collect_cash_and_check_in\(text,bigint\) to authenticated/i);
});

test('manual Time-Out is attendance-only, staff-gated, and records early exit without payment or refund writes', () => {
    assert.match(timeOut, /security definer set search_path = ''/i);
    assert.match(timeOut, /p\.role in \('staff','admin'\) and p\.status='active'/i);
    assert.match(timeOut, /if v_checked_in is null or v_status in \('cancelled','unattended','pending'\)/i);
    assert.match(timeOut, /v_actual:=least\(now\(\),v_end\)/i);
    assert.match(timeOut, /set checked_out_at=v_actual,[\s\S]*?status=case when v_end<=now\(\) then 'completed' else status end/i);
    assert.match(timeOut, /'early',v_actual<v_end/i);
    assert.doesNotMatch(timeOut, /insert into public\.payment|update public\.payment|delete from public\.payment|amount_paid|balance_payment|refund|credit/i,
        'manual Time-Out changes attendance state only; it creates no payment, refund, or credit');
    assert.match(migration, /revoke all on function public\.staff_record_time_out\(text,bigint\) from public,anon/i);
    assert.match(migration, /grant execute on function public\.staff_record_time_out\(text,bigint\) to authenticated/i);
});

test('scheduled Time-Out closes checked-in reservations at the scheduled end and runs automatically', () => {
    assert.match(automaticTimeOut, /where b\.status='confirmed' and b\.checked_in_at is not null and b\.end_at<=now\(\)/i);
    assert.match(automaticTimeOut, /set checked_out_at=coalesce\(b\.checked_out_at,b\.end_at\),status='completed'/i);
    assert.match(automaticTimeOut, /where w\.status='confirmed' and w\.checked_in_at is not null and w\.end_at<=now\(\)/i);
    assert.match(automaticTimeOut, /set checked_out_at=coalesce\(w\.checked_out_at,w\.end_at\),status='completed'/i);
    assert.match(automaticTimeOut, /'system','auto_timed_out'/i);
    assert.match(migration, /create or replace function public\.process_due_attendance\(\)[\s\S]*?internal\.auto_time_out_reservations\(\)[\s\S]*?internal\.cancel_no_show_bookings\(\)/i);
    assert.match(migration, /cron\.schedule\('inigosync-process-due-attendance','\* \* \* \* \*','select public\.process_due_attendance\(\)'\)/i);
});

test('no-shows become unattended after grace and Overview removes terminal rows', () => {
    assert.match(unattended, /set status='unattended',auto_cancelled_at=now\(\)/i);
    assert.match(unattended, /and b\.checked_in_at is null[\s\S]*?\)<now\(\)/i);
    assert.match(unattended, /and w\.checked_in_at is null[\s\S]*?\)<now\(\)/i);
    assert.match(dashboard, /if \(status === 'cancelled' \|\| status === 'completed' \|\| status === 'unattended'\) return false;/,
        'cancelled, completed, and unattended reservations are excluded from Overview entries');
});
