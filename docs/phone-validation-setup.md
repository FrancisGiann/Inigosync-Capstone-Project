# Optional contact number validation

## What this check means

The current plan uses the **Phone Intelligence** product in the user's Abstract dashboard for optional Philippine mobile numbers. A successful result requires Abstract to classify the number as valid, Philippine, mobile, and active. It does **not** prove that the user owns the number, that it is currently reachable, or that an SMS was delivered. UI copy and thesis claims must use **Validated number**, never **Verified owner**.

This replaces the former SMS OTP plan for customer, staff, and owner contact-number changes. Supabase Phone Auth can stay disabled. Email OTP for account sign-in and signup is a separate feature and remains in use.

## Owner setup

1. Sign in to [Abstract](https://app.abstractapi.com/dashboard). Under **Your products**, select **Phone Intelligence** and copy its primary API key. Use that product's key, not the Email Reputation or IP Intelligence keys.
2. In [Supabase Edge Function Secrets](https://supabase.com/dashboard/project/xrlwtnwamboucihsamrr/settings/functions), create the secret named `ABSTRACT_PHONE_VALIDATION_API_KEY` with that key. Enter it directly in Supabase; do not put it in chat, a repository file, browser JavaScript, or a database row.
3. Deploy the `validate-contact-phone` Edge Function and the staff booking migrations. The function calls Abstract on the server and stores a short-lived, one-use proof tied to the signed-in account and normalized phone number. The database checks that proof when saving a changed contact number.
4. In a test account, enter a valid Philippine mobile number in Account Settings and choose **Save Changes**. A changed number is validated before it is saved. Check that invalid or non-mobile numbers are rejected; a provider outage or exhausted quota must leave the previous saved number unchanged. Verify that an unchanged number can be retained and that removing an optional number clears its validation status.

The application limits calls to protect the free allowance: up to 80 provider lookups per rolling 30 days across the app, 3 per account per 24 hours, and 1 request per second globally. These are application limits and may change if Abstract changes its allowance. [Abstract pricing](https://www.abstractapi.com/pricing) currently lists a free phone tier with 100 requests per month; check the dashboard before relying on it for more traffic. No SMS is sent.

## Operational limits

- Number validation is a data-quality check. It must not be used as an authentication factor, an account recovery proof, or a basis for privileged access.
- The API key stays in an Edge Function secret. The browser calls only the authenticated project function.
- A failed or unavailable validation must not silently save a new number as validated.
- An Abstract **active** classification is a provider estimate, not a guaranteed live call, delivery, or proof that this user controls the number.

References: [Abstract Phone Intelligence API](https://docs.abstractapi.com/api/phone-intelligence), [Abstract pricing](https://www.abstractapi.com/pricing), [Supabase Edge Function secrets](https://supabase.com/docs/guides/functions/secrets).
