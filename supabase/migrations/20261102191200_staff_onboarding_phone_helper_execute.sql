-- The profile contact-number unique index evaluates this normalizer as the
-- service_role when the onboarding RPC updates a pending staff profile.
-- Grant only that server role the helper needed by the index expression.
grant execute on function internal.ph_mobile_to_e164(text) to service_role;
