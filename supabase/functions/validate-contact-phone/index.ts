import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { hasVerifiedEmailSession } from "../_shared/email-mfa.ts";
import { normalizePhilippineMobile } from "./_shared/ph-mobile.ts";
import {
  jsonCorsResponse as json,
  phoneValidationPreflight,
} from "./_shared/http.ts";

function isPhoneAvailabilitySetupError(error: { code?: string; message?: string } | null) {
  const message = (error?.message || "").toLowerCase();
  return error?.code === "PGRST202" || error?.code === "42883"
    || message.includes("could not find the function")
    || message.includes("function public.reserve_contact_phone_check")
    || message.includes("function public.contact_phone_");
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return phoneValidationPreflight();
  if (req.method !== "POST") return json({ message: "Method not allowed." }, 405, origin);
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json({ message: "Sign in to validate a contact number." }, 401, origin);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey)
    return json({ message: "Phone validation is unavailable." }, 503, origin);

  let body: { phone?: unknown; purpose?: unknown };
  try {
    if (Number(req.headers.get("content-length") || 0) > 4096) return json({ message: "Invalid request." }, 413, origin);
    body = await req.json();
  } catch { return json({ message: "Invalid request." }, 400, origin); }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return json({ message: "Invalid request." }, 400, origin);
  const purpose = body.purpose === undefined ? "contact" : body.purpose;
  if (purpose !== "contact" && purpose !== "emergency")
    return json({ message: "Invalid phone validation purpose." }, 400, origin);
  const normalized = normalizePhilippineMobile(body.phone);
  if (!normalized) return json({ valid: false, reason: "invalid" }, 200, origin);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json({ message: "Your session expired. Sign in again." }, 401, origin);
  if (!await hasVerifiedEmailSession(admin, token, authData.user.id)) return json({ message: "Verify your email before continuing." }, 403, origin);
  const { data: profile, error: profileError } = await admin.from("profiles")
    .select("role,status,contact_num,contact_num_validated")
    .eq("id", authData.user.id).maybeSingle();
  if (profileError || !profile) return json({ message: "Active account required." }, 403, origin);
  if (profile.status !== "active" || !["staff", "customer", "admin"].includes(profile.role))
    return json({ message: "Active account required." }, 403, origin);
  if (purpose === "emergency" && !["staff", "customer"].includes(profile.role))
    return json({ message: "Emergency contact validation is not available for this account." }, 403, origin);

  const { error: rateLimitError } = await admin.rpc("reserve_contact_phone_check", {
    p_user_id: authData.user.id,
  });
  if (rateLimitError) {
    if (isPhoneAvailabilitySetupError(rateLimitError))
      return json({ message: "Phone availability database setup is incomplete. Apply the latest Supabase migrations." }, 503, origin);
    const detail = (rateLimitError.message || "").toLowerCase();
    if (detail.includes("rate limit"))
      return json({ message: "Too many number checks. Wait a moment and try again." }, 429, origin);
    return json({ message: "Phone validation is unavailable." }, 503, origin);
  }

  // This check uses only the database and returns a boolean, never another
  // profile's ID or stored phone value. It also excludes the user's own row.
  const availabilityFunction = purpose === "emergency" ? "contact_phone_exists" : "contact_phone_in_use";
  const { data: phoneInUse, error: availabilityError } = await admin.rpc(availabilityFunction, {
    p_user_id: authData.user.id,
    p_phone_e164: normalized,
  });
  if (availabilityError && isPhoneAvailabilitySetupError(availabilityError))
    return json({ message: "Phone availability database setup is incomplete. Apply the latest Supabase migrations." }, 503, origin);
  if (availabilityError || typeof phoneInUse !== "boolean")
    return json({ message: "Phone availability is temporarily unavailable." }, 503, origin);
  if (phoneInUse && purpose === "contact")
    return json({ valid: false, reason: "in_use" }, 200, origin);

  const { data: recorded, error: proofError } = await admin.rpc("record_contact_phone_validation", {
    p_user_id: authData.user.id,
    p_phone_e164: normalized,
    p_purpose: purpose,
  });
  if (proofError || recorded !== true)
    return json({ message: "The number could not be saved safely. Validate it again." }, 503, origin);

  return json({ valid: true, normalized, available: !phoneInUse, reason: phoneInUse ? "in_use" : null }, 200, origin);
});
