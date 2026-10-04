-- Customer feedback submitted from the dashboard.
-- Only the submitting customer and authorized staff/admin can read a row;
-- customers may insert only rows attributed to their authenticated profile.
create table if not exists public.feedback (
    id uuid primary key default gen_random_uuid(),
    profile_id uuid not null references public.profiles(id) on delete cascade,
    rating smallint check (rating is null or rating between 1 and 5),
    message text not null check (length(trim(message)) > 0),
    created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;

revoke all on public.feedback from public, anon;
grant select, insert on public.feedback to authenticated;

drop policy if exists feedback_customer_insert_own on public.feedback;
create policy feedback_customer_insert_own on public.feedback
    for insert
    to authenticated
    with check (
        profile_id = (select auth.uid())
        and internal.is_active_customer((select auth.uid()))
    );

drop policy if exists feedback_customer_select_own on public.feedback;
create policy feedback_customer_select_own on public.feedback
    for select
    to authenticated
    using (profile_id = (select auth.uid()));

drop policy if exists feedback_staff_select_all on public.feedback;
create policy feedback_staff_select_all on public.feedback
    for select
    to authenticated
    using (public.inigosync_is_staff_or_admin());
