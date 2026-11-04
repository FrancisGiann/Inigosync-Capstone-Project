import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const resources = await readFile(new URL('../supabase/migrations/20260925014632_physical_court_resources.sql', import.meta.url), 'utf8');
const holds = await readFile(new URL('../supabase/migrations/20260926164901_paid_checkout_holds.sql', import.meta.url), 'utf8');
const checkout = await readFile(new URL('../supabase/migrations/20260929035830_staff_booking_rules_walkin_orders_attendance_receipts.sql', import.meta.url), 'utf8');
const customerUi = await readFile(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
const staffUi = await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');

test('customer and staff reservations serialize through a physical-resource exclusion constraint', () => {
  assert.match(resources, /constraint reservation_resource_slots_no_overlap exclude using gist\s*\(resource_id with =, during with &&\)/i,
    'overlapping bookings, walk-ins, and checkout holds cannot reserve the same physical resource');
  assert.match(resources, /create trigger booking_sync_reservation_resource_slots after insert or update on public\.booking/i);
  assert.match(resources, /create trigger walkin_sync_reservation_resource_slots after insert or update on public\.walk_in_booking/i);
  assert.match(holds, /insert into internal\.reservation_resource_slots\(hold_item_id,resource_id,during\)/i,
    'customer checkouts reserve the physical slot before opening provider checkout');
  assert.match(checkout, /create or replace function public\.prepare_paid_checkout_cart[\s\S]*?pg_advisory_xact_lock\(87499182034132371::bigint\)/i,
    'customer checkout holds use the same transaction lock');
  assert.match(checkout, /create or replace function public\.staff_create_walkin_order[\s\S]*?pg_advisory_xact_lock\(87499182034132371::bigint\)/i,
    'staff cash and online walk-in order creation use the same transaction lock');
});

test('online reservation confirmation remains gated by verified payment settlement', () => {
  const settlement = checkout.slice(checkout.indexOf('create or replace function public.record_paymongo_paid('));
  assert.match(settlement, /insert into public\.booking[\s\S]*?values\(a\.customer_id,[\s\S]*?'confirmed'/i,
    'customer bookings are created confirmed only inside PayMongo settlement');
  assert.match(settlement, /update public\.walk_in_booking w set status='confirmed',payment_method='PayMongo'[\s\S]*?where w\.walkin_order_id=v_order\.id and w\.status='pending'/i,
    'online walk-ins are confirmed only after settlement validates the pending order');
  assert.match(settlement, /if a\.status='paid' then return 'duplicate'/i,
    'duplicate provider events remain idempotent');
  assert.match(settlement, /exception when others then[\s\S]*?set status='review'[\s\S]*?return 'review'/i,
    'captured payments that cannot reserve a slot remain recoverable for review');
});

test('cash walk-ins use a server payment RPC and conflict messages tell staff to retry availability', () => {
  assert.match(staffUi, /staff_create_walkin_order_quoted/);
  assert.match(checkout, /One of the selected physical courts is already reserved at that time/i,
    'the authoritative staff RPC returns a specific conflict when physical-slot exclusion rejects an insert');
  assert.match(staffUi, /create\?\.error\?\.message \|\| 'Could not create the walk-in order/,
    'staff sees the actionable server conflict instead of a false success');
  assert.match(staffUi, /This court time was just reserved\. No booking or payment was recorded; return the cash and choose another available time\./,
    'cash conflict tells staff not to leave cash collected after the database rejects the reservation');
  assert.match(customerUi, /Payment may have been received, but the time was not confirmed\. Do not pay again; contact the sports center to arrange another time or a refund\./,
    'captured payment review explains that a reservation is not confirmed and gives a recovery action');
  assert.match(customerUi, /data\.status === 'expired'[\s\S]*?Checkout expired or payment did not complete, so your booking was not confirmed\. Check availability, then retry checkout if you still want this time\./,
    'expired or declined checkout gets a retry message that does not imply funds were captured');
  assert.match(customerUi, /toLowerCase\(\) === 'review'[\s\S]*?Payment may have been received/,
    'captured-payment review remains distinct from a failed payment');
  assert.match(staffUi, /Payment has not been confirmed yet, so this reservation is not booked\.[\s\S]*?do not collect payment again; ask the owner to verify the charge and arrange another time or a refund\./,
    'staff walk-in pending acknowledgment gives a safe recovery message for unconfirmed/captured outcomes');
});
