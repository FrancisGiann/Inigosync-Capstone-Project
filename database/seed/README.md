# Database setup — run order

All files here are meant to be pasted into the Supabase SQL editor
(Project → SQL Editor → New query) by hand, one at a time, in this order.
Nobody but the project owner has the credentials to do this — there is no
service_role key anywhere in this repo, and there never should be
(`Config/supabaseClient.js` only ever holds the publishable/anon key).

Every script below is written to be safe to re-run (idempotent): if a step
fails partway, or you're not sure whether it already ran, just run it again.

## Run order

1. `database/schema/002_content_tables.sql`
   Creates the `sport`, `court`, `event`, and `testimonial` tables, enables
   Row Level Security on all four, and adds the policies (public read,
   staff/admin write).

2. `database/seed/001_seed_users.sql`
   Creates one confirmed login per role (customer / staff / admin) directly
   in `auth.users`, plus the matching `public.profiles` row. See Login
   credentials below.

3. `database/seed/002_seed_content.sql`
   Seeds the 9 courts (8 sports — Bowling is split into Duckpin and Ten-Pin
   lanes under one sport), 5 sample events, and 6 placeholder testimonials.

Steps 2 and 3 don't depend on each other and can run in either order, but
both need step 1's tables/columns to exist first where relevant (step 3
does; step 2 doesn't touch the content tables at all).

4. `database/seed/003_update_user_emails.sql` — **optional, local-only, not
   in this repo.**
   Swaps the 3 accounts created by step 2 from their `.test` demo addresses
   to the project owner's own real email addresses (one real password for
   all three), by `UPDATE`ing the existing `auth.users` / `auth.identities` /
   `public.profiles` rows **in place** — it never deletes or recreates a
   user, so the existing UUIDs (and anything that later references them,
   e.g. bookings via `profiles.id`) stay intact.
   This file contains real personal email addresses and a real working
   password, so it is deliberately **not** checked into this repository —
   see `.gitignore` at the project root (`database/seed/003_update_user_emails.sql`
   and `database/seed/*.local.sql`). If you need to recreate it on a new
   machine, copy `001_seed_users.sql`'s account-matching pattern but as
   `UPDATE`s instead of `INSERT`s, matching each account by its *current*
   email (the old `.test` address OR the new real one, so it's safe to run
   more than once) and setting:
   - `auth.users.email` and `encrypted_password` (via
     `crypt('<your-password>', gen_salt('bf'))`), keeping `email_confirmed_at`
     non-null
   - `identity_data->>'email'` on the matching `auth.identities` row
     (`provider = 'email'`)
   - `public.profiles.email`

   See "Login credentials" below — the real values live only in that local
   file, never here.

## Login credentials

The baseline (`.test`) values created by step 2 are documented once, in
`001_seed_users.sql`'s own header comment — that file is tracked and safe to
read, since the addresses use the `.test` TLD (IANA-reserved for testing,
can never resolve to a real mailbox) so nobody mistakes them for a real
account. This README doesn't duplicate the literal values here, to keep a
single source of truth and to keep the habit of never writing real-looking
credentials into a file that gets committed.

| Role | Email | Password | Redirects to |
|---|---|---|---|
| Customer | `<your-customer-email>` | `<your-password>` | `user_dashboard.html` (via the shared Log In form) |
| Staff | `<your-staff-email>` | `<your-password>` | `staff_dashboard.html` (via the shared Log In form) |
| Admin | `<your-admin-email>` | `<your-password>` | `owner_dashboard.html` (via the shared Log In form) |

All three roles use the same Log In form. After password sign-in and the existing
email MFA check, `includes/auth.js` loads the protected profile role and routes
customers to `user_dashboard.html`, staff to `staff_dashboard.html`, and admins
to `owner_dashboard.html`. Signup remains customer-only. No records need
migration or cleanup for this UI/auth-flow-only change.

**If you've run `003_update_user_emails.sql`,** the table above shows the
*shape* of what to expect, not literal values — your real email addresses
and password live only in that gitignored, local-only file (or in Supabase
Dashboard → Authentication → Users, once applied). Never paste real
credentials into this README, a commit message, or any other tracked file.

**If you haven't run it,** the 3 accounts still use the throwaway `.test`
credentials from `001_seed_users.sql` — safe demo values, not real
accounts, meant to be rotated or deleted before any real launch.

## If `001_seed_users.sql` doesn't run cleanly

The two SQL files that touch `auth.users`/`auth.identities` were written
against Supabase's current (2023+) Auth schema, reviewed carefully by hand,
but never executed against this project (no service_role key = no way for
the Coder to run or test them). If a statement errors because a column
doesn't exist or doesn't match, the safest fallback is:

1. Supabase Dashboard → Authentication → Users → **Add user** → fill in one
   of the emails/passwords above → tick **Auto Confirm User**. This uses
   Supabase's own Admin API under the hood, so it can't drift from whatever
   schema version your project is actually running.
2. Then run just the `insert into public.profiles (...) on conflict (id) do
   update ...` portion of the matching block in `001_seed_users.sql` (or
   edit the row directly in the Table Editor) to set `role` to `customer`,
   `staff`, or `admin`.

## Known gap

The Coder does not have DB introspection access (anon/publishable key
only), so `public.profiles`' exact column constraints (NOT NULL, CHECK,
etc.) were inferred from how the rest of the codebase reads/writes that
table, not confirmed against the live schema. `status = 'active'` matches
the three values `includes/owner_dashboard.js` already maps
(`active` / `disabled` / `pending`). If any insert fails on a constraint
that isn't visible from the application code, adjust the value in the SQL
and re-run — every statement here is idempotent, so re-running after a fix
is always safe.
