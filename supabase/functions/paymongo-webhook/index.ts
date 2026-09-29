import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { validPaymongoSignature } from "./_shared/paymongo-signature.ts";
import { paidCheckoutPayment } from "./_shared/paid-checkout.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ message: "Method not allowed" }, 405);
  const webhookSecret = Deno.env.get("PAYMONGO_WEBHOOK_SECRET");
  const paymongoKey = Deno.env.get("PAYMONGO_SECRET_KEY");
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!webhookSecret || !paymongoKey || !url || !serviceKey) return json({ message: "Webhook is not configured." }, 503);

  const rawBody = await req.text();
  if (rawBody.length > 1024 * 1024) return json({ message: "Payload too large." }, 413);
  const signature = req.headers.get("Paymongo-Signature") || "";
  const testMode = paymongoKey.startsWith("sk_test_");
  if (!paymongoKey.startsWith("sk_test_") && !paymongoKey.startsWith("sk_live_")) return json({ message: "Invalid payment configuration." }, 503);
  if (!await validPaymongoSignature(rawBody, signature, webhookSecret, testMode)) return json({ message: "Invalid signature." }, 401);

  let body: any;
  try { body = JSON.parse(rawBody); } catch { return json({ message: "Invalid JSON." }, 400); }
  const envelope = body?.data;
  const eventType = envelope?.attributes?.type ?? envelope?.type;
  if (typeof eventType !== "string") return json({ message: "Invalid event." }, 400);
  let eventId = envelope?.id;
  if (typeof eventId !== "string") {
    // Hosted Checkout's current sample envelope omits evt_*; a digest of its
    // signed, immutable raw body gives retries the same deduplication key.
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody)));
    eventId = `evt_${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  if (eventType !== "checkout_session.payment.paid") return json({ received: true, ignored: true });

  const session = envelope?.attributes?.data ?? envelope?.data;
  const sessionId = session?.id;
  const attributes = session?.attributes;
  const eventLivemode = envelope?.attributes?.livemode ?? envelope?.livemode ?? attributes?.livemode;
  if (typeof sessionId !== "string" || !attributes || typeof eventLivemode !== "boolean"
      || eventLivemode !== !testMode) {
    return json({ message: "Payment mode or checkout session is invalid." }, 400);
  }
  // The reservation is charged the gross customer amount. PayMongo's
  // net_amount is the merchant proceeds after its fee and must not be used
  // to compare against the saved booking amount.
  const paidPayment = paidCheckoutPayment(attributes);
  if (!paidPayment) {
    // Ask PayMongo to retry while we can reconcile a complete paid resource.
    return json({ message: "Paid checkout details are incomplete." }, 503);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: result, error } = await admin.rpc("record_paymongo_paid", {
    p_event_id: eventId,
    p_session_id: sessionId,
    p_payment_id: paidPayment.paymentId,
    p_amount_minor: paidPayment.amountMinor,
    p_fee_minor: paidPayment.feeMinor,
    p_net_minor: paidPayment.netMinor,
  });
  if (error) {
    console.error("Could not record PayMongo payment", error.message);
    return json({ message: "Payment could not be recorded yet." }, 503);
  }
  if (result === "review" || result === "unmatched") {
    console.error("PayMongo payment needs reconciliation", { result, sessionId, eventId });
    // SQL durably recorded the event and marked the attempt for staff review.
    // A retry cannot improve that state because event IDs are deduplicated.
    return json({ received: true, result });
  }
  return json({ received: true, result });
});
