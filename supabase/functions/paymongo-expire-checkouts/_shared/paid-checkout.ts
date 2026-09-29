export function paidCheckoutPayment(attributes: any): {
  paymentId: string; amountMinor: number; feeMinor: number; netMinor: number;
} | null {
  const payment = Array.isArray(attributes?.payments)
    ? attributes.payments.find((entry: any) => entry?.attributes?.status === "paid" || entry?.status === "paid")
    : null;
  if (!payment) return null;
  const paymentAttributes = payment.attributes ?? payment;
  const paymentId = payment.id;
  const amountMinor = Number(paymentAttributes.amount);
  const feeMinor = Number(paymentAttributes.fee);
  const netMinor = Number(paymentAttributes.net_amount);
  if (typeof paymentId !== "string" || !Number.isSafeInteger(amountMinor) || amountMinor <= 0
      || !Number.isSafeInteger(feeMinor) || feeMinor < 0
      || !Number.isSafeInteger(netMinor) || netMinor < 0
      || amountMinor !== feeMinor + netMinor
      || String(paymentAttributes.currency || "").toUpperCase() !== "PHP") return null;
  return { paymentId, amountMinor, feeMinor, netMinor };
}
