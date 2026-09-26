# Owner portal revision verification

The owner portal revision is implemented in this workspace and its database/payment migrations and Edge Functions are deployed to Supabase project `xrlwtnwamboucihsamrr`. The customer and staff frontend is still a local workspace change. Live PayMongo checkout requires a provider test key, webhook secret, and public HTTPS `APP_BASE_URL`; these are server secrets, not owner-page settings. The cron worker currently returns `503 Worker is not configured`, so the revised customer frontend must remain unpublished until setup and provider testing are complete.

## Verified behavior

| Requirement | Evidence |
| --- | --- |
| Owner navigation, overview, payment settings, staff history, court connections, media cropping, reviews, and notification dialog | `tests/owner-portal.cjs` passed at 360, 390, 768, 1024, and 1440 px in both light and dark themes. The test exercises the owner-only settings UI, staff activity search and pagination, crop cancellation, keyboard dismissal, and narrow layouts. |
| Eight shared sport covers | `tests/landing-page.cjs` passed after verifying the sport-cover paths and landing behavior; owner portal tests exercise Court Listings. The database `court.image_url` values use the same checked-in sport-cover assets. |
| One checkout for a multi-booking cart, no unpaid customer booking write, bowling duration | `tests/reservation-qa-ui.cjs` passed with browser fixtures. A two-item cart invokes `paymongo-checkout` once. Two bowling sets reserve 120 minutes on one lane. |
| Cash and PayMongo staff balance actions stay separate | `tests/staff-balance-ui.cjs` passed. Cash invokes `staff_collect_cash_and_check_in`; PayMongo invokes `paymongo-balance-checkout` without first calling the cash action. |
| Webhook signature, payment amount, and duplicate event handling | `node --experimental-strip-types --test tests/paymongo-webhook.test.mjs` passed all seven checks. Rollback-only live SQL tests also accepted a paid checkout, rejected a duplicate payment event, settled Cash and PayMongo balances, and attributed the staff action to the authenticated actor. |
| Physical concurrency | Two concurrent live calls to `prepare_paid_checkout_cart` requested the same far-future unit and hour. One obtained a hold; the other failed with SQLSTATE `23P01`. The successful attempt was immediately expired through `abort_failed_paymongo_checkout`; a follow-up query found zero remaining test holds and zero open checkouts. |
| Server access and pricing guards | Live privilege checks showed authenticated users cannot insert bookings, insert or update `payment`, or delete bookings. Customer role calls to owner activity, staff cash check-in, and service-only cart preparation were denied in rollback tests. A new out-of-hours checkout was rejected with SQLSTATE `22023`. |

The live database had zero unpaid pending bookings and zero open checkout intents at the latest audit, so no old pending row required reconciliation. Rollback-only settlement tests left no payment or booking records behind. The concurrent test left an expired attempt for audit, with its hold removed.

## Remaining live rollout gate

Configure `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`, and `APP_BASE_URL` as described in [PayMongo checkout setup](paymongo-checkout-setup.md). Then complete a PayMongo **test-mode** end-to-end run for payment confirmation, cancellation, provider expiry, duplicate webhooks, and both balance methods before publishing the revised frontend. A redirect alone is never treated as payment confirmation.
