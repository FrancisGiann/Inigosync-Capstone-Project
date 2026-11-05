import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const resources = await readFile(new URL('../supabase/migrations/20260925014632_physical_court_resources.sql', import.meta.url), 'utf8');
const checkout = await readFile(new URL('../supabase/migrations/20260929035830_staff_booking_rules_walkin_orders_attendance_receipts.sql', import.meta.url), 'utf8');
const nonblocking = await readFile(new URL('../supabase/migrations/20261105024336_nonblocking_paymongo_checkouts.sql', import.meta.url), 'utf8');
const customerUi = await readFile(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
const staffUi = await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');

test('paid reservations serialize through a physical-resource exclusion constraint', () => {
  assert.match(resources, /constraint reservation_resource_slots_no_overlap exclude using gist\s*\(resource_id with =, during with &&\)/i,
    'overlapping paid bookings and walk-ins cannot reserve the same physical resource');
  assert.match(resources, /create trigger booking_sync_reservation_resource_slots after insert or update on public\.booking/i);
  assert.match(resources, /create trigger walkin_sync_reservation_resource_slots after insert or update on public\.walk_in_booking/i);
  assert.match(checkout, /create or replace function public\.prepare_paid_checkout_cart[\s\S]*?pg_advisory_xact_lock\(87499182034132371::bigint\)/i,
    'customer checkout validates against current reservations under the shared transaction lock');
  assert.match(checkout, /create or replace function public\.staff_create_walkin_order[\s\S]*?pg_advisory_xact_lock\(87499182034132371::bigint\)/i,
    'staff walk-in validation and final cash booking use the shared transaction lock');
});

test('online checkout attempts do not reserve availability before payment', () => {
  assert.match(nonblocking, /public\.prepare_paid_checkout_cart\(uuid,jsonb,text\)/);
  assert.match(nonblocking, /create or replace function internal\.stage_online_walkin_reservation\(\)/);
  assert.match(nonblocking, /prepare_staff_booking_extension_checkout\(text,bigint,integer,uuid,timestamptz\)/);
  assert.match(nonblocking, /delete from internal\.reservation_resource_slots\s+where hold_item_id is not null or walkin_order_id is not null/i,
    'the migration removes existing checkout-only occupancy while keeping attempt and staged quote records');
  assert.match(nonblocking, /Customer checkout hold insertion changed[\s\S]*?replace\(v_definition, v_old, ''\)/,
    'customer cart preparation removes its former provisional slot insert');
  assert.match(nonblocking, /Extension checkout hold insertion changed[\s\S]*?execute replace\(v_definition, v_old, ''\)/,
    'extension preparation removes its former provisional slot insert');
  assert.match(nonblocking, /or exists\(select 1 from internal\.checkout_intent_items x join internal\.checkout_intents i[\s\S]*?where not exists\(select 1 from internal\.reservation_resource_slots r where r\.hold_item_id=x\.id\)\) then\s*\$old\$;\s*v_old := btrim\(v_old, E'\\r\\n'\);\s*if position\(v_old in v_updated\) = 0 then\s*raise exception 'Customer cart hold integrity check changed; review nonblocking checkout migration'/i,
    'the refresh migration matches the complete checkout hold integrity clause and fails closed if the live definition drifts');
  assert.match(nonblocking, /v_updated := replace\(v_updated, v_old, ' then'\)/i,
    'removing the hold integrity clause preserves the enclosing IF terminator');
  const refreshStart = nonblocking.indexOf("'internal.refresh_reservation_resource_slots()'");
  const refreshEnd = nonblocking.indexOf('execute v_updated;', refreshStart);
  const refreshMigration = nonblocking.slice(refreshStart, refreshEnd);
  const refreshAnchors = [...refreshMigration.matchAll(/v_old := \$old\$([\s\S]*?)\$old\$;/g)].map(match => match[1]);
  assert.ok(refreshAnchors.length >= 4, 'refresh migration contains cart, walk-in, and integrity anchors');
  assert.equal((refreshMigration.match(/v_old := btrim\(v_old, E'\\r\\n'\);/g) || []).length, 4,
    'refresh anchors trim boundary newlines before each sequential replacement');
  const trimAnchorNewlines = value => value.replace(/^[\r\n]+|[\r\n]+$/g, '');
  const adjacentRefreshSql = `prefix${refreshAnchors[0]}${refreshAnchors[1].replace(/^[\r\n]+/, '')}suffix`;
  const afterCartHoldRemoval = adjacentRefreshSql.replace(trimAnchorNewlines(refreshAnchors[0]), '');
  assert.ok(afterCartHoldRemoval.includes(trimAnchorNewlines(refreshAnchors[1])),
    'removing the cart hold preserves the walk-in block anchor at their shared newline');
  const stageStart = nonblocking.indexOf('create or replace function internal.stage_online_walkin_reservation()');
  const stageEnd = nonblocking.indexOf('$function$;', stageStart);
  assert.ok(stageStart >= 0 && stageEnd > stageStart);
  assert.doesNotMatch(nonblocking.slice(stageStart, stageEnd), /insert into internal\.reservation_resource_slots/,
    'new staff walk-ins stage reservation details without provisional slot rows');
  const stage = nonblocking.slice(stageStart, stageEnd);
  assert.match(stage, /from internal\.reservation_resource_slots rs[\s\S]*?current_map\.court_unit_id=new\.court_unit_inventory_id[\s\S]*?rs\.booking_id is not null or rs\.walkin_id is not null or rs\.maintenance_id is not null/i,
    'walk-in staging checks overlapping real occupancy through shared physical resources');
  assert.match(stage, /current_resource\.is_active/i,
    'the overlap check only uses active physical resources');
  assert.match(stage, /from internal\.staff_walkin_order_reservations prior[\s\S]*?prior\.order_id=new\.walkin_order_id[\s\S]*?tstzrange\(prior\.time_date,prior\.end_at,'\[\)'\)/i,
    'walk-in staging rejects overlapping duplicate items in the same order');
  assert.match(stage, /using errcode='23P01'/i,
    'staging conflicts use the existing physical-slot conflict SQLSTATE');
  const walkinCreate = checkout.slice(checkout.indexOf('create or replace function public.staff_create_walkin_order('));
  assert.match(walkinCreate, /pg_advisory_xact_lock\(87499182034132371::bigint\)[\s\S]*?insert into public\.walk_in_booking/i,
    'the authoritative walk-in RPC holds the shared availability lock across validation, trigger staging, and order creation');
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
  assert.match(nonblocking, /exception when exclusion_violation then[\s\S]*paid_extension_slot_conflict/,
    'paid extensions recheck the real slot under the exclusion constraint');
  assert.match(nonblocking, /exception when exclusion_violation then[\s\S]*paid_walkin_slot_conflict/,
    'paid walk-ins recheck the real slot under the exclusion constraint');
  assert.match(nonblocking, /exception when exclusion_violation then[\s\S]*paid_extension_slot_conflict[\s\S]*refund_review_required',true/i,
    'a paid extension collision remains unextended and creates an owner review record');
  assert.match(nonblocking, /exception when exclusion_violation then[\s\S]*paid_walkin_slot_conflict[\s\S]*refund_review_required',true/i,
    'a paid walk-in collision remains unconfirmed and creates an owner review record');
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
