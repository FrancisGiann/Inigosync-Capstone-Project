const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);

const php = (amount) => new Intl.NumberFormat("en-PH", {
  style: "currency", currency: "PHP", minimumFractionDigits: 2,
}).format(amount);

export function buildCustomerBookingReminderEmail(input) {
  const bookingId = Number(input.bookingId);
  if (!Number.isSafeInteger(bookingId) || bookingId <= 0) throw new TypeError("Invalid booking ID.");
  const sport = typeof input.sport === "string" && input.sport.trim() ? input.sport : "Sport";
  const court = typeof input.court === "string" && input.court.trim() ? input.court : "Court";
  const startsAt = new Date(input.startsAt);
  const startLabel = Number.isNaN(startsAt.valueOf())
    ? "your scheduled time"
    : new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila", weekday: "long", month: "long", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    }).format(startsAt);
  const dueAmount = Math.max(0, Number(input.amountDue) || 0);
  const balanceLine = dueAmount > 0 ? `Balance due at check-in: ${php(dueAmount)}` : "";
  const dashboardUrl = String(input.dashboardUrl || "");
  const recipient = String(input.email || "").trim();
  if (!recipient) throw new TypeError("Invalid reminder recipient.");
  const text = [
    "Your InigoSync booking starts in less than five hours.",
    `Sport: ${sport}`,
    `Court: ${court}`,
    `Start time: ${startLabel} (Asia/Manila)`,
    balanceLine,
    `My Bookings: ${dashboardUrl}`,
  ].filter(Boolean).join("\n");
  const safeBalance = dueAmount > 0
    ? `<p><strong>Balance due at check-in:</strong> ${escapeHtml(php(dueAmount))}</p>`
    : "";

  return {
    to: [recipient],
    subject: "Your InigoSync booking starts in less than five hours",
    text,
    html: `<p>Your InigoSync booking starts in less than five hours.</p><p><strong>Sport:</strong> ${escapeHtml(sport)}<br><strong>Court:</strong> ${escapeHtml(court)}<br><strong>Start time:</strong> ${escapeHtml(startLabel)} (Asia/Manila)</p>${safeBalance}<p><a href="${escapeHtml(dashboardUrl)}">View My Bookings</a></p>`,
  };
}

