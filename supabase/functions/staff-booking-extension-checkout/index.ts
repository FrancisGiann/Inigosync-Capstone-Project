import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { hasVerifiedEmailSession } from "../_shared/email-mfa.ts";
import { hasPaymongoPaidWebhook } from "../_shared/paymongo-readiness.mjs";
import { enabledPaymongoMethods } from "../_shared/paymongo-methods.mjs";

const appBaseUrl = Deno.env.get("APP_BASE_URL") || "";
const allowedOrigin = (() => { try { return new URL(appBaseUrl).origin; } catch { return ""; } })();
const isPaymongoCheckoutUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === "https://checkout.paymongo.com" && url.protocol === "https:"
      && url.hostname === "checkout.paymongo.com" && url.pathname.length > 1
      && !url.username && !url.password;
  } catch { return false; }
};
const json = (body: unknown, status = 200, origin = "") => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store",
    ...(origin === allowedOrigin && allowedOrigin ? { "access-control-allow-origin": allowedOrigin, vary: "Origin" } : {}) },
});

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return origin === allowedOrigin && allowedOrigin
    ? new Response("ok", { headers: { "access-control-allow-origin": allowedOrigin,
      "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS", "access-control-max-age": "86400", vary: "Origin" } })
    : json({ message: "Origin not allowed." }, 403, origin);
  if (req.method !== "POST") return json({ message: "Method not allowed." }, 405, origin);
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json({ message: "Sign in to continue." }, 401, origin);
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const secretKey = Deno.env.get("PAYMONGO_SECRET_KEY");
  if (!url || !serviceKey || !secretKey || !appBaseUrl) return json({ message: "Online checkout is not configured yet." }, 503, origin);
  let body: { action?: unknown; attempt_id?: unknown; source?: unknown; id?: unknown; duration_minutes?: unknown; expected_end_at?: unknown };
  try { body = await req.json(); } catch { return json({ message: "Invalid request." }, 400, origin); }
  if (body.action != null && body.action !== "cancel")
    return json({ message: "Unsupported extension checkout action." }, 400, origin);
  const cancelAction = body.action === "cancel";
  const attemptId = typeof body.attempt_id === "string" ? body.attempt_id : "";
  if (cancelAction && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId))
    return json({ message: "Invalid extension checkout." }, 400, origin);
  const source = body.source === "booking" || body.source === "walkin" ? body.source : "";
  const id = Number(body.id); const duration = Number(body.duration_minutes);
  const expectedEndAt = typeof body.expected_end_at === "string" ? body.expected_end_at : "";
  if (!cancelAction && (!source || !Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(duration) || duration < 60 || duration % 60
      || !expectedEndAt || !Number.isFinite(Date.parse(expectedEndAt))))
    return json({ message: "Invalid booking extension." }, 400, origin);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json({ message: "Your session has expired. Sign in again." }, 401, origin);
  const { data: profile, error: profileError } = await admin.from("profiles").select("role,status")
    .eq("id", authData.user.id).maybeSingle();
  if (profileError || !profile || profile.role !== "staff" || profile.status !== "active")
    return json({ message: "Active staff access is required." }, 403, origin);
  if (!await hasVerifiedEmailSession(admin, token, authData.user.id)) return json({ message: "Verify your email before continuing." }, 403, origin);
  if (cancelAction) {
    const { data: cancellation, error: cancellationError } = await admin.rpc("get_staff_booking_extension_cancellation", {
      p_attempt_id: attemptId, p_staff_id: authData.user.id,
    });
    if (cancellationError || !cancellation?.attempt_id)
      return json({ status: "pending", message: "This extension checkout is no longer open. Check its payment status before retrying." }, 202, origin);
    if (cancellation.status === "expired" && typeof cancellation.session_id === "string"
        && /^cs_[A-Za-z0-9]+$/.test(cancellation.session_id))
      return json({ status: "expired", message: "PayMongo checkout expiry was confirmed. No extension was applied; check current availability before retrying." }, 200, origin);
    if (cancellation.status !== "ready" || typeof cancellation.session_id !== "string"
        || !/^cs_[A-Za-z0-9]+$/.test(cancellation.session_id))
      return json({ status: "pending", message: "PayMongo has not confirmed checkout expiry. The extension has not been applied; verify payment status before retrying." }, 202, origin);

    let expireResponse: Response;
    try {
      expireResponse = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${encodeURIComponent(cancellation.session_id)}/expire`, {
        method: "POST", headers: { authorization: `Basic ${btoa(`${secretKey}:`)}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(12000),
      });
    } catch (error) {
      console.error("PayMongo extension cancellation expiry uncertain", error instanceof Error ? error.message : "network error");
      return json({ status: "pending", message: "PayMongo has not confirmed checkout expiry. The extension has not been applied; verify payment status before retrying." }, 202, origin);
    }
    const expiryPayload = await expireResponse.json().catch(() => null);
    const expiredSession = expiryPayload?.data;
    if (!expireResponse.ok || expiredSession?.id !== cancellation.session_id
        || expiredSession?.attributes?.status !== "expired"
        || expiredSession?.attributes?.livemode !== secretKey.startsWith("sk_live_")) {
      const providerStatus = typeof expiredSession?.attributes?.status === "string"
        ? expiredSession.attributes.status : "unknown";
      return json({ status: providerStatus === "paid" || providerStatus === "processing" ? providerStatus : "pending",
        message: "PayMongo has not confirmed checkout expiry. The extension has not been applied; verify payment status before retrying." }, 202, origin);
    }
    const { data: markedExpired, error: markError } = await admin.rpc("mark_paymongo_checkout_expired", {
      p_attempt_id: attemptId, p_session_id: cancellation.session_id,
    });
    if (markError || markedExpired !== true)
      return json({ status: "pending", message: "PayMongo expired the checkout, but its reservation status changed during reconciliation. Check payment status before retrying." }, 202, origin);
    return json({ status: "expired", message: "PayMongo confirmed checkout expiry. No extension was applied; check current availability before retrying." }, 200, origin);
  }
  if (!await hasPaymongoPaidWebhook({ secretKey, webhookSecret: Deno.env.get("PAYMONGO_WEBHOOK_SECRET"), supabaseUrl: url }))
    return json({ message: "Online checkout is unavailable until payment confirmation is configured." }, 503, origin);
  const { data: settings, error: settingsError } = await admin.from("app_settings")
    .select("card_enabled,gcash_enabled,maya_enabled,grab_pay_enabled,qrph_enabled").eq("id", true).maybeSingle();
  const methods = settingsError ? [] : enabledPaymongoMethods(settings);
  const { data: prepared, error: prepareError } = await admin.rpc("prepare_staff_booking_extension_checkout", {
    p_source: source, p_id: id, p_duration_minutes: duration, p_staff_id: authData.user.id,
    p_expected_end_at: expectedEndAt,
  });
  if (prepareError || !prepared?.attempt_id)
    return json({ message: prepareError?.message || "This extension is no longer available." }, 409, origin);
  if (prepared.status === "ready" && typeof prepared.checkout_url === "string") {
    if (isPaymongoCheckoutUrl(prepared.checkout_url))
      return json({ attempt_id: prepared.attempt_id, checkout_url: new URL(prepared.checkout_url).toString() }, 200, origin);
    return json({ message: "The saved PayMongo checkout link is invalid. Contact the owner to reconcile this attempt." }, 409, origin);
  }
  const hasSavedRequest = prepared.status === "creating" && prepared.checkout_request
    && typeof prepared.checkout_request === "object" && !Array.isArray(prepared.checkout_request);
  if (!methods.length && !hasSavedRequest) {
    // An active saved request can still be retried with its original method
    // list. If no provider request was registered, release the newly created
    // hold because this checkout cannot safely be started now.
    if (prepared.status === "creating" && !prepared.checkout_request)
      await admin.rpc("abort_failed_paymongo_checkout", { p_attempt_id: prepared.attempt_id });
    return json({ message: "Online payment settings are unavailable." }, 503, origin);
  }
  const success = new URL("/Pages/staff_dashboard.html", appBaseUrl);
  success.searchParams.set("extension_checkout", "return"); success.searchParams.set("attempt_id", prepared.attempt_id);
  const cancel = new URL("/Pages/staff_dashboard.html", appBaseUrl);
  cancel.searchParams.set("extension_checkout", "cancel"); cancel.searchParams.set("attempt_id", prepared.attempt_id);
  const reference = String(prepared.attempt_id).replaceAll("-", "");
  const checkoutAttributes = prepared.checkout_request && typeof prepared.checkout_request === "object"
    && !Array.isArray(prepared.checkout_request) ? prepared.checkout_request : {
    line_items: [{ name: `Booking extension ${id}`, amount: Number(prepared.amount_minor), currency: "PHP", quantity: 1 }],
    payment_method_types: methods, success_url: success.toString(), cancel_url: cancel.toString(),
    reference_number: reference, description: `IñigoSync extension ${reference.slice(0, 12)}`,
    pass_on_fees: true, send_email_receipt: false,
  };
  const { data: registered, error: registerError } = await admin.rpc("register_paymongo_checkout_request", {
    p_attempt_id: prepared.attempt_id, p_request: checkoutAttributes,
  });
  if (registerError || registered !== true) return json({ message: "Could not safely prepare this extension checkout." }, 409, origin);
  let response: Response;
  try {
    response = await fetch("https://api.paymongo.com/v2/checkout_sessions", {
      method: "POST", headers: { authorization: `Basic ${btoa(`${secretKey}:`)}`,
        "content-type": "application/json", "Idempotency-Key": prepared.attempt_id },
      body: JSON.stringify({ data: { attributes: checkoutAttributes } }), signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    console.error("Booking extension PayMongo checkout uncertain", error instanceof Error ? error.message : "network error");
    return json({ message: "PayMongo could not be reached. Contact the owner before retrying this payment." }, 503, origin);
  }
  const payload = await response.json().catch(() => null);
  const session = payload?.data; const checkoutUrl = session?.attributes?.checkout_url;
  if (!response.ok || typeof session?.id !== "string" || !isPaymongoCheckoutUrl(checkoutUrl)
      || session?.attributes?.livemode !== !secretKey.startsWith("sk_test_")) {
    if (response.status >= 400 && response.status < 500 && !session?.id)
      await admin.rpc("abort_failed_paymongo_checkout", { p_attempt_id: prepared.attempt_id });
    return json({ message: "PayMongo did not create this extension checkout." }, 502, origin);
  }
  const { data: attached, error: attachError } = await admin.rpc("mark_staff_booking_extension_ready", {
    p_attempt_id: prepared.attempt_id, p_session_id: session.id, p_checkout_url: checkoutUrl,
  });
  if (attachError || attached !== true) return json({ message: "Checkout needs reconciliation. Contact the owner." }, 503, origin);
  return json({ attempt_id: prepared.attempt_id, checkout_url: checkoutUrl }, 200, origin);
});
