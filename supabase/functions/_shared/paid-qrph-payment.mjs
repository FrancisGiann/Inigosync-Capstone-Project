// Parse the signed `payment.paid` resource for the direct QR Ph Payment Intent
// flow. Settlement still checks amount, fees, attempt, and payment ID in SQL.
export function paidQrPhPayment(payment) {
  const attrs = payment?.attributes;
  const amountMinor = attrs?.amount;
  const feeMinor = attrs?.fee;
  const netMinor = attrs?.net_amount;
  if (payment?.type !== "payment" || typeof payment.id !== "string"
      || attrs?.status !== "paid" || attrs?.currency !== "PHP"
      || attrs?.source?.type !== "qrph" || typeof attrs.payment_intent_id !== "string"
      || !/^pi_[A-Za-z0-9]+$/.test(attrs.payment_intent_id)
      || !Number.isSafeInteger(amountMinor) || amountMinor <= 0
      || !Number.isSafeInteger(feeMinor) || feeMinor < 0
      || !Number.isSafeInteger(netMinor) || netMinor < 0
      || amountMinor !== feeMinor + netMinor) return null;
  return { paymentId: payment.id, intentId: attrs.payment_intent_id, amountMinor, feeMinor, netMinor };
}
