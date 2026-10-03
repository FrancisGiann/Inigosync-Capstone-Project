revoke all on function public.inigosync_is_admin() from public, anon;
revoke all on function public.inigosync_is_staff_or_admin() from public, anon;
grant execute on function public.inigosync_is_admin() to authenticated, service_role;
grant execute on function public.inigosync_is_staff_or_admin() to authenticated, service_role;
