-- Preserve the authoritative court price without prepaying pending online
-- walk-in lines. The later payment guard requires amount_paid = 0 until the
-- verified PayMongo webhook settles the order.
create or replace function internal.set_walkin_authoritative_amount()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.rate_unit_snapshot := internal.authoritative_reservation_rate_unit(
    new.court_listing_id,new.court_unit_inventory_id);
  new.amount_total := internal.authoritative_reservation_amount(
    new.court_listing_id,new.court_unit_inventory_id,new.time_date,
    new.end_at,new.duration_minutes,new.rate_quantity);
  new.amount_paid := case
    when new.walkin_order_id is not null and new.status='pending'
      and new.payment_id is null then 0
    else coalesce(new.amount_total,0)
  end;
  return new;
end;
$$;
revoke all on function internal.set_walkin_authoritative_amount() from public,anon,authenticated,service_role;
