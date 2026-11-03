# Staff account onboarding

The owner enters only a personal email address and one of the supported
positions. `invite-staff` creates a confirmed Auth password account, marks its
profile pending, stores only a SHA-256 digest of the random temporary password,
and emails the login URL, email, and temporary password to that same address
using the InigoSync orange and light email design. The same template is used
when an owner resends setup for a pending account. The temporary password is
16 characters, uses an easy-to-read mix of uppercase and lowercase letters,
digits, and a hyphen, and avoids common lookalike characters. Both invitation
and resend use this same generator.

The temporary password has no time-based expiration. It remains usable while
the account is pending until the staff member changes it during onboarding or
the owner resends setup. Resending rotates the Auth password and its private
digest, so the password in every earlier setup email stops working and only
the newest one can be used. Opening or reading the email does not itself
invalidate the password. The ten-minute recovery lease described below only
serializes a resend with account activation; it is not a password lifetime.

The password is never returned to the owner dashboard, included in the Edge
Function response, or written to logs.

On first sign-in the staff member completes the existing email MFA step, then
lands on `staff_onboarding.html`. The four steps collect a new password,
first/middle/last name, required personal details, and optional contact details
plus privacy agreement. The password step validates the new password and its
confirmation, then keeps the selected password in page memory. Auth is updated
only when the staff member submits the final step after completing all required
fields and agreeing to the Privacy Policy. It does not ask for the current
password again after sign-in. If setup is interrupted after the final password
save, the same password can be retried; an isolated, non-persistent Auth client
confirms it when Auth reports that the password is already current or a save
was interrupted. A user-scoped local timestamp blocks a second, different
password update for ten minutes after an uncertain save; the password itself
is never stored in browser storage. The marker clears after setup completes.
Password-save and resume checks have a visible timeout. The server still
rejects the original invitation password.

First and last name, birthdate showing age 18 or older, gender, civil status,
and address are required. Middle name, mobile number, emergency contact name,
and emergency contact number
are optional. When a mobile number is entered, the existing server validator
checks its Philippine format and availability without returning another
profile's phone data. An entered emergency number also gets live format and
database checks; an existing number is shown as advisory because emergency
contacts may legitimately be shared. These checks do not verify number
ownership. The Privacy Policy
modal embeds the current `Pages/privacy.html` text; Agree checks the required
checkbox, while Disagree and close do not. The completion Edge Function also
requires the explicit agreement flag. A separate consent record is not
persisted. Position and account status are not shown in the form; staff cannot
change their assigned position or activate their own account. Civil status is
stored in the staff-only `staff_private_details` table, separate from shared
profiles.

Setup can be interrupted; an incomplete staff login returns to this page. The
optional emergency number receives a purpose-specific, single-use proof which
the completion transaction consumes before saving it. The final footer button
appears only after the server confirms the profile and private civil status were
saved and the account activated. A
secure-session check that times out stays fail-closed and offers a reload to
retry instead of leaving the screen on an indefinite loading message. The
completion Edge Function rechecks the current Auth password, validates the
details, consumes the short-lived phone validation proofs, and activates only
a profile that is still pending. Profile activation and private civil-status
storage happen atomically in `complete_staff_onboarding_profile`. The
six-digit code is sent to the account's current email; entering it proves
control of that mailbox before setup can proceed. A valid domain or accepted
SMTP message still cannot prove that an individual mailbox exists from the
address alone. RLS staff helpers also require the server-owned
`onboarding_complete` flag, so a pending account cannot use staff operations.
Pending staff can read only their own bootstrap profile. A database trigger
rejects activation while onboarding is incomplete, including owner status
changes, and the completion endpoint preserves a concurrent owner
deactivation.

## Email delivery configuration

Supabase Auth continues to deliver the existing email MFA codes. Staff
temporary-password messages use the Gmail SMTP account already configured for
customer booking reminders because Auth email templates do not send a
generated plaintext password alongside a password account.

Before enabling staff creation:

1. Confirm these Supabase Edge Function secrets are configured (the first two
   are already used by customer booking reminders):

   ```sh
   CUSTOMER_BOOKING_SMTP_USERNAME=<smtp-mailbox>
   CUSTOMER_BOOKING_SMTP_APP_PASSWORD=<smtp-app-password>
   CUSTOMER_BOOKING_REMINDER_FROM_EMAIL="IñigoSync <staff@example.com>"
   ```

   `CUSTOMER_BOOKING_REMINDER_FROM_EMAIL` is optional and defaults to the SMTP
   mailbox. `STAFF_ONBOARDING_LOGIN_URL` is also optional; the function uses
   `https://inigossportcenter.com/index.html` when it is unset.
2. Apply `20261015070000_staff_self_service_onboarding.sql`,
   `20261102062517_staff_invite_auth_email_lookup.sql`, and
   `20261102073357_staff_onboarding_recovery_lock.sql`, and
   `20261102145436_staff_private_onboarding.sql`,
   `20261102150153_staff_private_details_grants.sql`,
   `20261102160000_allow_auth_email_sync_profile_guard.sql`,
   `20261102191200_staff_onboarding_phone_helper_execute.sql`, and
   `20261103003957_optional_staff_onboarding_mobile.sql` and
   `20261103025242_optional_middle_name_staff_minimum_age.sql` before deploying the
   updated `validate-contact-phone` and `complete-staff-onboarding` Edge
   Functions. The onboarding SQL adds no required values for existing staff:
   profiles remain as-is and the new private table starts empty. Deploy the
   `invite-staff`, `recover-pending-staff`, and `email-mfa` Edge Functions as
   well when they have changed locally.
   The staff email availability check depends on the server-only
   `owner_auth_email_exists` function from the latter migration.
3. Confirm the Supabase Auth SMTP configuration can deliver the six-digit MFA
   codes, then create a test account at an inbox you control. Verify that the
   owner response contains no password, the email reaches the configured
   address, incomplete staff cannot use the dashboard, and a completed staff
   login goes straight to the dashboard.

The function checks that SMTP credentials and a sender are available before
creating an Auth user. Setup failures, pre-submission connection errors, and
definitive SMTP rejections trigger deletion of only the fresh account created
by that request. Verify delivery and spam handling at a mailbox you control
before rollout.

Before account creation, the invite endpoint checks that the email domain has
an MX mail route or a usable A/AAAA fallback using DNS-over-HTTPS. Domains that
explicitly publish Null MX are rejected. This catches many domain typos but
cannot determine whether a particular address exists. A DNS lookup outage
fails closed before an account is created.

There is one delivery edge case: if SMTP disconnects or times out after the
message terminator was sent but before Gmail's final acceptance reply, the
message may already have been queued. In that case the function keeps the
account pending and tells the owner not to create it again. Ask the staff
member to check the mailbox first. If no message arrived, they can use
**Forgot password?** on the login page to receive a reset code at that same
mailbox, set a password, then sign in and complete onboarding. The reset
password is different from the stored temporary password, so the onboarding
completion check accepts it.

Existing staff profiles default to `onboarding_complete = true`, so the new
gate applies to accounts created through the updated owner flow. No existing
staff member is forced through first-time setup by this migration.

Pending staff rows display `Pending verification`. From the row's Actions
menu, an owner can correct the sign-in email and resend setup. The endpoint
accepts only pending staff accounts, checks duplicates and the destination
domain, replaces the temporary password, updates the Auth and profile email,
refreshes its private password digest, and then sends the message. The account
stays pending after any send or synchronization error; retry the correction
from that row after resolving the cause. If SMTP may have accepted a message,
the newest retry password is the one that will work.

Recovery takes a service-only, ten-minute lease on the pending staff credential
before changing Auth. A database trigger rejects activation while that lease
is live, and the completion endpoint checks the lease before validating the
new password. Normal success and error responses release the lease. If an
Edge invocation terminates before cleanup, the lease expires after ten
minutes; the owner can then retry. The database claim locks the profile row so
recovery and the pending-to-active transition cannot both win concurrently.

After Gmail SMTP returns its final acceptance response, the recovery function
reports that the mail server accepted the message. This confirms server
acceptance, not inbox placement; the recipient may need to check spam or other
mail folders. A successful response includes the MIME Message-ID as a trace
reference for the sending account. Each resend has a timestamped subject to
help Gmail show it as a separate conversation from the original setup
message. If the browser loses its connection before receiving a response,
the dashboard tells the owner to check the inbox before retrying. A retry
creates a new temporary password, so only the most recent setup email will
work. If the recovery lock could not be cleared, the success response asks the
owner to wait up to ten minutes for the lease to expire before another attempt.
