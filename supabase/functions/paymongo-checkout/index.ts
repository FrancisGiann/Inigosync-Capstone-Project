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
async function providerCheckout(sessionId: string, key: string) {
  const response = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Basic ${btoa(`${key}:`)}` }, signal: AbortSignal.timeout(10000),
  });
  return response.ok ? (await response.json())?.data?.attributes : null;
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
  let body: { booking_id?: unknown; items?: unknown; payment_option?: unknown; action?: unknown; attempt_id?: unknown };
  try { body = await req.json(); } catch { return json({ message: "Invalid request." }, 400, origin); }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json({ message: "Your session has expired. Sign in again." }, 401, origin);

  const attemptId = typeof body.attempt_id === "string" ? body.attempt_id : "";
  if (body.action === "status" || body.action === "cancel") {
    const { data: rows, error } = await admin.rpc("get_paymongo_checkout_attempt_detail", {
      p_attempt_id: attemptId, p_customer_id: authData.user.id,
    });
    const attempt = Array.isArray(rows) ? rows[0] : null;
    if (error || !attempt) return json({ message: "Checkout not found." }, 404, origin);
    if (body.action === "cancel" && attempt.status === "ready" && attempt.paymongo_session_id) {
      try {
        let attrs = await providerCheckout(attempt.paymongo_session_id, secretKey);
        if (attrs?.status === "active") {
          const response = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${encodeURIComponent(attempt.paymongo_session_id)}/expire`, {
            method: "POST", headers: { authorization: `Basic ${btoa(`${secretKey}:`)}`, "content-type": "application/json" },
            body: "{}", signal: AbortSignal.timeout(10000),
          });
          attrs = response.ok ? (await response.json())?.data?.attributes : null;
        }
        if (attrs?.status === "expired") await admin.rpc("mark_paymongo_checkout_expired", {
          p_attempt_id: attempt.id, p_session_id: attempt.paymongo_session_id,
        });
      } catch (error) { console.error("Checkout cancellation deferred", error instanceof Error ? error.message : "provider error"); }
    }
    const { data: fresh } = await admin.rpc("get_paymongo_checkout_attempt_detail", {
      p_attempt_id: attemptId, p_customer_id: authData.user.id,
    });
    const current = Array.isArray(fresh) ? fresh[0] : attempt;
    return json({ attempt_id: current.id, status: current.status, item_count: current.item_count || 1 }, 200, origin);
  }

  let prepared: any;
  let label = "court reservation";
  if (Array.isArray(body.items)) {
    if (body.items.length < 1 || body.items.length > 8)
      return json({ message: "Choose between one and eight court times per checkout." }, 400, origin);
    const option = body.payment_option === "full" ? "full" : "downpayment";
    const { data, error } = await admin.rpc("prepare_paid_checkout_cart", {
      p_customer_id: authData.user.id, p_items: body.items, p_payment_option: option,
    });
    if (error || !data) return json({ message: error?.code === "23P01"
      ? "That court or lane was just reserved. Refresh availability and choose another time."
      : "Could not hold these court times. Check the selections and try again." }, 409, origin);
    prepared = data;
    label = `${data.item_count} court reservation${data.item_count === 1 ? "" : "s"}`;
  } else {
    // Legacy pending bookings retain their saved amount on retry.
    const bookingId = Number(body.booking_id);
    if (!Number.isSafeInteger(bookingId) || bookingId <= 0) return json({ message: "Invalid booking." }, 400, origin);
    const { data, error } = await admin.rpc("prepare_paymongo_checkout", {
      p_booking_id: bookingId, p_customer_id: authData.user.id,
    });
    if (error || !Array.isArray(data) || !data[0]) return json({ message: "This booking is not eligible for online payment." }, 409, origin);
    prepared = data[0];
    label = `${data[0].courts} court reservation`;
  }

  const id = prepared.attempt_id as string;
  const { data: rows, error: attemptError } = await admin.rpc("get_paymongo_checkout_attempt_detail", {
    p_attempt_id: id, p_customer_id: authData.user.id,
  });
  const attempt = Array.isArray(rows) ? rows[0] : null;
  if (attemptError || !attempt) return json({ message: "Could not prepare checkout." }, 503, origin);
  if (attempt.status === "ready" && attempt.checkout_url)
    return json({ attempt_id: id, checkout_url: attempt.checkout_url }, 200, origin);
  if (attempt.status !== "creating") return json({ message: "This checkout needs staff review." }, 409, origin);

  const { data: settings } = await admin.from("app_settings").select("card_enabled,gcash_enabled").eq("id", true).maybeSingle();
  const methods = [settings?.card_enabled !== false ? "card" : "", settings?.gcash_enabled !== false ? "gcash" : ""].filter(Boolean);
  if (!methods.length) return json({ message: "Online payment is unavailable." }, 503, origin);
  const success = new URL("/Pages/user_dashboard.html", base);
  success.searchParams.set("paymongo", "success"); success.searchParams.set("attempt", id);
  const cancel = new URL("/Pages/user_dashboard.html", base);
  cancel.searchParams.set("paymongo", "cancelled"); cancel.searchParams.set("attempt", id);
  const reference = id.replaceAll("-", "");
  const checkoutAttributes = {
    line_items: [{ name: label, amount: Number(attempt.amount_minor), currency: "PHP", quantity: 1 }],
    payment_method_types: methods, success_url: success.toString(), cancel_url: cancel.toString(),
    reference_number: reference, description: `IñigoSync reservation ${reference.slice(0, 12)}`,
    pass_on_fees: true, send_email_receipt: false,
  };
  const { data: requestRegistered, error: requestError } = await admin.rpc("register_paymongo_checkout_request", {
    p_attempt_id: id, p_request: checkoutAttributes,
  });
  if (requestError || requestRegistered !== true)
    return json({ message: "Could not safely prepare this checkout. Refresh and try again." }, 409, origin);
  let response: Response;
  try {
    response = await fetch("https://api.paymongo.com/v2/checkout_sessions", {
      method: "POST", headers: { authorization: `Basic ${btoa(`${secretKey}:`)}`, "content-type": "application/json",
        "Idempotency-Key": id },
      body: JSON.stringify({ data: { attributes: checkoutAttributes } }), signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    console.error("PayMongo checkout creation uncertain", error instanceof Error ? error.message : "network error");
    return json({ message: "PayMongo could not be reached. The court is held temporarily; contact staff before trying again." }, 503, origin);
  }
  const payload = await response.json().catch(() => null);
  const session = payload?.data;
  const sessionId = session?.id;
  const checkoutUrl = session?.attributes?.checkout_url;
  const testKey = secretKey.startsWith("sk_test_");
  if (!response.ok || typeof sessionId !== "string" || typeof checkoutUrl !== "string"
      || session?.attributes?.livemode !== !testKey) {
    console.error("PayMongo rejected checkout", response.status, JSON.stringify(payload?.errors || []).slice(0, 1000));
    if (response.status >= 400 && response.status < 500 && !sessionId) {
      await admin.rpc("abort_failed_paymongo_checkout", { p_attempt_id: id });
    }
    return json({ message: "PayMongo could not create checkout. The court is held temporarily; contact staff if this continues." }, 502, origin);
  }
  const { data: attached, error: attachError } = await admin.rpc("attach_paymongo_checkout", {
    p_attempt_id: id, p_session_id: sessionId, p_checkout_url: checkoutUrl,
  });
  if (attachError || attached !== true)
    return json({ message: "Checkout was created but needs reconciliation. Contact staff with this checkout reference." }, 503, origin);
  return json({ attempt_id: id, checkout_url: checkoutUrl, expires_at: prepared.expires_at }, 200, origin);
});
