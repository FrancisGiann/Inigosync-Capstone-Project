# Philippine contact-number checks

Contact-number checks use the database only. The app accepts a Philippine mobile number in local `09XXXXXXXXX` or international `+639XXXXXXXXX` form, normalizes it to E.164, then checks whether the number is already saved. No phone verification provider or SMS service is called.

Authenticated Account Settings checks use the `validate-contact-phone` Edge Function. It confirms the active account, applies a request rate limit, returns only a boolean availability result, and records a short-lived, purpose-specific proof. Database triggers consume that proof when a contact number is saved. Signup uses the separate `signup_phone_availability` RPC with shared and per-IP caps. Staff walk-in guest entry uses its existing database-only registration check.

Contact numbers already linked to another account are blocked in the UI and by the profile write guard. Emergency-contact numbers may be shared by relatives: the UI shows an amber warning when a saved match is found, while valid numbers remain saveable. Emergency write guards still require PH format and the matching purpose proof for customer and staff self-service changes.

These checks establish only format and database availability. They do not prove ownership, reachability, or delivery. Do not describe a number as verified or active based on these checks.

Deploy the timestamped migrations in `supabase/migrations` and the `validate-contact-phone` Edge Function together. Supabase CLI was unavailable during implementation, so the migration and function deployment remain operator steps.
