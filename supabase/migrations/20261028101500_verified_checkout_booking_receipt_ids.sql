-- Expose only booking and payment IDs linked to a paid checkout attempt. The
-- Edge Function calls this as service_role after owner-scoping the attempt.
create or replace function public.get_paid_checkout_booking_receipts(
  p_attempt_id uuid,
  p_customer_id uuid
) returns table(booking_id bigint, payment_id bigint)
language sql security definer set search_path = '' as $$
  select b.booking_id, b.payment_id
  from internal.paymongo_checkout_attempts a
  join public.booking b on b.booking_id = a.booking_id
  where a.id = p_attempt_id
    and a.customer_id = p_customer_id
    and a.status = 'paid'
    and a.staff_id is null
    and a.walkin_order_id is null
    and a.balance_id is null
    and a.intent_id is null
    and b.payment_id is not null
  union
  select b.booking_id, b.payment_id
  from internal.paymongo_checkout_attempts a
  join internal.checkout_intents i on i.id = a.intent_id
  join internal.checkout_intent_items x on x.intent_id = a.intent_id
  join public.booking b on b.booking_id = x.booking_id
  where a.id = p_attempt_id
    and a.customer_id = p_customer_id
    and a.status = 'paid'
    and a.staff_id is null
    and a.walkin_order_id is null
    and a.balance_id is null
    and i.customer_id = p_customer_id
    and i.status = 'paid'
    and b.payment_id is not null;
$$;
revoke all on function public.get_paid_checkout_booking_receipts(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_paid_checkout_booking_receipts(uuid,uuid) to service_role;
