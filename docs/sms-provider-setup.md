# SMS activation for InigoSync

> **Superseded on 2026-09-29.** The project manager removed SMS phone
> ownership verification from scope. Do not follow the activation steps below
> for the current staff portal rollout. Use [Abstract phone validation
> setup](phone-validation-setup.md). The rest of this file records the earlier
> proposal only.

## Current capstone mode: free simulation

`Config/phoneVerification.js` selects `simulation` for the signup phone panel.
After normal signup and email confirmation, enter the optional phone step and
click Verify. The simulated message displays **123456**; enter it within 60
seconds, then click Confirm code. The button says **Demo passed**, and Continue
finishes login. Wrong/expired codes are rejected; Resend becomes available after
60 seconds. Skip and close still work. Email signup remains real.

This browser-only simulator costs nothing, needs no Twilio account and does not
call SMS sending, OTP verification or profile-update APIs. Real `phone_verified`
is never set by the demo. It applies to signup, not Account Settings. Supabase's
phone provider remains disabled. Missing config also defaults to simulation.

This is **not Twilio's API test environment**. Twilio's current docs say new test
credentials cannot be created in the new console; legacy test credentials still
work. See [Twilio test credentials](https://www.twilio.com/docs/iam/test-credentials).

When ready for real delivery, complete the provider setup below, then explicitly
change `mode` to `live`. The simulator is not a substitute for phone ownership
verification and must not be used as an authorization signal.

## Prepared on 2026-09-19

The existing signup integration calls Supabase `updateUser({ phone })` and
`verifyOtp({ phone, token, type: 'phone_change' })` after email confirmation.
It includes a 60-second resend cooldown, invalid-code handling, verified-user
checks before saving the profile, and an optional skip path. Provider secrets
belong only in Supabase Auth settings, never in this static website.

In the hosted project `xrlwtnwamboucihsamrr`, the SMS template was saved and
reopened to verify persistence:

    Your InigoSync verification code is {{ .Code }}. Do not share this code.

Existing settings retained: phone confirmations ON, six-digit OTP, 60-second
expiry. Phone provider remains OFF because all provider credentials are missing.
No SMS account, purchase, test-number bypass, or real message was created.
Supabase manages OTPs but requires an external SMS delivery service.

## Activate later with Twilio

Twilio is already selected in the Supabase provider form. This is a prepared
integration, not an active Twilio account or a promise of free delivery.

1. Create your own Twilio account and complete its email/phone verification.
   Review account eligibility, Philippine destination support, sender requirements,
   and pricing before upgrading or purchasing a sender.
2. Set up a Twilio Messaging Service with an eligible SMS sender and permission
   to deliver to the Philippines. Review message rates, sender costs, account
   balance and usage alerts before enabling live sending.
3. Open [Supabase Phone settings](https://supabase.com/dashboard/project/xrlwtnwamboucihsamrr/auth/providers?provider=Phone).
   Enter Twilio Account SID, Auth Token, and Message Service SID directly there.
   The selected integration is **Twilio**, not **Twilio Verify**; these services
   use different configuration. Leave the WhatsApp Content SID blank for SMS.
4. Keep phone confirmations enabled, OTP length six, and test-number overrides
   empty. Enable the Phone provider and save only after valid credentials exist.
5. Review Supabase Auth SMS rate limits before inviting customers. The application's
   resend timer is a usability feature, not a substitute for server rate limits.
6. Run `node scripts/check-sms-readiness.cjs`. Exit 0 means the public settings
   pass preflight; exit 2 means configuration is incomplete; exit 1 means the
   check failed. This read-only command sends no SMS and reveals no credentials.
7. With an account and phone you control, confirm email, click Verify beside the
   number, receive the SMS and submit the code within the configured expiry.
   Confirm the button becomes Verified and Continue opens the dashboard. Check
   that incorrect/expired codes do not mark the number verified. Real delivery
   remains untested until this step succeeds.

No frontend rewrite should be needed when provider billing is activated.

## Free testing versus real delivery

Local browser tests (`tests/auth-account-flows.cjs`) mock provider responses and
cost nothing. They do not send SMS or prove delivery to a real phone.

Twilio currently documents a no-card trial with limited units and a 30-day expiry.
It restricts recipients, geography and message content; its predefined-template
restriction may prevent the Supabase-generated OTP message from working on a
new trial. Check the account's current eligibility before relying on it. This
is not an ongoing free SMS service. Supabase test phone/OTP pairs also send no
texts and should not be presented as real verification or enabled in production.

References:

- [Supabase phone authentication and external providers](https://supabase.com/docs/guides/auth/phone-login)
- [Twilio trial restrictions](https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account)
- [Supabase Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits)
