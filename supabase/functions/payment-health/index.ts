import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { hasVerifiedEmailSession } from "../_shared/email-mfa.ts";
import { enabledPaymongoMethods } from "../_shared/paymongo-methods.mjs";

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
  if (!await hasVerifiedEmailSession(admin, token, authData.user.id)) return json({ message: "Verify your email before continuing." }, 403, origin);
  const { data: profile } = await admin.from("profiles").select("role,status").eq("id", authData.user.id).maybeSingle();
  if (!profile || !["admin", "staff"].includes(profile.role) || profile.status !== "active")
    return json({ message: "Active staff access is required." }, 403, origin);
  const { data: last } = await admin.from("payment").select("created_at").eq("payment_method", "PayMongo")
    .gt("paid", 0).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const { data: settings, error: settingsError } = await admin.from("app_settings")
    .select("card_enabled,gcash_enabled,qrph_enabled").eq("id", true).maybeSingle();
  const methods = settingsError ? [] : enabledPaymongoMethods(settings);
  const key = Deno.env.get("PAYMONGO_SECRET_KEY") || "";
  const keyMode = key.startsWith("sk_test_") ? "test" : key.startsWith("sk_live_") ? "live" : "unknown";
  const webhookSecret = Deno.env.get("PAYMONGO_WEBHOOK_SECRET") || "";
  let apiConnected: boolean | null = null;
  let webhookConfigured: boolean | null = webhookSecret ? null : false;
  if (keyMode === "test" || keyMode === "live") {
    try {
      const response = await fetch("https://api.paymongo.com/v1/webhooks", {
        headers: { authorization: `Basic ${btoa(`${key}:`)}` }, signal: AbortSignal.timeout(8000),
      });
      apiConnected = response.ok;
      if (response.ok) {
        const payload = await response.json();
        const expectedUrl = `${url}/functions/v1/paymongo-webhook`;
        const hasEvent = (eventType: string) => (payload?.data || []).some((entry: any) => {
          const attrs = entry?.attributes || {};
          return attrs.url === expectedUrl && attrs.status === "enabled"
            && attrs.livemode === (keyMode === "live")
            && Array.isArray(attrs.events) && attrs.events.includes(eventType);
        });
        webhookConfigured = Boolean(webhookSecret && hasEvent("checkout_session.payment.paid")
          && (settings?.qrph_enabled !== true || hasEvent("payment.paid")));
      }
    } catch { apiConnected = null; }
  } else if (!key) {
    apiConnected = false;
  }
  const onlineReady = Boolean(allowedOrigin && methods.length && apiConnected === true && webhookConfigured === true);
  if (profile.role === "staff") return json({ online_ready: onlineReady }, 200, origin);
  return json({ key_mode: keyMode, api_connected: apiConnected, webhook_configured: webhookConfigured,
    online_ready: onlineReady, last_confirmed_payment_at: last?.created_at || null }, 200, origin);
});
