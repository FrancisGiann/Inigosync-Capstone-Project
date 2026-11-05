# Staff Portal — Revision S3 (staff personal details)

## Standing development-data lifecycle rule (2026-10-31)

The connected project is still in development. A feature or schema change must include a data-impact review: identify existing rows and stored snapshots that no longer match the current contract, then migrate or remove only the proven obsolete records in the same work when safe. Preserve valid current-format test bookings, payments, accounts, configuration, and their required history. Before destructive cleanup, count the exact candidates, inspect foreign keys and application/reporting references, establish a recovery path, and review the proposed row set. Afterward, verify referential integrity and the affected staff, customer, and owner views or RPCs. Never use record age alone as a deletion rule. Document any deferred cleanup with the reason and the validation still needed.

---

> **Current phone decision:** The 2026-09-29 amendment at the end of this
> document replaces all SMS and phone OTP requirements below with Abstract
> Phone Intelligence validation. See
> [phone-validation-setup.md](docs/phone-validation-setup.md).

Adds `profiles.address, birthdate, gender, emergency_contact_name, emergency_contact_number` (migration 018). Staff edit them in Account Settings and see them (with computed age) in View Profile; the owner's Staff Management shows "Age · Gender" under each name, has View / Edit modals with every field, and Add New Staff collects them (saved right after the invite-staff edge function creates the profile row, via `profiles.update().eq('email', …)`). Also S2 (Time-In payment popup, migration 017) and the staff profile photo card are logged here.


---

# Staff Portal — Revision S2 (Time-In payment popup)

## Decisions (user, 2026-09-13)
| # | Decision |
|---|----------|
| S11 | **Time-In opens a popup** (staff modal shell) showing the booking (customer, court/unit, date, time, hours) and a payment block: Total = `amount_total` or rate × hours; Paid so far = `amount_paid`; **Balance due** = total − paid. If balance > 0: staff MUST pick **Cash / Online payment** and confirm "Collect ₱X & Time-In" (no manual amounts). If balance = 0: plain "Time-In". If the rate is unknown: show **"Rate TBA"** — nothing to collect, plain "Time-In" (no manual entry, per user). |
| S12 | Migration `017_booking_payment.sql`: `booking` + `walk_in_booking` gain `amount_total numeric(10,2) null`, `amount_paid numeric(10,2) not null default 0`, `payment_option text null` (booking only: 'full' / 'downpayment'), `balance_payment_method text null`, `balance_paid_at timestamptz null`. Idempotent. Comments must not contain "table <word>" / "on <word>" phrases (Supabase editor RLS scanner). |
| S13 | Customer booking insert saves `payment_option` (from the wizard's Full / Downpayment radio) and `amount_total` (rate × hours when known); `amount_paid` stays 0 until PayMongo. Walk-in wizard saves `amount_total` and `amount_paid = amount_total` (paid at the desk) when the rate is known, plus `payment_method` as today. Both with schema-mismatch retry dropping the new columns. |
| S14 | Confirm in the popup updates the row: `checked_in_at = now()`, and when collecting: `amount_paid = amount_paid + balance`, `balance_payment_method`, `balance_paid_at = now()`, `amount_total` (fill if null). Overview/Transactions Payment column shows "Paid · Cash" / "Due ₱300" / "Rate TBA". |


---

# Staff Portal — Revision S1 (time-in only, no confirm/decline, walk-in wizard, court schedule grid, transactions = time-ins, notifications, dropdown profile, password wizard)

## Context
`Pages/staff_dashboard.html` + `includes/staff_dashboard.js` + `Style/staff_dashboard.css` (panels overview | walkin | schedule | transactions | profile | settings). Today: Overview rows have Confirm / Decline / Time-In / Time-Out; Walk-In form has duration (1/2/3 h) + start time + GCash/Cash; Court Schedule is a 2-hour-column grid per sport; Transactions read `audit_log` (confirm/decline trail); Staff Profile is a sidebar tab; Settings password is one form; the bell is dead; Log Out sits in the sidebar. PayMongo is NOT integrated (docs/OWNER_ACTION_LIST.md C) — payments confirm bookings later; staff never confirm.

## Decisions (user answers 2026-09-13)
| # | Decision |
|---|----------|
| S1 | **Booking Overview = today's & upcoming bookings, newest first, with a single action: Time-In** (writes `booking.checked_in_at = now()`; audit_log best-effort). No Confirm/Decline/Time-Out anywhere. Status is derived, never written: `Booked` (not yet started), `In play` (checked in and now < end_at), `Completed` (checked in and now ≥ end_at — **auto time-out**), `Unattended` (not checked in and now > time_date + 30 min), `Cancelled` rows hidden. Filters: All / Booked / In play / Completed / Unattended; search; stat tiles: Bookings today, In play now, Still to come, Walk-ins today. Row shows customer, court + unit, time range, source (Online / Walk-in), payment. Walk-ins appear in the same list (source = Walk-in) with Time-In too (`walk_in_booking.checked_in_at`, add column via migration 016 if missing). |
| S2 | Payment: no pending state shown — an online booking is **Booked** as soon as it exists (option a). `status` column untouched. |
| S3 | **Walk-In wizard** (today only): ① Customer — name required, mobile optional (validatePhMobile if given) → ② Sport (chips) → Court/unit (select, from `InigoCourtsData.resolveCourtUnits`) → ③ Time — From/To selects listing only free hours today for that court+unit (same rule as the customer's Step 2: bookings `pending/confirmed` + walk-ins, hourly 8 AM–8 PM from `InigoBusinessHours`, past hours excluded) → ④ Payment — **Cash / Online payment** (radio; "Online payment" = PayMongo later; store `payment_method` text) → ⑤ Summary → **Save walk-in**. Insert into `walk_in_booking` {courts, sports, court_unit, customer_name, customer_mobile, time_date, end_at, duration_minutes, payment_method} with schema-mismatch retry dropping unknown columns; migration `016_walkin_columns.sql` adds `court_unit, end_at, payment_method, checked_in_at` (idempotent) + keeps RLS as is. Duration/start-time fields removed. |
| S4 | After save: **Walk-in receipt** card (same look as the customer's receipt: brand, receipt no, court/unit, date, time, hours × rate, total, payment method) with **Download PNG** (html2canvas, add the CDN script like user_dashboard.html) and **Print** (`window.print()` + `@media print` rule that hides everything but the receipt). "New walk-in" resets the wizard. |
| S5 | **Court Schedule** = availability grid for a chosen date (default today, min today): sport tabs → one row per **unit** (Court 1…9 / Lane 1…20 / Table 1…2), 12 hourly columns 8–9 AM … 7–8 PM, cell = Open / Booked (tooltip: who + source), past hours on today greyed; per-row "N open hours" count; legend. Data: bookings (pending/confirmed, `court_unit`) + walk-ins for that day, same occupancy helpers as customer/owner. Replaces the old 2-hour grid. |
| S6 | **Transaction Records** = time-in log: all bookings + walk-ins (union, newest first) with Date · Customer · Court/unit · Time · Source · Payment · Timed in · Timed out (auto = end time when checked in and finished) · Status (derived as S1). Date range filter (default today), source filter, search. No confirm/decline. `audit_log` no longer read (leave the table and best-effort write helper). |
| S7 | Sidebar: remove **Log Out** and **Staff Profile**. Header dropdown: **View Profile** (new `data-staff-panel="profile"` kept but reachable only from the dropdown, like the owner page: avatar, name, role "Staff", position, email, mobile, member since, "Edit in Account Settings") · Account Settings · Log Out. Existing profile-edit inputs (name/contact) move into Account Settings' Personal Information card. |
| S8 | **Notifications** (bell): bookings starting within the next 60 min ("Juan · Badminton Court 2 · 3:00 PM"), new bookings created today, today's walk-ins; unread dot via `localStorage['inigosync-staff-notif-seen']`; click → Overview; refresh 60 s. |
| S9 | Settings: **2-step password wizard** identical to owner/customer (`data-staff-pw-*`, current → new + confirm, min 8, show/hide, re-auth via session email, `updateUser`). Placeholders "Enter current password" etc. Personal Information card (name, mobile) with Save. |
| S10 | Sidebar logo already done (A1). Keep `staff-*` prefixes, `data-staff-*` hooks, typography tokens, both themes, no overflow at 360. |

## Security
- Time-In writes only `checked_in_at` (and walk-in equivalent) — check `booking` has an UPDATE policy for staff (004's comment says it may not; if the update fails with 42501, toast "Ask the owner to run 004/016" — migration 016 must include `create policy if not exists`-style drop/create for `booking_staff_checkin` UPDATE limited to staff/admin via `inigosync_is_staff_or_admin()` with `with check` same). Escape all names; no service keys.

## Success criteria
1. Overview: no Confirm/Decline/Time-Out; Time-In works; statuses derive as S1; walk-ins listed.
2. Walk-in wizard 5 steps, today only, From/To limited to free hours, saves, shows receipt with Download + Print.
3. Court Schedule per-unit hourly grid with date picker and open-hour counts.
4. Transactions show bookings + walk-ins with time-in/out; no confirm/decline.
5. Sidebar has no Log Out / Staff Profile; dropdown has View Profile; profile panel works.
6. Bell shows real items with unread dot.
7. Password wizard works; personal info saves.
8. Both themes, 360/768/1280 no overflow, no console errors (stubbed session).


---

# Owner Dashboard — Revision A3 (password placeholders, staff-only list, status trim, Website performance card, Feedbacks & Reviews tab)

## Decisions
| # | Decision |
|---|----------|
| C1 | Change Password: placeholders "Enter current password" / "Enter new password (min. 8 characters)" / "Re-enter new password"; the password inputs (inside `.admin-input-wrap` with the eye toggle) must look identical to every other `.admin-input` (same height, border, radius, padding, focus ring) — the toggle sits inside the padding, not altering the box. |
| C2 | Staff Management lists **only `role = 'staff'`** (the owner/admin account is excluded from the table, the "Active staff accounts" stat, and the profile-panel count). |
| C3 | Booking status this month shows **Pending / Completed / Unattended** only (Confirmed and Cancelled removed from the list; counts still fetched for nothing else — drop them). |
| C4 | "Recent bookings" card → **Website performance** card. Honest, client-measurable checks only: (1) **API response** — timed lightweight `head` count on `booking` (ms; Good < 400, Slow < 1500, Problem otherwise/failed); (2) **Page load** — Navigation Timing `loadEventEnd - startTime` (Good < 2.5 s, Slow < 5 s); (3) **Media storage used** — sum of object sizes from `sb.storage.from('media').list()` over `slides/` and `courts/*` (recursive, best-effort) shown as "X MB of 1 GB" (free-tier constant `MEDIA_STORAGE_LIMIT_BYTES`, documented) with Good/Warn ≥ 80 %; (4) **Database records** — head counts: bookings, customer accounts, feedback; (5) **Errors this session** — `window.onerror`/`unhandledrejection` counter; (6) **Connection** — `navigator.onLine` + `navigator.connection.effectiveType` when available. Overall badge = worst status. "Last checked HH:MM" + **Run check** button; auto-runs on load and every 5 min. If storage listing fails (bucket missing) show "Not set up" not an error. |
| C5 | New sidebar tab **Feedbacks & Reviews** (`data-admin-panel="feedback"`, after Media Manager): Google-Play-style summary — big average (1 decimal) + star row + "N reviews", 5→1 star distribution bars with counts (click a bar = filter to that star, click again clears); toolbar: sort **Most recent / Highest rating / Lowest rating**, star filter chips (All, 5…1, "No rating"); list of cards: customer name (profiles lookup, escaped), stars (or "No rating"), date, message. Empty state. Reads `feedback` (RLS 009 already allows staff/admin SELECT). Also the bell's feedback items link to this tab. |

## Success criteria
1. Password fields match other inputs visually; placeholders as specified.
2. Owner not in staff table; stat counts staff only.
3. Status list = 3 rows.
4. Website performance card shows the 6 checks with real numbers and a Run check button; no fabricated values; bucket-missing handled.
5. Feedback tab: summary, distribution, sort + filter work; XSS-safe.


---

# Owner Dashboard — Revision A2 (nav/profile/staff modal/no payment card/responsive/court photos with crop/per-hour only)

## Context
Follow-up to Revision A1 after the user reviewed the owner page. Also fixes the CSS comment bug (`*/` inside comments in LandingPage.css/owner_dashboard.css) that dropped the dark-mode `:root` block.

## Decisions
| # | Decision |
|---|----------|
| B1 | Remove the sidebar **Log Out** nav item (`[data-admin-logout]` in `.admin-nav`); the profile dropdown keeps Log Out. |
| B2 | Profile dropdown gains **View Profile** → new `data-admin-panel="profile"` (not in the sidebar, like the customer page's profile panel): avatar, full name, role tag "Owner", email, mobile (`contact_num`), member since (`profiles.created_at`), quick stats (courts listed, active staff), and an "Edit in Account Settings" button. Painted by `renderAdminProfile()`. |
| B3 | Staff → **+ Add New Staff opens a modal** (`[data-admin-staff-modal]`, same `.admin-modal` shell as the court modal); inline `.admin-add-panel` card removed. Submit logic unchanged. |
| B4 | **Payment Configuration card removed** from Staff Management (markup + its JS block). `includes/appSettings.js` and the customer booking's payment options are untouched (they keep reading `app_settings` / defaults). Panel subtitle updated. |
| B5 | **Responsive/consistency pass** on `owner_dashboard.css`: one card system (`.admin-card` padding/radius/head), `.admin-stat-grid` 4→2→1 columns, `.admin-grid-2` stacks ≤ 1080px, tables scroll horizontally in `.admin-table-wrap`, court/slide grids `auto-fill minmax(260px,1fr)`, modals full-width ≤ 640px, topbar wraps on mobile, sidebar drawer unchanged. Verify at 360 / 768 / 1280. |
| B6 | **Court photos with crop**: in the court modal, a **Cover photo** slot plus **one slot per unit** (derived from quantity+unit, e.g. Court 1…Court 9; labels editable? no — derived). Each slot: thumbnail, Upload, Remove. Upload opens a **crop editor modal** (vanilla: image in a fixed-aspect frame 16:10, drag to pan, zoom slider, Apply/Cancel) → canvas crop → JPEG ≤ 1600×1000 → `media` bucket (`courts/<slug>/cover-<ts>.jpg`, `courts/<slug>/unit-<n>-<ts>.jpg`) → cover saves to the court's image column (as today), units save to `unit_images` JSON `[{label, image_url}]` (database/schema/006_court_unit_images.sql). Cover URL text input stays as fallback. `courtsData.js` already reads `unit_images`. Crop helper lives in `includes/imageTools.js` (`openCropEditor(file, {aspect}) → Promise<Blob>` + DOM for the modal injected once). |
| B7 | **Per-hour only**: remove the "Per game" option and the Billing unit select from the court modal; always send `rate_unit: '/hr'`; card/receipt labels keep reading `rateUnit` (now always "/hr"). |

## Success criteria
1. No Log Out in the sidebar; dropdown has View Profile + Account Settings + Log Out; View Profile shows the owner's real data.
2. Add New Staff is a modal; Payment Configuration gone; staff invite still works.
3. Owner page has no horizontal overflow at 360px; cards align at 768/1280.
4. Court modal: cover + per-unit upload with crop; saved URLs appear on the customer dashboard's unit picker; Per game gone.
5. Dark/light both render (CSS comment scanner clean).


---

# Owner (Admin) Dashboard — Revision A1 + system-wide typography

## Context

The owner dashboard (`Pages/owner_dashboard.html` 880 lines, `includes/owner_dashboard.js` 1050 lines,
`Style/owner_dashboard.css` 791 lines; panels `overview | staff | courts | media | settings`) lags behind the
customer dashboard that was just reworked (Revision 5). The user wants it brought to the same standard, plus a
single typography system applied to every page of the product.

Findings from direct reads (2026-09-12):

- **Brand**: sidebar shows a text monogram `IS` (`.admin-logo-dot`) instead of the real logo the customer page
  uses (`assets/Logo/WebLogo.png` in `.dash-sidebar-brand`).
- **Fonts**: all five pages load the same Google Fonts link (Oswald / Inter / Space Mono) and each CSS file
  redefines `--font-display/--font-body/--font-mono` itself. Space Mono is sprinkled over UI labels (stats,
  table meta, chips, captions) and there are ~300 ad-hoc `font-size` declarations across the six CSS files.
- **Topbar**: bell button exists but is dead (no dropdown, no data); profile dropdown exists
  (`[data-admin-profile]` → Account Settings / Log Out) but the avatar is initials-only (`.admin-avatar`).
- **Overview**: stat cards + Chart.js trend (`event/chart.js`) are live; **"Busiest courts this week"** and
  **"Staff on shift"** are hardcoded fake data.
- **Court Listings**: add/edit share one inline `.admin-add-panel` form that scrolls into view
  (`openCourtFormForEdit()` → `scrollIntoView`). No modal exists anywhere on the admin page. Card visuals differ
  from the customer's court cards.
- **Media Manager**: "Home featured slideshow" and "Court photos" are static, disabled placeholders (no Storage
  bucket). The landing-page hero already reads slides from `public.event`
  (`title, meta, tag, image_url, display_order, is_published`, `002_content_tables.sql`) via
  `includes/home-showcase.js` / `window.InigoContent.getEvents()`; the customer dashboard hero is 3 static
  `<article data-dash-hero-slide>`.
- **Staff**: list live; "Reset Password" = `resetPasswordForEmail` (email link); "Deactivate" sets
  `profiles.status='disabled'`; **no Activate** action; row edit is inline.
- **Settings**: name saves `profiles.full_name`; email input present but **never saved**; no avatar upload;
  password change is a single 3-field form.
- Reusable from the customer page (`includes/Dashboard.js`): `downscaleImageToAvatarDataUrl()` +
  `saveAvatarUrl()` + avatar rendering (256×256 JPEG data URL in `profiles.avatar_url`), the 2-step password
  wizard (`signInWithPassword` re-auth → `auth.updateUser({password})`), the notifications dropdown
  (`[data-dash-notif*]`, `renderNotifications()`), the `.dash-modal-overlay`/`.dash-modal` shell, `InigoToast`.

## Decisions (user confirmed 1,3–9 "all good"; #2 delegated: "you choose", apply to the whole system)

| # | Decision |
|---|----------|
| A1 | **Logo**: replace `.admin-logo-dot` "IS" with `<img src="../assets/Logo/WebLogo.png">` + wordmark, same markup/sizing as `.dash-sidebar-brand`. Do the same on the staff sidebar if it also uses a text monogram. |
| A2 | **Typography (system-wide)**: new shared `Style/typography.css`, linked FIRST on every page (`Index`, `terms`, `user_dashboard`, `staff_dashboard`, `owner_dashboard`). Fonts: **Sora** (display/headings, 600–700) + **Inter** (body/UI, 400–600) with `font-variant-numeric: tabular-nums` for numbers; **Space Mono removed** (`--font-mono` is kept as an alias of Inter so nothing breaks, then usages are cleaned up). One Google Fonts link (`Sora:wght@500;600;700&Inter:wght@400;500;600;700`) replaces the old one on all five pages. Type scale as CSS variables: `--fs-xs .75rem, --fs-sm .8125rem, --fs-md .875rem, --fs-base 1rem, --fs-lg 1.125rem, --fs-xl 1.375rem, --fs-2xl 1.75rem, --fs-3xl 2.25rem, --fs-hero clamp(2.25rem,5vw,3.5rem)`; line-heights `--lh-tight 1.15, --lh-snug 1.3, --lh-normal 1.55`; letter-spacing for uppercase eyebrows `.08em`. Each CSS file's `--font-*` definitions are deleted (inherit from typography.css) and every `font-size:` is mapped to the nearest scale token; heading elements (`h1–h4`, `.admin-stat-value`, `.dash-*-title`…) use `--font-display`. Result: one place defines fonts, sizes, and weights for the whole product. |
| A3 | **Overview replacements**: "Busiest courts this week" → **Recent bookings** (latest 8 `booking` rows joined to `profiles.full_name`, columns Customer / Court / Date & time / Status with the same status-badge classes; "View all" not needed). "Staff on shift" → **Booking status this month** (counts of pending / confirmed / completed / cancelled + client-derived unattended, as a compact bar list). Both live, refreshed with `refreshOverviewStats()`. |
| A4 | **Staff → Reset Password**: sets the password to **`12345678`** via a new SECURITY DEFINER RPC `public.admin_reset_staff_password(target_id uuid)` (migration `014_admin_reset_staff_password.sql`): verifies `auth.uid()` is an `admin` profile, target is `staff`/`admin`, then `update auth.users set encrypted_password = crypt('12345678', gen_salt('bf')), updated_at = now()`; requires `pgcrypto`. Button asks `confirm()` first, then toasts "Password reset to the default. Ask <name> to change it after logging in." Keep the email-link path out (replaced). Add **Activate** button for `disabled` staff (`profiles.status='active'`), mirroring the court cards' Activate/Deactivate pair. Staff row edit stays inline (unchanged). |
| A5 | **Media Manager**: remove the "Court photos" card entirely (markup + CSS + JS stubs). Make the slideshow real against `public.event`: list published+unpublished slides ordered by `display_order`; per slide: photo (replace via upload), Title (`title`), Caption (`meta`), Tag (`tag`, optional), Published toggle (`is_published`), Move up/down (`display_order`), Remove (delete row); "Add slide" (max 6). Uploads go to a new **public Storage bucket `media`** created by migration `015_media_bucket.sql` (`insert into storage.buckets … on conflict do nothing` + RLS policies: public read, admin insert/update/delete on `bucket_id='media'`); client uses `sb.storage.from('media').upload(path, file, {upsert:true})` then `getPublicUrl()` → `event.image_url`. Images are downscaled client-side to max 1600×900 JPEG before upload (reuse the canvas approach of `downscaleImageToAvatarDataUrl`, generalised as `downscaleImageToBlob(file, maxW, maxH, quality)` in a new shared `includes/imageTools.js`). If the bucket is missing (error 404/“Bucket not found”), toast "Media storage isn't set up yet — run 015_media_bucket.sql". The customer dashboard hero (`[data-dash-hero]`) is rewired to render from `InigoContent.getEvents()`-equivalent data (add a small `includes/contentEvents.js` used by both dashboards, or reuse `includes/landingPage.js`'s `InigoContent` if it can load standalone — coder to decide after reading it) so owner edits show on the landing page AND the customer dashboard. |
| A6 | **Court Listings**: Add/Edit move into a **modal** (`.admin-modal-overlay`/`.admin-modal`, port of the customer `.dash-modal` shell), opened from "+ Add New Court" and each card's Edit; Esc/backdrop/Cancel close; Save keeps the existing insert/update logic (`courtSubmitBtn` handler) and refreshes the grid. The modal's Image field offers **Upload** (to the `media` bucket, path `courts/<id>-<ts>.jpg`) **or URL**. Card redesign to match the customer's court cards: image/monogram media block with status badge, name, sport chip, `N units` chip, rate line ("Rate TBA" when null), description tags, and a consistent action row (Edit = secondary, Activate/Deactivate = ghost/danger). Filter chips unchanged. |
| A7 | **Notifications (owner)**: port the customer bell/dropdown (`[data-admin-notif*]`): items = new bookings (`status='pending'`, latest 10, "Juan booked Badminton · Sep 14, 9–11 AM") and new feedback (latest 5, "★★★★☆ — message excerpt"). Unread dot = any item newer than `localStorage['inigosync-admin-notif-seen']`; opening the menu marks seen. Clicking a booking item goes to Overview (Recent bookings). Refresh every 60 s and on `inigosync:profile-ready`. |
| A8 | **Topbar profile**: `.admin-avatar` renders `profiles.avatar_url` (img) when set, initials otherwise — one `renderAdminProfile()` paints every avatar (topbar + settings card). Dropdown unchanged. |
| A9 | **Account Settings**: (1) **Profile photo card** — Upload / Remove, same pipeline as the customer page (`downscaleImageToAvatarDataUrl` → `profiles.avatar_url`; move that helper into `includes/imageTools.js` and have Dashboard.js use it too, no behaviour change). (2) **Full name + email editable**: name → `profiles.update({full_name})`; email → `sb.auth.updateUser({ email })` then toast "Confirmation link sent to <new email> — the change applies after you click it." On load and on `onAuthStateChange('USER_UPDATED')`, if `session.user.email !== profile.email`, sync `profiles.email` and repaint. (3) **Change Password = 2-step wizard** identical to the customer's (Step 1 current password → `signInWithPassword` re-auth; Step 2 new + confirm with show/hide → `auth.updateUser({password})`), with `data-admin-pw-*` hooks. |

## Files to change

### New
- `Style/typography.css` — fonts, scale, weights, base element rules (A2).
- `includes/imageTools.js` — `downscaleImageToDataUrl(file, {size, quality})` (avatar) + `downscaleImageToBlob(file, {maxW, maxH, quality})` (media). Loaded by user + owner dashboards before their main script.
- `database/schema/014_admin_reset_staff_password.sql` (A4), `database/schema/015_media_bucket.sql` (A5).
- `docs/OWNER_ACTION_LIST.md` items: run 014 + 015; note the default password policy.

### `Pages/owner_dashboard.html`
- Sidebar brand → logo image (A1). Fonts link swap + `typography.css` link (A2).
- Topbar: bell → `[data-admin-notif]` dropdown markup (A7); avatar container accepts `<img>` (A8).
- Overview: replace the two fake cards with `[data-admin-recent-bookings]` table and `[data-admin-status-breakdown]` list (A3).
- Courts: remove inline `.admin-add-panel` form; add `[data-admin-court-modal]` (A6).
- Media: delete Court photos card; slideshow card becomes `[data-admin-slides]` container + "Add slide" (A5).
- Staff: rows gain Activate (rendered by JS); Reset copy updated (A4).
- Settings: Profile photo card, editable email, 2-step password wizard (A9).
- Script order: `imageTools.js` before `owner_dashboard.js`.

### `includes/owner_dashboard.js`
- `renderAdminProfile()` (avatar img/initials, name, email fields); avatar upload/remove handlers; email change + sync; password wizard state machine (port from `Dashboard.js`, `data-admin-pw-*`).
- `refreshOverviewStats()` → also `refreshRecentBookings()` and `refreshStatusBreakdown()`.
- Court modal open/close/populate/save; card renderer redesign; image upload helper `uploadToMedia(path, blob)`.
- Slides: `loadSlides()`, `renderSlides()`, handlers for replace/add/remove/reorder/publish/title/caption (debounced save on blur).
- Staff: `admin_reset_staff_password` RPC call; Activate handler.
- Notifications: `refreshAdminNotifications()`, `renderAdminNotifications()`, menu toggle, seen marker.

### `Style/owner_dashboard.css`
- Remove `--font-*` block; map sizes to tokens; kill mono usages (A2). New: `.admin-brand img`, `.admin-notif*`, `.admin-modal*`, `.admin-court-card` redesign, `.admin-slide*`, `.admin-recent-table`, `.admin-status-breakdown`, `.admin-avatar img`, `.admin-pw-step*`, `.admin-input[readonly]`.

### Other pages (A2 only — no functional change)
- `Pages/Index.html`, `Pages/terms.html`, `Pages/user_dashboard.html`, `Pages/staff_dashboard.html`: fonts link swap + `typography.css` link.
- `Style/LandingPage.css`, `Style/Auth.css`, `Style/Dashboard.css`, `Style/staff_dashboard.css`, `Style/Loading.css`: drop local `--font-*` definitions; map `font-size` values to tokens; replace `--font-mono` usages with body font + `tabular-nums` where it was used for numbers.
- `Pages/user_dashboard.html` + `includes/Dashboard.js`: hero slides rendered from `event` rows (A5); avatar helper moved to `imageTools.js` (A9) — behaviour unchanged.
- `Pages/staff_dashboard.html`: logo image if it also uses a text monogram (A1).

## Constraints and non-goals
- No build step; plain scripts on `window`; keep `data-admin-*` hooks and `admin-*` CSS prefix; hoisted function declarations; explain-why comments citing "Revision A1 / A-number".
- Do not change booking logic, business hours, staff dashboard behaviour, or the customer Revision 5 features (only their fonts/sizes and the hero data source).
- Staff creation/invite flow unchanged. No auth.users deletion. No service-role key in the browser — the only privileged operation is the SECURITY DEFINER RPC (A4), which itself checks the caller is an admin.
- Typography pass must not change layout structure — only font family/size/weight/line-height tokens. Visual regressions are checked page by page.

## Success criteria
1. Sidebar shows the logo image on owner (and staff, if applicable) pages.
2. Every page loads only Sora + Inter; no `Space Mono` request in the network tab; all `font-size` values in the six CSS files come from typography tokens (grep shows no raw `font-size: <number>` outside `typography.css`, except intentional `clamp` hero sizes); headings visibly use Sora, body Inter; no layout breakage on mobile/desktop for Index, login, customer, staff, owner.
3. Overview shows live Recent bookings and Booking status this month; fake cards gone.
4. Reset Password sets the target's password to `12345678` (login test with that password succeeds afterwards); non-admin callers get a Postgres exception; Activate restores a deactivated staff.
5. Media Manager: adding/replacing/reordering/publishing/removing a slide persists to `event`, uploads land in the `media` bucket, and the landing-page hero AND the customer dashboard hero show the change; Court photos card is gone.
6. Court Add/Edit happen in a modal with Esc/backdrop close; save/insert/update still work; cards look consistent with the customer's.
7. Owner bell shows pending bookings + feedback with an unread dot; opening clears it.
8. Settings: photo upload/remove works and shows in the topbar; name saves; email change sends a confirmation and `profiles.email` follows after confirmation; password wizard works with wrong-current-password rejection.

## Verification
- `node --check` on all touched JS; brace-balance on all CSS.
- Serve with `python -m http.server 8532`; open all five pages; check console/network (fonts requested: Sora, Inter only).
- Owner login: walk every panel per criteria 3–8; run 014/015 first in Supabase (owner action).
- Reviewer pass on: RPC SQL (privilege check), storage policies, modal/upload code, typography diff (spot-check each page).


## Post-implementation notes (2026-09-12)

Implemented in two sequential coder lanes (features, then typography), reviewed, findings fixed.

- **A2 typography**: `Style/typography.css` now owns fonts (Sora + Inter), the `--fs-*` scale, weights and line-heights; the six page stylesheets only reference tokens. Space Mono removed. `Style/Auth.css` `.auth-field-row` min column raised 86→96px because Sora labels are wider (verified in Playwright at 320–768px). Landing `.cta-button` now inherits 1rem (was UA 13.33px) — matches its sibling link.
- **A4 hardening**: the reset RPC also deletes the target's `auth.refresh_tokens` and `active_session` row, so a reset ends every open session of that staff account (defence in depth; refresh-token delete is wrapped so a privilege error can't block the reset). `inigosync_is_active_admin()` is revoked from `public`/`anon`.
- **A5**: Media Manager cap is 5 slides (both heroes render max 5); a newly added slide starts **unpublished**; reorder renumbers duplicates first. Public `event_public_read` policy (from 002) still exposes unpublished rows to SELECT — the heroes filter client-side; acceptable for marketing copy, noted.
- **A7**: notifications retry without `end_at` on a pre-012 database and show "Couldn't load booking alerts" instead of failing silently.
- **A9**: email change keeps the typed address in the input with a "pending confirmation" hint; password re-auth uses the session's email.
- Static demo staff rows are now wired (fallback only).

**Not verified live** (no signed-in session available to the agents): RPC + login with the default password, storage upload + both heroes, notifications data, email confirmation round-trip, and the dashboards' rendering with the new fonts (landing + terms pages were screenshotted at 360/1280 and are clean). Owner must run `014` then `015` first (docs/OWNER_ACTION_LIST.md).

## Risks
- The RPC touches `auth.users` — must be SECURITY DEFINER owned by `postgres` and revoke `execute` from `anon`; grant to `authenticated`. Document that any admin can reset any staff password to a known default (intended by the user; staff should change it on first login).
- Storage bucket creation via SQL works on hosted Supabase (`storage.buckets` insert) but policies must be created on `storage.objects`; if the project restricts this, fallback is creating the bucket in the dashboard UI (documented in OWNER_ACTION_LIST).
- Email change with "Secure email change" enabled sends links to both addresses; the toast text covers "check both inboxes".
- Typography pass is wide (six CSS files); mis-mapped sizes are the most likely regression → reviewer spot-checks every page at 360px and 1280px widths.


---

# Earlier revisions (kept for the code comments that cite them)

# Customer Dashboard — Revision 5 (8 AM–8 PM hours, From/To booking picker, receipt redesign, locked profile + mobile OTP, dashboard-only footer)

## Context

The customer (user) dashboard at `Pages/user_dashboard.html` + `includes/Dashboard.js` + `Style/Dashboard.css`
already has: a per-court "Show availability" peek strip on the Overview tab (today only, start-time labels,
per-court-row granularity), a Book-a-Court wizard whose Step 2 renders hourly slot buttons and supports a
contiguous start→end range (first click = start, second click = end), a Receipts tab rendering one
`.dash-receipt-card` per booking with PNG download, an Account Settings tab where names + mobile are editable
(email already `disabled`), and a `<footer class="site-footer">` that renders on every tab.

The user wants the customer account to:

1. **Dashboard (Overview) availability** — show real hourly slots as ranges (8–9 AM, 9–10 AM, … 7–8 PM),
   and let the customer pick a **date** so the strip reflects that day's availability, not only today.
2. **Booking Step 2** — no clickable slots; a **From / To time-range picker** (whole hours, 8 AM → 8 PM)
   whose options shrink to what is still free on the chosen date. Any number of consecutive hours.
3. **Receipt** — keep exactly the same information, change the visual design.
4. **Account Settings** — personal info (first/middle/last name) **not editable**; email **not editable**;
   mobile number changes require **OTP verification** (like the email OTP at signup).
5. **Footer** — visible only on the Dashboard (Overview) tab.

Single shared hours source: `includes/businessHours.js` (`OPEN_HOUR = 8`, `CLOSE_HOUR = 21` today).

## Decisions (confirmed with the user on 2026-09-12)

| # | Decision | Final |
|---|----------|-------|
| D1 | Operating hours | `CLOSE_HOUR` 21 → **20**. Bookable window is **8:00 AM – 8:00 PM**. Slots = 8–9, 9–10, … 7–8 PM (**12 slots**). A customer may book **any contiguous run of whole hours** inside that window (1 hr up to all 12) — no fixed 2-hour blocks, no half-hours. Affects Overview, Step 2, and the staff Court Schedule (`hoursRange(2)` → 6 columns ending 6–8 PM) automatically. |
| D2 | Slot label format | Range on every slot button/pill: `8:00 AM – 9:00 AM` (new helper `formatHourRangeLabel(hour)` in `businessHours.js`). Peek strip uses a short form `8–9 AM` to fit. |
| D3 | Step 2 time selection | **No slot grid. Step 2 becomes a From/To time-range picker** (user corrected this on the second pass: "there should be no slots to click"). Two `<select>`s: **From** (options 8:00 AM … 7:00 PM) and **To** (options 9:00 AM … 8:00 PM). Options are **reduced by that date's availability**: a From hour is offered only if it is free (not booked for the chosen court+unit, not past when the date is today); after From is chosen, To offers only hours from `From+1` up to the next booked hour (or 8 PM), so the range is always contiguous and free. Changing From re-derives To (and clears it if no longer valid). A helper line under the pickers lists the free windows for the day, e.g. "Open on this date: 8 AM – 10 AM, 11 AM – 8 PM", or "Fully booked on this date". Result maps to `bookingState.startHour` = From, `bookingState.endHour` = To − 1 (existing inclusive convention) → single `booking` row with `end_at`/`duration_minutes`; `bookingHoursSelected()`, `updateSummary()`, the insert payload, and the DB EXCLUDE constraint are unchanged. |
| D4 | Overview ⇄ Step 2 consistency | User's example: book 8–9 AM → Overview strip AND Step 2 both show 8–9 taken and 9 AM–8 PM still open, for that date/unit. Peek strip becomes **per selected unit** (uses the existing `[data-overview-unit-select]`) and uses the **same occupancy helper** Step 2 uses (`overviewBookingWindow` + `overviewWindowsOverlap` + unit match), so the two can never disagree. Fetch includes `court_unit, end_at` with the same schema-mismatch retry Step 2 uses. After a successful booking, both the Overview widget and Step 2 grid are refreshed. |
| D5 | Overview date | One `<input type="date" data-dash-overview-date>` above the courts grid (min = today, default today). Changing it re-fetches bookings + walk-ins for that day and re-renders. Past hours on today are shown as `is-past`. |
| D6 | Mobile OTP | **Implement the real SMS OTP code path now; no paid SMS provider yet** (user: "code-only for now, but apply it"). Flow: `sb.auth.updateUser({ phone: '+63…' })` sends the code; `sb.auth.verifyOtp({ phone, token, type: 'phone_change' })` confirms. On success write `profiles.contact_num` (local `09…` form) + new `profiles.phone_verified = true`. **Zero-cost demo path for the thesis defense:** Supabase Auth → Phone provider supports *Test phone numbers with fixed OTPs* (`auth.sms.test_otp`) — no SMS is sent and no Twilio account is charged; the exact same code path runs. Documented as a new `docs/OWNER_ACTION_LIST.md` item (enable Phone provider, add test numbers now, add a real SMS provider later). Until the provider is enabled, the UI shows a friendly "SMS verification isn't set up yet" toast — **no fake client-side code generation**. |
| D7 | Receipt look | "Store receipt / ticket stub" style: brand header (IñigoSync + "Official booking receipt"), monospace receipt no., dashed perforation dividers, itemised body (**Rate/hr × hours = Amount**, when rate is known; otherwise "Rate TBA"), a prominent TOTAL row, status badge, date/time, thank-you footer, download button. Same underlying fields (Court, Receipt #, Status, Sport, Date, Time, Amount) — no new data. **Priority (user): the downloaded PNG must look identical to the on-screen card** — so the design must use only html2canvas-safe CSS (no `backdrop-filter`, no external images/fonts beyond what already renders, no `mix-blend-mode`), and the coder must verify by opening the PNG side-by-side. A payment-option / downpayment line is NOT included because `booking` does not store the chosen payment option (out of scope; noted under risks). |
| D8 | Footer visibility | `setActivePanel()` sets `document.querySelector('.site-footer').hidden = name !== 'overview'`. |
| D9 | Footer content (recommended, user asked for a suggestion) | Replace the landing-page footer clone with a **slim dashboard footer** built for a signed-in customer: (1) brand + one-line tagline; (2) **Quick links** — Book a Court, My Bookings, Receipts, Account Settings (each a `data-dash-nav` button, so they use the existing tab switcher); (3) **Need help?** — phone, email, address, and **Operating hours: 8:00 AM – 8:00 PM daily** read from `InigoBusinessHours` so it can never drift; (4) **Policies** — Terms (`Pages/terms.html`) and the no-cancellation / unattended policy line; (5) copyright line. **Drop the Google Maps `<iframe>`** on the dashboard (it is the single heaviest element on the page and already has to be special-cased out of html2canvas; a "Get directions" link to Google Maps replaces it). Keep the social links as icons. Uses new `dash-footer-*` classes in `Dashboard.css`; the landing page footer in `Index.html` is untouched. |

## Files to change

### `includes/businessHours.js`
- `CLOSE_HOUR = 20`; update header comments (they currently justify 21).
- Add `formatHourRangeLabel(hour)` → `"8:00 AM – 9:00 AM"` and `formatHourRangeLabelShort(hour)` → `"8–9 AM"` (period shown once when both sides share it, e.g. `11 AM–12 PM`). Export on `window.InigoBusinessHours`.

### `Pages/user_dashboard.html`
- Overview courts header (`~:387-401`): add a date field `<input type="date" class="dash-input" data-dash-overview-date>` with label "Availability for" next to the sort select.
- Step 2 (`~:516-547`): **remove** `<div class="dash-slot-grid" data-dash-slot-grid>`; add two form groups — `<select class="dash-select" data-dash-book-from>` ("From") and `<select class="dash-select" data-dash-book-to>` ("To") — and a status line `<p class="dash-form-hint" data-dash-book-open-windows>` for the "Open on this date: …" text. Helper text: "Choose a start and end time (8:00 AM – 8:00 PM, whole hours)".
- Settings Personal Information card (`~:905-955`):
  - First/middle/last name inputs → `readonly` (keep values populated by `renderProfile()`), label hint "Personal information can't be changed here".
  - Email stays `disabled`; label → "Email address · cannot be changed".
  - Mobile: input + adjacent `Verify` button (`data-dash-mobile-verify`) + a verified badge span (`data-dash-mobile-verified`). Remove the profile "Save Changes"/"Cancel" pair (nothing left to save except via OTP).
- Add a Mobile OTP dialog reusing the generic `.dash-modal-overlay`/`.dash-modal` shell: 6 code boxes (`data-dash-otp-box`), "Resend code" with cooldown, Cancel/Confirm (`data-dash-mobile-otp-*`).
- Footer (D9): replace `<footer class="site-footer">…</footer>` (`~:1040-1089`) with the slim `<footer class="dash-footer">` described in D9 (Quick links use `data-dash-nav="booking|bookings|receipts|settings"`; hours text filled by JS from `InigoBusinessHours`). Keep the surrounding comment explaining it lives outside `[data-dash-panel]`.

### `includes/Dashboard.js`
- **Overview** (`OVERVIEW_SLOT_HOURS`, `renderOverviewSlotPill`, `isOverviewCourtHourOccupied`, `refreshOverviewCourtWidget`):
  - New `overviewDate` state (default today) driven by `[data-dash-overview-date]`; replace `todayRange()` usage with a day range built from `overviewDate`.
  - Booking query: `select('courts, court_unit, time_date, end_at, duration_minutes, status')` with schema-mismatch retry that drops `court_unit, end_at`.
  - `isOverviewCourtHourOccupied(court, hour, unitLabel)` — match `court_unit` against the card's selected unit (null/'' both sides treated as same unit, identical to `isSlotHourBooked`).
  - Pill label → `formatHourRangeLabelShort(hour)`; add `is-past` for elapsed hours when the chosen date is today. Unit select change re-renders that card's strip.
- **Step 2** (replace `paintSlotGrid`, `onSlotClick`, `extendSelectionTo`, `renderSlotGrid`):
  - Keep `fetchDayBookings()` and `isSlotHourBooked(hour)` (per-unit occupancy) as the single source of truth.
  - New `computeFreeWindows()` → array of `{ startHour, endHourExclusive }` runs of free, non-past hours for the selected court/unit/date.
  - New `renderTimePickers()`: fills `[data-dash-book-from]` with every free hour (`formatHourLabel`), fills `[data-dash-book-to]` from `From+1` to the end of the run containing From, writes the "Open on this date" line, and disables both selects with a message when the day has no free hour. Called by `resetSlotSelectionAndRender()` (rename to `resetTimeSelectionAndRender()`), i.e. on court/unit/date change and before submit (race guard re-fetch stays).
  - `change` handlers: From → set `bookingState.startHour`, rebuild To, clear `endHour`; To → set `bookingState.endHour = to − 1`; both call `updateSummary()` and `updateWizardButtons()`.
  - `bookStepIsReady()` for step 2 now requires **both** From and To.
  - Keep `bookingState.startHour/endHour`, `bookingHoursSelected()`, `updateSummary()`, `bookingTimeRangeLabel()`, and the insert payload unchanged.
- **Receipts** (`renderReceiptCard`): new markup per D7 using new `dash-receipt-*` sub-classes; `downloadReceiptAsPng` unchanged (still captures `.dash-receipt-card`).
- **Settings**:
  - Remove the profile-save handler's name/mobile writes (or guard it out) — names/email are read-only.
  - New mobile verification flow: validate with `window.validatePhMobile`, convert to E.164 `+63XXXXXXXXXX`, `updateUser({ phone })`, open OTP modal, `verifyOtp({ phone, token, type: 'phone_change' })`, then `profiles.update({ contact_num, phone_verified: true })` (schema-mismatch retry drops `phone_verified`). Toast success; `renderProfile()` shows the verified badge when `phone_verified` is true.
  - Map Supabase errors: SMS provider not configured / "Unsupported phone provider" → friendly toast; invalid/expired token → inline error in modal.
- **Footer**: D8 one-liner in `setActivePanel()` (target `.dash-footer`); fill `[data-dash-footer-hours]` from `InigoBusinessHours.formatHourLabel(OPEN_HOUR)` / `(CLOSE_HOUR)`; `downloadReceiptAsPng`'s iframe `ignoreElements` guard can stay (harmless).
- **After a successful booking insert**: call `refreshOverviewCourtWidget()` in addition to the existing My Bookings/notification refresh so the Overview strip immediately shows the new booking (D4).

### `Style/Dashboard.css`
- Step 2: remove `.dash-slot-grid` / `.dash-slot` selection-state rules that are no longer used (`.is-selected`, `.is-range-*`, `.is-in-range`); keep `.dash-slot-mini`, `.is-unavailable`, `.is-past` for the Overview strip and size `.dash-slot-mini` for `8–9 AM` labels. Add a two-column `.dash-time-range` layout for the From/To selects (1 column ≤ 620px) and `.dash-form-hint` for the open-windows line.
- Overview header layout for the new date field.
- Receipt redesign styles (D7) — `.dash-receipt-card` retains its class; add `.dash-receipt-brand`, `.dash-receipt-divider` (dashed), `.dash-receipt-total`, `.dash-receipt-meta`. Must still render correctly through html2canvas (avoid `backdrop-filter`, external images).
- Read-only input style (`.dash-input[readonly]`), mobile verify row, verified badge, OTP box styles (port the sizing of `.auth-otp-box` from `Style/Auth.css` under a `dash-otp-box` name).
- New `.dash-footer*` styles (D9): compact 3–4 column grid, collapses to 1 column ≤ 640px, matches the dashboard's card/line tokens rather than the landing page's.

### `includes/staff_dashboard.js` / `includes/owner_dashboard.js`
- No code change expected; verify the schedule grid still renders sanely with `CLOSE_HOUR = 20` (6 two-hour columns). Update any comment that hard-codes "9 PM".

### `database/schema/013_profile_phone_verified.sql` (new)
- `alter table public.profiles add column if not exists phone_verified boolean not null default false;` + comment. Idempotent, same style as `011_profile_avatar.sql`.

### `docs/OWNER_ACTION_LIST.md`
- New item: enable Phone provider + SMS provider in Supabase Auth, run `013_profile_phone_verified.sql`.

### `implementation_plan.md` (project root)
- Prepend a "Revision 5" section mirroring this plan (project convention: it's the running log every code comment cites).

## Constraints and non-goals
- No build step; plain `<script>` files attaching to `window`. Keep `data-dash-*` hooks, `dash-*` CSS prefix, hoisted function declarations.
- Do not change the `booking` insert payload shape or the `booking_no_overlap` semantics.
- Do not touch owner/staff dashboards beyond verifying they still work with the new `CLOSE_HOUR`.
- No fake OTP success path. No email-change flow.
- Non-contiguous slot selection (e.g. 8–9 AM and 2–3 PM in one booking) is out of scope (would require multiple booking rows/receipts).
- The static "Upcoming reservations" card on Overview is untouched (pre-existing fake data; separate task).

## Success criteria
1. Overview: date picker present; strip shows 12 pills labeled `8–9 AM … 7–8 PM`; changing date or unit updates booked/open state; today's elapsed hours look past.
2. Step 2: no slot buttons; From/To selects offer only free hours per D3 (e.g. with 10–11 AM booked, From = 8 AM ⇒ To offers 9 AM and 10 AM only); "Open on this date" line matches the Overview strip for the same date/unit; Next is disabled until both are chosen; summary shows correct range/hours/total; booking insert produces one row with correct `time_date`/`end_at`/`duration_minutes`.
3. Receipts: every field previously shown is still shown; new design; PNG download still works and the download button is not baked into the image.
4. Settings: names/email cannot be edited; mobile change goes through OTP; `contact_num` updates only after successful `verifyOtp`; verified badge shown when `phone_verified` true; unconfigured SMS provider yields a clear error, not a crash.
5. Footer visible on Overview only; hidden on every other tab and on deep links (notification → receipts).
6. Staff Court Schedule still renders (6 columns, last 6–8 PM). No console errors on customer dashboard load.

## Verification
- Start `static-server` from `.claude/launch.json` (python http.server :8532) and open `Pages/user_dashboard.html` in the in-app browser; sign in as a customer.
- Walk each tab: Overview (date change, unit change, expand strip), Book a Court (multi-click flows, past date guard, summary), Receipts (visual + download), Settings (readonly fields, Verify → modal), footer visibility on each tab.
- Check console/network for errors; confirm the booking `select` retries gracefully if `012` isn't applied.
- Reviewer pass on the diff (booking selection logic and OTP flow are regression-prone).

## Resolved questions (user answers, 2026-09-12)
1. Hours → 8 AM – 8 PM, last slot 7–8 PM, any contiguous number of hours. ✔
2. Step 2 → **no clickable slots**; From/To time pickers whose options shrink to the free hours on the chosen date (user's second correction). Still one contiguous range, one booking. ✔
3. Mobile OTP → real code path now, no paid provider yet; demo via Supabase test-OTP numbers. ✔
4. Receipt → store-receipt/ticket style; downloaded PNG must equal on-screen card. ✔
5. Footer → user asked for a recommendation; D9 is the recommendation (slim dashboard footer, no map iframe).

## Risks
- `phone_change` OTP requires the Supabase **Phone** provider to be enabled; with it disabled `updateUser({ phone })` errors — handled with a friendly toast, but the feature can't be exercised until the owner flips it on (owner action item).
- Receipt cannot show payment option / downpayment because `booking` doesn't store it; adding that is a separate schema + wizard change.
- Changing `CLOSE_HOUR` alters the staff schedule's column count; verify nothing in `staff_dashboard.js` hard-codes 7 columns.
- Existing bookings that end at 9 PM (made under the old hours) will render past the new grid; they're rare/none pre-launch, and My Bookings/Receipts still show them correctly from `end_at`.

## Execution notes
- Copy this plan into the project's `implementation_plan.md` as "Revision 5" before delegating (project convention).
- Single `coder` lane (all changes share `Dashboard.js` / `Dashboard.css`), then a `reviewer` pass on slot-selection logic and the OTP flow.


## Post-implementation notes (2026-09-12)

Implemented by the coder, reviewed independently, review findings fixed. Deviations from the plan above:

- **D4 tightened**: Step 2 now also counts staff walk-ins (`fetchDayWalkins()` → `slotGridWalkins`, court-wide since walk-ins have no unit) and the Overview strip counts only `pending`/`confirmed` bookings — both views now use the same inputs, so the "Open on this date" line and the Overview pills agree.
- **D6 hardened**: `updateUser({ phone })` only opens the OTP modal when `data.user.new_phone === e164` (a pending change). If Supabase's "Enable phone confirmations" is OFF, no code is sent and the UI says so instead of dead-ending. Pending OTP state is cleared on every modal close.
- `refreshOverviewCourtWidget()` got a request-sequence guard (`overviewRequestSeq`) so fast date changes can't paint stale data.
- Receipt: hours fall back to `duration_minutes` when `end_at` is absent; rate line uses the court's real `rateUnit` instead of a hard-coded "/hr".
- Footer starts visible in markup (Overview is the default panel and `setActivePanel()` only runs on navigation).
- `updateWizardButtons()` was not added — `updateSummary()` → `renderBookWizard()` already re-gates Next.

**Not verified live** (no signed-in session available to the agents): the receipt PNG side-by-side check, the OTP round trip, and "no console errors on load". Owner must run `database/schema/013_profile_phone_verified.sql` and enable Phone provider + confirmations + test-OTP numbers (docs/OWNER_ACTION_LIST.md E5) before mobile verification can be exercised.


---



# Customer Page — Revision 2 (post-feedback-v6 corrections)

## Goal

Five corrections to the customer page after reviewing the v6 redesign:
sport-based sorting on the Dashboard courts section, **re-scoping that
section to marketing rather than booking**, removing cancellation from My
Bookings and replacing it with the real no-cancellation / no-refund /
auto-"Unattended" policy, making Receipts show a downloadable receipt for
every booking made, and a **responsive audit/fix pass across the whole
page**.

## Context and current state

Verified by direct read today against commit `8ac0bb9`.

- **Courts sort** (`Pages/user_dashboard.html:379-382`) — the dropdown
  currently offers only `Available first` and `Price: Low to High`. The
  earlier `Sport (A–Z)` option was dropped in Phase 1 on the reasoning that
  per-sport grouping made it redundant. The user has now explicitly asked
  for sorting **by sports**, so that reasoning is overruled.
- **Courts still contains booking affordances**, which is the core of this
  revision: `wireBookNowButtons()` (`includes/Dashboard.js:953`) renders a
  **"Book Now"** button on every court card, and `jumpToBookingFromPeekSlot()`
  (`:1066`) makes every open peek-slot pill a click-to-book control that
  jumps into the Book a Court wizard at Step 3. The user's instruction is
  that this section is **marketing/showcase only** — booking has its own
  designated panel.
- **My Bookings has Cancel buttons** in two places: the static demo rows
  (`Pages/user_dashboard.html:626,639,652`) and, more importantly, the live
  renderer (`includes/Dashboard.js:1708`, `data-dash-cancel-booking`).
- **Two stale policy notices** state a cancellation policy that contradicts
  the real rule: `Pages/user_dashboard.html:542` (booking wizard) and `:600`
  (My Bookings) both say bookings "are cancelled" and are "non-refundable".
- **`booking.status` cannot store `'unattended'` today.** A documented CHECK
  constraint permits only `'pending' | 'confirmed' | 'cancelled' |
  'completed'` — violating it fails with Postgres code `23514` (see the
  detailed comment block at `includes/Dashboard.js:~859` and its `23514`
  error branch). `database/schema/004_staff_module.sql` also adds
  `checked_in_at`, which is exactly the "did they show up?" signal needed
  here.
- **Receipts is hardcoded to an empty state** — `RECEIPT_EMPTY_HTML`
  (`includes/Dashboard.js:1754`) always renders "No receipts yet"; the
  html2canvas → `toBlob()` → `<a download>` PNG path
  (`downloadReceiptAsPng()`, `:1808`) already exists and works but currently
  has nothing to act on.
- **Responsive coverage is thin**: only 5 `@media` blocks in
  `Style/Dashboard.css` (420 / 620 / 640 / 860 / 1080px), and the newest
  UI from the v6 pass (booking wizard steps, receipt cards, court cards with
  unit combo boxes, notification/feedback popovers, the wide
  `.dash-table`) was largely added without matching breakpoints.

## Approach and architectural decisions

**R1 — Courts section becomes marketing-only.** Remove **"Book Now"**
(`wireBookNowButtons()` and its `data-dash-book-court` markup) and remove the
**click-to-book hand-off** from peek slots (`jumpToBookingFromPeekSlot()`).
**Peek slots is retained as a read-only availability display** — it shows
open/booked hours but no longer navigates anywhere. Rationale: the user
praised this feature specifically and §4 of the v6 spec said keep it; showing
"here's how free our courts are" is showcase information, whereas *acting* on
a slot is booking, which now belongs solely to the Book a Court panel. The
booking wizard's own Step-1 court picker is unaffected. **Flagged for
confirmation** — if the user wants peek gone entirely, it is a small
follow-up deletion.

**R2 — Sort by sport, restored as the primary control.** The dropdown regains
a sport-based option as its **default**, ordering the per-sport groups
alphabetically, with `Available first` and `Price: Low to High` retained as
alternatives that sort courts *within* each sport group (grouping always
stays on, so the two concerns compose rather than conflict).

**R3 — No cancellation anywhere.** Delete the Cancel buttons from both the
static rows and the live renderer, plus the `data-dash-cancel-booking`
handler. Rewrite both policy notices to the real rule: **no cancellation, no
refunds/cashback, and arriving more than 30 minutes after the start time
automatically marks the booking Unattended.**

**R4 — "Unattended" is derived for display, not written to the database.**
A booking renders as **Unattended** when: `now > time_date + 30 minutes`,
`checked_in_at` is null, and status is still `pending`/`confirmed`. This is
computed client-side at render time in both My Bookings and the receipt.
Rationale: the CHECK constraint above would reject the value (code `23514`),
and nothing in this project runs a scheduled job, so a written status would
require a DB trigger/cron this repo cannot verify or safely add — the
`booking` table's RLS and triggers are explicitly not visible to this repo
(`database/schema/004_staff_module.sql:22-41`). Deriving it means the rule is
visibly enforced immediately, with zero migration risk and no fabricated
data. A migration `database/schema/010_booking_unattended_status.sql` is
**written but not required**, extending the CHECK to permit `'unattended'`
for whenever the owner wants staff/automation to persist it; the UI works
identically before and after it is applied. Existing `'cancelled'` rows are
still displayed correctly (historical data), we simply never create new ones.

**R5 — A receipt for every booking.** `renderReceipts()` builds one receipt
card per booking from the customer's real `booking` rows (the same data
`refreshMyBookings()` already fetches — reuse it, no second query). Each card
shows reference/booking id, court, sport, date, time, derived status, rate
and amount **where genuinely known** — falling back to the existing "Rate
TBA" honesty convention rather than inventing peso figures, since
`court.rate` is null for every row in the live DB and no `payment` rows exist
yet. Each card keeps its own **Download** button wired to the existing
`downloadReceiptAsPng()`. The empty state persists only when the customer
truly has no bookings.

**R6 — Responsive pass.** Audit every panel at ~1280 / 1024 / 768 / 480 /
360px and fix what breaks, prioritising the v6-era UI that never got
breakpoints: booking wizard steps + stepper, receipt cards, court cards and
their unit combo boxes, the notification and feedback popovers (must not
overflow the viewport on small screens), the modal, and the wide
`.dash-table` in My Bookings (horizontal scroll or a stacked card layout on
narrow screens). Fixes go in `Style/Dashboard.css` using the **existing
breakpoints** where possible rather than introducing a competing scale.

## Files to change

- `Pages/user_dashboard.html` — remove Book Now / Cancel markup, rewrite both
  policy notices, sort dropdown options, receipt container.
- `includes/Dashboard.js` — drop `wireBookNowButtons()` + peek hand-off, sport
  sort, drop cancel handler, derived Unattended status, real receipt
  rendering.
- `Style/Dashboard.css` — responsive fixes (primary), plus any styling the
  above needs.
- `database/schema/010_booking_unattended_status.sql` — **new, optional.**

## Constraints and non-goals

- **Do NOT touch** `Pages/staff_dashboard.html`, `Pages/owner_dashboard.html`,
  `includes/staff_dashboard.js`, `includes/owner_dashboard.js`,
  `includes/landingPage.js`, `Style/LandingPage.css`.
- The `booking` INSERT payload must remain byte-identical; the booking wizard,
  notifications, feedback modal, nav, and Account Settings are **not** in
  scope beyond responsive fixes.
- Never fabricate a rate, amount, or receipt. Keep "Rate TBA" / honest empty
  states.
- `window.escapeHtml` on every interpolated value.
- No build step; no new dependencies beyond the html2canvas CDN already
  present.

## Success criteria

1. Dashboard courts sort **by sport** by default; the other two options still
   work within groups.
2. **No "Book Now" button and no click-to-book** anywhere in the Dashboard
   courts section; peek slots still displays availability read-only.
3. My Bookings has **no Cancel control**, and both notices state the real
   no-cancellation / no-refund / 30-minute-Unattended policy.
4. A booking >30 min past start with no check-in displays as **Unattended**
   in My Bookings and on its receipt; no new `'cancelled'` rows are ever
   written; no `23514` errors.
5. **Every booking produces a receipt** in Receipts, each downloadable as a
   real `.png`; empty state only when there are genuinely no bookings.
6. No horizontal overflow or clipped/unusable controls at 1280 / 1024 / 768 /
   480 / 360px on any panel; popovers and modals stay within the viewport.
7. `node --check` passes; no console errors; Phase 1/2 features intact.

## Verification steps

1. `node --check includes/Dashboard.js`.
2. Grep for dead `data-dash-book-court`, `data-dash-cancel-booking`, and
   "non-refundable"/"are cancelled" strings.
3. Confirm the `booking` INSERT payload is unchanged (`git diff`).
4. Serve locally and check each panel at the five widths above.

## Open questions and risks

- **Peek slots kept as read-only** (R1) rather than deleted, since the user
  praised it and the v6 spec said keep it — but it *was* the main
  booking-adjacent feature in a section now designated marketing-only.
  Flagged; trivial to remove if unwanted.
- **"Unattended" is display-derived, not stored** (R4). Staff/owner
  dashboards read `status` directly from the DB and will therefore still show
  such bookings as `pending`/`confirmed` until the optional migration plus a
  writer exist. Flagged as a known, deliberate limitation.
- Receipt amounts stay "Rate TBA" until real rates/payments exist — the
  receipt is structurally complete but financially blank by design, not by
  oversight.

# Customer Page — Revision 3 (courts redesign + larger booking preview)

## Goal

Two focused UI/layout corrections to the customer page, both requested
directly by the user: redesign the Dashboard Overview panel's Courts section
so it stops wasting horizontal space, and make the Book a Court wizard's
Step-1 court preview substantially larger and the step's clear visual focus.
Plain HTML/CSS/JS, no build step, no new dependencies.

## Context and current state

Verified by direct read against the working tree after Revision 2.

- **`.dash-court-grid`** (`Style/Dashboard.css`) was a fixed
  `grid-template-columns: repeat(3, 1fr)`. The Overview panel's Courts
  section groups cards per sport (`.dash-court-groups` → one
  `.dash-court-group-title` + one `.dash-court-grid` per sport — see
  Revision 2's R2). The real data (`includes/courtsData.js`'s fallback,
  mirroring the live `court`/`sport` tables) is 9 courts across 8 sports —
  only Bowling has 2 rows (Duckpin + Ten-Pin); every other sport has exactly
  1. A fixed 3-column grid therefore rendered 7 of 8 groups as a single card
  in a 3-column row, leaving two-thirds of that row permanently empty — the
  "too much empty space on the right side" the user reported.
- **`.dash-court-media-lg`** (`Pages/user_dashboard.html`'s Book a Court Step
  1, styled in `Style/Dashboard.css`) — the standalone, larger court preview
  — was only 220px tall (170px under the old 640px breakpoint), stacked
  directly below the Court `<select>` in one column. The user asked for it
  to be "more larger."

## Approach and architectural decisions

**Change 1 — `.dash-court-grid` becomes a fluid, wrapped flex row instead of
a fixed grid**, so a sport's cards always fill the row's full width instead
of leaving empty tracks. A wrapped flex row was chosen over CSS Grid's own
`repeat(auto-fit, minmax(...))` specifically because auto-fit only collapses
a column that is empty across the WHOLE grid — an uneven last row (e.g. a
future 3-card group landing where only 2 columns fit) would still leave a
hole in that row. Flex-wrap instead redistributes each row's own leftover
space across whatever cards actually landed in it, so there is never a dead
track regardless of card count or viewport width.

A card that is the ONLY card under its sport heading (true for 7 of the 8
real sports today) additionally gets a LANDSCAPE layout — photo on the left
spanning the card's full height, name/rating/rate/tags/unit-picker/peek
toggle in a normal-width column on the right — rather than simply stretching
the existing portrait card to the full row width, which would just be a
very short, very wide banner with a tiny fixed-height photo on top (a
"stretched portrait card"). Bowling's 2-card group is deliberately excluded
from the landscape treatment: at the narrower end of the width range this
still has to support, a card sharing its row with a sibling doesn't have
enough width left for a landscape split's body column (the per-unit
`<select>` plus the "Show availability" toggle) without wrapping or
clipping. Two cards evenly filling the row (the same flex-basis that makes
the fluid grid work) already reads as "full width, deliberate" without
rotating. The landscape treatment (and the fluid grid's own per-card
flex-basis) is turned off below the existing 640px breakpoint, where every
card — solo or not — reverts to one full-width portrait column, matching
pre-Revision-3 mobile behavior exactly.

Peek slots (Revision 2, R1) are unaffected — still a read-only, non-
interactive `<span>` strip inside whichever card renders it, landscape or
portrait.

**Change 2 — `.dash-court-media-lg` is substantially taller (400px, 240px
under 640px) AND, on screens wider than 640px, sits beside the Court/unit
`<select>`s instead of stacked below them** (`.dash-book-step1-layout`, a new
CSS-grid wrapper with named `grid-template-areas`, dominant preview column
sized `1.6fr` against the fields column's `1fr`). The markup's DOM order
stays `[fields, preview]` — the Court `<select>`, the thing a customer
interacts with first, always reads/tab-orders before the preview — only the
WIDE-screen visual order is flipped (preview left/dominant) via
`grid-template-areas`, not `order` integers, so the wide-vs-narrow swap is a
single readable area map. Below 640px this collapses to one column in
natural DOM order (Court picker above preview), which is also the more
usable order on a narrow phone. Picking a specific unit remains preview-only
(unchanged from Revision 2/Phase 2) — it never changes what gets submitted.

## Files changed

- `Style/Dashboard.css` — `.dash-court-grid`/`.dash-court-card` fluid
  flex-wrap conversion, the new solo-card landscape rules, `.dash-court-
  media-lg`'s height/overflow, the new `.dash-book-step1-layout` +
  `.dash-book-step1-fields`/`.dash-book-step1-preview` rules, the matching
  640px/1080px breakpoint updates, and a corrected/extended responsive audit
  note (a stale Revision 2 R6 claim about `.dash-court-grid`'s old 1080px
  2-column rule was corrected in place).
- `Pages/user_dashboard.html` — Book a Court Step 1 restructured into the
  `.dash-book-step1-layout` wrapper (`.dash-book-step1-fields` +
  `.dash-book-step1-preview`); no `data-dash-*` attributes, ids, or their
  values changed, so every `includes/Dashboard.js` selector for this step
  still resolves to the same elements.
- `includes/Dashboard.js` — **not touched**. Both changes are pure
  markup/CSS; the `booking` INSERT payload, `sb.from('booking').insert({...})`
  and everything around it, is therefore byte-identical to before this
  revision (verified via `git diff` showing zero changes to this file).

## Constraints and non-goals

Same as Revision 2's constraints section — `Pages/staff_dashboard.html`,
`Pages/owner_dashboard.html`, `includes/staff_dashboard.js`,
`includes/owner_dashboard.js`, `includes/landingPage.js`,
`Style/LandingPage.css` untouched; the booking wizard's submitted payload,
notifications, feedback modal, nav, My Bookings' no-cancellation policy,
derived Unattended status, and per-booking receipts all unaffected; peek
slots stay non-interactive; `window.escapeHtml` unaffected since no
rendering JS changed; no fabricated data; no unrelated refactors.

## Success criteria

1. A sport with exactly one court (7 of the 8 real sports) fills its grid
   row's full width via a deliberate landscape layout, not a stretched
   portrait card or empty grid tracks.
2. Bowling's 2-card group also fills its row's full width, evenly split.
3. No horizontal overflow or clipped/unreachable controls at 1280/1024/
   768/480/360px for either the Courts section or the Book a Court Step-1
   preview (verified with a headless-browser scrollWidth check at all 5
   widths, plus screenshots).
4. Book a Court Step 1's preview is visibly the dominant element of the
   step, substantially larger than before, side-by-side with the court/unit
   pickers on screens wider than 640px.
5. The `booking` INSERT payload is unchanged (`includes/Dashboard.js` has
   zero diff).

## Verification steps

1. CSS brace balance / HTML tag balance (both confirmed programmatically).
2. `git diff --stat -- includes/Dashboard.js` returns empty.
3. Headless-browser (CDP) pass at 1280/1024/768/480/360px: `document.
   documentElement.scrollWidth <= clientWidth` on both the Overview and
   Booking panels, plus screenshots of the 1-card and 2-card (Bowling)
   court groups and the Step-1 preview at each width.
4. Console/exception check while exercising court/unit `<select>` changes,
   the peek-availability toggle, and the sort `<select>`, confirming no new
   errors.

---

# Customer Page — Revision 4 (mobile feedback placement, fixed drawer, clickable notifications, profile photo)

## Goal

Four changes to the customer dashboard (`Pages/user_dashboard.html`): (1) show
the Feedback card inside the side menu on mobile exactly as on desktop, (2) make
the mobile sidebar drawer truly fixed so it does not move when the page scrolls,
(3) make each notification clickable so it opens that booking's receipt, and
(4) add a profile-image upload to Account Settings that persists to the database,
keeping the existing initials avatar as the no-image default.

## Context and current state

- `.dash-feedback-card` (sidebar, `Pages/user_dashboard.html` ~line 106) is
  `display: none` below 860px; `.dash-feedback-btn-mobile` (topbar, ~line 139)
  takes over instead. Both open the same modal via `[data-dash-feedback-open]`.
- `.dash-sidebar` is `position: fixed` below 860px (`Style/Dashboard.css`
  ~line 2200) — but `.dash-shell` carries `.inigo-reveal`, and
  `Style/Loading.css` sets `transform: translateY(0)` on it. A transform on an
  ancestor makes it the containing block for `position: fixed` descendants, so
  the drawer and the scrim are positioned relative to `.dash-shell` (the whole
  page) rather than the viewport, and they scroll away with the page. That is
  the reported "menu bar moves when I scroll" bug. The `translateY(0)` is a
  visual no-op — nothing anywhere sets a non-zero translate on `.inigo-reveal`.
- Notifications (`includes/Dashboard.js`, `renderNotifications()` ~line 325) are
  derived from the customer's own `booking` rows (no `notification` table — D6).
  Items render as non-interactive `<div class="dash-notif-item">`.
- Receipts (`renderReceiptCard()` ~line 1808) render one card per booking, keyed
  by `booking.booking_id` (`normalizeReceipt()`), but the card's
  `data-dash-receipt-card` attribute carries no value, so there is nothing to
  target a specific receipt by.
- `profiles.avatar_url` already exists and is already selected by
  `includes/authGuard.js` (line 87) — it is simply never read or written by the
  UI. `renderProfile()` sets `.dash-avatar` `textContent` to initials.
- No Supabase Storage bucket exists anywhere in this project (see
  `includes/owner_dashboard.js` ~line 1035 and the two notes in
  `Pages/owner_dashboard.html`), and provisioning one is out of this repo's
  tracked scope.

## Approach and architectural decisions

R4-1 — Feedback lives in the sidebar at every width. Delete the
`@media (max-width: 860px)` rule that hides `.dash-feedback-card`, and remove
the `.dash-feedback-btn-mobile` markup + all of its CSS (base rule, the 860px
`display: inline-flex`, and the 640px icon-only overrides). One entry point, one
location, identical on mobile and desktop — which is what was asked, and it also
de-crowds a mobile topbar that already holds hamburger + title + theme + bell +
avatar. The sidebar gains `overflow-y: auto` so the card is always reachable on
short viewports.

R4-2 — Fix the drawer by removing the transform containing block. In
`Style/Loading.css`, drop `transform` from the `.inigo-reveal` transition and
drop `transform: translateY(0)` from the resolved state. Because that translate
is a no-op, this changes nothing visually on any dashboard but restores
viewport-relative `position: fixed` for the drawer and scrim. Also add
`body.dash-sidebar-open { overflow: hidden; }` so the page behind the open
drawer does not scroll. Applies to owner/staff dashboards too (same class) —
strictly a fix there as well, no behavioural change.

R4-3 — Clickable notifications open that booking's receipt. Carry
`booking.booking_id` through `renderNotifications()`; render each item as a
`<button class="dash-notif-item" data-dash-notif-booking="ID">` instead of a
`<div>`. Give receipt cards their id: `data-dash-receipt-card="${idAttr}"`
(`wireReceiptDownloads()`'s `closest('[data-dash-receipt-card]')` is unaffected).
Clicking a notification: close the dropdown, `setActivePanel('receipts')`, then
`scrollIntoView()` the matching card and flash a temporary `.is-highlighted`
outline. If the card is not found (receipts still loading), fall back to just
opening the Receipts panel — never a dead click, never a fabricated target.
Existing `.dash-notif-item` CSS gains button resets (background/border/width/
text-align/cursor) plus hover and `:focus-visible` states.

R4-4 — Profile photo stored as a data URL in `profiles.avatar_url`.
New "Profile Photo" card at the top of the Account Settings panel: live preview
(the existing `.dash-avatar` when empty, an `<img>` when set), an "Upload Photo"
button driving a hidden `<input type="file" accept="image/*">`, and a "Remove
Photo" button shown only when an image exists. On pick: validate that the file
is an image, then downscale through a `<canvas>` to a 256x256 center-cropped
JPEG (quality 0.82, roughly 20-50 KB) and store that data URL in
`profiles.avatar_url` via the same self-`update()` path the Personal Information
save already uses. `renderProfile()` becomes the single place that paints every
`.dash-avatar`: `avatar_url` present renders `<img class="dash-avatar-img">`,
absent renders today's initials, unchanged.

Decision needing confirmation: data URL in the existing `avatar_url` column
vs. a real Supabase Storage bucket. Storage is the "proper" answer but needs
new provisioned infrastructure (bucket + `storage.objects` RLS policies) that
this repo has explicitly kept out of scope everywhere else, and the column
already exists and is already fetched. The downscale keeps rows small. If the
bucket is preferred instead, that changes R4-4's write path only, not its UI.

## Files to change (with intent)

- `Style/Loading.css` — remove the no-op `transform` from `.inigo-reveal` (R4-2).
- `Style/Dashboard.css` — un-hide the sidebar feedback card at <=860px, delete
  `.dash-feedback-btn-mobile` rules, sidebar `overflow-y`, body scroll lock,
  `.dash-notif-item` button/hover/focus states, `.dash-receipt-card.is-highlighted`,
  `.dash-avatar-img` + Profile Photo card styles (R4-1/2/3/4).
- `Pages/user_dashboard.html` — remove the mobile topbar feedback button; add the
  Profile Photo card to the Account Settings panel (R4-1, R4-4).
- `includes/Dashboard.js` — notification ids + click-to-receipt, receipt card id
  attribute, avatar rendering, upload/downscale/save/remove wiring (R4-3, R4-4).
- `database/schema/011_profile_avatar.sql` — documentation-only migration: assert
  `avatar_url` exists (`add column if not exists`) and comment it to record that
  it now holds a downscaled data URL (R4-4).

## Constraints and non-goals

- Do not change the default (initials) avatar in any way — it stays exactly as-is
  whenever no image is set.
- No new Supabase Storage bucket, no new RLS policies, no `notification` table.
- No fabricated data: notifications stay derived from real `booking` rows.
- Owner and staff dashboards are not otherwise touched (the `.inigo-reveal` fix
  is shared and benign).
- Keep the existing plain `<script src>` architecture — no bundler, no new deps.
- Preserve the file's heavy explanatory-comment convention.

## Success criteria

1. At <=860px the Feedback card appears in the sidebar drawer, in the same place
   and form as desktop; no Feedback button remains in the topbar.
2. At <=860px, opening the drawer and scrolling the page leaves the drawer and
   scrim visually fixed to the viewport; the background does not scroll.
3. Clicking any notification opens the Receipts panel and scrolls to and
   highlights that booking's receipt card; the dropdown closes.
4. Account Settings can upload a profile image; it appears in the topbar avatar,
   the Profile panel avatar, and the settings preview; it survives a reload
   (round-trips from `profiles.avatar_url`); Remove Photo restores the initials.
5. No console errors; desktop layout at >=1080px is unchanged.

## Verification steps

1. CSS brace balance and HTML tag balance checked programmatically.
2. Headless-browser pass at 1280 / 860 / 640 / 360px: drawer fixed-position check
   (`getBoundingClientRect().top === 0` after scrolling), feedback card visible in
   the drawer, no topbar feedback button, no horizontal overflow.
3. Notification click: assert active panel is `receipts` and the highlighted
   card's id matches the clicked notification's booking id.
4. Upload a small test image, confirm the `profiles` row's `avatar_url` is
   written, reload, confirm the image renders; then Remove and confirm initials.
5. Console/exception check across all four flows.

## Open questions and risks

- The storage decision above — the one item that needs the user's call.
- Data URLs make the `profiles` row larger; the 256x256 JPEG cap keeps this at
  tens of KB, but many users with photos will grow `authGuard`'s profile fetch
  slightly.
- Removing `transform` from `.inigo-reveal` touches all three dashboards; risk is
  low (no-op value) but is worth a visual smoke test of the reveal animation.

## Post-implementation notes (Revision 4 as shipped)

- `.dash-notif-item-body` became a `<span>` rather than a `<div>`, since the
  notification item itself is now a `<button>` and `<div>` is not valid content
  inside one. `display: flex` makes it render identically either way.
- `.inigo-reveal` in `Style/Loading.css` is the only shared file touched; the
  reveal fade was smoke-tested on the owner and staff dashboards and still
  toggles opacity 0 -> 1 correctly, with no transform reintroduced.
- Not verified live (no signed-in Supabase session available in the sandbox):
  the `profiles.avatar_url` write round-trip against the real database, and the
  notification -> receipt jump against real booking rows. Both were exercised
  through the real code paths with a stubbed `window.sb` query chain, but need
  a signed-in browser pass to be considered confirmed.
# Current decision: contact number validation (2026-09-29)

The project manager replaced the SMS phone ownership verification described in
earlier revisions above. The current staff portal rollout uses Abstract Phone
Validation for optional customer, staff, and owner contact numbers. An
authenticated Edge Function calls Abstract with a secret kept in Supabase;
after a valid Philippine mobile result, it creates a short-lived, one-use proof
that the database requires when a changed number is saved. There is no SMS,
OTP dialog, Supabase Phone Auth requirement, or demo code. A successful check
means **number validated**, not ownership or current reachability. Email OTP
used for account authentication is unaffected. The project uses application
limits to stay under Abstract's free allowance. Setup and limitations are in
[docs/phone-validation-setup.md](docs/phone-validation-setup.md). All phone
instructions in older revisions of this document are superseded by this section.

## Development data cleanup audit (2026-10-31)

The connected Supabase project is development/test data. The 35 payment records
were confirmed linked and acknowledged, and current booking and walk-in records
were structurally valid; preserve them and their history. The forward migration
[`20261031141803_cleanup_legacy_development_artifacts.sql`](supabase/migrations/20261031141803_cleanup_legacy_development_artifacts.sql)
removes only the four audited orphan legacy attendance events (`booking_timed_in`
for missing `booking` or `walk_in_booking` rows, and `walkin_recorded` for
missing `walk_in_booking` rows). It also drops the one-time internal cleanup
snapshot table, which held 12 rows, had no references in current database
function definitions or application runtime reads, and is not created by any
recurring runtime path. The drop uses
no `CASCADE`; the migration fails and rolls back if an unreviewed dependency
exists. The audit guard is pinned to the four reviewed UTC `created_at`
timestamps and requires the exact 1/1/2 action/entity distribution. The
snapshot guard requires its reviewed UTC `captured_at` timestamp
(`2026-09-26 12:06:26.530372+00`), one snapshot ID, and the exact per-table
counts: `_metadata=1`, `public.booking=7`, `public.court=1`, `public.sport=1`,
and `public.walk_in_booking=2`. These guards permit only the audited cohorts (or
an already-removed state for idempotency), and commented dry-run queries
list/count candidates before apply.

Other audit history and all valid current-format bookings/payments remain
untouched. No additional cleanup candidate is approved by this audit; any newly
observed orphan or changed snapshot count is deferred for review rather than
treated as obsolete by age or broad shape alone. Applied as remote migration
`20261031141803` after a verified, encrypted local backup at
`%LOCALAPPDATA%/InigoSync/database-backups/2026-10-31-legacy-cleanup.json.dpapi`
(Windows current-user DPAPI; retain until the next reviewed cleanup). Post-apply checks
found zero selected orphan events, no snapshot table, unchanged counts of 24
bookings, 13 walk-ins, 35 payments, and 35 payment acknowledgments. A staff RPC
check still returned `visit_transactions_v1` with 3 completed and 21 unattended
records (24 total). Browser testing remains with the project manager.

## Transaction Records design and implementation (2026-10-31)

Current records represent two different events. A **staff-timed-in visit** has
a staff time-in audit event, whether or not time-out has been recorded; any
balance collected at the desk appears as its amount, including zero for a fully prepaid visit. A **no-show/unattended visit**
has no staff time-in event, desk collection, transaction ID, or staff receipt.
The customer's booking deposit is separate from the staff transaction amount.
Showing both in a single seven-column transaction table therefore produces
intentional blanks for most of the current rows (21 of 24 for the checked staff
account). Those blanks are not evidence of missing payment records.

Approved page structure: keep **Transaction Records** as the page, with two
clearly labeled views or tabs. The [illustrative staff-transaction mockup](docs/mockups/staff-transaction-records-plan.png)
uses the current dark/orange theme and a fixed-width table without horizontal
scrolling:

1. **Transactions** — one row per staff time-in event, including active visits
   before time-out and completed visits. Columns: transaction ID, customer,
   actual time in / time out (dash until time-out), source (`Booking` or
   `Walk-in`), visit status (`In progress` or `Completed`), amount collected by
   staff, and `View receipt`. The staff transaction receipt should combine
   the time-in audit event with its payment acknowledgment when money was
   collected. For a verified fully paid zero-collection visit, show `₱0.00` and a
   staff time-in acknowledgment with transaction ID, booking/walk-in ID, visit
   details, and `Full payment paid`; generating it from the time-in event must
   not invent a second customer payment. The
   mockup's short transaction IDs are illustrative; the actual persisted event
   UUID must remain accessible in the detail/receipt view and search.
2. **Unattended visits** — booking or walk-in reference, customer, scheduled
   visit date/time, source, and `Unattended` status. Show staff collection as
   `₱0.00` only if that column is retained in this view; omit time-in/time-out,
   transaction ID, and receipt columns because no staff transaction happened.

Both views share aligned customer/reference search, a `Source` menu, visit date,
and newest/oldest sort; the Transactions view also searches transaction ID and
shows a status menu for `In progress`/`Completed`. Unattended has only one
possible status, so it has no status control. The `Source` label and its
`All sources` default are display-only; `Booking` and `Walk-in` are selectable,
with a clear action to restore all sources. At narrow
widths, rows become stacked cards rather than making the table scroll
horizontally. The approved design is implemented in the staff dashboard; active
time-ins appear immediately with `In progress` until checkout. The previously
applied
[`20261031134804_staff_visit_transactions.sql`](supabase/migrations/20261031134804_staff_visit_transactions.sql)
has been restored to match the live function definition. The forward RPC
replacement in
[`20261031145608_staff_transaction_records_redesign.sql`](supabase/migrations/20261031145608_staff_transaction_records_redesign.sql)
was applied to the connected Supabase project on 2026-10-31. It returns staff-attributed
time-in audit IDs and unattended visits separately, with no payment ID or
receipt fields for unattended rows. Zero-collection time-in rows use the event
ID to generate a time-in acknowledgment with ₱0.00 collected; this does not
create a payment or acknowledgment row. The follow-up forward migration
[`20261101011223_staff_transaction_receipt_context.sql`](supabase/migrations/20261101011223_staff_transaction_receipt_context.sql)
was applied to the connected Supabase project on 2026-11-01. It adds verified
current full-payment state and available visit/booking details to the RPC.
The existing zero-collection booking in development records returns booking ID
70, `fully_paid: true`, and `amount_minor: 0`; no records were converted or
deleted. The acknowledgment distinguishes the booking total from the amount
collected at time-in.

The read-only live-data review on 2026-10-31 found six staff-attributed time-in
events (five `timed_in`, one `collected_online_balance` carrying
`time_in_recorded=true`), all joined to visits with a time-in timestamp and
currently checked out. Thus there was no in-progress event to verify from live
records; inclusion of future active visits is covered by the RPC contract test.
Current booking and walk-in records, accounts, payments, acknowledgments, and
their history remain unchanged. No additional conversion or cleanup is
warranted for this RPC/UI contract change; the separately audited cleanup above
is the only approved development-data cleanup. Post-apply checks found the same
24 bookings, 13 walk-ins, 35 payments, and 35 acknowledgments. The checked
staff RPC still returned 24 records (3 completed, 21 unattended, 0 currently
in progress), and anonymous execution remains denied. Browser testing remains
with the project manager. A live customer-role call was also rejected by the
active-staff gate; no customer or payment data changed during verification.

### Paid staff walk-ins start as time-ins

The staff walk-in cash flow now collects tender and displays change in an
accessible payment dialog after the staff member selects Cash and clicks
**Complete cash payment**. Pay Online keeps its PayMongo checkout and return
flow. Existing server paths establish authoritative payment before
reservation confirmation: the cash order RPC creates its order as `paid`
before inserting confirmed reservations, and `record_paymongo_paid` changes an
online order to `paid` before confirming its pending reservations. The
baseline migration
[`20261101051738_staff_paid_walkin_auto_timein.sql`](supabase/migrations/20261101051738_staff_paid_walkin_auto_timein.sql)
sets Time-In on fully paid staff walk-in reservations. The connected project
records it at `20261101051738`, followed by the authorization gate at
`20261101051857`. The gate allows automatic Time-In only for the active
order-owning staff member inside the transaction-local staff walk-in RPC, or
for the trusted PayMongo service role. The audit trigger applies the same
authorization check. Both functions use `SECURITY DEFINER`, an empty
`search_path`, and revoke execute from client roles.

The local forward replacement
[`20261101131600_staff_paid_walkin_auto_timein_auth_gate.sql`](supabase/migrations/20261101131600_staff_paid_walkin_auto_timein_auth_gate.sql)
keeps the gate after the baseline on fresh migration replay. It is installed
in development. The subsequent correction migration is recorded live as
`20261101052310` and installs the final pending-only gate. Repository file
timestamps use the configured Asia/Shanghai clock while MCP migration
versions are UTC; reconcile the timestamp mapping before a CLI-managed push.

The baseline included a historical conversion, which was too broad. A
read-only reconstruction found nine converted visits: three remain confirmed
and inside their scheduled windows, while six had a prior system
`marked_unattended` event and had passed `end_at`. All nine had one paid staff
order, payment, acknowledgment, and matching staff-created walk-in audit;
payment occurred from 138 minutes before to 17 minutes after scheduled start.
The six ended no-show rows did not have reliable attendance evidence.

The correction migration
[`20261101132200_staff_walkin_attendance_backfill_correction.sql`](supabase/migrations/20261101132200_staff_walkin_attendance_backfill_correction.sql)
restores those six rows to `unattended` with null attendance timestamps. It
retains their original automatic-Time-In audit events and writes six
compensating system events. The three active confirmed paid visits remain
timed in. The correction also limits automatic Time-In to inserts and
pending-to-confirmed settlement, so a service-role transition from an
unattended or terminal state cannot create attendance. Migration
[`20261101051924_staff_walkins_not_unattended.sql`](supabase/migrations/20261101051924_staff_walkins_not_unattended.sql)
restricts future no-show processing to customer bookings.
The intervening
[`20261101052431_staff_paid_walkin_status_invariant.sql`](supabase/migrations/20261101052431_staff_paid_walkin_status_invariant.sql)
is intentionally a no-op: a proposed invariant would have reclassified
elapsed no-shows as attended and rejected their valid `unattended` status.
It was not applied to development. Keep that version inert on fresh replay.

The effective final trigger is now also guarded against direct timestamp
forgery. Local migration `20261101150000_staff_paid_walkin_direct_update_guard.sql`
rejects an authenticated insert/update that sets or rewrites `checked_in_at`
on an order-backed walk-in unless it comes from the owning active staff RPC or
the verified service-role settlement. Its predecessor,
`20261101141000_staff_paid_walkin_owner_gate.sql`, contains the owner-bound
pending-to-confirmed gate. Both function-only migrations were applied through
the Supabase apply tool; remote history recorded versions `20261101061932`
and `20261101062227`. A concurrent remote migration at `20261101061940`
(`staff_paid_walkin_trusted_settlement`) has a local-name counterpart at
`20261101133100`, but its recorded version differs. The live functions were
read back after the latest application and include the owner, active-profile,
marker, pending-state, and direct timestamp-write checks. The authenticated
role's direct UPDATE against a real visit was additionally denied by the
current table grants (`permission denied for table walk_in_booking`).

Development now contains 16 walk-ins, 38 payments, 38 acknowledgments, nine
automatic-Time-In events across nine unique visits, six compensation events,
zero unattended walk-ins, and one active timed-in walk-in. The seven rows
without a check-in are cancelled orders whose payment attempts expired; they
are not active transactions and should not appear in Transaction Records.
Event validation found no duplicate events, missing visit rows, actor
mismatches, payment/order mismatches, or missing check-in timestamps. No rows
changed in my rollback-only security probes. Both trusted cash-owner and
service-role settlement paths produced one audit event in the probe; no live
PayMongo walk-in record was available, so PayMongo-specific end-to-end
settlement remains unverified.
The Supabase CLI and `npx` are unavailable, and remote versions differ from
local filename timestamps (`20261101051857` remote gate vs local
`20261101131600`, with remote `20261101052310`/`20261101052431` history and
local `20261101132200`/`20261101133000`/`20261101133100` variants). Do not run
`migration repair` or a CLI push until the migration definitions/provenance
are reconciled; the currently deployed function-only guards have recorded
remote history entries.

The focused contract tests now check payment, acknowledgment, staff audit,
correction, migration ordering, and final direct-write gate behavior.

### Staff Booking Overview attendance controls

The Booking Overview now includes both customer bookings and staff walk-ins,
with an explicit Type column and a Booking/Walk-in filter. Existing customer,
sport, court/unit, scheduled time, balance, search, date filter, and row actions
remain. The default date filter is today's Manila date. The date picker's
native Clear action leaves the date blank to show today and upcoming dates;
the separate Clear filters button restores today's date. Staff can also select
a future date explicitly. Within the selected date, actionable Time-In rows
come first, then actionable Time-Out rows, then
rows with no action; each group sorts by booking date and start time with a
stable ID tie-break. A staff Time-Out requires confirmation; on success, the
row leaves the active overview.

The existing Time-In payment modal requires settlement of any outstanding
balance before check-in, while paid walk-ins appear as active time-out-only
rows through the existing paid-walk-in trigger. The existing one-minute
attendance job automatically checks out active booking and walk-in rows at
slot end. The existing notice capture creates staff ending-soon notices
within ten minutes, and the dashboard refreshes the feed on its one-minute
cycle.

Forward migration
[`20261101051352_staff_early_checkout_auto_completion.sql`](supabase/migrations/20261101051352_staff_early_checkout_auto_completion.sql)
prevents the scheduled attendance job from writing a second timeout event for
a reservation already checked out early. It preserves that reservation's
confirmed status through the end of its originally scheduled slot, then marks
it completed without another audit entry. A read-only development-data check
found zero confirmed checked-in early checkouts before or after slot end in
both `booking` and `walk_in_booking`; no records were converted or deleted.
The Supabase CLI is unavailable in this environment, so the file was created
using the repository timestamp convention; Supabase's apply tool recorded
version `20261101051352`, matching the migration filename. The post-apply
check kept 24 bookings, 16 walk-ins, nine timeout audit rows, and zero early
checkout rows in either category. No cleanup was indicated by the observed
records.

### Earlier paid walk-in attendance rule (November 1, 2026; superseded below)

The project manager clarified that a staff walk-in is automatically timed in after its full payment. Walk-ins cannot be unattended; that status applies only to customer bookings. This instruction supersedes the earlier historical attendance interpretation above. The forward migration `20261101133000_staff_paid_walkin_status_invariant.sql` applies the receipt-backed historical correction and disallows `unattended` in the walk-in status constraint. The later `20261101141000` and `20261101150000` function-only migrations finish the authorization gate and block direct timestamp writes. The earlier `20261101052431` version remains an inert local history entry. Current development counts are 16 walk-ins, 38 payments, 38 acknowledgments, zero unattended walk-ins, and one active timed-in walk-in; all nine automatic-Time-In events map to unique, internally consistent records. Remote migration history has generated versions from concurrent development work and does not match all local filename timestamps. The CLI is unavailable, so migration-history repair is deferred until provenance can be reconciled with supported tooling.

### Configurable unbooked slot cutoff

The owner Business Hours editor now saves a separate 0–59 minute slot cutoff (default 10), while preserving the no-show grace period for attendance handling. The shared rules reader, customer availability, staff walk-in picker and Court Schedule, trusted checkout, and staff walk-in order RPC use this setting. The deadline remains exclusive: a slot is closed at its exact configured cutoff. Migration `20261101160000_booking_slot_start_cutoff.sql` adds a constrained `slot_cutoff_minutes` column with default 10, so existing rules receive the default without changing or deleting reservations or no-show grace values.

Blank cutoff input is explicitly rejected before numeric conversion. The legacy three-argument owner save RPC remains callable for older clients: new dates inherit the cutoff effective on that date, while same-date updates preserve their existing cutoff. The four-argument owner RPC is the path for intentionally changing the value.

A prior documented read-only development-data review found 7 `booking_rule_sets` rows: 1 legacy row at 30 minutes of no-show grace, 2 rows at 35, and 4 rows at 30. A fresh read-only check through connected Supabase on November 2, 2026 confirmed 7 rows, zero grace values outside 0–59 (minimum 30, maximum 35), and zero cutoff values outside 0–59. No slot-cutoff values existed before the earlier cutoff migration. The range migration was applied to the connected database on November 2, 2026. A post-migration check confirmed the same 7 rows and values, both 0–59 table constraints, and the 0–59 check in both owner-save RPC overloads. The migration service recorded remote version `20261102023543`, which differs from the local filename timestamp and must be reconciled before CLI migration-history operations.

The Business Hours editor now accepts only ASCII digits for both minute fields and saves only whole values from 0 to 59. Invalid characters and malformed pastes are rejected, with an input-event fallback that restores the last accepted text without converting malformed input into a number; values above 59 show an inline error. Migration `20261102150000_booking_rule_minutes_range.sql` narrows the grace column constraint and both the current and legacy owner-save RPC validations to 0–59. The latest read-only data check confirmed all seven live rows already satisfy the new range, so no cleanup or conversion is needed.

### Superseded same-day early Time-In proposal (November 1, 2026)

The project manager asked to plan same-day early Time-In before applying it. This midnight proposal was superseded by the final 30-minute rule below and was never applied.

1. In the staff UI, offer Time-In during that window for a confirmed customer booking. Preserve the existing full-balance collection requirement. A paid staff walk-in already receives automatic Time-In on settlement and must follow the same display states.
2. Distinguish `checked_in_at` before `time_date` as checked in and waiting for the slot. It must remain visible near the top of Booking Overview but must not count as `In play right now` or expose Time-Out until scheduled start. Keep court occupancy tied to the reserved interval, not check-in time. At scheduled start, transition the derived display to `In play` without rewriting persisted attendance.
3. Enforce the same local-day lower bound and existing upper bounds in trusted cash Time-In, QR balance checkout preparation, and PayMongo settlement (`record_paymongo_paid`, which can write `checked_in_at` after payment). Guard manual Time-Out on the server until scheduled start; hiding the button alone is insufficient. Keep actor, payment, no-show, and audit checks intact. Review any other entry point that writes `checked_in_at`.
4. Add boundary tests for before midnight, midnight, before start, exact start, grace deadline, scheduled end, and Manila day rollover, plus payment and staff authorization paths. Verify the waiting state, Overview order, action availability, active count, and schedule display.
5. Before any migration, recheck current development records for incompatible early attendance or checkout values, preserve valid same-day records, and make only evidence-backed targeted conversions. Verify counts and UI behavior before and after. Include an independent security review of payment and privileged database paths.

Read-only development inspection on November 1 found 25 customer bookings and 18 walk-ins. One booking and eight walk-ins had `checked_in_at < time_date`; all nine check-ins occurred on the same Manila calendar day as their reserved slot. One confirmed walk-in was checked in while its start was still in the future. None of the nine had a Time-Out before scheduled start. These records are valid for the proposed waiting state; no cleanup is currently indicated. Recheck immediately before implementation because development data can change.

A read-only check of deployed function definitions found no scheduled-start guard in `staff_record_time_out`. The deployed `record_paymongo_paid` also writes `checked_in_at` on successful balance settlement. Both need explicit treatment in the implementation; the UI and checkout preparation checks alone cannot enforce the rule.

### Final 30-minute booking Time-In and scheduled walk-in Time-In (November 1, 2026)

The project manager replaced the proposed full-day window with a 30-minute lead for online bookings. Staff may press Time-In from exactly 30 minutes before the reserved start, but an early arrival is shown as `Arrived · waiting`, stays in Booking Overview, is excluded from `In play right now`, and cannot be timed out before the slot starts. Transaction Records also displays an early checked-in visit as `Arrived · waiting` until its scheduled start. Paid walk-ins are confirmed at payment without attendance. Their Actions cell shows `Walk-in` before start; they never receive a manual Time-In button. The one-minute attendance job automatically records Time-In when their reserved slot is in progress, and an on-slot payment can time in immediately. Walk-ins do not become `Unattended`; if an attendance job was missed for an entire slot, the elapsed reservation is completed without a fabricated check-in and receives a system audit event. Action priority remains actionable Time-In, then actionable Time-Out, then status-only rows. The date filter defaults to today, and the native date-picker Clear action shows today and upcoming dates.

Forward migration [`20261101180500_staff_scheduled_walkin_timein.sql`](supabase/migrations/20261101180500_staff_scheduled_walkin_timein.sql) moves the established cash, QR preparation, and manual Time-Out RPC bodies into the private `internal` schema with client execute revoked, then installs staff/role-gated public wrappers for the new timing rules. The paid-walk-in trigger retains its direct-write authorization guard but only checks in a newly paid visit if the slot is already in progress. A separate trusted job checks in previously paid visits at/after start and writes one `timed_in` audit event attributed to the order-owning staff member. `process_due_attendance` runs that job before scheduled Time-Out and booking no-show processing. The existing one-minute cron job remains active.

Before application, development had 26 bookings (7 checked in, 1 early) and 18 walk-ins (11 checked in, 8 early). Seven walk-ins without check-in were cancelled expired orders; there were zero confirmed paid walk-ins lacking check-in and zero active balance checkout attempts. The migration changes no records at application time. Post-application counts remained 26/7/1 for bookings and 18/11/8 for walk-ins. No existing visit or audit was converted or deleted. Rollback-only SQL probes against the connected development database verified early cash/QR rejection, exact 30-minute cash Time-In and QR preparation acceptance, manual walk-in rejection, pre-start Time-Out rejection for both sources, future paid walk-ins remaining unchecked at payment, one scheduled Time-In audit event, worker idempotency, and elapsed walk-ins completing without Unattended. All probes rolled back, and post-probe checks found no new function or audit rows left behind.

After deployment, another rollback-only probe confirmed that a scheduled walk-in Time-In appears exactly once in the order-owning staff member's Transaction Records response with `in_progress`, `fully_paid=true`, and zero collected at Time-In. The probe left 26 bookings, 18 walk-ins, 11 checked-in walk-ins, and zero elapsed-slot audit events unchanged. The attendance cron's first observed post-deployment run succeeded. Readback confirmed the three public timing guards, their preserved private RPC bodies, the in-slot trigger guard, restricted internal execute privileges, and the active cron job.

The connected development migration tool recorded this migration as remote version `20261101101155` while the local filename uses Asia/Shanghai timestamp `20261101180500`. Existing remote/local migration-history drift remains unresolved; do not perform CLI push or migration repair until provenance is reconciled and clean replay is verified. Focused security review approved development application with this warning. The new public staff RPCs are intentionally executable by authenticated users because each validates an active staff profile; the internal RPC bodies are not executable by client roles.

### Time-In payment confirmation and tender capture follow-up (November 1, 2026)

For reservations with a balance, choosing Cash or Online Payment is only a
method selection. Cash opens a POS dialog and requires sufficient tender in
cents before the authenticated collection/Time-In RPC runs. Online Payment
opens the hosted PayMongo checkout; a verified return opens Time-In for staff
review and does not itself record attendance. The 30-minute booking Time-In
gate, balance validation, late-payment/no-show handling, and automatic
walk-in schedule behavior remain enforced server side.

Forward migration
[`20261101190000_staff_timein_cash_tender.sql`](supabase/migrations/20261101190000_staff_timein_cash_tender.sql)
adds tender/change capture to the cash payment and acknowledgment. The follow-up
[`20261101200000_staff_balance_settlement_attendance_boundary.sql`](supabase/migrations/20261101200000_staff_balance_settlement_attendance_boundary.sql)
keeps verified PayMongo booking-balance settlement from writing
`checked_in_at` and corrects its audit detail to `time_in_recorded=false`; the
existing settlement function and its late/no-show branches remain intact. It
also treats an active admin who owns a paid walk-in order the
same as staff for automatic on-slot Time-In and records the actual owner role
in the audit event. It does not permit manual walk-in Time-In or alter the
walk-in slot window.

A read-only connected-development check found 26 bookings, 18 walk-ins, and 42
payments. The only booking with `balance_payment_method='PayMongo'` was already
completed, checked in, and checked out; preserve this historical attendance
record because the database cannot establish whether the customer physically
arrived. No backfill or cleanup is included. One confirmed unpaid unchecked
booking remains valid in the current format. Both follow-up migrations were
applied to the connected development database after independent security
review. The migration service recorded remote versions `20261101104413` and
`20261101104418`, which differ from the local filename timestamps; reconcile
the existing remote/local migration-history drift before any CLI push or fresh
replay.

After application, readback confirmed the three-argument cash RPC is callable
by authenticated staff but not anon, its private body is not client-callable,
and the booking/audit settlement triggers are installed. A rollback-only
PayMongo settlement probe verified that payment leaves booking attendance
empty and writes `time_in_recorded=false`; a second probe verified that a
fully paid booking can be timed in exactly once afterward without another
payment. A rollback-only cash probe entered ₱700 against a ₱650 balance and
verified the checked-in state, ₱700 tender, ₱50 change, and matching receipt.
The probes restored 26 bookings, 18 walk-ins, and 42 payments, including the
historical completed PayMongo booking. The focused Node suite passed 47/47;
JavaScript syntax checks passed. Browser automation remains unrun because
Playwright is not installed in this checkout. The exposed staff cash RPCs
produce the expected Supabase advisor warning for intentional authenticated
`SECURITY DEFINER` endpoints; both validate an active staff profile.

# Staff Portal — Booking Extension (2026-11-01)

## Implementation

- In the staff Booking Overview, checked-in hourly reservations expose a compact `+` action next to Time-Out only when the database reports immediately consecutive time is available. Opening the dialog reloads available one-hour increments through the configured closing time. Staff choose a contiguous duration, then Cash through the calculator popup or PayMongo.
- Cash uses server-side pricing and atomically checks the existing reservation, configured operating hours, current physical slot availability, tender, payment ledger, receipt, and updated `end_at`. It retains the existing reservation ID and start time and updates the payment total/paid amount.
- Online payment creates a 15-minute physical resource hold using the existing checkout hold/exclusion mechanism. The booking end changes only in the signed PayMongo settlement transaction after amount, attempt, staff, existing booking end, and held extension are checked. Payment confirmed after the original booking ends is marked for manual refund review without extending it. Existing PayMongo expiry reconciliation expires checkout sessions before releasing holds; PayMongo checkout sessions do not expire by themselves, so this existing scheduled worker must be deployed and running.
- A paid extension checkout that enters manual review releases its physical hold, including amount and reservation-state mismatches. The provider payment still requires owner reconciliation or refund; the original booking is not extended in that state.
- Booking/walk-in extension options and payment RPCs validate active staff access. The checkout Edge Function also validates the signed-in staff role and verified email session. No customer email receipt is requested.

## Data impact review

- Read-only inspection of the connected development project showed 27 `booking` rows, 18 `walk_in_booking` rows, and 44 `payment` rows before this additive schema change.
- The migration adds an internal extension checkout ledger plus nullable extension metadata to checkout intent items. Existing booking, walk-in, payment, receipt, and account rows are not transformed or deleted; no existing current-format records were identified as incompatible. No data cleanup is required for this additive change.
- The migration has not been applied to the hosted database, and there is no local Supabase CLI/psql available here. Therefore post-migration row counts and database behavior remain to be verified when the migration is applied in a disposable/local Supabase database. Re-run the three baseline counts after migration to confirm the totals remain unchanged.

## Verification gaps

- PayMongo extension checkout expiry depends on the existing `paymongo-expire-checkouts` worker being configured and operational. It must continue to reconcile provider state before releasing a held slot.
- This migration was not executed against a database in this workspace; its SQL still needs local Supabase migration validation before deployment.
- A disposable/local database integration test remains necessary for the slot exclusion race, paid-review hold release, duplicate webhook settlement, and the dynamic PayMongo function rewrite. The current Node tests exercise source contracts and UI cash arithmetic only.
- A read-only check against the connected development database confirmed that the existing PayMongo settlement function has exactly one intended top-level insertion marker and the expected row/variable declarations. This checks integration shape only; it does not validate the new SQL at runtime.

## Staff extension corrective deployment — 2026-11-04

- Walk-in W-91 was confirmed, paid, checked in, and had an open consecutive hour at the time of the report. The extension-options RPC failed because one pricing call passed a numeric duration to an integer-only helper. `20261104143000_fix_staff_booking_extension_price_duration_type.sql` replaces that RPC with integer-minute pricing. It was applied to the connected Inigosync development project; readback confirmed the corrected function body.
- Live PayMongo logs also showed an ambiguous `x.intent_id` reference in extension settlement. `20261104144500_fix_staff_extension_paymongo_alias.sql` narrowly renames the SQL alias after checking exactly one expected fragment. It was applied after the options fix; readback confirmed the distinct alias.
- Both migrations replace functions only. They do not convert or delete booking, walk-in, or payment records. A disposable-database paid-extension and conflict/review integration test is still needed; source-contract tests and deployed function readback do not prove the full webhook settlement path. No data cleanup is indicated by these corrections.
- A walk-in cash extension then exposed `record "new" has no field "booking_id"` in the shared reservation-update trigger. `20261104150000_fix_walkin_extension_guard_record_field.sql` uses separate `TG_TABLE_NAME` branches so each trigger record reads only its own ID field. It was applied to the connected Inigosync development project after the two fixes above; function readback confirmed the new walk-in branch and removal of the old `CASE`. Walk-in #91 retained its original end time and has no extension payment after the failed attempt. This function-only migration changes no stored records and needs no cleanup. A disposable-database cash-extension and open-online-hold regression test remains required; the focused Node test checks source structure rather than executing the trigger.

# Account Customer Reviews — 2026-11-02

## Implementation and data conversion

- Customer accounts receive one editable review independent of booking history. New authenticated saves are scoped by `customer_id = auth.uid()` and customer-account status; the public projection excludes account, booking, display-name, and contact identifiers. Synthetic rows have an explicit `is_sample` marker that customer, owner, and landing UI must display.
- The migration preserves the newest booking review for each customer (stable ID and timestamp) and removes older per-booking duplicates when replacing the obsolete booking-review tables. It retains the existing three-review selection only when all selected IDs still resolve to distinct-account written reviews; otherwise it clears the selection rather than displaying stale picks.
- Existing private `feedback` rows are not converted to public reviews because the old form was private and its authors did not consent to publication. The old feedback table and its records remain outside the new public review flow for separate owner review/cleanup; do not delete them as part of review deployment.
- The connected development read-only snapshot provided for this task had 28 active customer profiles and zero booking-review/public-projection rows or featured selection. No live writes or live conversion were run by implementation. Root owns migration deployment and any subsequent labeled sample seeding.
- The public projection now cascades on source-review deletion. A source update that clears a selected comment, and deletion of a selected account review, clear the featured selection transactionally so the homepage cannot retain a partial set of stale picks. The new private table also has the restrictive email-MFA policy; the active MFA bootstrap hook and owner summary RPC are replaced to reference the new public-safe review objects.

## Verification gaps

- Apply the new migration in a disposable/local Supabase database before deployment and confirm table grants, RLS, triggers, and owner selection behavior. This checkout has no local `psql`/Supabase database.
- Run the post-migration read-only checks and role/trigger behavior cases in `docs/account-customer-reviews-verification.sql`; static Node assertions alone cannot validate Supabase RLS, FK cascade, or trigger behavior. For `20261102140000_optional_featured_customer_reviews.sql`, preserve the existing ordered selection and verify saving zero to three picks plus single-item invalidation.
- After migration, confirm `customer_review` and `public_customer_reviews` counts match the pre-migration `booking_review` distinct-customer count (zero in the supplied live snapshot), and confirm the public table exposes only safe columns. Root should seed only accounts without genuine reviews, mark all synthetic rows `is_sample = true`, and verify counts before and after.
# Pending staff email resend guard repair (2026-11-02)

Live recovery requests reached `recover-pending-staff` but returned 502 because
GoTrue's admin email update returned 500. Auth logs showed the profile identity
guard rejecting the `auth.users` email-sync trigger. The forward migration
`20261102160000_allow_auth_email_sync_profile_guard.sql` permits that nested
sync only when the profile email equals the same user's canonical Auth email;
direct profile email changes remain blocked. The owner dialog now displays
backend errors and keeps a newly saved address retryable if SMTP delivery fails
after the Auth update. Deployment requires applying this migration and updating
the recovery Edge Function. The guard repair does not alter existing records or
their meaning, so no record conversion or cleanup is needed. Verify the live
Auth/profile sync and a direct profile-update rejection after deployment.
The connected development project now has the guard migration recorded as
remote version `20261102115515` (the local filename uses `20261102160000`),
and `recover-pending-staff` is deployed as version 3. A rollback-only probe
against one existing pending staff record passed: an Auth email update synced
the profile, a direct profile email edit raised SQLSTATE 42501, and the record
returned to its original matching emails with pending status and incomplete
onboarding. No probe email persisted. The owner browser recovery test passed
for an SMTP failure after the email was saved followed by a retry.

## Sent email shown as a fetch failure (2026-11-02 follow-up)

The live recovery request at 12:18 UTC completed SMTP submission but the Edge
runtime logged `respondWith` receiving no Response. The handler had fallen
through after SMTP and lock cleanup. The recipient's single staff profile is
still pending, its Auth and profile emails match, and its onboarding credential
row exists; no record conversion or cleanup is needed. The function now returns
success after accepted delivery, and a lock-release warning when applicable.
The owner UI shows an understandable red top notice for actual failures and
an unconfirmed-delivery message for network interruptions, prompting an inbox
check before another send. The shared setup email uses the site's orange and
neutral brand styling. The connected project runs `recover-pending-staff` v4
and `invite-staff` v22 with the updated template. Focused browser recovery
checks and all six staff invite tests passed; the wordmark asset returned
HTTP 200. No new database migration or persisted-data change was required.

## Staff resend accepted by SMTP but missing from inbox (2026-11-02)

Recovery POSTs at 13:00 and 13:01 UTC returned 200 after Gmail SMTP accepted
the messages. Auth/profile email matches the current `+staff1` address, the
account remains pending, and the recovery lock is clear. The recipient's Gmail
search across all folders showed only the earlier 20:18 message, while the
sender's Sent folder showed a later branded setup message. Inbox delivery or
a later bounce had not been established at that point; SMTP acceptance alone
does not establish inbox delivery. The success notice is now concise and says the email was
submitted, while setup stays pending. Recovery v5 returns the MIME Message-ID
for tracing, and resend subjects carry a readable Manila timestamp to make
new messages easier to identify. These changes do not mutate existing records
or change their meaning. A later controlled resend and recipient-mailbox
inspection are recorded below; do not repeatedly resend
without checking the sender and recipient mailboxes because each attempt
replaces the temporary password.

## Short pending-staff setup credential and delivery check (2026-11-02)

The owner clarified that a resend should save the corrected address, generate
a new temporary password, and email that address and password so the pending
staff member can sign in and choose a different password. The 43-character
temporary value was replaced with a 16-character, unambiguous value sampled
from Web Crypto; uppercase, lowercase, a digit, and a hyphen are guaranteed
and their positions are shuffled. The invite and recovery functions both use
the same generator. The setup email keeps the address, password, sign-in link,
and orange branding in a compact layout. No existing records or stored
credentials were converted; a future authorized resend replaces only that
pending account's current Auth password and stored hash. The connected project
now runs `recover-pending-staff` v6 and `invite-staff` v23. Focused Node tests
passed and an independent auth/security review found no blocker. Inbox
placement was checked with one controlled resend to the current address at
21:29. Gmail SMTP returned final acceptance and the function returned 200.
Read-only inspection of the recipient's Gmail subsequently found that exact
timestamped message in Spam, addressed to `christianoborza+staff1@gmail.com`.
Gmail's notice said it resembled messages previously identified as spam. The
message was marked "Not spam"; Gmail confirmed that it moved to Inbox and
stated future messages from the sender will go to Inbox. Earlier 21:00-21:02
resends were also found in Spam. The sender's Sent list did not show the 21:29
message, but recipient-side receipt confirms delivery; the missing Sent row
does not establish a send failure. An unrelated 15:13 bounce to a different
address does not explain this case. Readback showed exactly one pending
profile, matching Auth/profile emails, one credential record, and no active
recovery lock. No extra test resend was made. Each resend rotates the temporary
password, so only the latest message should be used for staff setup.

## Pending staff onboarding session gate and required details (2026-11-02)

Live logs around the pending account's sign-in show the email-MFA session check
sometimes taking about 10 seconds and once returning a 503 after roughly 40
seconds; successful profile bootstrap reads returned 200. `authGuard.js` awaited
session proof and profile checks without a timeout, so `staff_onboarding.html`
could remain on its secure-session loading text while those requests stalled.
The onboarding page now gives those checks 15 seconds, then fails closed with
a visible reload/retry action. Email proof remains required before the own-row
profile read and onboarding form become available.

The password step asks only for a new password and confirmation. Login and
email MFA already established the session; Auth updates the password on that
session without a second current-password field. If a refresh interrupts
after the change, the same password in both fields resumes details completion
after an isolated, non-persistent Auth check confirms Auth reports it as
already current. A bounded save/check returns a visible error instead of an
indefinite spinner. The details footer becomes a dashboard
button only after the server reports successful activation. Civil status is
database `NOT NULL`, and the service-only activation RPC explicitly consumes
the optional emergency-phone proof because its privileged profile update does
not run the authenticated-user proof trigger. The CDN UMD script now precedes
the shared Supabase client configuration.

The onboarding form now asks for current, new, and confirmed passwords, then
first/middle/last name, a validated mobile number, birthdate, civil status,
address, gender, and emergency contact details. Position and account status are
displayed read-only; account activation remains a server operation. Civil
status is stored separately in `staff_private_details`. A service-only,
transactional RPC validates the pending-to-active transition and stores the
private field atomically. Pending staff are allowed through existing phone
availability/proof RPCs only for their own onboarding validation.

The connected development database was read before changes: 4 staff profiles,
1 pending/incomplete profile, and 1 onboarding credential row. Its `profiles`
table has name parts, mobile, address, birthdate, gender, and emergency-contact
fields, but no staff civil-status field/table. No records were written or
converted. The new private table started empty when schema was applied; the
existing pending record remains valid in its current format. There is no old
record cleanup to run. A second pre-deployment read-only check after local implementation
returned the same counts (4 staff, 1 pending/incomplete, 1 credential, 0 active
recovery locks); the private-details table was still absent at that time.

Schema source is in `database/schema/019_staff_private_onboarding.sql`. The
portable Supabase CLI v2.122.0 generated
`supabase/migrations/20261102145436_staff_private_onboarding.sql`. The
connected development project applied it as remote version `20261102145919`.
Its default table grants left authenticated users with write privileges, so
the follow-up `20261102150153_staff_private_details_grants.sql` removed those
grants and restored SELECT only; the connected project recorded it as version
`20261102150213`. The schema source describes the final grant state, so it
intentionally differs from the first migration and is equivalent to both
migrations applied in order. The updated `validate-contact-phone` and
`complete-staff-onboarding` functions were deployed as versions 15 and 3.
Post-apply counts remain 4 staff profiles, 1 pending/incomplete profile,
1 onboarding credential, and 0 private-detail rows. RLS is enabled, client
roles cannot execute the completion RPC, and authenticated users have SELECT
but no INSERT, UPDATE, or DELETE grant on the private table. Both Edge
Functions reject unauthenticated POSTs with HTTP 401, and the deployed source
matches the local entrypoints. A harmless RPC call for a nonexistent profile
returned false. A real pending-account login, password change, and complete
profile write still require interactive verification with that account's
credentials. The focused Node static tests (7/7),
onboarding Playwright browser fixture, `node --check`, and `git diff --check`
passed. The browser fixture mocks Auth and the Edge Functions, so it does not
verify the live SQL transaction or Auth password update behavior.

The user initially reported reaching the dashboard after deployment, but a
subsequent read-only check still found one pending/incomplete staff profile,
one onboarding credential, and zero private-detail rows. The function logs
showed no successful completion request in that interval. An independent
post-deployment security review confirmed the remote grants, RLS, and RPC
guards, but could not establish end-to-end completion. Confirm that the newly
created staff account (rather than an already active account) completes the
two setup steps, then recheck the pending/credential/private-detail counts.

The project manager then removed the need to re-enter the current password
during onboarding and requested the landing-page visual style. Step 1 now asks
only for a new password and confirmation. The screenshot of a stuck save was
consistent with a client-side wait: Auth logs showed the password update PUT
returned HTTP 200, while the onboarding account remained pending. The client
now bounds the Auth save, reports a retryable error, and can resume an
already-current new password after a refresh. The card uses the shared
Sora/Inter typography, semantic theme tokens, and landing-page icon toggle.
Browser fixture coverage includes dark/light display, a stalled Auth request,
same-password-only retry after a delayed update, resume, and mobile layout.
The client also persists a user-scoped timestamp (never the password) for ten
minutes so a refresh after a timed-out Auth update cannot start a competing
password change. Browser coverage includes this refresh case.

A real details submission at 2026-11-02 19:08 UTC reached the completion Edge
Function but returned HTTP 500: the profile update evaluated the contact-number
unique index as `service_role`, which lacked EXECUTE on
`internal.ph_mobile_to_e164(text)`. The narrow forward migration
`20261102191200_staff_onboarding_phone_helper_execute.sql` grants this helper
to `service_role` only. It is applied in the connected project. A role-scoped
SQL call verified that normalization now succeeds, and the grant check verified
`authenticated` still lacks EXECUTE. The migration changes permissions only;
no persisted record conversion is needed. The pending account remains pending
until the staff member retries the details submission; verify account status and
private-detail count after that real retry. The staff member completed the
two-step form in the open browser and landed on `staff_dashboard.html`. The
connected project then showed zero pending staff, four active completed staff,
one staff-private-detail row, and zero onboarding credentials. These before/
after counts confirm the pending profile was activated and its temporary
credential record was consumed without altering the other staff records.

## Progressive staff onboarding and optional mobile (2026-11-03)

The setup page now separates password, name, required personal details, and
optional contacts/privacy into four steps. Password policy checks update live;
the password stays in page memory and Auth is updated only after required
fields are complete, an optional mobile has passed availability validation if
provided, and the staff member agrees to the Privacy Policy. The pending-save
timestamp contains no password and retains the same-password-only recovery
behavior if the final request is interrupted. The existing Auth session, email
MFA proof, temporary-password digest check, and pending-account activation
gate remain in use.

First and last name, birthdate showing age 18 or older, gender, civil status,
and address are required. Middle name, mobile, and emergency contact details
are optional. The privacy modal
uses the existing `Pages/privacy.html`; Agree checks the box, while Disagree or
close leaves it unchecked. The completion Edge Function rejects requests
without the explicit agreement flag. The agreement is checked for the
completion request but no separate consent record is written.

The existing `complete_staff_onboarding_profile` RPC required a contact phone,
so `20261103003957_optional_staff_onboarding_mobile.sql` updates its validation
to accept NULL while retaining required-profile checks and the existing
emergency-proof transaction. `database/schema/019_staff_private_onboarding.sql`
is kept aligned with the forward migration. The project manager's read-only
development-record check found 4 completed staff, no pending staff, one
staff-private-detail row, and two current staff profiles with no mobile number.
Those rows are valid under the new optional-phone behavior; the migration does
not rewrite or delete profile/private-detail/credential records, so no data
conversion or cleanup is needed.

Verification run locally: `node --check includes/staff_onboarding.js`,
`node --test tests/staff-onboarding-ui.test.mjs`,
`node --test tests/staff-onboarding-access-gate.test.mjs tests/phone-format-validation.test.mjs`,
the focused Playwright `tests/staff-onboarding-ui.cjs` flow, and
`git diff --check` for the onboarding files. Static and browser tests passed.
The browser fixture covers deferred Auth update, required-field gating,
optional mobile and emergency-number live checks, privacy Agree/Disagree/close
behavior, and retry after a failed completion request. Deno, Supabase CLI,
and psql were not available for local Edge Function or SQL execution. The
connected project received the optional-mobile migration and
`complete-staff-onboarding` Edge Function v4. A role-scoped SQL call accepted
a NULL mobile number for a nonmatching test UUID and returned false without
changing records. Service-role EXECUTE remained enabled while authenticated
EXECUTE remained disabled. Counts after migration stayed at four completed
staff, one private-detail row, and two staff profiles without a mobile number.
There is no pending staff account now, so the new four-step flow still needs
a live run with a newly invited staff member for full end-to-end verification.

---

# Owner secondary-email aliases (2026-11-03)

## Feature contract

- An owner can add a verified secondary email address and set a distinct password for it, while still signing in to the same canonical Supabase Auth user/profile UUID. The alias is stored in a private alias registry; it does not create or depend on a Google Auth identity or another `auth.users` row. The existing canonical `kikooborza@gmail.com` email and Google OAuth sign-in remain available.
- Adding an alias requires an active owner and the exact current verified owner session. One short-lived code sent to the new email proves mailbox control. The alias is saved after that code is verified, and a separate branded link notice is sent to it without any password. If first-time password setup continues, the same successful enrollment proof authorizes it. Password setup can be postponed; later Set actions require the still-active, exact owner session and its existing email-MFA proof. Change actions also require the current linked-email password before a challenge can be created. No additional code is sent to either mailbox.
- Login verifies the alias password server-side, creates a one-use magiclink session for the canonical owner, then sends a separate one-time login code to the alias. The session is admitted only after that exact alias code is verified and while the alias, credential version, active owner, and Auth session remain live. Removing an alias deletes its credential and revokes dependent broker sessions/tickets.
- Owner Account Settings offers Add email account as a two-stage wizard: enter the secondary email, verify its one-time code in a login-style six-digit popup, then set the separate password using that same proof. Per-alias Set/Change password creates a short-lived server challenge from the active owner session and existing email-MFA proof, without another email or SMS code. Change-password challenges also bind to the credential version checked after current-password verification; begin and save serialize per alias, save requires that version to remain current, and a successful save invalidates every challenge for the alias. Only the active wizard stage is visible; resend is available only before initial alias verification. Closing after secondary-email verification but before password setup leaves a linked alias without a password until setup is resumed. Retry notice and Remove remain available. Passwords and OTPs never enter browser storage, email notices, or logs. Rate-limit keys and code values are HMAC-hashed server-side.

## Data impact and deferred cleanup

The migration `20261103140000_owner_linked_email_password_auth.sql` creates private service-role-only alias, credential, challenge, ticket, broker-session, rate-limit, and notice state. Alias rows cascade from canonical Auth users; tickets, sessions, login challenges, and notices cascade from alias deletion. It does not alter Google or email identity records. The project manager separately removed three non-primary Google identity rows from live owner UUID `746ab269-f714-4424-a657-3eaf53ac3c0c`; readback had only the primary `kikooborza@gmail.com` Google identity, one canonical email identity, active admin profile, and zero sessions. Do not recreate those links or change existing primary identities. No other identity cleanup is part of this feature. Any unrelated cleanup stays deferred until references and affected views are understood.

The forward migration `20261103150000_owner_linked_email_single_otp.sql` changes password setup/rotation to consume the original verified linked-email enrollment proof, or a short-lived active-session challenge for an already-verified alias, and retires the former canonical-owner OTP verifier. It does not rewrite aliases, credentials, identities, or current-format records. Existing enrollment challenges remain stored and can complete while their proof is fresh; pending challenges created by the former owner-OTP flow cannot authorize password saves and become eligible for cleanup at `expires_at`.

The forward migration `20261103174850_owner_linked_email_password_challenge_version.sql` adds a nullable credential version and setup/change marker to enrollment challenges, plus a service-role-only alias credential lookup. It binds valid passwordless first-time setup challenges to the current version, preserves original email-verification challenges (their version remains null), and deletes only still-live password-setup/change challenges for aliases that already have a password because those rows predate version binding. It does not modify alias credentials or identity records. The replacement begin/save RPCs take one alias-scoped advisory lock, compare the expected version and password-exists state before challenge creation, require that stored state to still match at save, increment the version with a predicate, and delete all challenges for that alias after a successful save. Read-only pre/post migration snapshots found zero rows in each bind, cleanup, and unverified email-code challenge category; no challenge rows were changed. Expired rows remain subject to the existing expiry cleanup job.

## Deployment order and rollback

1. Configure the existing Supabase `SUPABASE_SERVICE_ROLE_KEY` and SMTP username, app password, and sender secrets. The Edge Function derives its private 256-bit HMAC key from the service-role key with HKDF-SHA-256, a fixed InigoSync-specific salt, and the domain label `owner-email-alias-auth/hmac-pepper/v1`; no additional secret or paid resource is required.
2. For the already staged feature, deploy the updated `owner-linked-auth` with gateway JWT verification disabled (the function validates bearer sessions itself) so the old canonical-owner OTP action is no longer reachable. Until the forward migration is applied, password setup fails closed because its RPC is unavailable. Then apply `20261103150000_owner_linked_email_single_otp.sql`; old canonical-owner proof rows cannot authorize password saves and naturally expire.
3. Deploy the owner/auth frontend assets. Keep the origin allowlist and SMTP setup aligned with the site.
4. The project manager chose the existing main project and will perform integration checks personally. Keep the live frontend unchanged until those checks pass. Do not modify the production owner's primary email/Google identity for these checks.

Backend staging on the existing main project completed on 2026-11-03: Supabase accepted `owner_linked_email_password_auth` as remote migration version `20261103142749`, `owner_linked_email_single_otp` as `20261103152927`, `owner_linked_email_availability` as `20261103155318`, and `owner_linked_email_challenge_expiry_cleanup` as `20261103155326`. `owner-linked-auth` is deployed as version 4 with `verify_jwt=false`; the local preview origin `http://127.0.0.1:4178` is allowed for project-owner testing. A read-only status check confirmed the five-minute challenge cleanup cron job is active. The current frontend remains local and has not been published. Codex did not enroll an alias, request a code, or send an email. The user tried the earlier flow; Gmail accepted three messages but placed them in Spam, and the linked address used was a plus-address routed to the primary inbox. Existing owner and staff UI paths still use their prior deployed frontend. The migration replaces the shared MFA proof functions with additive alias-proof branches; monitor ordinary sign-in during the project manager's checks.

For rollback, remove the alias UI/client calls first, deploy an Edge version that refuses alias actions, and use a forward migration to disable alias broker-session admission. Retain alias/password rows until rollback behavior is confirmed; delete only after reviewing exact rows/sessions. Rotating the service-role key changes the derived HMAC key: pending OTP challenges become unverifiable and keyed rate-limit buckets reset, while PBKDF2 alias password hashes and already verified broker-session rows remain valid under their existing Auth-session, alias-version, active-owner, and seven-day proof checks. For suspected service-role-key compromise, also revoke alias broker sessions/tickets/challenges and force affected alias passwords to be reset as incident response. Never recreate or restore the three removed Google identity links as part of rollback.

## Integration cases for the project owner on the existing main project

- Confirm migration SQL compiles and anon/authenticated cannot read or execute alias credential operations; service-role calls have only intended access.
- Use an owner account and secondary mailbox under the project owner's control. Reject aliases equal to any canonical Auth email or already claimed alias. Verify a new address only after the code sent to that address; wrong, expired, replayed, cross-session, cross-owner, and over-attempt codes fail. The alias stays the same owner UUID and can exist without a password while notice delivery remains independently retryable.
- Require one new-email code for initial alias enrollment only; the same proof can authorize immediate first-time password setup. Later Set actions use the exact active owner session, owner status, and email-MFA gate. Change actions additionally require the current linked-email password before challenge creation. Verify stale credential versions reject both challenge creation and save across concurrent sessions, and a successful save invalidates every outstanding challenge for that alias. Reject expired, wrong-session, wrong-alias, wrong-owner, and over-attempt initial proofs. Confirm rotations invalidate prior broker tickets/sessions and removal immediately revokes alias login. Verify that password setup sends no code to either mailbox; owner sign-in MFA and alias-login OTP remain enabled.
- Sign in using alias/password, verify the returned owner UUID is unchanged, and ensure protected access stays blocked until a login code delivered to that alias is verified. Reject stale/revoked sessions, inactive owners, changed credential versions, and unlinked aliases.
- Confirm login/IP/code limits, private hashed storage, and that no password appears in SMTP messages or logs. Confirm notice first-send eligibility, retry throttling, failure and uncertain-delivery handling.

Static contract tests are maintained in `tests/owner-linked-auth-contract.test.mjs`. The project owner requested that Codex not run tests and chose the existing main project over a separate free project. Codex has not run tests, test queries, browser checks, or sent real emails. Backend staging was deployed to main as recorded above; the integration cases remain for the project owner before publishing the frontend feature.

## Owner linked-email availability and verification presentation (2026-11-03)

The Add email dialog now checks a syntactically valid address after a short debounce and shows a concise available/unavailable state beside its label. The new authenticated `check-email-availability` Edge action calls a service-role-only SQL function that requires an active admin profile, the exact live Auth session, and its existing email-MFA proof before comparing normalized addresses in `auth.users` and the private alias registry. The status is advisory; `begin-add-email` retains its serialized database uniqueness check as the authoritative gate against concurrent changes. The check endpoint is only accessible through the authenticated Edge Function, and stale frontend responses are ignored.

The new forward migration `20261103160000_owner_linked_email_availability.sql` adds only the service-role function; it changes no stored rows or data meaning, so no data conversion or cleanup is needed. The linked-email password step now shows the same live five-part requirement checklist as sign-up. Send-code and OTP verification controls sit in their respective modal footers while all six OTP inputs remain in the popup body. The Edge Function's verification and login-code emails use the signup template's table-based brand/header, card, code panel, typography, and colors, with a single selectable code text node and five-minute expiry. Enrollment notices continue to contain no password.

Requested verification was limited to syntax and diff checks. No tests, browser/runtime checks, database queries, deployments, or emails were run/sent. The availability migration and UI still require project-owner integration verification on the existing main project before frontend publication.

## Linked-email login response and challenge retention hardening (2026-11-03)

The `verify-login-code` Edge action now returns `{ verified: true }`, matching the existing login consumer's response contract. Password-save and other actions retain their existing `success` response fields.

The new forward migration `20261103170000_owner_linked_email_challenge_expiry_cleanup.sql` adds an internal security-definer cleanup function with execute revoked from public, anon, and authenticated and granted to `service_role`. A pg_cron job runs it every five minutes and deletes only enrollment-challenge rows where `expires_at <= now()`. Fresh and reusable proofs remain intact until expiry. With a healthy scheduler, expired challenge rows (including stored address and proof material) are targeted for deletion within five minutes after their expiry; a disabled or delayed scheduler can extend that retention. The existing `expires_at` index supports the cleanup. No schema/data conversion is required; this cleanup affects only expired rows. No database query was run, so existing expired-row counts and the deployed cron job state remain for project-owner verification.

The static contract now asserts the Edge/login response match and restricted scheduled cleanup. Per instruction, those tests were not run; no database, browser, email, or deployment actions were performed.

## Cancel pending staff accounts (2026-11-04)

Staff Management now offers **Cancel account** for a row whose status is
`pending` and `onboarding_complete` is false. The action asks for confirmation,
then calls the new `cancel-pending-staff` Edge Function. That function follows
the existing active-owner, bearer-session, and verified-email-session checks,
and rejects any target that is not a still-pending, incomplete staff account.
Successful cancellation deletes the Auth user; `profiles` and
`staff_onboarding_credentials` cascade from Auth. The existing auth session,
phone-validation, private onboarding-detail, and other Auth-owned records also
follow their declared Auth-user cascades; profile-owned account-session event
rows also cascade with the profile. Active/deactivated account actions are
unchanged, and no `cancelled` status is stored.

The forward migration `20261103223857_cancel_pending_staff.sql` adds a
service-role-only claim function. It locks and rechecks the profile, then
claims the same ten-minute lease used by pending-staff recovery. This prevents
recovery and cancellation from claiming the same account and makes the
existing activation trigger reject onboarding completion during cancellation.
Auth deletion failure releases the claim best-effort; an interrupted request
leaves a lease that expires within ten minutes. `walk_in_booking.staff_id`
uses `ON DELETE SET NULL`, so the claim function and immediate pre-delete
server check reject cancellation if any walk-in row references the staff
profile, returning a clear owner-facing error. A scoped `BEFORE DELETE ON
public.profiles` trigger independently enforces the same attribution guard if
a walk-in is linked after preflight. It applies only to pending, incomplete
staff profiles with walk-in references; unrelated profile deletes and the
invite-staff compensation path remain allowed when there is no such reference.
This preserves attribution even on completed or cancelled walk-ins.
`internal.staff_walkin_orders.staff_id` and
`internal.staff_booking_extension_checkouts.staff_id` use `ON DELETE
RESTRICT`; `internal.paymongo_checkout_attempts.staff_id` and
`internal.app_announcements.created_by` have non-cascading profile references
(default `NO ACTION`). Those dependencies also make Auth deletion fail safely
if present; none are rewritten or removed by this feature.

The latest recorded development verification in this plan (2026-11-02)
reported zero pending staff and zero onboarding credentials after the sole
pending account completed setup. The connected project was inspected read-only
and this migration was applied as `20261103223857_cancel_pending_staff` before
the archive and transaction migrations. This DDL did not delete or rewrite
live records; no cancellation endpoint was invoked and no staff account was
deleted. Current pending-account and dependency counts, and the owner-facing
cancellation flow, remain unverified for that separate feature.

## Staff archive visibility (2026-11-04)

Disabled staff can be archived from Staff Management. Archive retains the
Auth user, profile UUID, status, and all transaction and audit links; it only
sets `profiles.archived_at`. Archived rows are excluded from All, Active,
Setup pending, and Deactivated filters, and are listed by the Archived filter.
Restoring visibility clears only `archived_at`, leaving the account disabled;
activation remains a separate owner action. Setup-pending Cancel keeps its
existing deletion semantics and separate `cancel-pending-staff` endpoint.

The `delete-disabled-staff` Edge Function has been repurposed to archive or
restore. It retains the established bearer-session, verified-email, and active
owner checks, rejects self-targeting and any non-disabled/non-staff target,
and performs conditional service-role updates. It no longer calls the Auth
delete API. The new forward migration
`20261103223931_archive_disabled_staff.sql` adds a nullable marker (existing
rows default to unarchived), a check constraint requiring archived staff to
remain disabled, and a trigger that restricts marker changes to service-role
requests. `database/schema/020_staff_archive.sql` is aligned with that schema.
The existing hard-delete guards in `20261103223857_cancel_pending_staff.sql`
remain unchanged; the pending cancellation endpoint and its guarded delete
flow are untouched. No transaction, review, audit, or Auth records are
rewritten or deleted by archive/restore.

Compatibility review covered the tracked development seed and recorded
development notes. The seed has one demo staff profile and no linked business
history; the latest recorded development snapshot (2026-11-02) reported four
completed staff and no pending accounts. The new column is nullable and no
existing records are converted, so these current-format rows remain visible
unless explicitly archived. The connected project was inspected read-only
after migration: all 35 profiles had a NULL marker, so none were archived.
No profile record was changed, and no conversion or cleanup occurred.

The archive migration is applied. The related Edge Function and browser
archive flow were not deployed or runtime-tested as part of this
transaction-centralization work.

## Branch-wide staff booking and transaction records (2026-11-04)

Booking Overview already reads the branch-wide `booking` and
`walk_in_booking` tables. The latest booking SELECT policy grants those rows
to active staff and admins, and the walk-in SELECT policy uses the same
active-staff/admin helper. Transaction Records had a separate filter in
`staff_get_involved_transactions()` that limited time-in audit rows to the
calling staff member's `actor_id`; this made each staff account see only its
own time-ins. The forward migration
`20261103223951_staff_branch_wide_visit_transactions.sql` retains the active
staff-only RPC gate, including `onboarding_complete is true`, and gathers
trusted staff/admin time-in events across the branch. The onboarding condition
matches `inigosync_is_staff_or_admin()` for staff profiles; the RPC continues
to exclude admins, as before. Receipt acknowledgment joins and unattended
booking rows are unchanged. Customers cannot retrieve records and anonymous
execution remains revoked; owners remain outside this staff-only RPC
contract, and existing customer booking access and owner pages are unchanged.

This is a read-scope correction: no transaction, receipt, booking, or audit
record is deleted or converted. The latest recorded development snapshot
found 26 bookings and 18 walk-ins; the November 2 snapshot recorded four
completed staff accounts. Read-only preflight of the connected `Inigosync`
project reported 27 bookings, 21 walk-ins, 35 profiles, 122 audit rows, and 44
payment acknowledgments. Its 19 eligible checked-in audit events were all
staff-attributed and linked to checked-in visits (7 booking time-ins, 1 booking
balance-payment/time-in, and 11 walk-in time-ins), so the new staff/admin
event-role filter retains current transaction events. After migration, those
aggregate counts remained unchanged and all 35 profiles had a NULL
`archived_at`. No customer details or session tokens were queried; no business
or account rows were deleted, rewritten, or converted.

The connected project recorded the three migrations in order as
`20261103223857_cancel_pending_staff`,
`20261103223931_archive_disabled_staff`, and
`20261103223951_staff_branch_wide_visit_transactions`. Local migration
filenames were aligned to these database-generated version IDs so a later
deployment will not replay the same DDL. A database-level authenticated-role
and claim check using all four active, onboarded staff identities returned 35
transaction rows with identical full-payload hashes for every account.
Booking Overview still queries branch-wide booking and walk-in rows without a
staff-id filter, and its RLS policy permits active staff. The direct RLS query
smoke test lacked the app's verified-email-session claim and returned no
booking rows, so live Booking Overview equivalence was not verified with real
browser sessions.

Verification: `node --test tests/staff-transactions-contract.test.mjs` passed
all 17 tests, including the latest migration's fully-onboarded active-staff
gate, branch-wide role filter, receipt context, and unattended rules.
`node scripts/build.cjs` and `git diff --check` passed. The `npm` executable is
not installed, so the package-manager wrapper could not be run. All three
migrations were applied through the connected Supabase tool; no browser-based
two-account session test or frontend deployment was performed.

## Reservation payment settlement gate (2026-11-04)

Customer card/online reservations are created only by the verified PayMongo
settlement function. Staff walk-in cash is confirmed only inside the server
cash tender flow; staff online walk-ins remain pending until webhook settlement.
Those flows use shared physical-resource exclusion holds and the transaction
advisory lock `87499182034132371`. Customer checkout reserves its physical
resource before opening provider checkout, and booking/walk-in synchronization
triggers maintain the same GiST exclusion constraint for all reservation rows.
That slot-specific constraint is the authoritative cross-source concurrency
gate; a separate payment-table lock was considered and rejected because it
would serialize unrelated resources and could turn a transient lock conflict
into a false captured-payment review. Existing settlement attempt locks and
webhook idempotency remain unchanged. Customer expiry and review messages are
now distinct: expired checkout says payment did not complete and invites retry
after checking availability; review warns the payment may have been received, says not to pay again, and
directs the customer to arrange a new time or refund. Staff messages similarly
state when an online walk-in is not booked, and a cash slot conflict instructs
staff to return the tender and choose another time.

This requires no new schema and rewrites no existing bookings, walk-ins,
payments, receipts, or checkout attempts, so no historical-record conversion
or cleanup is indicated. Contract checks cover the shared exclusion constraint
and reservation synchronization triggers, but database concurrency could not
be exercised locally: the Supabase CLI and `psql` are unavailable in this
workspace. A concurrent settlement probe against the connected development
database remains unverified.

## Visible dashboard refresh cadence and extension transaction records (2026-11-04)

The staff Booking Overview and Transaction Records refresh every 15 seconds
while their panels and browser tab are visible. Customer My Bookings and the
owner overview figures and income refresh every 30 seconds under the same
visibility rule. Panel entry, tab return, profile readiness, and existing
successful local mutation callbacks still refresh immediately. Transaction
refreshes coalesce while one RPC is in flight, and the customer/owner loaders
discard stale responses; dashboard filters are preserved across refreshes.

The staff transaction RPC returns one additional row per successfully paid
extension, with its payment acknowledgment. Cash rows come from the trusted
`booking_extended` record; PayMongo rows require a paid extension checkout and
linked payment. Existing pending/review attempts do not appear. The migration
was applied to the connected development database. Active-staff readback
returned 39 rows including one extension row for payment #85 with receipt
context; booking, walk-in, and payment counts stayed at 29/22/50. No persisted
records were converted or removed, so no historical cleanup was needed.

The follow-up `20261104170000_staff_extension_visit_status.sql` corrects the
transaction projection: Source remains Booking or Walk-in, Extension is a
separate record-type label, and Visit Status reflects the linked reservation.
An extension remains In Progress while its checked-in reservation is active
and becomes Completed after checkout or the current end time passes. This
function-only migration was applied to the connected development database.
Readback for walk-in #91 returned source `walkin`, record type `extension`,
status `in_progress`, and payment #85; counts remained 29 bookings, 22
walk-ins, and 50 payments. It changes no stored records or payment meaning,
so no conversion or cleanup was required. A disposable database integration
test for paid online and review paths remains outstanding.
## Customer booking and visit reminders (2026-11-04)

Customer bell reminders now use a new event-keyed
`internal.customer_visit_reminders` table. It separates the online booking
start event (within 30 minutes) from the ending event (within 10 minutes) for
checked-in, confirmed bookings and walk-ins that have not been checked out.
Start reminders require a confirmed online booking that has not been checked
in. End reminders use the current active/check-in state, so pending, cancelled,
unattended, completed, and checked-out visits do not produce an end alert.
The new events use the existing customer notification read-state RPC and the
existing SMTP transport/secrets. Announcement selection now opens a native,
keyboard-operable dialog with escaped text while keeping its per-user
mark-as-read call; other notification links keep their current routing.

The old `internal.customer_booking_reminders` table is deliberately retained.
Its rows, including sent timestamps, snapshots, attempts, and any leases, are
not reset or deleted. The feed no longer projects those rows, so their old
five-hour wording cannot render as a current notification. The old claim RPC
returns no new work, which prevents an already-deployed old worker from
continuing five-hour deliveries after the migration. New reminder state uses a
composite `(visit_type, visit_id, event_type, event_at)` identity, where
`event_at` snapshots the scheduled start or end. Timestamp-versioned
reschedules and extensions create distinct events and may trigger a reminder at the new time;
old timestamped events remain as history but are hidden unless their timestamp
still matches the current schedule and the event is within its upcoming
window. The batch claim limit is five to stay within the existing five-minute
lease during sequential SMTP delivery. This avoids collisions between
separate start/end/schedule revisions while preserving the legacy booking history.
No development-record cleanup is included: old rows remain useful as delivery
history, while their prior event semantics cannot be safely converted into
the new event keys. If physical cleanup is later desired, first compare counts
of sent, unsent, and currently leased legacy rows and retain an audit export;
then verify customer read-state and email history before deleting anything.

The migration was applied to the connected live Supabase project `Inigosync`
as remote version `20261104070412`; the local filename now matches that remote
history entry. The updated `customer-booking-reminders` Edge Function is
deployed as version 12 with `verify_jwt=false`. The existing per-minute Cron
job and SMTP secrets were reused; no secrets or schedules were changed.

Before migration, the legacy reminder table contained 11 rows, all sent, with
zero pending and zero claimed. A post-migration readback confirmed the same
11/11/0/0 counts, so legacy delivery history was preserved. The new reminder
table had zero rows at verification because no visit was inside a reminder
window then. The expected private-table state was confirmed: RLS enabled and
table access revoked from public client roles; the customer feed index and
four reminder RPCs are present. The existing minute Cron remains active. The
function was not invoked manually, so this rollout did not send a test email.
No tests or browser/runtime checks were run.

## PayMongo checkouts only occupy slots after verified payment (2026-11-05)

The project manager clarified that customer Book a Court, staff booking
extensions, and staff online walk-ins must leave availability open while a
PayMongo checkout is merely created, active, pending, failed, or expired. Only
the signed, amount-verified `payment.paid` settlement may create/confirm a
booking or extend an existing one. Settlement rechecks the actual physical
resource under the existing exclusion constraint; concurrent paid conflicts
remain in review with an audit record directing staff to arrange another time
or refund. The staff walk-in hosted checkout accepts all enabled methods:
QR Ph, card, GCash, Maya, and GrabPay. No layout or styling changes were made.

Migration `20261105022742_paymongo_wallet_method_guards.sql` aligns the owner
settings constraint and customer/walk-in RPC gates with all enabled PayMongo
methods. Migration `20261105024336_nonblocking_paymongo_checkouts.sql` removes
provisional customer, extension, and walk-in occupancy while keeping checkout,
attempt, and staged reservation metadata. It preserves actual booking,
walk-in, payment, receipt, and audit records. Staff walk-in staging performs a
read-only overlap check against actual mapped bookings/walk-ins/maintenance and
earlier items in the same order, then settlement uses the exclusion constraint
to resolve races without a provisional hold.

Read-only development-data review on Nov 5, 2026 first found 6 booking-linked
resource rows and one active `hold_item` occupancy row (its checkout intent was
`ready` and unexpired); there were no `walkin_order` hold rows, no extension
checkout rows, and no unpaid pending/confirmed legacy public bookings with or
without PayMongo attempts. Eight private walk-in order quote rows belonged to
expired orders and remain preserved as history. A later read-only recheck found
zero checkout hold rows (zero active and zero stale/terminal), zero walk-in
order hold rows, and six real booking/walk-in/maintenance occupancy rows. Thus
no existing resource-slot rows were in the migration's cleanup set at that
later snapshot. The migration deletes only provisional resource-slot mappings
with `hold_item_id` or `walkin_order_id`; checkout, attempt, staged quote,
booking, payment, receipt, and audit records remain intact. Live edge logs
showed 9 HTTP 409 and 3 HTTP 200 responses for extension checkout during the
preceding 24-hour window. Correlated function logs contained only boot/shutdown
events, so they did not identify the 409 branch; the staff page now shows the
function's JSON error message for future diagnosis.

The initial focused Node suite passed 59/59. Follow-up verification against the
current worktree passed 50/50 tests across seven payment/checkout files and
39/39 tests across webhook, QR reconciliation, and walk-in flow files. The
browser UI smoke test `staff-walkin-order-ui.cjs` could not start because
`playwright` is unavailable; no dependency was installed. Scoped
`git diff --check` passes. SQL function-body replacements have static
regression tests, and read-only `pg_get_functiondef` checks against the
connected development database matched the five hold/item/extension/refresh
anchors plus the active checkout-hold integrity clause. They also confirmed
the existing online-method constraint name and both database gates that the
wallet migration patches; the walk-in checkout status RPC has no method gate
and is intentionally not rewritten. The live rollout on Nov 5, 2026 applied
migrations `20261105022742` (`paymongo_wallet_method_guards`) and
`20261105024336` (`nonblocking_paymongo_checkouts`). Immediately before the
nonblocking migration, the read-only check found zero `hold_item` rows and zero
`walkin_order_id` rows; an earlier real-occupancy snapshot contained six
physical resource rows. The migration deletes only provisional mappings
carrying those IDs and does not delete booking, walk-in, payment, receipt, or
audit records. The latest readback has zero provisional mappings, three
confirmed bookings with three source occupancy rows, and five booking-mapped
physical resource slots; there are no active walk-ins or maintenance occupancy
rows. The active source rows therefore match current confirmed bookings. The
one-row change between historical physical-resource snapshots cannot be
attributed from the retained data; no additional data cleanup was performed.
Keep this discrepancy noted for any future occupancy audit rather than
deleting or rewriting records.

Preflight found no open checkout intents, payment attempts, extension attempts,
or online walk-in orders. The deployed Edge Functions are `paymongo-checkout`
v27, `staff-booking-extension-checkout` v3, and `staff-walkin-checkout` v21.
Read-only function retrieval confirmed each deployed entrypoint and shared
dependency matches the local source after ignoring the final newline. Live
function checks confirm customer and extension checkout no longer create
provisional holds, slot refresh no longer rebuilds customer/walk-in holds, and
paid slot conflicts remain routed to review. The web app was not deployed; the
project manager will push the remaining GitHub changes.
