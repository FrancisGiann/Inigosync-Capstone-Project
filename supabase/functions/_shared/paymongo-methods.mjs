// Owner payment settings are authoritative. A missing or incomplete row
// must never silently enable a payment method during checkout.
export function enabledPaymongoMethods(settings, { testMode = false } = {}) {
  if (!settings || typeof settings !== "object") return [];
  const methods = [];
  if (settings.card_enabled === true) methods.push("card");
  if (settings.gcash_enabled === true) methods.push("gcash");
  if (settings.qrph_enabled === true) methods.push("qrph");
  // Test QR Ph codes can be paid with real money. Hosted Checkout does not
  // expose the QR simulator URL here, so keep it out of test-mode checkout.
  // Live, staff, balance, and health flows retain their existing method list.
  if (testMode) return ["card", "gcash", "paymaya", "grab_pay"];
  return methods;
}

