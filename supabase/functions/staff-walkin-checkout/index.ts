import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { hasVerifiedEmailSession } from "../_shared/email-mfa.ts";
import { hasPaymongoPaidWebhook, hasPaymongoWebhook } from "../_shared/paymongo-readiness.mjs";
import { enabledPaymongoMethods } from "../_shared/paymongo-methods.mjs";

const appBaseUrl = Deno.env.get("APP_BASE_URL") || "";
const allowedOrigin = (() => { try { return new URL(appBaseUrl).origin; } catch { return ""; } })();
const safeQrTestUrl = (value: unknown) => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "test.paymongo.com"
      && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
};
const json = (body: unknown, status = 200, origin = "") => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store",
    "access-control-allow-origin": origin && origin === allowedOrigin ? origin : "null",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS", vary: "Origin" },
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
  const secretKey = Deno.env.get("PAYMONGO_SECRET_KEY") || "";
  const publicKey = Deno.env.get("PAYMONGO_PUBLIC_KEY") || "";
  const webhookSecret = Deno.env.get("PAYMONGO_WEBHOOK_SECRET") || "";
  if (!url || !serviceKey || !secretKey || !webhookSecret || !appBaseUrl)
    return json({ message: "Online checkout is not configured yet." }, 503, origin);
  const base = new URL(appBaseUrl);
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    return json({ message: "Online checkout return URL is not secure." }, 503, origin);

  let body: { order_id?: unknown; customer_id?: unknown; guest_name?: unknown;
    guest_mobile?: unknown; items?: unknown; channel?: unknown };
  try { body = await req.json(); } catch { return json({ message: "Invalid request." }, 400, origin); }
  if (body.channel != null && body.channel !== "qrph")
    return json({ message: "Unsupported walk-in payment channel." }, 400, origin);
  const qrPhCheckout = body.channel === "qrph";
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const retry = typeof body.order_id === "string";
  if (retry && !uuidPattern.test(body.order_id as string))
    return json({ message: "Invalid walk-in order." }, 400, origin);
  if (!retry && (body.customer_id != null && (typeof body.customer_id !== "string" || !uuidPattern.test(body.customer_id))
      || typeof body.guest_name !== "string" && body.customer_id == null
      || !Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100
      || body.guest_mobile != null && typeof body.guest_mobile !== "string"))
    return json({ message: "Invalid walk-in details." }, 400, origin);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json({ message: "Your session has expired. Sign in again." }, 401, origin);
  if (!await hasVerifiedEmailSession(admin, token, authData.user.id)) return json({ message: "Verify your email before continuing." }, 403, origin);

  const { data: profile, error: profileError } = await admin.from("profiles")
    .select("role,status").eq("id", authData.user.id).maybeSingle();
  if (profileError || !profile || !["staff", "admin"].includes(profile.role) || profile.status !== "active")
    return json({ message: "Active staff access is required." }, 403, origin);
  const { data: settings, error: settingsError } = await admin.from("app_settings")
    .select("card_enabled,gcash_enabled,qrph_enabled").eq("id", true).maybeSingle();
  const methods = settingsError ? [] : enabledPaymongoMethods(settings);
  if (settingsError || !settings)
    return json({ message: "Online payment settings are unavailable. No new order was saved." }, 503, origin);
  if (qrPhCheckout && settings.qrph_enabled !== true)
    return json({ message: "QR Ph checkout is disabled in Payment Configuration." }, 409, origin);
  if (qrPhCheckout) {
    const publicKeyMatchesMode = secretKey.startsWith("sk_test_")
      ? publicKey.startsWith("pk_test_") : secretKey.startsWith("sk_live_") && publicKey.startsWith("pk_live_");
    if (!publicKeyMatchesMode)
      return json({ message: "Dynamic QR Ph is not configured. No new order was saved." }, 503, origin);
    if (!await hasPaymongoWebhook({ secretKey, webhookSecret, supabaseUrl: url, eventType: "payment.paid" }))
      return json({ message: "QR Ph confirmation is unavailable. Enable the signed payment.paid webhook before accepting QR payments." }, 503, origin);
  } else {
    if (!await hasPaymongoPaidWebhook({ secretKey, webhookSecret, supabaseUrl: url }))
      return json({ message: "Online checkout is unavailable. No new order was saved." }, 503, origin);
    if (!methods.length) return json({ message: "Online payment settings are unavailable. No new order was saved." }, 503, origin);
  }

  let orderId: string;
  if (retry) {
    orderId = body.order_id as string;
  } else {
    const { data: created, error: createError } = await admin.rpc("staff_create_walkin_order_service", {
      p_staff_id: authData.user.id, p_customer_id: body.customer_id || null,
      p_guest_name: body.customer_id ? null : body.guest_name,
      p_guest_mobile: body.guest_mobile || null, p_items: body.items,
      p_payment_method: "paymongo",
    });
    if (createError || !created?.order_id)
      return json({ message: createError?.message || "Could not create the walk-in order. No reservation was saved." }, 409, origin);
    orderId = created.order_id;
  }

  const { data: prepared, error: prepareError } = await admin.rpc("prepare_staff_walkin_checkout", {
    p_order_id: orderId, p_staff_id: authData.user.id,
  });
  if (prepareError || !prepared?.attempt_id)
    return json({ message: "This walk-in order needs staff review before online payment.", order_id: orderId }, 409, origin);
  const checkoutExpiresAt = Date.parse(prepared.expires_at);
  if (!Number.isFinite(checkoutExpiresAt) || checkoutExpiresAt <= Date.now())
    return json({ message: "This walk-in checkout expired. Create a new walk-in order.", order_id: orderId }, 409, origin);
  if (prepared.status === "ready" && qrPhCheckout
      && (prepared.checkout_request?.payment_method_allowed?.[0] !== "qrph" || !prepared.qr_image_url))
    return json({ message: "This checkout was prepared with a different payment method. Ask staff to review it.", order_id: orderId }, 409, origin);
  if (qrPhCheckout && prepared.status === "ready" && prepared.qr_image_url)
    return json({ order_id: orderId, attempt_id: prepared.attempt_id,
      ...(secretKey.startsWith("sk_test_") ? { test_mode: true, qr_test_url: safeQrTestUrl(prepared.qr_test_url) }
        : { qr_image_url: prepared.qr_image_url, test_mode: false }), base_minor: prepared.base_minor,
      currency: "PHP", expires_at: prepared.expires_at, channel: "qrph" }, 200, origin);
  if (prepared.status === "ready" && prepared.checkout_url)
    return json({ order_id: orderId, attempt_id: prepared.attempt_id,
      checkout_url: prepared.checkout_url, base_minor: prepared.base_minor,
      currency: "PHP", expires_at: prepared.expires_at,
      channel: prepared.checkout_request?.payment_method_types?.includes("qrph") ? "qrph" : null }, 200, origin);
  if (prepared.status !== "creating") return json({ message: "This checkout needs staff review.", order_id: orderId }, 409, origin);

  if (qrPhCheckout) {
    const amountMinor = Number(prepared.base_minor);
    const expiresAt = Date.parse(prepared.expires_at);
    const expirySeconds = Math.floor((expiresAt - Date.now()) / 1000);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !Number.isFinite(expiresAt)
        || expirySeconds < 60)
      return json({ message: "This QR Ph order is too close to expiry. Create a new walk-in order.", order_id: orderId }, 409, origin);

    let intentId = prepared.paymongo_session_id;
    let request = prepared.checkout_request && typeof prepared.checkout_request === "object"
      ? prepared.checkout_request : null;
    if (intentId && (!request || request.payment_method_allowed?.[0] !== "qrph"
        || request.amount !== amountMinor || typeof request.client_key !== "string"
        || !Number.isInteger(request.qr_expiry_seconds) || request.qr_expiry_seconds < 60
        || request.qr_expiry_seconds > 9000))
      return json({ message: "The saved QR Ph attempt needs staff review.", order_id: orderId }, 409, origin);

    if (!intentId) {
      const intentRequest = { amount: amountMinor, currency: "PHP", payment_method_allowed: ["qrph"],
        description: `IñigoSync walk-in ${prepared.attempt_id}` };
      let intentResponse: Response;
      try {
        intentResponse = await fetch("https://api.paymongo.com/v1/payment_intents", {
          method: "POST", headers: { authorization: `Basic ${btoa(`${secretKey}:`)}`,
            "content-type": "application/json", "Idempotency-Key": prepared.attempt_id },
          body: JSON.stringify({ data: { attributes: intentRequest } }), signal: AbortSignal.timeout(12000),
        });
      } catch (error) {
        console.error("PayMongo QR Ph intent creation uncertain", error instanceof Error ? error.message : "network error");
        return json({ message: "PayMongo could not be reached. Verify this QR Ph order before retrying.", order_id: orderId }, 503, origin);
      }
      const payload = await intentResponse.json().catch(() => null);
      const intent = payload?.data;
      intentId = intent?.id;
      const attrs = intent?.attributes;
      if (!intentResponse.ok || typeof intentId !== "string" || typeof attrs?.client_key !== "string"
          || attrs.amount !== amountMinor || attrs.currency !== "PHP" || attrs.livemode !== secretKey.startsWith("sk_live_")) {
        console.error("PayMongo rejected QR Ph intent", intentResponse.status,
          JSON.stringify(payload?.errors || []).slice(0, 1000));
        return json({ message: "PayMongo could not create a QR Ph payment intent. The order may need staff review.", order_id: orderId }, 502, origin);
      }
      request = { ...intentRequest, client_key: attrs.client_key,
        qr_expiry_seconds: Math.min(9000, expirySeconds) };
      const { data: registered, error: registerError } = await admin.rpc("register_paymongo_qrph_intent", {
        p_attempt_id: prepared.attempt_id, p_request: request, p_intent_id: intentId,
      });
      if (registerError || registered !== true)
        return json({ message: "The QR Ph intent was created but needs reconciliation. Contact the owner with this order reference.", order_id: orderId }, 503, origin);
    }

    // Recover the provider response if QR attach succeeded but the previous
    // Edge invocation timed out before persisting the image.
    if (prepared.paymongo_session_id) {
      try {
        const existingResponse = await fetch(`https://orders-api.paymongo.com/v1/payment_intents/${encodeURIComponent(intentId)}`, {
          headers: { authorization: `Basic ${btoa(`${secretKey}:`)}` }, signal: AbortSignal.timeout(8000),
        });
        const existingPayload = existingResponse.ok ? await existingResponse.json() : null;
        const existingIntent = existingPayload?.data;
        const existingImage = existingIntent?.attributes?.next_action?.code?.image_url;
        const existingTestUrl = safeQrTestUrl(existingIntent?.attributes?.next_action?.code?.test_url);
        if (existingIntent?.id === intentId && existingIntent?.attributes?.amount === amountMinor
            && existingIntent?.attributes?.livemode === secretKey.startsWith("sk_live_")
            && typeof existingImage === "string" && /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(existingImage)) {
          const { data: attached, error: attachError } = await admin.rpc("attach_paymongo_qrph_intent", {
            p_attempt_id: prepared.attempt_id, p_intent_id: intentId, p_qr_image_url: existingImage,
            p_qr_test_url: secretKey.startsWith("sk_test_") ? existingTestUrl : null,
          });
          if (attachError || attached !== true)
            return json({ message: "The QR Ph code needs reconciliation. Contact the owner with this order reference.", order_id: orderId }, 503, origin);
          return json({ order_id: orderId, attempt_id: prepared.attempt_id,
            ...(secretKey.startsWith("sk_test_") ? { test_mode: true, qr_test_url: existingTestUrl }
              : { qr_image_url: existingImage, test_mode: false }),
            base_minor: amountMinor, currency: "PHP", expires_at: prepared.expires_at, channel: "qrph" }, 200, origin);
        }
      } catch { /* Fall through to the normal attach attempt. */ }
    }

    let paymentMethodResponse: Response;
    const paymentMethodExpiry = request.qr_expiry_seconds;
    try {
      paymentMethodResponse = await fetch("https://api.paymongo.com/v1/payment_methods", {
        method: "POST", headers: { authorization: `Basic ${btoa(`${publicKey}:`)}`,
          "content-type": "application/json", "Idempotency-Key": `${prepared.attempt_id}:qrph-method` },
        body: JSON.stringify({ data: { attributes: { type: "qrph", expiry_seconds: paymentMethodExpiry } } }),
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      return json({ message: "PayMongo could not prepare the QR code. Retry setup before taking payment.", order_id: orderId }, 503, origin);
    }
    const methodPayload = await paymentMethodResponse.json().catch(() => null);
    const paymentMethodId = methodPayload?.data?.id;
    if (!paymentMethodResponse.ok || typeof paymentMethodId !== "string") {
      console.error("PayMongo QR Ph method creation failed", paymentMethodResponse.status,
        JSON.stringify(methodPayload?.errors || []).slice(0, 1000));
      return json({ message: "PayMongo could not prepare the QR code. Retry setup before taking payment.", order_id: orderId }, 502, origin);
    }

    let attachResponse: Response;
    try {
      attachResponse = await fetch(`https://api.paymongo.com/v1/payment_intents/${encodeURIComponent(intentId)}/attach`, {
        method: "POST", headers: { authorization: `Basic ${btoa(`${publicKey}:`)}`,
          "content-type": "application/json", "Idempotency-Key": `${prepared.attempt_id}:qrph-attach` },
        body: JSON.stringify({ data: { attributes: { payment_method: paymentMethodId, client_key: request.client_key } } }),
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      return json({ message: "PayMongo could not finish the QR code. Retry setup before taking payment.", order_id: orderId }, 503, origin);
    }
    const attachPayload = await attachResponse.json().catch(() => null);
    const attachedIntent = attachPayload?.data;
    const qrImageUrl = attachedIntent?.attributes?.next_action?.code?.image_url;
    const qrTestUrl = safeQrTestUrl(attachedIntent?.attributes?.next_action?.code?.test_url);
    if (!attachResponse.ok || attachedIntent?.id !== intentId
        || attachedIntent?.attributes?.amount !== amountMinor
        || attachedIntent?.attributes?.livemode !== secretKey.startsWith("sk_live_")
        || typeof qrImageUrl !== "string" || !/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(qrImageUrl)) {
      console.error("PayMongo QR Ph attach failed", attachResponse.status,
        JSON.stringify(attachPayload?.errors || []).slice(0, 1000));
      return json({ message: "PayMongo did not return a valid dynamic QR code. Retry setup before taking payment.", order_id: orderId }, 502, origin);
    }
    const { data: attached, error: attachError } = await admin.rpc("attach_paymongo_qrph_intent", {
      p_attempt_id: prepared.attempt_id, p_intent_id: intentId, p_qr_image_url: qrImageUrl,
      p_qr_test_url: secretKey.startsWith("sk_test_") ? qrTestUrl : null,
    });
    if (attachError || attached !== true)
      return json({ message: "The QR Ph code was created but needs reconciliation. Contact the owner with this order reference.", order_id: orderId }, 503, origin);
    return json({ order_id: orderId, attempt_id: prepared.attempt_id,
      ...(secretKey.startsWith("sk_test_") ? { test_mode: true, qr_test_url: qrTestUrl }
        : { qr_image_url: qrImageUrl, test_mode: false }),
      base_minor: amountMinor, currency: "PHP", expires_at: prepared.expires_at, channel: "qrph" }, 200, origin);
  }

  const success = new URL(qrPhCheckout ? "/Pages/walkin_payment_return.html" : "/Pages/staff_dashboard.html", base);
  const cancel = new URL(qrPhCheckout ? "/Pages/walkin_payment_return.html" : "/Pages/staff_dashboard.html", base);
  if (qrPhCheckout) {
    success.searchParams.set("result", "submitted");
    cancel.searchParams.set("result", "cancelled");
  } else {
    success.searchParams.set("walkin_checkout", "return");
    success.searchParams.set("order", orderId);
    cancel.searchParams.set("walkin_checkout", "cancel");
    cancel.searchParams.set("order", orderId);
  }
  const reference = prepared.attempt_id.replaceAll("-", "");
  const checkoutMethods = qrPhCheckout ? ["qrph"] : methods;
  const requestedCheckoutAttributes = {
    line_items: [{ name: "Front desk walk-in order", amount: Number(prepared.base_minor), currency: "PHP", quantity: 1 }],
    payment_method_types: checkoutMethods, success_url: success.toString(), cancel_url: cancel.toString(),
    reference_number: reference, description: `IñigoSync walk-in ${reference.slice(0, 12)}`,
    pass_on_fees: true, send_email_receipt: false,
  };
  const checkoutAttributes = prepared.checkout_request && typeof prepared.checkout_request === "object"
    ? prepared.checkout_request : requestedCheckoutAttributes;
  const savedMethods = checkoutAttributes.payment_method_types;
  if (!Array.isArray(savedMethods) || (qrPhCheckout && (savedMethods.length !== 1 || savedMethods[0] !== "qrph")))
    return json({ message: "This checkout was prepared with a different payment method. Ask staff to review it.", order_id: orderId }, 409, origin);
  const { data: requestRegistered, error: requestError } = await admin.rpc("register_paymongo_checkout_request", {
    p_attempt_id: prepared.attempt_id, p_request: checkoutAttributes,
  });
  if (requestError || requestRegistered !== true)
    return json({ message: "Could not safely prepare this checkout. Refresh and try again.", order_id: orderId }, 409, origin);

  let response: Response;
  try {
    response = await fetch("https://api.paymongo.com/v2/checkout_sessions", {
      method: "POST", headers: { authorization: `Basic ${btoa(`${secretKey}:`)}`,
        "content-type": "application/json", "Idempotency-Key": prepared.attempt_id },
      body: JSON.stringify({ data: { attributes: checkoutAttributes } }), signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    console.error("PayMongo walk-in checkout creation uncertain", error instanceof Error ? error.message : "network error");
    return json({ message: "PayMongo could not be reached. The courts remain held temporarily; verify this checkout before retrying.", order_id: orderId }, 503, origin);
  }
  const payload = await response.json().catch(() => null);
  const session = payload?.data;
  const sessionId = session?.id;
  const checkoutUrl = session?.attributes?.checkout_url;
  const testKey = secretKey.startsWith("sk_test_");
  if (!response.ok || typeof sessionId !== "string" || typeof checkoutUrl !== "string"
      || session?.attributes?.livemode !== !testKey) {
    console.error("PayMongo rejected walk-in checkout", response.status,
      JSON.stringify(payload?.errors || []).slice(0, 1000));
    if (response.status >= 400 && response.status < 500 && !sessionId)
      await admin.rpc("abort_failed_paymongo_checkout", { p_attempt_id: prepared.attempt_id });
    return json({ message: "PayMongo could not create checkout. The order may need staff review.", order_id: orderId }, 502, origin);
  }

  const { data: attached, error: attachError } = await admin.rpc("attach_paymongo_checkout", {
    p_attempt_id: prepared.attempt_id, p_session_id: sessionId, p_checkout_url: checkoutUrl,
  });
  if (attachError || attached !== true)
    return json({ message: "Checkout was created but needs reconciliation. Contact the owner with this order reference.", order_id: orderId }, 503, origin);
  return json({ order_id: orderId, attempt_id: prepared.attempt_id,
    checkout_url: checkoutUrl, base_minor: prepared.base_minor, currency: "PHP",
    expires_at: prepared.expires_at, channel: savedMethods.includes("qrph") ? "qrph" : null }, 200, origin);
});
