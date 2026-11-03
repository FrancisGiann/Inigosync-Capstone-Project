-- Supabase's default table grants include writes for authenticated users.
-- Keep private staff details readable under RLS, with writes service-only.
revoke all on public.staff_private_details from authenticated;
grant select on public.staff_private_details to authenticated;
