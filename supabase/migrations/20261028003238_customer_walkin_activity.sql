create or replace function public.customer_list_walkin_activity(p_offset integer default 0,p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_result jsonb;
begin
  if v_actor is null or not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.role = 'customer' and p.status = 'active'
  ) then
    raise exception 'Active customer access is required' using errcode = '42501';
  end if;
  if p_offset is null or p_limit is null or p_offset < 0 or p_limit not between 1 and 100 then
    raise exception 'Invalid walk-in activity page' using errcode = '22023';
  end if;

  with linked as (
    select w.walkin_id,w.sports,w.courts,w.court_unit,w.time_date,w.end_at,w.amount_total,w.status
    from public.walk_in_booking w
    left join internal.staff_walkin_orders o on o.id = w.walkin_order_id
    where (w.walkin_order_id is not null and o.customer_id = v_actor)
       or (w.walkin_order_id is null and w.customer_id = v_actor)
  ), page as (
    select * from linked order by time_date desc,walkin_id desc offset p_offset limit p_limit
  )
  select jsonb_build_object(
    'total_count',(select count(*) from linked),
    'rows',coalesce((select jsonb_agg(to_jsonb(page) order by time_date desc,walkin_id desc) from page),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.customer_list_walkin_activity(integer,integer) from public,anon;
grant execute on function public.customer_list_walkin_activity(integer,integer) to authenticated;
