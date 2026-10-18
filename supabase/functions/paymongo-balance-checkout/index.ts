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
    return url.protocol === "https:" && url.hostname === "test.paymongo.com" && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
};
const safeQrImageDataUri = (value: unknown) => typeof value === "string" && value.length <= 1_500_000
  && /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null;
const json = (body: unknown, status = 200, origin = "") => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store",
    "access-control-allow-origin": origin && origin === allowedOrigin ? origin : "null",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS", vary: "Origin" },
});

async function createBalanceQrIntent({ admin, prepared, secretKey, origin }: {
  admin: ReturnType<typeof createClient>; prepared: any; secretKey: string; origin: string;
}) {
  const amountMinor = Number(prepared.amount_minor);
  const expiresAt = Date.parse(prepared.expires_at);
  const expirySeconds = Math.floor((expiresAt - Date.now()) / 1000);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !Number.isFinite(expiresAt) || expirySeconds < 60)
    return json({ message: "This QR Ph balance is too close to expiry. Refresh the reservation before retrying." }, 409, origin);

  let intentId = prepared.paymongo_session_id;
  let request = prepared.checkout_request && typeof prepared.checkout_request === "object" ? prepared.checkout_request : null;
  if (intentId && (!request || request.payment_method_allowed?.[0] !== "qrph" || request.amount !== amountMinor
      || typeof request.client_key !== "string" || !Number.isInteger(request.qr_expiry_seconds)
      || request.qr_expiry_seconds < 60 || request.qr_expiry_seconds > 9000))
    return json({ message: "The saved QR Ph balance attempt needs staff review." }, 409, origin);
  if (!intentId) {
    const intentRequest = { amount: amountMinor, currency: "PHP", payment_method_allowed: ["qrph"],
      description: `IñigoSync reservation balance ${prepared.attempt_id}` };
    let response: Response;
    try {
      response = await fetch("https://api.paymongo.com/v1/payment_intents", {
        method: "POST", headers: { authorization: `Basic ${btoa(`${secretKey}:`)}`,
          "content-type": "application/json", "Idempotency-Key": prepared.attempt_id },
        body: JSON.stringify({ data: { attributes: intentRequest } }), signal: AbortSignal.timeout(12000),
      });
    } catch (error) {
      console.error("PayMongo balance QR intent creation uncertain", error instanceof Error ? error.message : "network error");
      return json({ message: "PayMongo could not be reached. Verify the balance payment before retrying." }, 503, origin);
    }
    const payload = await response.json().catch(() => null);
    intentId = payload?.data?.id;
    const attrs = payload?.data?.attributes;
    if (!response.ok || typeof intentId !== "string" || typeof attrs?.client_key !== "string"
        || attrs.amount !== amountMinor || attrs.currency !== "PHP" || attrs.livemode !== secretKey.startsWith("sk_live_")) {
      console.error("PayMongo rejected balance QR intent", response.status, JSON.stringify(payload?.errors || []).slice(0, 1000));
      return json({ message: "PayMongo could not create this QR Ph balance payment. Ask staff to verify it." }, 502, origin);
    }
    request = { ...intentRequest, client_key: attrs.client_key, qr_expiry_seconds: Math.min(9000, expirySeconds) };
    const { data: registered, error } = await admin.rpc("register_paymongo_qrph_intent", {
      p_attempt_id: prepared.attempt_id, p_request: request, p_intent_id: intentId,
    });
    if (error || registered !== true)
      return json({ message: "The QR Ph intent was created but needs reconciliation. Contact the owner before retrying." }, 503, origin);
  }

  if (prepared.paymongo_session_id) {
    let response: Response;
    try {
      response = await fetch(`https://orders-api.paymongo.com/v1/payment_intents/${encodeURIComponent(intentId)}`, {
        headers: { authorization: `Basic ${btoa(`${secretKey}:`)}` }, signal: AbortSignal.timeout(8000),
      });
      if (response.status === 404) response = await fetch(`https://api.paymongo.com/v1/payment_intents/${encodeURIComponent(intentId)}`, {
        headers: { authorization: `Basic ${btoa(`${secretKey}:`)}` }, signal: AbortSignal.timeout(8000),
      });
    } catch (error) {
      console.error("PayMongo balance QR intent retrieval failed", error instanceof Error ? error.message : "network error");
      return json({ message: "The saved PayMongo intent could not be verified. Contact the owner before retrying QR setup." }, 503, origin);
    }
    const payload = response.ok ? await response.json().catch(() => null) : null;
    const intent = payload?.data;
    if (!response.ok || intent?.id !== intentId || intent?.attributes?.amount !== amountMinor
        || intent?.attributes?.livemode !== secretKey.startsWith("sk_live_"))
      return json({ message: "The saved PayMongo intent has a different or unknown mode or amount." }, 409, origin);
    const image = safeQrImageDataUri(intent?.attributes?.next_action?.code?.image_url);
    if (image) return attachBalanceQr({ admin, prepared, intentId, image, intent, secretKey, origin, amountMinor });
  }

  let methodResponse: Response;
  try {
    methodResponse = await fetch("https://api.paymongo.com/v1/payment_methods", {
      method: "POST", headers: { authorization: `Basic ${btoa(`${Deno.env.get("PAYMONGO_PUBLIC_KEY") || ""}:`)}`,
        "content-type": "application/json", "Idempotency-Key": `${prepared.attempt_id}:qrph-method` },
      body: JSON.stringify({ data: { attributes: { type: "qrph", expiry_seconds: request.qr_expiry_seconds } } }),
      signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    console.error("PayMongo balance QR method creation failed", error instanceof Error ? error.message : "network error");
    return json({ message: "PayMongo could not prepare the QR code. Retry setup before taking payment." }, 503, origin);
  }
  const methodPayload = await methodResponse.json().catch(() => null);
  const paymentMethodId = methodPayload?.data?.id;
  if (!methodResponse.ok || typeof paymentMethodId !== "string")
    return json({ message: "PayMongo could not prepare the QR code. Retry setup before taking payment." }, 502, origin);
  let attachResponse: Response;
  try {
    attachResponse = await fetch(`https://api.paymongo.com/v1/payment_intents/${encodeURIComponent(intentId)}/attach`, {
      method: "POST", headers: { authorization: `Basic ${btoa(`${Deno.env.get("PAYMONGO_PUBLIC_KEY") || ""}:`)}`,
        "content-type": "application/json", "Idempotency-Key": `${prepared.attempt_id}:qrph-attach` },
      body: JSON.stringify({ data: { attributes: { payment_method: paymentMethodId, client_key: request.client_key } } }),
      signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    console.error("PayMongo balance QR attachment failed", error instanceof Error ? error.message : "network error");
    return json({ message: "PayMongo could not finish the QR code. Retry setup before taking payment." }, 503, origin);
  }
  const attachedPayload = await attachResponse.json().catch(() => null);
  const intent = attachedPayload?.data;
  const image = safeQrImageDataUri(intent?.attributes?.next_action?.code?.image_url);
  if (!attachResponse.ok || intent?.id !== intentId || intent?.attributes?.amount !== amountMinor
      || intent?.attributes?.livemode !== secretKey.startsWith("sk_live_") || !image)
    return json({ message: "PayMongo did not return a valid dynamic QR code. Retry setup before taking payment." }, 502, origin);
  return attachBalanceQr({ admin, prepared, intentId, image, intent, secretKey, origin, amountMinor });
}

async function attachBalanceQr({ admin, prepared, intentId, image, intent, secretKey, origin, amountMinor }: {
  admin: ReturnType<typeof createClient>; prepared: any; intentId: string; image: string;
  intent: any; secretKey: string; origin: string; amountMinor: number;
}) {
  const testUrl = safeQrTestUrl(intent?.attributes?.next_action?.code?.test_url);
  const livemode = intent.attributes.livemode;
  const { data, error } = await admin.rpc("attach_paymongo_qrph_intent", {
    p_attempt_id: prepared.attempt_id, p_intent_id: intentId, p_qr_image_url: image,
    p_qr_livemode: livemode, p_qr_test_url: secretKey.startsWith("sk_test_") ? testUrl : null,
  });
  if (error || data !== true) return json({ message: "The QR Ph code needs reconciliation. Contact the owner before retrying." }, 503, origin);
  return json({ attempt_id: prepared.attempt_id, qr_image_url: image,
    ...(livemode === false ? { test_mode: true, qr_test_url: testUrl } : { test_mode: false }),
    base_minor: amountMinor, currency: "PHP", expires_at: prepared.expires_at, channel: "qrph" }, 200, origin);
}

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
  const base = new URL(appBaseUrl);
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    return json({ message: "Online checkout return URL is not secure." }, 503, origin);
  let body: { source?: unknown; id?: unknown; channel?: unknown };
  try { body = await req.json(); } catch { return json({ message: "Invalid request." }, 400, origin); }
  if (body.channel != null && body.channel !== "qrph") return json({ message: "Unsupported payment channel." }, 400, origin);
  const qrPhCheckout = body.channel === "qrph";
  const source = body.source === "booking" || body.source === "walkin" ? body.source : "";
  const id = Number(body.id);
  if (!source || !Number.isSafeInteger(id) || id <= 0) return json({ message: "Invalid reservation." }, 400, origin);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json({ message: "Your session has expired. Sign in again." }, 401, origin);
  if (!await hasVerifiedEmailSession(admin, token, authData.user.id)) return json({ message: "Verify your email before continuing." }, 403, origin);
  if (qrPhCheckout) {
    const publicKey = Deno.env.get("PAYMONGO_PUBLIC_KEY") || "";
    const publicKeyMatchesMode = secretKey.startsWith("sk_test_") ? publicKey.startsWith("pk_test_")
      : secretKey.startsWith("sk_live_") && publicKey.startsWith("pk_live_");
    if (!publicKeyMatchesMode || !await hasPaymongoWebhook({ secretKey,
        webhookSecret: Deno.env.get("PAYMONGO_WEBHOOK_SECRET"), supabaseUrl: url, eventType: "payment.paid" }))
      return json({ message: "QR Ph confirmation is unavailable until the matching PayMongo keys and signed payment.paid webhook are configured." }, 503, origin);
  } else if (!await hasPaymongoPaidWebhook({ secretKey,
      webhookSecret: Deno.env.get("PAYMONGO_WEBHOOK_SECRET"), supabaseUrl: url }))
    return json({ message: "Online checkout is unavailable until payment confirmation is configured." }, 503, origin);
  const { data: settings, error: settingsError } = await admin.from("app_settings")
    .select("card_enabled,gcash_enabled,qrph_enabled").eq("id", true).maybeSingle();
  if (qrPhCheckout && (settingsError || settings?.qrph_enabled !== true))
    return json({ message: "QR Ph checkout is disabled or unavailable in Payment Configuration." }, 409, origin);
  const methods = settingsError ? [] : enabledPaymongoMethods(settings);
  if (!methods.length) return json({ message: "Online payment settings are unavailable." }, 503, origin);
  const { data: prepared, error: prepareError } = await admin.rpc("prepare_paymongo_balance_checkout", {
    p_source: source, p_id: id, p_staff_id: authData.user.id,
  });
  if (prepareError || !prepared?.attempt_id)
    return json({ message: "This balance cannot be collected online right now." }, 409, origin);
  if (qrPhCheckout) {
    const expiresAt = Date.parse(prepared.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
      return json({ message: "This QR Ph checkout expired. Refresh the reservation before retrying." }, 409, origin);
    const expectedLivemode = secretKey.startsWith("sk_live_");
    if (prepared.status === "ready" && prepared.checkout_request?.payment_method_allowed?.[0] !== "qrph")
      return json({ message: "This balance already has a different payment checkout. Ask staff to review it before retrying." }, 409, origin);
    if (prepared.status === "ready" && prepared.qr_livemode !== expectedLivemode)
      return json({ message: "This saved QR Ph checkout was created in a different or unknown PayMongo mode." }, 409, origin);
    if (prepared.status === "ready" && !safeQrImageDataUri(prepared.qr_image_url))
      return json({ message: "The saved QR Ph image is invalid. Ask staff to review this checkout." }, 409, origin);
    if (prepared.status === "ready") return json({ attempt_id: prepared.attempt_id,
      qr_image_url: safeQrImageDataUri(prepared.qr_image_url),
      ...(prepared.qr_livemode === false ? { test_mode: true, qr_test_url: safeQrTestUrl(prepared.qr_test_url) } : { test_mode: false }),
      base_minor: prepared.amount_minor, currency: "PHP", expires_at: prepared.expires_at, channel: "qrph" }, 200, origin);
    if (prepared.status !== "creating") return json({ message: "This balance payment needs staff review." }, 409, origin);
    return await createBalanceQrIntent({ admin, prepared, secretKey, origin });
  }
  if (prepared.status === "ready" && prepared.checkout_url)
    return json({ attempt_id: prepared.attempt_id, checkout_url: prepared.checkout_url }, 200, origin);
  if (prepared.status !== "creating") return json({ message: "This payment needs staff review." }, 409, origin);
  const success = new URL("/Pages/staff_dashboard.html", base);
  success.searchParams.set("balance_checkout", "return"); success.searchParams.set("source", source); success.searchParams.set("id", String(id));
  const cancel = new URL("/Pages/staff_dashboard.html", base);
  cancel.searchParams.set("balance_checkout", "cancel"); cancel.searchParams.set("source", source); cancel.searchParams.set("id", String(id));
  const reference = String(prepared.attempt_id).replaceAll("-", "");
  const checkoutAttributes = {
    line_items: [{ name: `Reservation ${id} balance`, amount: Number(prepared.amount_minor), currency: "PHP", quantity: 1 }],
    payment_method_types: methods, success_url: success.toString(), cancel_url: cancel.toString(),
    reference_number: reference, description: `IñigoSync balance ${reference.slice(0, 12)}`,
    pass_on_fees: true, send_email_receipt: false,
  };
  const { data: requestRegistered, error: requestError } = await admin.rpc("register_paymongo_checkout_request", {
    p_attempt_id: prepared.attempt_id, p_request: checkoutAttributes,
  });
  if (requestError || requestRegistered !== true)
    return json({ message: "Could not safely prepare this balance checkout. Refresh and try again." }, 409, origin);
  let response: Response;
  try {
    response = await fetch("https://api.paymongo.com/v2/checkout_sessions", {
      method: "POST", headers: { authorization: `Basic ${btoa(`${secretKey}:`)}`,
        "content-type": "application/json", "Idempotency-Key": prepared.attempt_id },
      body: JSON.stringify({ data: { attributes: checkoutAttributes } }), signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    console.error("PayMongo balance checkout uncertain", error instanceof Error ? error.message : "network error");
    return json({ message: "PayMongo could not be reached. Ask staff to verify this checkout before retrying." }, 503, origin);
  }
  const payload = await response.json().catch(() => null);
  const session = payload?.data;
  const sessionId = session?.id;
  const checkoutUrl = session?.attributes?.checkout_url;
  const testKey = secretKey.startsWith("sk_test_");
  if (!response.ok || typeof sessionId !== "string" || typeof checkoutUrl !== "string"
      || session?.attributes?.livemode !== !testKey) {
    if (response.status >= 400 && response.status < 500 && !sessionId)
      await admin.rpc("abort_failed_paymongo_checkout", { p_attempt_id: prepared.attempt_id });
    return json({ message: "PayMongo did not create this balance checkout. Ask staff to verify it before retrying." }, 502, origin);
  }
  const { data: attached, error: attachError } = await admin.rpc("attach_paymongo_checkout", {
    p_attempt_id: prepared.attempt_id, p_session_id: sessionId, p_checkout_url: checkoutUrl,
  });
  if (attachError || attached !== true)
    return json({ message: "Checkout needs reconciliation. Contact the owner with this payment reference." }, 503, origin);
  return json({ attempt_id: prepared.attempt_id, checkout_url: checkoutUrl }, 200, origin);
});
