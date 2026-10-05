# Customer email change setup

The customer dashboard requests an email change with `auth.updateUser({ email })`. With **Secure email change enabled**, Supabase sends two recipient-specific one-time codes: one to the current address and one to the requested address. The dashboard verifies them in sequence with `auth.verifyOtp({ email, token, type: 'email_change' })`. It displays the current email until both codes are accepted and Supabase reports the confirmed new address. A database trigger then syncs the confirmed `auth.users.email` into `public.profiles.email`.

## Required Supabase Auth settings

In the Supabase Dashboard, open **Authentication → Providers → Email** and keep **Secure email change** enabled. This protects the change by requiring proof of access to both the existing and requested email addresses.

In **Authentication → Email Templates → Change Email Address**, set the subject to `Confirm your new IñigoSync email address` and paste the checked-in [Change Email Address template](email_templates/change_email_address.html) into the message body. Supabase sends it to both addresses with a different `{{ .Token }}` in each email. The `{{ .NewEmail }}` variable names the requested address. Keep it code-only; a confirmation-link template cannot be entered into the dashboard's six-digit fields.

Configure SMTP and the project Site URL as appropriate for the deployed environment. The dashboard's **Resend codes** action calls `auth.resend({ type: 'email_change', email: <requested address> })`; Supabase issues fresh codes for both addresses, so the customer must verify the current address again before the new address.

These settings are project-level and are not controlled by the checked-in frontend or migration. Confirm Secure email change is enabled and the saved Change Email Address template in each Supabase environment before enabling customer email changes there. Free-tier project restrictions may limit whether custom Auth email templates can be saved; verify that the template is active in the target project.
