import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20261002033700_admin_delete_archived_checkout_history.sql', import.meta.url), 'utf8');
const settlement = await readFile(new URL('../supabase/migrations/20260928010000_staff_booking_rules_walkin_orders_attendance_receipts.sql', import.meta.url), 'utf8');

test('sport deletion preserves expired checkout records while detaching only inventory foreign keys', () => {
  assert.match(migration, /alter column listing_id drop not null/i);
  assert.match(migration, /foreign key \(listing_id\) references public\.court\(id\) on delete set null/i);
  assert.match(migration, /alter column unit_id drop not null/i);
  assert.match(migration, /foreign key \(unit_id\) references public\.court_unit_inventory\(id\) on delete restrict/i);
  assert.match(migration, /set unit_id=null\s+where x\.listing_id=p_court_id/i);
  assert.doesNotMatch(migration, /delete\s+from internal\.checkout_intent_items/i);
});

test('deletion locks settlement rows and permits only fully expired checkout history', () => {
  assert.ok(migration.indexOf('update internal.reservation_resource_config_lock') < migration.indexOf('for v_row_id in'));
  assert.ok(migration.indexOf('for v_row_id in') < migration.indexOf('for update;\n  end loop;\n  for v_row_id in'));
  assert.ok(migration.indexOf('checkout_intents i') < migration.indexOf('select c.sport_id into sid'));
  assert.match(migration, /i\.status is distinct from 'expired'/i);
  assert.match(migration, /a\.status is distinct from 'expired'/i);
  assert.match(migration, /x\.booking_id is not null/i);
  assert.match(migration, /p\.role='admin' and p\.status='active'/i);
  assert.match(migration, /revoke all on function public\.admin_delete_sport\(uuid,integer\) from public,anon/i);
});

test('late payment for an expired attempt is recorded for review without creating a booking', () => {
  const expiredGate = settlement.match(/if a\.status not in \('ready','review'\) then([\s\S]*?)if \(a\.pass_on_fees/i)?.[1];
  assert.ok(expiredGate, 'the payment settlement migration retains its expired-attempt gate');
  assert.match(expiredGate, /if a\.status='expired' then/i);
  assert.match(expiredGate, /set status='review'/i);
  assert.match(expiredGate, /return 'review'/i);
  assert.doesNotMatch(expiredGate, /insert into public\.booking/i);
});
