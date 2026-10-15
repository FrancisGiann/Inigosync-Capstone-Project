# Staff account onboarding

The owner enters only a personal email address and one of the supported
positions. `invite-staff` creates a confirmed Auth password account, marks its
profile pending, stores only a SHA-256 digest of the random temporary password,
and emails the login URL, email, and temporary password to that same address.
The password is never returned to the owner dashboard, included in the Edge
Function response, or written to logs.

On first sign-in the staff member completes the existing email MFA step, then
lands on `staff_onboarding.html`. They choose a different password and enter
their name, birthdate, and other personal details. Setup can be interrupted;
an incomplete staff login returns to this page. The profile becomes active
only after the Edge Function verifies the current Auth password and saves the
required details. RLS staff helpers also require the server-owned
`onboarding_complete` flag, so a pending account cannot use staff operations.
Pending staff can read only their own bootstrap profile. A database trigger
rejects activation while onboarding is incomplete, including owner status
changes, and the completion endpoint activates only a profile that is still
pending so a concurrent owner deactivation is preserved.
Mobile and emergency contact numbers are not collected during this pending
step because existing phone validation requires an active profile. Staff can
add those numbers later in Account Settings after onboarding is complete.

## Email delivery configuration

Supabase Auth continues to deliver the existing email MFA codes. Staff
temporary-password messages use the Resend HTTPS API because Supabase Auth
email templates do not send a generated plaintext password alongside a
password account.

Before enabling staff creation:

1. Verify a sending domain in Resend and create an API key that can send mail.
2. Set these Supabase Edge Function secrets:

   ```sh
   supabase secrets set RESEND_API_KEY=<resend-api-key>
   supabase secrets set STAFF_ONBOARDING_FROM_EMAIL="IñigoSync <staff@example.com>"
   supabase secrets set STAFF_ONBOARDING_LOGIN_URL="https://your-site.example/index.html"
   ```

3. Apply `20261015070000_staff_self_service_onboarding.sql` and deploy the
   `invite-staff`, `complete-staff-onboarding`, and `email-mfa` Edge Functions.
4. Confirm the Supabase Auth SMTP configuration can deliver the six-digit MFA
   codes, then create a test account at an inbox you control. Verify that the
   owner response contains no password, the email reaches the configured
   address, incomplete staff cannot use the dashboard, and a completed staff
   login goes straight to the dashboard.

The function checks that all Resend and login URL secrets are present before
creating an Auth user. If delivery fails after account creation, it attempts
to delete only the fresh account created by that request. Missing secrets,
an unverified sender domain, and provider/API errors therefore prevent normal
staff creation; configure these before rollout. Delivery provider acceptance
does not guarantee inbox placement, so verify delivery and spam handling for
the chosen domain.

Existing staff profiles default to `onboarding_complete = true`, so the new
gate applies to accounts created through the updated owner flow. No existing
staff member is forced through first-time setup by this migration.
