-- Enrich only newly-created immutable payment acknowledgments with the
-- transaction ID and reservation duration/unit facts available at issue time.
-- Existing payloads are deliberately left intact when the payment already
-- has an acknowledgment, so old records never acquire guessed rate data.
-- The rate amount is intentionally omitted: reservation rows do not retain
-- the historical configured price, and deriving one from the total is unsafe.
create or replace function internal.enrich_new_payment_acknowledgment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_reservation_id bigint;
  v_duration integer;
  v_quantity integer;
  v_rate_unit text;
  v_billable_quantity numeric;
  v_found boolean;
begin
  for v_item in select value from jsonb_array_elements(coalesce(new.payload->'items', '[]'::jsonb)) loop
    v_reservation_id := nullif(v_item->>'reservation_id', '')::bigint;
    v_found := false;
    v_duration := null;
    v_quantity := null;
    v_rate_unit := null;
    v_billable_quantity := null;

    if v_reservation_id is not null then
      if new.order_id is not null then
        select w.duration_minutes, w.rate_quantity, w.rate_unit_snapshot
          into v_duration, v_quantity, v_rate_unit
        from public.walk_in_booking w
        where w.walkin_id = v_reservation_id and w.walkin_order_id = new.order_id;
        v_found := found;
      else
        select b.duration_minutes, b.rate_quantity, b.rate_unit_snapshot
          into v_duration, v_quantity, v_rate_unit
        from public.booking b
        where b.booking_id = v_reservation_id
          and (b.payment_id = new.payment_id or b.balance_payment_id = new.payment_id);
        v_found := found;
        if not v_found then
          select w.duration_minutes, w.rate_quantity, w.rate_unit_snapshot
            into v_duration, v_quantity, v_rate_unit
          from public.walk_in_booking w
          where w.walkin_id = v_reservation_id
            and (w.payment_id = new.payment_id or w.balance_payment_id = new.payment_id);
          v_found := found;
        end if;
      end if;
    end if;

    if v_found then
      if v_rate_unit = '/hr' and v_duration is not null then
        -- Hourly pricing uses exact elapsed duration / 60, including
        -- mixed day/night schedules. `rate_quantity` is set count only.
        v_billable_quantity := v_duration::numeric / 60;
      elsif v_rate_unit = '/set' then
        v_billable_quantity := v_quantity;
      end if;
      v_item := v_item || jsonb_strip_nulls(jsonb_build_object(
        'duration_minutes', v_duration,
        'rate_quantity', v_quantity,
        'rate_unit', v_rate_unit,
        'billable_quantity', v_billable_quantity
      ));
    end if;
    v_items := v_items || jsonb_build_array(v_item);
  end loop;

  new.payload := jsonb_set(new.payload, '{items}', v_items, true)
    || jsonb_build_object('transaction_id', new.payment_id);
  return new;
end;
$$;

revoke all on function internal.enrich_new_payment_acknowledgment() from public, anon, authenticated;
drop trigger if exists payment_acknowledgment_receipt_details on internal.payment_acknowledgments;
create trigger payment_acknowledgment_receipt_details
before insert on internal.payment_acknowledgments
for each row execute function internal.enrich_new_payment_acknowledgment();
