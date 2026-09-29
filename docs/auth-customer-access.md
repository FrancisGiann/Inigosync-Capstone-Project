# Customer access and optional phone validation

## Early email availability

Signup checks the normalized email after a short typing pause, on blur, and
before leaving step 1. A taken address stays on step 1 with a login suggestion.
Failed checks and rate limits show retry guidance rather than claiming availability.
Responses for an older input are ignored. Successful answers are cached for 30
seconds; signup remains authoritative if another registration wins the race.

`public.signup_email_availability(text)` is a security-invoker RPC exposing only
`available`, `taken`, `invalid`, or `rate_limited`. Its private helper checks
`auth.users`, including existing customer/staff/admin and unconfirmed accounts,
without exposing account details. This intentionally discloses exact-address
registration status as requested; it never provides a searchable user list.

The private limiter allows 20 checks/minute per forwarded-client header and 300
globally, using atomic upserts. The global ceiling remains even if caller headers
are spoofed. Only hashed client buckets are retained; old minute buckets are
removed on subsequent requests. No email/IP strings are stored in the limiter.
The limiter has RLS and no client grants/policies: its deny-all advisor INFO is
intentional. See [RLS policy advisory](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).
Existing unrelated project security warnings were not changed.

The migration is in `supabase/migrations/*_signup_email_availability.sql` and was
applied to the connected project. Live rollback-only SQL assertions verified
existing-email matching, case/space normalization, invalid input, rate limiting
and absence of anonymous table access. An anonymous HTTP RPC check also passed.

Google buttons on customer Log In and Sign Up accept only an active `customer`
profile. Authenticated `staff`/`admin` profiles are signed out locally and see a
persistent explanation directing them to **Log in as Admin**. The existing role
is never changed. Password logins check the same profile before sending a
first-device email OTP. Existing remembered staff/admin sessions still resume
their own dashboard.

The signup phone field is optional. Blank numbers are submitted as `null`;
entered numbers must pass the local PH mobile format check. The signup
request does not persist a new contact number before server validation. After
email confirmation (or immediate signup when confirmation is disabled), a
customer who entered a number can validate and save it through the authenticated
`validate-contact-phone` Edge Function, or skip and add it later in Account
Settings. A failed validation leaves the saved number unchanged.

Email availability uses a compact label beside the email heading and green/red
field borders. Status changes reserve the same space, so the card does not resize.

The Edge Function calls Abstract's Phone Intelligence API using a server-side
secret. On a valid PH mobile response it creates a short-lived, one-use proof
bound to the account and number. The database consumes that proof when a changed
`profiles.contact_num` is saved. The database records
`contact_num_validated` and `contact_num_validated_at`; browser code cannot set
them or bypass the proof. The older client-writable `phone_verified` flag is
reset to false during migration; existing contact numbers remain saved but
start with the new validation state false. Supabase
Phone Auth and SMS delivery are not used for this
feature. See [owner setup](phone-validation-setup.md).

The displayed state is **Validated number**. It means the provider classified
the number as valid, Philippine, mobile, and active. It does not establish
ownership, guaranteed current reachability, or delivery. It is never an
authorization claim; account roles still come from the protected profile
role. Email OTP for signup and login is
unchanged.

## Verification

`tests/auth-account-flows.cjs` uses mocked Auth and validation responses; it
creates no real accounts or provider requests. It covers rejected Google roles,
successful customer OAuth, optional and malformed phone values, both
email-confirmation paths, successful validation, rejection, unavailable provider,
and skipping. Live Abstract validation needs a configured secret and a test
account; mocked tests alone do not prove provider behavior.
