# PayMongo checkout setup and rollout

Customer bookings now start with a short physical-court hold. The browser sends the selected court or lane, time, and payment choice to `paymongo-checkout`; the server checks availability and rates, then creates **one PayMongo session for the cart**. A booking and calendar block are created only after a signed PayMongo payment event is verified. A redirect from PayMongo is never proof of payment. A cancelled or expired session keeps its hold until the provider confirms that the session has closed.

## Required server configuration

Set these as Supabase Edge Function secrets for project `xrlwtnwamboucihsamrr`:

| Secret | Purpose |
| --- | --- |
| `PAYMONGO_SECRET_KEY` | PayMongo test secret key while validating checkout; use the corresponding live key only during a deliberate production launch. |
| `PAYMONGO_WEBHOOK_SECRET` | Signing secret for the webhook in the same PayMongo mode. |
| `APP_BASE_URL` | Exact origin of the customer and staff pages. Use a public HTTPS origin for a live deployment. A localhost origin is suitable only for local checkout tests. |

Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions. Keep all provider and service-role credentials off the browser, repository, and owner settings page. The owner page changes the deposit percentage and enabled payment methods in `app_settings`; it only **reports** PayMongo connection, webhook, and last confirmed payment status.

The expiry worker's shared token is generated in Supabase Vault by migration `20260927025000_enable_checkout_expiry_cron.sql`. The scheduled job sends that token to `paymongo-expire-checkouts`; the worker validates it through a service-only database function. Do not copy the token into frontend code or a second secret.

## Webhook and payment behavior

Register a PayMongo endpoint at `https://xrlwtnwamboucihsamrr.supabase.co/functions/v1/paymongo-webhook` for `checkout_session.payment.paid`, then set its signing secret above. The handler verifies the raw-body signature, test/live mode, PHP gross amount, and session ID, and deduplicates the event. `paymongo-webhook` and the cron worker have Supabase JWT verification disabled because they use separate signed authentication. Customer and staff checkout functions require an authenticated Supabase JWT.

The default deposit is 50%; the owner may change it and enable Cash, Card, and GCash. At least one online method must stay enabled. New checkouts snapshot their total and deposit charge, so later settings or court-rate edits cannot reprice them. Bowling uses `/set`: each set costs one set rate and reserves one hour on the selected lane.

Staff may collect a deposit booking's remaining balance in Cash through the authenticated check-in action. For PayMongo, staff start a separate balance checkout. The webhook records that balance, then staff confirm attendance. Neither a successful browser redirect nor an unverified payment may increase `amount_paid`.

For a walk-in customer paying with GCash, staff can choose **E-wallet QR**. The staff screen locally renders a QR containing that order's PayMongo Checkout URL. The customer scans it with their phone, opens the hosted checkout, and completes the GCash payment there. This is a checkout-link QR, not a PayMongo QR Ph payment code. Its checkout session offers GCash only and returns the customer's phone to a public front-desk instruction page. Staff wait for the signed `checkout_session.payment.paid` webhook and the confirmed acknowledgment before issuing the entry pass. The screenshot event types `qr.paid`, `qr.expired`, and `qrph.expired` belong to different PayMongo QR integrations and are not required for this flow.

For the QR rollout, apply `20261001010000_walkin_checkout_request_recovery.sql` before deploying the updated `staff-walkin-checkout` function and static site. The migration lets a retry reuse the exact registered PayMongo request and identifies a saved GCash checkout so Transactions can reopen its QR. Verify the full scan, mobile GCash authorization, signed webhook, expiry, and retry paths in PayMongo test mode before using live keys.

## Rollout checks

1. Configure the three secrets and verify the owner Payment Configuration page reports an API connection and ready webhook.
2. Test a full-payment cart and a deposit cart with PayMongo test credentials. Confirm the bookings appear only after the signed webhook, and that one cart creates one checkout.
3. Test cancellation and expiry; verify the hold is removed only after PayMongo reports the session expired. Check duplicate webhook delivery creates no extra payment or booking.
4. Test two customers choosing the same physical court at the same time, two bowling sets on one lane, and Cash and PayMongo balance collection at staff check-in.
5. Review any older unpaid pending bookings individually. Existing attempts remain eligible for provider reconciliation; do not delete or mark them paid without checking PayMongo.

If PayMongo credentials, webhook, or the app return origin are missing, **keep the revised customer checkout unpublished**. The database and Edge Functions may be deployed first; their missing-configuration responses prevent a customer from creating an unpaid booking. The scheduled worker also reports unconfigured until `PAYMONGO_SECRET_KEY` is present. Once checkout is configured, publish the frontend, test with PayMongo test mode, and only then plan a separate live-key launch.

An ambiguous checkout creation stays held for review. Search PayMongo by the attempt UUID without hyphens (`reference_number`) and close any provider session before releasing its court hold. The worker moves an unattached creating attempt to review after 23 hours rather than assuming it can safely expire it.
