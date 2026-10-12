// A new checkout is unsafe if its paid event has no configured receiver.
// This check is advisory about provider configuration; signed webhook and
// database reconciliation remain authoritative for settlement.
export async function hasPaymongoPaidWebhook({ secretKey, webhookSecret, supabaseUrl, fetcher = fetch }) {
  if (!/^(sk_test_|sk_live_)/.test(secretKey || "") || !webhookSecret || !supabaseUrl) return false;
  let expectedUrl;
  try { expectedUrl = new URL("/functions/v1/paymongo-webhook", supabaseUrl).toString(); }
  catch { return false; }
  try {
    const response = await fetcher("https://api.paymongo.com/v1/webhooks", {
      headers: { authorization: `Basic ${btoa(`${secretKey}:`)}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return Array.isArray(payload?.data) && payload.data.some((entry) => {
      const attrs = entry?.attributes || {};
      return attrs.url === expectedUrl && attrs.status === "enabled"
        && attrs.livemode === secretKey.startsWith("sk_live_")
        && Array.isArray(attrs.events) && attrs.events.includes("checkout_session.payment.paid");
    });
  } catch { return false; }
}

