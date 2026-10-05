# IñigoSync — Owner Action List

> **2026-09-29 phone-plan update:** The earlier SMS and OTP instructions in
> historical project notes are superseded. Current owner action **E5** uses
> Abstract Phone Validation with an Edge Function secret. The project manager
> has removed SMS phone ownership verification from scope. See
> [current setup](phone-validation-setup.md). Some older items below document
> the prior deployment state and should not be read as the new staff portal rollout.

This file includes historical setup notes. The current task has authorized
Supabase project access and PayMongo test-account access, so the earlier
statements about agent access may no longer apply. Never place API keys in the
repository or chat.

Ordered by priority. Each item says **why it's blocked**, **what to do**, and
**what unblocks** once it's done.

---

## A. Run the SQL migrations *(highest value, ~5 minutes total)*

> This section records the older manual rollout. The current staff portal uses
> timestamped `supabase/migrations/20260928*.sql` files, which must be applied
> in order and verified before the new screens are considered operational.

I can write SQL but cannot execute it — the app only ever holds the publishable
(anon) key, and DDL requires elevated access. Every file below is **idempotent**:
re-running it is always safe.

**How:** Supabase Dashboard → your project → **SQL Editor** → **New query** →
paste the file's contents → **Run**.

| # | File | What it does | If you skip it |
|---|---|---|---|
| A1 | `database/schema/003_court_rating.sql` | Adds a nullable `rating` column to `court` (0–5, `CHECK`ed) | Court cards never show a rating. Nothing breaks. |
| A2 | `database/schema/004_staff_module.sql` | Adds `booking.checked_in_at` / `checked_out_at` / `duration_minutes`, creates the `audit_log` table + RLS, adds walk-in name/mobile columns | Staff Time-In/Out and Transaction Records stay unavailable; the UI degrades to an honest empty state rather than erroring |
| A3 | `database/schema/005_session_security.sql` | Creates the `active_session` table + RLS for one-device-at-a-time enforcement | Single-session silently no-ops. Login and dashboards work normally. |
| A4 | `database/schema/006_court_unit_images.sql` | Adds a nullable `unit_images` jsonb column to `court`, so one sport can carry a photo per individual court/lane/table | The landing page's court viewer still lists every unit (Court 1–9, Duckpin/Ten-Pin, Table 1–2) — they just all share the sport's single photo. Nothing breaks. |
| A5 | `database/schema/007_app_settings.sql` | Creates the single-row `app_settings` table + RLS (admin read/write, staff/customer read-only), seeded with today's defaults (GCash + Cash on, 50% downpayment) | The owner dashboard's Payment Configuration Save button fails with a clear "needs a database update" message instead of a fake success toast; the customer booking and staff walk-in screens keep using the hardcoded 50%/GCash+Cash-on defaults exactly as they do today. Nothing breaks. |
| A6 | `database/schema/013_profile_phone_verified.sql` | Historical column from the superseded SMS design. The new migration resets this untrusted flag, adds separate server-enforced validation state, and keeps existing phone numbers; follow E5 for current setup. | No SMS OTP setup is needed. |
| A7 | `database/schema/014_admin_reset_staff_password.sql` | Adds a `admin_reset_staff_password(target_id)` function (SECURITY DEFINER) that resets a staff/admin account's password to the fixed default **`12345678`**. Requires `pgcrypto` (added automatically if missing). | The owner dashboard's Staff Management → **Reset Password** button fails with "needs a database update" instead of resetting anything. Nothing breaks — the old email-link reset path is gone either way (see below). |
| A8 | `database/schema/015_media_bucket.sql` | Creates a **public** Storage bucket named `media` with no per-bucket file-size limit and accepts `image/*`; row-level-security policies allow **anyone to view** files but **only an active admin to upload/replace/delete**. App uploads accept image MIME types and rasterize them to JPEG before storage. | Media Manager's "Upload photo" / "Replace photo" buttons (slideshow + Court Listings) show "Media storage isn't set up yet — run database/schema/015_media_bucket.sql" instead of uploading. Pasting a plain `https://` image URL into Court Listings still works either way — only file uploads need this. |
| A9 | `database/schema/016_walkin_checkin.sql` | Adds `court_unit` / `end_at` / `payment_method` / `checked_in_at` columns to `walk_in_booking`, backfills `end_at` for existing rows, and adds UPDATE policies (`booking_staff_checkin`, `walkin_staff_checkin`) so staff can set `checked_in_at` on a `booking` or `walk_in_booking` row they don't own | Staff Time-In (Booking Overview / Transaction Records) fails with "Ask the owner to run 004 and 016." instead of persisting; the Walk-In wizard still records a walk-in, but drops the specific court/unit, real end time, and payment method (schema-mismatch retry), so Court Schedule/Transaction Records show sport-wide availability and no payment method for those rows. Nothing breaks. |
| A10 | `database/schema/017_booking_payment.sql` | Adds `amount_total` / `amount_paid` / `payment_option` / `balance_payment_method` / `balance_paid_at` columns to `booking`, and `amount_total` / `amount_paid` / `balance_payment_method` / `balance_paid_at` to `walk_in_booking` | Nothing breaks — the customer booking wizard, the staff walk-in wizard, and staff Time-In all still succeed (schema-mismatch retry drops the new columns) — but the new staff Time-In payment popup can't remember what a booking/walk-in has been billed or what staff collect at check-in, so Total/Paid so far/Balance due fall back to rate × hours (or "Rate TBA") every time instead of a saved figure, and the Payment column can't show "Paid · Cash"/"Due ₱X". |
| A11 | `database/schema/018_staff_details.sql` | Adds `address` / `birthdate` / `gender` / `emergency_contact_name` / `emergency_contact_number` columns to `profiles` | Nothing breaks — sign-in, Staff Management, and a staff member's own Account Settings/View Profile all keep working exactly as they do today (schema-mismatch retry drops these five fields on save). Until this runs: Staff Management's staff table shows no "Age · Gender" line, the Add New Staff/Edit staff modals show a "couldn't be saved yet" toast for these fields, and a staff account's own View Profile/Account Settings show a small "ask the owner to run 018" hint instead of Address/Age/Gender/Emergency contact. |

> All frontend code is written to **work correctly before these are applied**.
> Missing columns/tables degrade gracefully — they never break the app. Applying
> them switches the corresponding features on.

**About A7 — the default-password policy.** Clicking Reset Password on a
staff/admin row asks for confirmation, then immediately sets that account's
password to **`12345678`** — no email, no link, no waiting on SMTP. This is
intentional: it means any active admin can always get a locked-out staff
member back in on the spot. The trade-off (also intentional) is that the
default is a fixed, publicly-documented value — **tell staff to change it
themselves the moment they log back in** (Account Settings → Change
Password on their own dashboard). The function refuses to run for anyone
who isn't an active admin, and refuses to target a customer account or the
admin's own account, no matter what the browser sends it — see the
migration file's own comments for the exact checks.

**About A8 — if the bucket insert is refused on your plan.** Some hosting
tiers restrict direct `insert into storage.buckets` from the SQL Editor. If
running `015_media_bucket.sql` errors out on that specific statement:
1. Go to **Supabase Dashboard → Storage → New bucket**, name it exactly
   `media`, toggle **Public bucket** ON, leave the per-bucket file-size limit
   unset, and set allowed MIME types to `image/*`. The application accepts
   image MIME types and rasterizes uploads before saving them.
2. Re-run **only the policy statements** in `015_media_bucket.sql` — i.e.
   everything from the `inigosync_is_active_admin()` function definition
   down through the four `storage.objects` policies. The bucket-creation
   `insert` at the top is safe to leave in (it will simply fail on that one
   statement and you continue from the next), or delete just that one
   statement before re-running.

---

## B. Answer the `pg_cron` question *(blocks Phase 4 design)*

**Why it's blocked:** checking installed Postgres extensions requires catalog
access the anon key does not have.

**What to do:** run **block 9** of `database/qa/001_introspect.sql` in the SQL
Editor and send me the result. It is a read-only `select` — it changes nothing.

**Why it matters:** two spec requirements *must* run on a server-side schedule,
because browser JavaScript only runs while somebody has a tab open:

- **Automatic Cancellation** — the fixed 30-minute grace period, auto-cancel,
  and slot re-opening
- **Booking notifications** — the once-only reminder in the 5h→0h window

**The two possible answers:**
- `pg_cron` **is** listed → I build both as Postgres functions on a cron
  schedule. Clean, self-contained, no external service.
- `pg_cron` is **not** listed → they need a different design (a scheduled Edge
  Function, or an external cron pinging a webhook). Same features, different
  architecture — which is exactly why I want to know *before* building.

---

## C. Create a free PayMongo test account *(blocks Phase 5 — Payment Automation)*

**Why it's blocked:** it's an account in your name, and the secret key must never
touch this repo.

**What to do:**
1. Sign up at <https://dashboard.paymongo.com/signup> (free; no business
   documents needed while you stay in **Test Mode**).
2. Stay in **Test Mode** — the toggle is in the dashboard. No real money moves.
3. Go to **Developers → API Keys**. You'll see two test keys:
   - **Public key** (`pk_test_…`) — safe to share with me; it goes in frontend code.
   - **Secret key** (`sk_test_…`) — **never send this to me and never put it in
     the repo.** You'll set it as a Supabase Edge Function secret yourself:
     ```
     supabase secrets set PAYMONGO_SECRET_KEY=sk_test_xxx
     ```

**What unblocks:** the e-wallet payment flow (GCash/Maya in test mode), real
receipt/invoice generation, and the live payment loading phase — i.e. the
Payment Automation objective, which currently has **no code at all**.

**Test payments:** PayMongo's test mode provides simulated GCash/card flows that
always succeed or fail on demand — ideal for a defense demo, and no real funds.

---

## D. Create a free Resend account *(blocks email notifications)*

**Why it's blocked:** account in your name; the API key is a secret.

**Recommended because you have no domain.** Resend lets you send from its shared
`onboarding@resend.dev` sender on the free tier (**3,000 emails/month**) with
**no domain required**.

**What to do:**
1. Sign up at <https://resend.com/signup> (free, no card).
2. **API Keys → Create API Key.** Keep it secret — set it as a Supabase Edge
   Function secret yourself, exactly like the PayMongo key. Don't send it to me.
3. Tell me only that it's done, and which sender address you want to use.

**Caveat worth knowing:** on the shared `resend.dev` sender, deliverability to
Gmail is decent but not guaranteed, and mail may land in Spam. For a thesis
demo that's usually fine. If it isn't:
- **Brevo** (<https://brevo.com>) — free 300 emails/day, and it lets you verify a
  **single Gmail address as the sender** with no domain at all. Best
  deliverability without owning a domain.
- **Gmail SMTP + App Password** — free, ~500/day, sends as your own Gmail.
  Simplest of all, slightly less "real system" for a defense narrative.

I'll build the email layer **provider-agnostic**, so switching later is a
config change, not a rewrite.

**Optional — a free domain, if you want one:** you're a student, so the
[GitHub Student Developer Pack](https://education.github.com/pack) includes a
free `.me` domain from Namecheap for a year. Not required for any of the above.

---

## E. Configure the Supabase Auth redirect allowlist *(optional now — belt and braces)*

**Why it's blocked:** it's a project setting in the Supabase dashboard.

**What to do:** Supabase Dashboard → **Authentication → URL Configuration →
Redirect URLs**, and add:
- `http://localhost:8532/Pages/Index.html` (local development)
- your production URL, when you have one

**Why it used to matter, and what changed.** Password reset used to work by
emailing a *link*, and that link only came back to the right page if this
allowlist contained it. **Reset is now code-based** — you type six digits into
the app, exactly like log-in and sign-up (see E3) — so the normal path no longer
touches this setting at all.

**Still worth two minutes,** because the app still asks Supabase to send people
back here (`redirectTo`) and still handles a `type=recovery` return:
- any reset email sent *before* you paste in the new template still carries a
  link, and that link needs this;
- it costs nothing and closes the gap if a link-bearing template is ever used.

---

## E2. ⚠️ Paste in the Magic Link email template *(REQUIRED — OTP login will otherwise fail)*

**Why it's blocked:** it's an email template in the Supabase dashboard. I can
write the file; only you can paste it in.

**Why this is urgent.** Phase 6 added first-login-per-device email OTP, and it
covers **all three roles** — customer, staff and admin all take the same path.
It sends the code using Supabase's **Magic Link** template. Supabase's *default*
Magic Link template contains only a clickable link:

```html
<h2>Magic Link</h2>
<p><a href="{{ .ConfirmationURL }}">Log in</a></p>
```

There is **no `{{ .Token }}` in the default**, so the email arrives with no
6-digit code to type — and you are stuck on the verify screen, staring at six
empty boxes, with no way forward. **On a fresh project this is broken by
default.** Please treat this as a required step, not an optional one.

**What to do:** open `docs/email_templates/magic_link.html`, copy the whole
file, then go to Supabase Dashboard → **Authentication → Email Templates →
Magic Link**, paste it into the message body, and Save. Suggested subject:

```
Your IñigoSync login code
```

**What it replaces.** The two-line default above. The new one is a proper
branded email built to match the reset-password one: IñigoSync wordmark, the
`#FF6115` accent, Iñigos Sports Center / Lucena City in the footer, and the
6-digit code as the hero of the message — big, monospaced and spaced out so it
can be read off a phone in one go.

**How to test:** log in from a browser you've never used before (or clear
`localStorage`). You should be asked for a code, and the email should contain a
6-digit number. One quirk to expect while testing: the **Resend code** button
re-enables after 30 seconds, but Supabase only accepts a new request for the
same address after **60**, so an immediate resend comes back as an error. Wait
the full minute.

**Notes worth knowing:**
- **It is deliberately code-only** — there is no login link in it, and please
  don't add one. A link would let whoever opens the mailbox log in from *that*
  device, which is exactly the check this OTP step exists to make; it would also
  leave the browser you actually started from stuck on the verify screen
  forever. The reasoning is written out in full at the top of the file.
- **This template needs nothing else configured.** It does not depend on the
  redirect allowlist (item E), because it contains no link. The same is now
  true of E3 and E4 — all three auth emails are code-only.
- **Do not "tidy" the file.** The tables, inline styles and the `<!--[if mso]>`
  block are deliberate; email clients (Outlook especially) do not support the
  CSS the website uses.

### ⚠️ If *no* email arrives at all, this template is not the fix

There are two different symptoms and they have two different causes:

| What you see | Cause | Fix |
|---|---|---|
| Email arrives, but it's a **link** and there's no code | the default template | **this item (E2)** |
| **No email at all**, or only the first one or two | Supabase's built-in SMTP | custom SMTP — see below |

Supabase's built-in email service is explicitly *"not meant for production
use"* and is currently capped at **2 messages per hour, project-wide** (their
Custom SMTP docs). For a defense demo where several people log in, that runs
out almost immediately; past the cap Supabase rejects the send with a
rate-limit error instead of delivering it, so the first test works and the
next one appears to do nothing.

The fix is to set up your own SMTP on the dashboard's Authentication settings
page (**Authentication → Emails → SMTP Settings** in the current layout) — the
Resend account in **item D** below is exactly what that needs, since Resend
hands you an SMTP host, port, user and password on the free tier. Once custom
SMTP is on, the limit starts at 30 messages/hour and is adjustable under
**Authentication → Rate Limits**.

**This is not hypothetical on this project.** `includes/auth.js` already carries
special handling for Supabase's `over_email_send_rate_limit` error, added on
2026-08-22 with the comment *"the ones that came up while diagnosing the OTP
email issue — Supabase's built-in mailer caps out fast during repeated
signups"*. So the cap has been hit here before, and the app turns it into
"Too many attempts — please wait a minute and try again" rather than a silent
failure. If you see **that** message, it is the mailer, not the template.

**Please tell me which of the two symptoms you actually have** — it decides
whether anything further is needed after pasting these templates in.

---

## E3. ⚠️ Paste in the Reset Password email template *(REQUIRED — password reset will otherwise dead-end)*

**Why it's blocked:** it's an email template in the Supabase dashboard — the
same place as E2 and E4. I can write the file; only you can paste it in.

**Why this is urgent now.** This item used to be cosmetic. It is not any more.
"Forgot password?" now works the same way as log-in and sign-up: you type your
email, the app sends a **6-digit code**, you type it into six boxes, and then
you choose the new password. There is nowhere in the app to paste a link.
Supabase's *default* Reset Password template is a link and nothing else:

```html
<h2>Reset Password</h2>
<p>Follow this link to reset the password for your user:</p>
<p><a href="{{ .ConfirmationURL }}">Reset Password</a></p>
```

No `{{ .Token }}` means no code to type, and the reset screen cannot be
satisfied. **On a fresh project this is broken by default.**

**What to do:** open `docs/email_templates/reset_password.html`, copy the whole
file, then go to Supabase Dashboard → **Authentication → Email Templates →
Reset Password**, paste it into the message body, and Save. Suggested subject:

```
Reset your IñigoSync password
```

**What it replaces.** The three-line default above. The new one matches the
other two exactly: IñigoSync wordmark, the `#FF6115` accent, Iñigos Sports
Center / Lucena City in the footer, and the 6-digit code as the hero of the
message — big, monospaced and spaced out so it can be read off a phone in one
go — plus the "expires in about an hour" note and the "if you didn't ask for
this, ignore it" security line.

**How to test:** open the app → **Log In → Forgot password?** → enter an
address you can read → **Send Reset Code**. You should land on a six-box screen
and the email should contain a 6-digit number. Type it in, choose a new
password, then log in with it. The same 60-second resend quirk described in E2
applies here too: the **Resend code** button re-enables after 30 seconds but
Supabase only accepts a new request after 60, so wait the full minute.

**Notes worth knowing:**
- **Same code-only rule as E2 and E4, and the same reason** — please don't add
  `{{ .ConfirmationURL }}` back. A link would hand a live recovery session to
  whatever device opened the mailbox, while the browser that asked for the
  reset sits waiting for six digits it will never get. The full reasoning is at
  the top of the file.
- **It no longer needs item E (redirect allowlist).** That was true of the old
  link-based version. This one contains no link, so there is nothing for the
  allowlist to govern. The app still keeps the link path working for emails
  sent before you paste this in — see item E.
- **No image is required.** The logo is live text, because an emailed image
  needs a public https URL and this project has no hosting yet. If you want the
  real mark later, upload `assets/Logo/WebLogo.png` to a **public** Supabase
  Storage bucket and follow the `LOGO SLOT` comment inside the file — it is one
  paste, no other change.
- **Do not "tidy" the file.** The tables, inline styles and the
  `<!--[if mso]>` block are deliberate; email clients (Outlook especially) do
  not support the CSS the website uses.
- **The "no email at all" caveat under E2 applies to this one too.** If reset
  emails stop arriving after the first couple, that is the built-in SMTP limit,
  not the template.

---

## E4. ⚠️ Paste in the Confirm signup email template *(REQUIRED — new sign-ups will otherwise stall)*

**Why it's blocked:** it's an email template in the Supabase dashboard — the
same place as E2 and E3.

**Why this is urgent.** It is the same defect as E2, one flow over. After
someone fills in the sign-up form, the app shows six boxes and waits for a
code, then verifies it. But Supabase's *default* **Confirm signup** template is
a link and nothing else:

```html
<h2>Confirm your signup</h2>
<p>Follow this link to confirm your user:</p>
<p><a href="{{ .ConfirmationURL }}">Confirm your mail</a></p>
```

No `{{ .Token }}` means no code, and a brand-new customer's first experience of
the system is a screen they cannot get past.

**What to do:** open `docs/email_templates/confirm_signup.html`, copy the whole
file, then go to Supabase Dashboard → **Authentication → Email Templates →
Confirm signup**, paste it into the message body, and Save. Suggested subject:

```
Confirm your IñigoSync account
```

**How to test:** register a new account with an address you can read. The email
should contain a 6-digit number; type it into the six boxes and you should land
straight in the customer dashboard.

**Notes worth knowing:**
- **Same code-only rule as E2, and the same reason** — please don't add a
  confirmation link. It would confirm the account in whatever device opened the
  mailbox while the browser that filled in the form waits forever. The full
  reasoning is at the top of the file.
- **Different email from E2, on purpose.** E2 is "here is your log-in code" for
  someone who already has an account; this one welcomes a new customer. They
  are not the same message with a different title.
- Staff and admin accounts don't come through here — they're invited from the
  admin dashboard, which is a different Supabase template again.
- **The "no email at all" caveat under E2 applies to this one too.** If sign-up
  emails stop arriving after the first couple, that is the built-in SMTP limit,
  not the template.

---

## E5. Configure Abstract Phone Validation *(REQUIRED for saving a changed optional contact number)*

The project manager removed SMS verification from scope. Do not enable
Supabase Phone Auth, an SMS provider, or test OTP numbers for this feature.
Abstract validates number format and mobile type; it does not prove ownership.

1. Sign in to [Abstract](https://app.abstractapi.com/dashboard), open **Phone Intelligence** under Your products, and copy that product's API key.
2. In the Supabase project's **Edge Functions → Secrets**, add
   `ABSTRACT_PHONE_VALIDATION_API_KEY`. Enter the value directly in Supabase,
   never in chat or source code.
3. Deploy the `validate-contact-phone` Edge Function and the database migration
   that enforces its short-lived, one-use validation proof.
4. In a test account, validate a Philippine mobile number in Account Settings.
   Confirm that invalid/non-mobile numbers, provider failure, and exhausted
   quota leave the old number unchanged. The UI should say **Validated number**.

See [phone validation setup](phone-validation-setup.md) for limitations and the
free-tier budget. The older `013_profile_phone_verified.sql` column is historical;
the new server-enforced validation flow replaces the old SMS badge semantics.

---

## E6. Paste in the Invite user email template *(recommended — branding, and makes the log-in email explicit)*

**Why it's blocked:** it's an email template in the Supabase dashboard, the
same place as E2–E4 above, just a different template — **Invite user**
instead of Magic Link / Reset Password / Confirm signup.

**Why this matters, but isn't a REQUIRED item like E2–E4.** Staff Management
→ **+ Add New Staff** invites the new hire through the `invite-staff` Edge
Function, which creates their account and asks Supabase to send its **Invite
user** email. Nothing is broken if you skip this — Supabase's own default
Invite user template already contains a working link, so the invite still
arrives and still gets the new hire in. What you get without this file is
Supabase's generic default wording (no IñigoSync branding, no mention of
what the account is for or what position it's for), and no reminder of the
one thing that trips people up: **Supabase always sends this email to the
account's own address, so whatever the owner types into Add New Staff's
"Personal email address" field is both where this email goes AND that
person's future log-in.** There is no separate "work email" anywhere in this
flow.

**What to do:** open `docs/email_templates/invite_staff.html`, copy the whole
file, then go to Supabase Dashboard → **Authentication → Email Templates →
Invite user**, paste it into the message body, and Save. Suggested subject:

```
Your IñigoSync staff account
```

**Two settings on the same URL Configuration page need to be correct before
you test this** (Authentication → URL Configuration):
1. **Site URL** must be set to your real app URL (e.g.
   `http://localhost:8532` for local development). This template reads
   `{{ .SiteURL }}` twice — once in the footer, once to build the "sign in at
   the Staff Portal" line — so a blank or wrong Site URL sends both to the
   wrong place.
2. **Redirect URLs** (the same page, just below Site URL) must allow
   wherever the invite link is meant to land — see item E above for exactly
   how to set this. Unlike E2–E4, which were all rewritten to be code-only
   specifically so they no longer depend on this allowlist, **this is the one
   template in this folder that keeps a real link on purpose** (see the
   file's own header comment for why), so it is the one that still needs
   item E done.

**Enter the staff member's personal email, not a work address.** Supabase
gives no way to send account creation to one address and day-to-day log-in
to another — they are the same field. Pages/owner_dashboard.html's Add New
Staff modal already labels the field "Personal email address" and says this
next to it for that reason.

**How to test:** Staff Management → **+ Add New Staff** → fill in a real
address you can read → **Send Invite**. The email should arrive branded as
IñigoSync (not Supabase's generic default wording), greet the name you
typed (or "Hi there" if you left it blank), show the position if you chose
one, and its button should lead to a working "set your password" screen.

**Notes worth knowing:**
- **This one keeps its link on purpose — unlike E2–E4.** Those three are
  deliberately code-only because the same browser waiting for the code has
  to receive it. Here, the OWNER is the one at the keyboard, not the invited
  staff member, so there is no tab anywhere waiting for a code — a link is
  the only way for the invite to reach whatever device the new hire actually
  reads their email on.
- **Do not "tidy" the file.** As with E2–E4, the tables, inline styles and
  the `<!--[if mso]>` blocks are deliberate. This one has an extra piece the
  other three don't: a small VML block so the button still renders as a
  button in Outlook, not just the other three's code box.
- **"24 hours"** is what the template quotes for how long the invite link
  stays valid — see the file's own header comment for exactly which
  dashboard setting controls that, and how it compares to the shorter figure
  E2–E4 quote for their 6-digit codes.
- **The button's "set your password" screen is this site's own** —
  `{{ .ConfirmationURL }}` lands on `Pages/Index.html`, which detects the
  `type=invite` it carries and opens a "Set your password" panel (reusing
  the password-recovery UI in `includes/auth.js`); submitting signs the new
  hire straight into `staff_dashboard.html`, no separate log-in step needed.

---

## F. Set real court rates *(no longer needs me — you can do this yourself now)*

Every `court.rate` is currently `NULL`, so the UI honestly shows **"Rate TBA"**
everywhere. I deliberately did not invent prices — fabricating figures in a
thesis system is worse than showing a placeholder.

**As of Phase 2 you can now do this yourself in the app:** log in as admin →
**Court Listings** → edit a court → set its rate. Changes are written straight to
the `court` table and appear immediately on the landing page and in the customer
booking dropdown.

Confirm the real figures with Ms. Driz first.

---

## G. Fill in the two Terms & Conditions placeholders

`Pages/terms.html` contains two `[TO BE CONFIRMED WITH MS. DRIZ]` markers —
online payment fees, and refund eligibility for voluntary cancellation. These
are business-policy decisions, not technical ones, so they were left explicit
rather than invented.

Get the real answers and I'll drop them in, or edit the file directly.

---

## Quick reference — what each item unblocks

| Do this | Unlocks |
|---|---|
| **A1–A6** (run SQL) | Court ratings, staff Time-In/Out, audit trail, single-session, per-court photos, real Payment Configuration persistence, mobile "Verified" badge |
| **A7** (`014_admin_reset_staff_password.sql`) | Staff Management's Reset Password button (instant default-password reset) |
| **A8** (`015_media_bucket.sql`) | Media Manager slideshow uploads, Court Listings photo uploads — landing page + customer dashboard hero pick up the change immediately |
| **A11** (`018_staff_details.sql`) | Staff Management's staff table "Age · Gender" line, the Add New Staff/Edit staff modals' Address/Birthdate/Gender/Emergency contact fields, and a staff account's own View Profile/Account Settings Address/Age/Gender/Emergency contact fields |
| **B** (`pg_cron` check) | Lets me *design* auto-cancellation + reminders correctly |
| **C** (PayMongo) | Payment Automation objective, receipts, payment loading phase |
| **D** (Resend) | Gmail booking reminders |
| **E** (redirect URLs) | Needed for E6's invite link to land correctly; otherwise only the old link-style reset emails still in flight — reset itself no longer needs it |
| **E2** (Magic Link template) | **Required** — first-login OTP is unusable without it, for all three roles |
| **E3** (Reset Password template) | **Required** — "Forgot password?" cannot be completed without the code |
| **E4** (Confirm signup template) | **Required** — new sign-ups cannot get past the verify screen without it |
| **E5** (Abstract API key in Edge Function secrets) | **Required** — changed optional contact numbers cannot be validated and saved without it |
| **E6** (Invite user template) | Recommended, not required — branded staff-invite email instead of Supabase's generic default, and makes explicit that the invite (and every future notice) goes to the account's own **personal** email |
| **F** (court rates) | Replaces every "Rate TBA" with real pricing |
| **G** (T&C values) | Completes the Terms & Conditions page |

**Cheapest high-impact combination:** A1–A6, E2, E3 and E4 — all three email
templates, not two. That's roughly fifteen minutes of copy-paste in the Supabase
dashboard and it activates most of what's already built and sitting dormant —
including log-in, sign-up and password reset, all three of which are *currently
broken* on a default Supabase project because none of the default templates
contain `{{ .Token }}`. Complete **E5** separately to validate and save changed
optional contact numbers through Abstract; it requires no SMS provider.
If you're about to onboard real staff, add **E6** as well — not required
(Supabase's default Invite user template already has a working link), but it's
another five minutes, and — because it's the one auth email in this project
that still carries a real link — it is also the one that needs item **E**
(redirect URLs) actually done, not just left as a nice-to-have.
