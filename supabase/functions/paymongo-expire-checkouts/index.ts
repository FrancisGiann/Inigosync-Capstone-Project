import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { paidCheckoutPayment } from "./_shared/paid-checkout.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ message: "Method not allowed." }, 405);
  const supplied = req.headers.get("x-paymongo-cron-secret") || "";

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const paymongoKey = Deno.env.get("PAYMONGO_SECRET_KEY");
  if (!url || !serviceKey || !paymongoKey) return json({ message: "Worker is not configured." }, 503);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authorized, error: authorizationError } = await admin.rpc("verify_paymongo_expiry_worker", {
    p_token: supplied,
  });
  if (authorizationError || authorized !== true) return json({ message: "Unauthorized." }, 401);
  const { data: due, error: listError } = await admin.rpc("list_paymongo_checkouts_due_for_expiry");
  if (listError) {
    console.error("Could not list PayMongo sessions due for expiry", listError.message);
    return json({ message: "Could not list sessions." }, 503);
  }

  let expired = 0;
  let paid = 0;
  let deferred = 0;
  const basic = btoa(`${paymongoKey}:`);
  for (const item of Array.isArray(due) ? due : []) {
    const attemptId = item?.attempt_id;
    let sessionId = item?.session_id;
    if (typeof attemptId !== "string") { deferred++; continue; }
    try {
      if (typeof sessionId !== "string") {
        if (item?.should_abandon === true || !item?.checkout_request
            || typeof item.checkout_request !== "object" || Array.isArray(item.checkout_request)) {
          const { data: abandoned, error } = await admin.rpc("mark_paymongo_checkout_abandoned", {
            p_attempt_id: attemptId,
          });
          if (error || abandoned !== true) deferred++;
          else expired++;
          continue;
        }

        // The original create call may have timed out after PayMongo created a
        // session. Replay the exact stored request with its original key; the
        // key is abandoned locally before its documented 24-hour lifetime.
        const createResponse = await fetch("https://api.paymongo.com/v2/checkout_sessions", {
          method: "POST",
          headers: { authorization: `Basic ${basic}`, "content-type": "application/json",
            "Idempotency-Key": attemptId },
          body: JSON.stringify({ data: { attributes: item.checkout_request } }),
          signal: AbortSignal.timeout(10000),
        });
        const created = await createResponse.json().catch(() => null);
        sessionId = created?.data?.id;
        const checkoutUrl = created?.data?.attributes?.checkout_url;
        const expectedLivemode = paymongoKey.startsWith("sk_live_");
        if (!createResponse.ok || typeof sessionId !== "string" || typeof checkoutUrl !== "string"
            || created?.data?.attributes?.livemode !== expectedLivemode) {
          deferred++;
          continue;
        }
        const { data: attached, error: attachError } = await admin.rpc("attach_paymongo_checkout", {
          p_attempt_id: attemptId, p_session_id: sessionId, p_checkout_url: checkoutUrl,
        });
        if (attachError || attached !== true) { deferred++; continue; }
      }

      const getResponse = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${encodeURIComponent(sessionId)}`, {
        headers: { authorization: `Basic ${basic}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!getResponse.ok) { deferred++; continue; }
      let resource = (await getResponse.json())?.data;
      let attributes = resource?.attributes;
      if (!resource || typeof attributes?.status !== "string"
          || typeof attributes?.livemode !== "boolean"
          || attributes.livemode !== paymongoKey.startsWith("sk_live_")) {
        deferred++;
        continue;
      }

      const payment = paidCheckoutPayment(attributes);
      if (payment) {
        const { data: recorded, error } = await admin.rpc("record_paymongo_paid", {
          p_event_id: `expiry-reconcile:${sessionId}:${payment.paymentId}`,
          p_session_id: sessionId,
          p_payment_id: payment.paymentId,
          p_amount_minor: payment.amountMinor,
          p_fee_minor: payment.feeMinor,
          p_net_minor: payment.netMinor,
        });
        if (error || !["paid", "duplicate", "review"].includes(recorded)) {
          console.error("Could not reconcile paid PayMongo session", error?.message || recorded);
          deferred++;
        } else {
          if (recorded === "review") console.error("Paid PayMongo session needs staff review", { sessionId, attemptId });
          paid++;
        }
        continue;
      }

      if (attributes.status === "active") {
        const expireResponse = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${encodeURIComponent(sessionId)}/expire`, {
          method: "POST",
          headers: { authorization: `Basic ${basic}`, "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(10000),
        });
        if (!expireResponse.ok) { deferred++; continue; }
        resource = (await expireResponse.json().catch(() => null))?.data;
        attributes = resource?.attributes;
      }
      if (attributes.status !== "expired") { deferred++; continue; }
      const { data: marked, error: markError } = await admin.rpc("mark_paymongo_checkout_expired", {
        p_attempt_id: attemptId,
        p_session_id: sessionId,
      });
      if (markError || marked !== true) deferred++;
      else expired++;
    } catch (error) {
      console.error("PayMongo expiry reconciliation deferred", error instanceof Error ? error.message : "request failed");
      deferred++;
    }
  }
  return json({ processed: expired + paid + deferred, expired, paid, deferred });
});
