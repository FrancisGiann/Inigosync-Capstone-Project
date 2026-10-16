// Owner payment settings are authoritative. A missing or incomplete row
// must never silently enable a payment method during checkout.
export function enabledPaymongoMethods(settings) {
  if (!settings || typeof settings !== "object") return [];
  const methods = [];
  if (settings.card_enabled === true) methods.push("card");
  if (settings.gcash_enabled === true) methods.push("gcash");
  if (settings.qrph_enabled === true) methods.push("qrph");
  return methods;
}

