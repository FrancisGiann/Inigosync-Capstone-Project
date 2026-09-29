import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const appBaseUrl = Deno.env.get("APP_BASE_URL") || "";
const allowedOrigin = (() => { try { return new URL(appBaseUrl).origin; } catch { return ""; } })();
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
  const secretKey = Deno.env.get("PAYMONGO_SECRET_KEY");
  if (!url || !serviceKey || !secretKey || !appBaseUrl)
    return json({ message: "Online checkout is not configured yet." }, 503, origin);
  const base = new URL(appBaseUrl);
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    return json({ message: "Online checkout return URL is not secure." }, 503, origin);

  let body: { order_id?: unknown };
  try { body = await req.json(); } catch { return json({ message: "Invalid request." }, 400, origin); }
  if (typeof body.order_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.order_id))
    return json({ message: "Invalid walk-in order." }, 400, origin);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json({ message: "Your session has expired. Sign in again." }, 401, origin);

  const { data: prepared, error: prepareError } = await admin.rpc("prepare_staff_walkin_checkout", {
    p_order_id: body.order_id, p_staff_id: authData.user.id,
  });
  if (prepareError || !prepared?.attempt_id)
    return json({ message: "This walk-in order is not eligible for online payment." }, 409, origin);
  if (prepared.status === "ready" && prepared.checkout_url)
    return json({ order_id: body.order_id, attempt_id: prepared.attempt_id,
      checkout_url: prepared.checkout_url, base_minor: prepared.base_minor,
      currency: "PHP", expires_at: prepared.expires_at }, 200, origin);
  if (prepared.status !== "creating") return json({ message: "This checkout needs staff review." }, 409, origin);

  const { data: settings } = await admin.from("app_settings")
    .select("card_enabled,gcash_enabled").eq("id", true).maybeSingle();
  const methods = [settings?.card_enabled !== false ? "card" : "",
    settings?.gcash_enabled !== false ? "gcash" : ""].filter(Boolean);
  if (!methods.length) return json({ message: "Online payment is unavailable." }, 503, origin);
  const success = new URL("/Pages/staff_dashboard.html", base);
  success.searchParams.set("walkin_checkout", "return");
  success.searchParams.set("order", body.order_id);
  const cancel = new URL("/Pages/staff_dashboard.html", base);
  cancel.searchParams.set("walkin_checkout", "cancel");
  cancel.searchParams.set("order", body.order_id);
  const reference = prepared.attempt_id.replaceAll("-", "");
  const checkoutAttributes = {
    line_items: [{ name: "Front desk walk-in order", amount: Number(prepared.base_minor), currency: "PHP", quantity: 1 }],
    payment_method_types: methods, success_url: success.toString(), cancel_url: cancel.toString(),
    reference_number: reference, description: `IñigoSync walk-in ${reference.slice(0, 12)}`,
    pass_on_fees: true, send_email_receipt: false,
  };
  const { data: requestRegistered, error: requestError } = await admin.rpc("register_paymongo_checkout_request", {
    p_attempt_id: prepared.attempt_id, p_request: checkoutAttributes,
  });
  if (requestError || requestRegistered !== true)
    return json({ message: "Could not safely prepare this checkout. Refresh and try again." }, 409, origin);

  let response: Response;
  try {
    response = await fetch("https://api.paymongo.com/v2/checkout_sessions", {
      method: "POST", headers: { authorization: `Basic ${btoa(`${secretKey}:`)}`,
        "content-type": "application/json", "Idempotency-Key": prepared.attempt_id },
      body: JSON.stringify({ data: { attributes: checkoutAttributes } }), signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    console.error("PayMongo walk-in checkout creation uncertain", error instanceof Error ? error.message : "network error");
    return json({ message: "PayMongo could not be reached. The courts remain held temporarily; verify this checkout before retrying." }, 503, origin);
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
    return json({ message: "PayMongo could not create checkout. The order may need staff review." }, 502, origin);
  }

  const { data: attached, error: attachError } = await admin.rpc("attach_paymongo_checkout", {
    p_attempt_id: prepared.attempt_id, p_session_id: sessionId, p_checkout_url: checkoutUrl,
  });
  if (attachError || attached !== true)
    return json({ message: "Checkout was created but needs reconciliation. Contact the owner with this order reference." }, 503, origin);
  return json({ order_id: body.order_id, attempt_id: prepared.attempt_id,
    checkout_url: checkoutUrl, base_minor: prepared.base_minor, currency: "PHP",
    expires_at: prepared.expires_at }, 200, origin);
});
