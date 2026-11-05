-- Permit staff booking-extension intents while preserving the existing attempt shapes.
alter table internal.paymongo_checkout_attempts
  drop constraint if exists paymongo_attempt_balance_fields;

alter table internal.paymongo_checkout_attempts
  add constraint paymongo_attempt_balance_fields check (
    (balance_id is null and balance_source is null and
      ((walkin_order_id is null and staff_id is null)
        or (walkin_order_id is not null and staff_id is not null)))
    or (balance_id is not null and balance_source is not null
      and staff_id is not null and walkin_order_id is null)
    or (balance_id is null and balance_source is null
      and staff_id is not null and intent_id is not null and walkin_order_id is null)
  );
