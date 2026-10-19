-- Owner report income from the payment ledger, bucketed by payment time.
-- Includes online bookings, walk-in bookings, balance payments, and paid staff orders.
create or replace function public.owner_income_report(p_from_at timestamptz, p_to_at timestamptz, p_bucket text)
returns table(bucket_start timestamptz, income numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_owner uuid := (select auth.uid());
  v_step interval;
  v_local_from timestamp without time zone;
  v_local_to timestamp without time zone;
  v_expected_span interval;
begin
  if v_owner is null or not exists (
    select 1 from public.profiles p
    where p.id = v_owner and p.role = 'admin' and coalesce(p.status, 'active') <> 'disabled'
  ) then
    raise exception 'Active owner access is required' using errcode = '42501';
  end if;
  if p_bucket is null or p_bucket not in ('day', 'month', 'year') or p_from_at is null or p_to_at is null or p_from_at >= p_to_at then
    raise exception 'Invalid income report range' using errcode = '22023';
  end if;
  v_step := case p_bucket when 'day' then interval '1 day' when 'month' then interval '1 month' else interval '1 year' end;
  v_expected_span := case p_bucket when 'day' then interval '7 days' when 'month' then interval '1 year' else interval '10 years' end;
  v_local_from := p_from_at at time zone 'Asia/Manila';
  v_local_to := p_to_at at time zone 'Asia/Manila';

  -- Accept only the bounded owner-report windows: a Monday-to-Monday week,
  -- one complete calendar year, or one complete calendar decade. Convert to
  -- Manila wall time first so UTC offsets cannot shift the intended buckets.
  if v_local_from <> date_trunc('day', v_local_from)
    or v_local_to <> date_trunc('day', v_local_to)
    or v_local_to <> v_local_from + v_expected_span
    or (p_bucket = 'day' and extract(isodow from v_local_from) <> 1)
    or (p_bucket = 'month' and (extract(month from v_local_from) <> 1 or extract(day from v_local_from) <> 1))
    or (p_bucket = 'year' and (extract(month from v_local_from) <> 1 or extract(day from v_local_from) <> 1 or mod(extract(year from v_local_from)::integer, 10) <> 0)) then
    raise exception 'Income report range must match a complete supported Manila calendar period' using errcode = '22023';
  end if;

  return query
    with linked_payments as (
      select b.payment_id from public.booking b where b.payment_id is not null
      union select b.balance_payment_id from public.booking b where b.balance_payment_id is not null
      union select w.payment_id from public.walk_in_booking w where w.payment_id is not null
      union select w.balance_payment_id from public.walk_in_booking w where w.balance_payment_id is not null
      union select o.payment_id from internal.staff_walkin_orders o where o.payment_id is not null and o.status = 'paid'
    ), payments as (
      select date_trunc(p_bucket, pay.created_at at time zone 'Asia/Manila') as local_bucket,
             coalesce(nullif(pay.base_minor, 0)::numeric / 100, pay.paid) as amount
      from linked_payments linked
      join public.payment pay on pay.payment_id = linked.payment_id
      where pay.created_at >= p_from_at and pay.created_at < p_to_at
        and coalesce(nullif(pay.base_minor, 0)::numeric / 100, pay.paid) > 0
    ), buckets as (
      select generate_series(v_local_from, v_local_to - v_step, v_step) as local_bucket
    )
    select (b.local_bucket at time zone 'Asia/Manila') as bucket_start,
           coalesce(sum(payments.amount), 0)::numeric as income
    from buckets b left join payments on payments.local_bucket = b.local_bucket
    group by b.local_bucket order by b.local_bucket;
end;
$$;

revoke all on function public.owner_income_report(timestamptz,timestamptz,text) from public, anon;
grant execute on function public.owner_income_report(timestamptz,timestamptz,text) to authenticated;
