// Owner payment settings are authoritative. A missing or incomplete row
// must never silently enable a payment method during checkout.
export function enabledPaymongoMethods(settings, { testMode = false } = {}) {
  if (!settings || typeof settings !== "object") return [];
  const methods = [];
  if (settings.card_enabled === true) methods.push("card");
  if (settings.gcash_enabled === true) methods.push("gcash");
  if (settings.qrph_enabled === true) methods.push("qrph");
  // Test-mode customer checkout adds QR Ph only when owner-enabled in the
  // checkout handler; other test methods retain their sandbox method list.
  // Keep QR Ph out of the general test method list; other flows are unchanged.
  if (testMode) return ["card", "gcash", "paymaya", "grab_pay"];
  return methods;
}

