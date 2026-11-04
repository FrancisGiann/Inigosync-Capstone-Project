-- Remove obsolete per-booking review hooks after booking_review and its
-- public projection were retired in favor of one customer_review per account.
-- These functions have no callers or triggers in the current schema.
drop function if exists public.prepare_booking_review();
drop function if exists public.publish_booking_review();
drop function if exists public.redact_booking_review_contact();
