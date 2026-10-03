revoke all on function public.staff_create_walkin_order(uuid,text,text,jsonb,text) from public, anon;
grant execute on function public.staff_create_walkin_order(uuid,text,text,jsonb,text) to authenticated;
