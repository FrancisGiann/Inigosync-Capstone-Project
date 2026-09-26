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
  if (!url || !serviceKey || !secretKey || !appBaseUrl) return json({ message: "Online checkout is not configured yet." }, 503, origin);
  const base = new URL(appBaseUrl);
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    return json({ message: "Online checkout return URL is not secure." }, 503, origin);
  let body: { source?: unknown; id?: unknown };
  try { body = await req.json(); } catch { return json({ message: "Invalid request." }, 400, origin); }
  const source = body.source === "booking" || body.source === "walkin" ? body.source : "";
  const id = Number(body.id);
  if (!source || !Number.isSafeInteger(id) || id <= 0) return json({ message: "Invalid reservation." }, 400, origin);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json({ message: "Your session has expired. Sign in again." }, 401, origin);
  const { data: prepared, error: prepareError } = await admin.rpc("prepare_paymongo_balance_checkout", {
    p_source: source, p_id: id, p_staff_id: authData.user.id,
  });
  if (prepareError || !prepared?.attempt_id)
    return json({ message: "This balance cannot be collected online right now." }, 409, origin);
  if (prepared.status === "ready" && prepared.checkout_url)
    return json({ attempt_id: prepared.attempt_id, checkout_url: prepared.checkout_url }, 200, origin);
  if (prepared.status !== "creating") return json({ message: "This payment needs staff review." }, 409, origin);
  const { data: settings } = await admin.from("app_settings").select("card_enabled,gcash_enabled").eq("id", true).maybeSingle();
  const methods = [settings?.card_enabled !== false ? "card" : "", settings?.gcash_enabled !== false ? "gcash" : ""].filter(Boolean);
  if (!methods.length) return json({ message: "Online payment is unavailable." }, 503, origin);
  const success = new URL("/Pages/staff_dashboard.html", base);
  success.searchParams.set("balance_checkout", "return"); success.searchParams.set("source", source); success.searchParams.set("id", String(id));
  const cancel = new URL("/Pages/staff_dashboard.html", base);
  cancel.searchParams.set("balance_checkout", "cancel"); cancel.searchParams.set("source", source); cancel.searchParams.set("id", String(id));
  const reference = String(prepared.attempt_id).replaceAll("-", "");
  let response: Response;
  try {
    response = await fetch("https://api.paymongo.com/v2/checkout_sessions", {
      method: "POST", headers: { authorization: `Basic ${btoa(`${secretKey}:`)}`,
        "content-type": "application/json", "Idempotency-Key": prepared.attempt_id },
      body: JSON.stringify({ data: { attributes: {
        line_items: [{ name: `Reservation ${id} balance`, amount: Number(prepared.amount_minor), currency: "PHP", quantity: 1 }],
        payment_method_types: methods, success_url: success.toString(), cancel_url: cancel.toString(),
        reference_number: reference, description: `IñigoSync balance ${reference.slice(0, 12)}`,
        pass_on_fees: false, send_email_receipt: false,
      } } }), signal: AbortSignal.timeout(12000),
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
