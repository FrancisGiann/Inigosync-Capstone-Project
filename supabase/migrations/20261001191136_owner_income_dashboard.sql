-- Owner income reporting from the payment ledger. Values are recognized at
-- payment time, before provider fees, and only through booking/payment links.
create or replace function public.owner_income_period(p_period text)
returns table(bucket_start timestamptz, income numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_owner uuid := (select auth.uid());
  v_now_local timestamp without time zone := now() at time zone 'Asia/Manila';
  v_start timestamp without time zone;
  v_end timestamp without time zone;
  v_step interval;
begin
  if v_owner is null or not exists (
    select 1 from public.profiles p
    where p.id = v_owner and p.role = 'admin' and coalesce(p.status, 'active') <> 'disabled'
  ) then
    raise exception 'Active owner access is required' using errcode = '42501';
  end if;
  if p_period is null or p_period not in ('day', 'month', 'year') then
    raise exception 'Invalid income period' using errcode = '22023';
  end if;

  if p_period = 'day' then
    v_start := date_trunc('day', v_now_local);
    v_end := v_start + interval '1 day';
    v_step := interval '1 hour';
  elsif p_period = 'month' then
    v_start := date_trunc('month', v_now_local);
    v_end := v_start + interval '1 month';
    v_step := interval '1 day';
  else
    v_start := date_trunc('year', v_now_local);
    v_end := v_start + interval '1 year';
    v_step := interval '1 month';
  end if;

  return query
    with linked_payments as (
      select b.payment_id from public.booking b where b.payment_id is not null
      union
      select b.balance_payment_id from public.booking b where b.balance_payment_id is not null
      union
      select w.payment_id from public.walk_in_booking w where w.payment_id is not null
      union
      select w.balance_payment_id from public.walk_in_booking w where w.balance_payment_id is not null
      union
      select o.payment_id from internal.staff_walkin_orders o
        where o.payment_id is not null and o.status = 'paid'
    ), payments as (
      select date_trunc(
               case when p_period = 'day' then 'hour'
                    when p_period = 'month' then 'day' else 'month' end,
               pay.created_at at time zone 'Asia/Manila'
             ) as local_bucket,
             coalesce(nullif(pay.base_minor, 0)::numeric / 100, pay.paid) as amount
      from linked_payments linked
      join public.payment pay on pay.payment_id = linked.payment_id
      where pay.created_at >= (v_start at time zone 'Asia/Manila')
        and pay.created_at < (v_end at time zone 'Asia/Manila')
        and coalesce(nullif(pay.base_minor, 0)::numeric / 100, pay.paid) > 0
    ), buckets as (
      select generate_series(v_start, v_end - v_step, v_step) as local_bucket
    )
    select (b.local_bucket at time zone 'Asia/Manila') as bucket_start,
           coalesce(sum(payments.amount), 0)::numeric as income
    from buckets b left join payments on payments.local_bucket = b.local_bucket
    group by b.local_bucket order by b.local_bucket;
end;
$$;

revoke all on function public.owner_income_period(text) from public, anon;
grant execute on function public.owner_income_period(text) to authenticated;
