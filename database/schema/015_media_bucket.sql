-- ============================================================================
-- IñigoSync — Schema: public Storage bucket for admin-uploaded media
-- (Revision A1, decision A5/A6)
-- ============================================================================
-- Run this in the Supabase SQL editor (Project → SQL Editor) any time after
-- database/schema/002_content_tables.sql (only needed so public.profiles
-- exists for the admin-check subquery below — 002 doesn't create profiles
-- itself, but every project this repo targets already has it). Safe to
-- re-run: the bucket insert is `on conflict do update` and every policy is
-- dropped-then-recreated.
--
-- Why this exists: Media Manager's home-featured slideshow (`public.event`)
-- and Court Listings' photo field previously only accepted a pasted image
-- URL — there was nowhere to actually UPLOAD a file from, because no
-- Supabase Storage bucket existed anywhere in this project. This file
-- creates one public bucket, `media`, that both features upload into
-- (`slides/…` and `courts/…` path prefixes respectively — see
-- includes/owner_dashboard.js's uploadToMedia()).
--
-- SECURITY — public bucket ≠ public write. `public = true` below only makes
-- OBJECT DOWNLOADS public (so an <img src> pointed at a slide/court photo
-- works with no auth header, same as every other image on the site) — it
-- does not by itself grant upload/replace/delete to anyone. Every write
-- operation is additionally gated by the RLS policies on storage.objects
-- below, which require the caller to be an ACTIVE ADMIN profile (re-checked
-- server-side on every request, never trusted from the client). A
-- publishable/anon key can therefore always read but never write into this
-- bucket. The bucket has no per-bucket raw-file size limit; the storage
-- provider's project-wide limit still applies. The app accepts any image/*
-- source and canonicalizes uploads to JPEG before storage; the bucket keeps
-- an image/* guard as a server-side image-only backstop.
-- ============================================================================

-- No `comment on` statement here on purpose — storage.buckets/storage.objects
-- are owned by supabase_storage_admin, not the `postgres` role the SQL
-- Editor runs as, and COMMENT ON requires table ownership (unlike the
-- INSERT/policy statements below, which Supabase explicitly grants
-- postgres enough privilege for). A COMMENT here could fail with a
-- permission error and abort the rest of this script — not worth the risk
-- for pure documentation; this file's own header comment covers the same
-- information as the alternative.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, null, array['image/*'])
on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- ----------------------------------------------------------------------------
-- Helper — is the currently-authenticated user an ACTIVE ADMIN? Deliberately
-- a NEW, admin-only helper rather than reusing
-- public.inigosync_is_staff_or_admin() (002_content_tables.sql), which also
-- accepts 'staff' and does not check `status`. Media/court photo uploads are
-- an owner-dashboard-only surface (staff never see Media Manager or Court
-- Listings), so this scopes Storage writes to exactly that audience, and
-- additionally excludes a deactivated admin account.
-- ----------------------------------------------------------------------------
create or replace function public.inigosync_is_active_admin()
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
          and p.status = 'active'
    );
$$;

-- Postgres grants EXECUTE to PUBLIC on every new function by default;
-- revoke that first so only signed-in users can even call the helper
-- (it returns false for them anyway — this just narrows the surface).
revoke all on function public.inigosync_is_active_admin() from public, anon;
grant execute on function public.inigosync_is_active_admin() to authenticated;

-- ============================================================================
-- Row Level Security on storage.objects — public read, active-admin write.
-- storage.objects already has RLS enabled by default on every Supabase
-- project (Supabase's own Storage docs create policies directly without an
-- `alter table ... enable row level security` step); this file does the
-- same rather than attempting an ALTER that a non-owner role would be
-- refused for.
-- ============================================================================

drop policy if exists "media_public_read" on storage.objects;
create policy "media_public_read" on storage.objects
    for select
    using (bucket_id = 'media');

drop policy if exists "media_admin_insert" on storage.objects;
create policy "media_admin_insert" on storage.objects
    for insert
    to authenticated
    with check (bucket_id = 'media' and public.inigosync_is_active_admin());

drop policy if exists "media_admin_update" on storage.objects;
create policy "media_admin_update" on storage.objects
    for update
    to authenticated
    using (bucket_id = 'media' and public.inigosync_is_active_admin())
    with check (bucket_id = 'media' and public.inigosync_is_active_admin());

drop policy if exists "media_admin_delete" on storage.objects;
create policy "media_admin_delete" on storage.objects
    for delete
    to authenticated
    using (bucket_id = 'media' and public.inigosync_is_active_admin());

-- ============================================================================
-- `public.event` — NOT changed here on purpose.
-- ============================================================================
-- database/schema/002_content_tables.sql already gives `event` everything
-- Media Manager's slideshow needs: public SELECT ("event_public_read", `true`)
-- and INSERT/UPDATE/DELETE for staff-or-admin ("event_staff_write", via
-- public.inigosync_is_staff_or_admin()). That policy is intentionally
-- broader than "admin-only" — it matches the SAME staff-or-admin write rule
-- 002 already applies to `court` and `sport`, and Media Manager is reached
-- exclusively from the owner dashboard today regardless, so there is no
-- practical gap. Adding a second, stricter policy here would not actually
-- narrow anything (Postgres OWNS multiple permissive policies for the same
-- command together), and dropping/replacing the existing one is out of
-- scope for this migration — it is shared with Court Listings' own writes
-- and untouched by this revision. If a future change wants Media Manager
-- restricted to admins only (unlike Court Listings), that is a deliberate,
-- separate policy change on `event`, not something to bundle in here.
-- ============================================================================

-- ============================================================================
-- Frontend behaviour before vs. after this file is applied
-- ============================================================================
-- BEFORE (current live state, this migration NOT applied): any upload
-- attempt from Media Manager's slideshow or the Court Listings modal's
-- "Upload photo" button gets a Storage error whose message includes
-- "Bucket not found" — includes/owner_dashboard.js's
-- isMediaBucketMissingError() recognizes this and shows "Media storage
-- isn't set up yet — run database/schema/015_media_bucket.sql" instead of a
-- raw error or a silent failure. Pasting a plain https:// image URL into
-- Court Listings' Image field still works exactly as before (that path
-- never touches Storage).
--
-- AFTER: both upload paths succeed, the resulting public URL is written to
-- `event.image_url` / `court.image_url`, and the photo renders immediately
-- everywhere that reads those columns (owner dashboard, customer dashboard
-- hero, landing page).
-- ============================================================================
