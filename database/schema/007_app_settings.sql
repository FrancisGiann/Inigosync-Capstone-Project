-- ============================================================================
-- IñigoSync — Schema: app settings (payment configuration)
-- ============================================================================
-- Run this in the Supabase SQL editor (Project → SQL Editor) any time after
-- database/schema/002_content_tables.sql — order relative to 003/004/005/006
-- and the seed files in database/seed/ doesn't matter. Safe to re-run: the
-- CREATE TABLE uses `if not exists`, the seed INSERT below uses
-- `on conflict ... do nothing`, and policies are dropped-then-recreated.
--
-- Why this exists: the owner dashboard's Payment Configuration panel
-- (Staff Management → Payment Configuration) lets an admin flip GCash/Cash
-- toggles and set a downpayment percentage, but the Save button only ever
-- ran `console.log('[admin] payment settings saved (placeholder)', ...)` —
-- nothing was ever persisted. Separately, the 50% downpayment split was
-- hardcoded a second time in includes/Dashboard.js (customer booking) and
-- a third time in includes/staff_dashboard.js (walk-in booking), so the
-- admin panel had no real effect anywhere it "configured". This table gives
-- it one real source of truth all three dashboards agree on.
--
-- This is NOT payment processing — no PayMongo/e-wallet integration exists
-- yet (docs/OWNER_ACTION_LIST.md item C). This table only configures WHICH
-- manual payment methods are offered at checkout/walk-in, and what
-- percentage a "Downpayment" charges — never a live charge.
--
-- Design — a SINGLE row, enforced at the database level rather than by
-- convention ("always read the first row"): `id` is a `boolean primary key`
-- defaulting to `true`, with a CHECK that it can only ever BE `true`. A
-- second row would need `id = true` again (primary key violation) or
-- `id = false` (fails the CHECK) — there is no value left that could ever
-- create a second row. The app always upserts `id: true` (see
-- includes/owner_dashboard.js's Payment Configuration save handler), so
-- "insert the first time, update every time after" is one `.upsert()`
-- call, never a read-then-branch.
--
-- GRACEFUL DEGRADATION — includes/appSettings.js (window.InigoAppSettings)
-- is the actual read path for includes/Dashboard.js and
-- includes/staff_dashboard.js, using the same fetch-with-static-fallback
-- shape as includes/courtsData.js. Before this file is applied, every
-- fetch against `app_settings` 404s (relation does not exist) and
-- window.InigoAppSettings quietly falls back to today's hardcoded values
-- (GCash + Cash both on, 50% downpayment) — the exact values seeded below,
-- so behaviour is identical whether or not this migration has run. The
-- owner dashboard's Payment Configuration Save button is the one place
-- this is NOT silent: if the table doesn't exist yet, saving fails with a
-- clear "needs a database update" message instead of a fake success toast
-- — see includes/owner_dashboard.js.
--
-- See docs/OWNER_ACTION_LIST.md item A5.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- app_settings — one row, holding every dashboard's payment configuration.
-- ----------------------------------------------------------------------------
create table if not exists public.app_settings (
    id                boolean primary key default true
        constraint app_settings_singleton check (id = true),
    gcash_enabled     boolean not null default true,
    qrph_enabled      boolean not null default false,
    cash_enabled      boolean not null default true,
    downpayment_pct   numeric(5,2) not null default 50
        constraint app_settings_downpayment_pct_range check (downpayment_pct >= 0 and downpayment_pct <= 100),
    updated_at        timestamptz not null default now()
);

comment on table public.app_settings is 'Single-row app-wide settings — currently just payment configuration. Written by the owner dashboard''s Payment Configuration panel (includes/owner_dashboard.js); read by includes/Dashboard.js (customer booking) and includes/staff_dashboard.js (walk-in booking) via includes/appSettings.js. See this file''s header comment for the singleton-row design.';
comment on column public.app_settings.id is 'Always `true` — a boolean primary key with a CHECK that it can only be true makes a second row impossible. Never reference this column for anything other than the upsert target (id: true).';
comment on column public.app_settings.gcash_enabled is 'Whether GCash is offered as a payment method. Frontend fallback when this table/row is missing: true.';
comment on column public.app_settings.cash_enabled is 'Whether on-site cash is offered as a payment method. Frontend fallback when this table/row is missing: true.';
comment on column public.app_settings.downpayment_pct is 'Percentage of a booking''s rate charged as a "Downpayment" (the alternative being Full Payment). Frontend fallback when this table/row is missing: 50.';

-- Seed the single row with today's hardcoded defaults, so a fresh
-- `select * from app_settings` returns a real row immediately after this
-- migration runs, without requiring the admin to open Payment
-- Configuration and click Save first. `on conflict do nothing` keeps this
-- idempotent — re-running this file never resets values an admin has
-- already changed.
insert into public.app_settings (id, gcash_enabled, qrph_enabled, cash_enabled, downpayment_pct)
values (true, true, false, true, 50)
on conflict (id) do nothing;


-- ============================================================================
-- Row Level Security — every authenticated user (customer/staff/admin) may
-- SELECT; only admin may INSERT/UPDATE.
-- ============================================================================
-- Reuses the SECURITY DEFINER pattern from
-- database/schema/002_content_tables.sql's
-- public.inigosync_is_staff_or_admin() — but that helper is deliberately
-- too broad for this table (it also returns true for `staff`, and this
-- table's spec is admin-only writes), so this adds a narrower sibling with
-- the exact same shape rather than loosening the existing one.
create or replace function public.inigosync_is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
    select exists (
        select 1
        from public.profiles p
        where p.id = auth.uid()
          and p.role = 'admin'
    );
$$;

revoke all on function public.inigosync_is_admin() from public, anon;
grant execute on function public.inigosync_is_admin() to authenticated;

alter table public.app_settings enable row level security;

-- Table-level grants. RLS policies only ever *narrow* access the
-- underlying GRANT already allows — without these, `authenticated` would
-- get "permission denied" before RLS is even evaluated. No `anon` grant at
-- all (unlike sport/court/event/testimonial in 002, which the public
-- landing page reads) — this table has no anonymous-facing use, and no
-- delete grant either — a settings row is only ever upserted, never
-- deleted.
grant select on public.app_settings to authenticated;
grant insert, update on public.app_settings to authenticated;

drop policy if exists "app_settings_authenticated_read" on public.app_settings;
create policy "app_settings_authenticated_read" on public.app_settings
    for select
    to authenticated
    using (true);

drop policy if exists "app_settings_admin_write" on public.app_settings;
create policy "app_settings_admin_write" on public.app_settings
    for all
    to authenticated
    using (public.inigosync_is_admin())
    with check (public.inigosync_is_admin());


-- ============================================================================
-- Frontend behaviour before vs. after this file is applied
-- ============================================================================
-- BEFORE (current live state — nothing throws, nothing is silently faked):
--   * includes/appSettings.js's getSettings() queries `app_settings`, gets a
--     "relation does not exist" error, catches it, and resolves to
--     { gcashEnabled: true, cashEnabled: true, downpaymentPct: 50 } — today's
--     hardcoded values. includes/Dashboard.js and includes/staff_dashboard.js
--     behave exactly as they did before this table existed.
--   * The owner dashboard's Payment Configuration Save button attempts the
--     upsert, gets the same error, and shows a clear "this needs a database
--     update that hasn't been applied yet" toast — never a fake "Payment
--     settings saved." success message.
--
-- AFTER — the seeded row above makes GCash/Cash/downpayment_pct real from
-- the moment this file finishes running. The owner dashboard's Payment
-- Configuration panel loads the real row, Save persists changes (reload
-- survives it), and both includes/Dashboard.js and
-- includes/staff_dashboard.js pick up the real values on their next page
-- load.
-- ============================================================================
