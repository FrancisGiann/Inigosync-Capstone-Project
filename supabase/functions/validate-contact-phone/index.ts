import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { normalizePhilippineMobile, validateWithAbstract } from "./_shared/abstract-phone.ts";
import {
  jsonCorsResponse as json,
  phoneValidationPreflight,
  phoneValidationUnavailable,
} from "./_shared/http.ts";

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return phoneValidationPreflight();
  if (req.method !== "POST") return json({ message: "Method not allowed." }, 405, origin);
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json({ message: "Sign in to validate a contact number." }, 401, origin);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const abstractKey = Deno.env.get("ABSTRACT_PHONE_VALIDATION_API_KEY");
  if (!url || !serviceKey || !abstractKey)
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
    return json({ message: "Invalid request." }, 400, origin);
  const normalized = normalizePhilippineMobile(body.phone);
  if (!normalized) return json({ valid: false, reason: "invalid" }, 200, origin);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json({ message: "Your session expired. Sign in again." }, 401, origin);
  const { data: profile, error: profileError } = await admin.from("profiles")
    .select("role,status,contact_num,contact_num_validated")
    .eq("id", authData.user.id).maybeSingle();
  if (profileError || !profile) return json({ message: "Active account required." }, 403, origin);
  if (profile.status !== "active" || !["staff", "customer", "admin"].includes(profile.role))
    return json({ message: "Active account required." }, 403, origin);
  if (purpose === "emergency" && profile.role !== "customer")
    return json({ message: "Emergency contact validation is available to customers only." }, 403, origin);

  if (purpose === "contact" && profile.contact_num_validated === true
      && normalizePhilippineMobile(profile.contact_num) === normalized)
    return json({ valid: true, normalized, phone_type: "mobile", line_status: "active" }, 200, origin);

  let quotaError: { message?: string } | null = null;
  // The shared provider quota intentionally allows only one request/second.
  // If two account fields validate together, serialize at the trusted edge and
  // retry only this non-consuming global rate-limit response.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reserved = await admin.rpc("reserve_contact_phone_validation", {
      p_user_id: authData.user.id,
      p_purpose: purpose,
    });
    quotaError = reserved.error;
    if (!quotaError) break;
    const detail = (quotaError.message || "").toLowerCase();
    if (!detail.includes("request rate limit") || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  if (quotaError) {
    const detail = (quotaError.message || "").toLowerCase();
    if (detail.includes("rate limit") || detail.includes("safety limit"))
      return json({ message: "Phone validation limit reached. Try again later." }, 429, origin);
    return json({ message: "Phone validation is unavailable." }, 503, origin);
  }

  const result = await validateWithAbstract(normalized, abstractKey);
  if (result.status === "unavailable") return phoneValidationUnavailable(result.retryAfterSeconds);
  if (result.status === "invalid") return json({ valid: false, reason: result.reason }, 200, origin);

  if (purpose === "contact") {
    // Contact numbers are unique; an emergency contact may legitimately use
    // another account's number, so it only needs the provider line check.
    const { data: phoneInUse, error: availabilityError } = await admin.rpc("contact_phone_in_use", {
      p_user_id: authData.user.id,
      p_phone_e164: result.normalized,
    });
    if (availabilityError || typeof phoneInUse !== "boolean")
      return json({ message: "Phone availability is temporarily unavailable." }, 503, origin);
    if (phoneInUse)
      return json({ valid: false, reason: "in_use", phone_type: "mobile", line_status: "active" }, 200, origin);
  }

  const { data: recorded, error: proofError } = await admin.rpc("record_contact_phone_validation", {
    p_user_id: authData.user.id, p_phone_e164: result.normalized, p_purpose: purpose,
  });
  if (proofError || recorded !== true)
    return json({ message: "The number could not be saved safely. Validate it again." }, 503, origin);

  return json({ valid: true, normalized: result.normalized, phone_type: "mobile", line_status: "active" }, 200, origin);
});
