# Customer email change setup

The customer dashboard requests an email change with `auth.updateUser({ email })`, then verifies the one-time code using `auth.verifyOtp({ email, token, type: 'email_change' })`. The dashboard displays the current email until Supabase confirms the new address. A database trigger then syncs the confirmed `auth.users.email` into `public.profiles.email`.

## Required Supabase Auth settings

In the Supabase Dashboard, open **Authentication → Providers → Email** and disable **Secure email change**. This sends a single verification code to the new email address. With Secure email change enabled, Supabase requires confirmation at both old and new addresses, which does not match this customer flow.

In **Authentication → Email Templates → Change Email Address**, use a template that includes the OTP token. For example:

```html
<h2>Confirm your new email address</h2>
<p>Enter this verification code in IñigoSync to confirm the change:</p>
<p><strong>{{ .Token }}</strong></p>
<p>New email: {{ .NewEmail }}</p>
```

Configure SMTP and the project Site URL as appropriate for the deployed environment. Keep the token in the Change Email Address template; a confirmation-link-only template cannot be entered into the dashboard's code field.

These settings are project-level and are not controlled by the checked-in frontend or migration. Confirm them in each Supabase environment before enabling customer email changes there.
