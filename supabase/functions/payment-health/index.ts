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
  if (!url || !serviceKey) return json({ message: "Payment status is unavailable." }, 503, origin);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json({ message: "Sign in again." }, 401, origin);
  const { data: profile } = await admin.from("profiles").select("role,status").eq("id", authData.user.id).maybeSingle();
  if (profile?.role !== "admin" || profile?.status === "disabled") return json({ message: "Owner access is required." }, 403, origin);
  const { data: last } = await admin.from("payment").select("created_at").eq("payment_method", "PayMongo")
    .gt("paid", 0).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const key = Deno.env.get("PAYMONGO_SECRET_KEY") || "";
  const webhookSecret = Deno.env.get("PAYMONGO_WEBHOOK_SECRET") || "";
  let apiConnected: boolean | null = null;
  let webhookConfigured: boolean | null = webhookSecret ? null : false;
  if (key.startsWith("sk_test_") || key.startsWith("sk_live_")) {
    try {
      const response = await fetch("https://api.paymongo.com/v1/webhooks", {
        headers: { authorization: `Basic ${btoa(`${key}:`)}` }, signal: AbortSignal.timeout(8000),
      });
      apiConnected = response.ok;
      if (response.ok) {
        const payload = await response.json();
        const expectedUrl = `${url}/functions/v1/paymongo-webhook`;
        const configured = (payload?.data || []).some((entry: any) => {
          const attrs = entry?.attributes || {};
          return attrs.url === expectedUrl && attrs.status === "enabled"
            && (attrs.events || []).includes("checkout_session.payment.paid");
        });
        webhookConfigured = Boolean(webhookSecret && configured);
      }
    } catch { apiConnected = null; }
  } else {
    apiConnected = false;
  }
  return json({ api_connected: apiConnected, webhook_configured: webhookConfigured,
    last_confirmed_payment_at: last?.created_at || null }, 200, origin);
});
