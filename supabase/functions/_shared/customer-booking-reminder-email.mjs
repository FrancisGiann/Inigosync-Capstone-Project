const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);

const php = (amount) => new Intl.NumberFormat("en-PH", {
  style: "currency", currency: "PHP", minimumFractionDigits: 2,
}).format(amount);

export function buildCustomerBookingReminderEmail(input) {
  const visitId = Number(input.visitId);
  if (!Number.isSafeInteger(visitId) || visitId <= 0) throw new TypeError("Invalid visit ID.");
  const visitType = input.visitType === "walkin" ? "walk-in" : "booking";
  const eventType = input.eventType;
  if (!["starting_soon", "ending_soon"].includes(eventType)) throw new TypeError("Invalid reminder event.");
  const sport = typeof input.sport === "string" && input.sport.trim() ? input.sport : "Sport";
  const court = typeof input.court === "string" && input.court.trim() ? input.court : "Court";
  const dateLabel = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? "your scheduled time" : new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila", weekday: "long", month: "long", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    }).format(date);
  };
  const startLabel = dateLabel(input.startsAt);
  const endLabel = dateLabel(input.endsAt);
  const courtUnit = typeof input.courtUnit === "string" && input.courtUnit.trim() ? input.courtUnit.trim() : "";
  const dueAmount = Math.max(0, Number(input.amountDue) || 0);
  const isStart = eventType === "starting_soon";
  const title = isStart ? "Your booking starts in about 30 minutes" : "Your visit ends in about 10 minutes";
  const timing = isStart ? `Scheduled start: ${startLabel} (Asia/Manila)` : `Scheduled end: ${endLabel} (Asia/Manila)`;
  const balanceLine = isStart && dueAmount > 0 ? `Balance due at check-in: ${php(dueAmount)}` : "";
  const dashboardUrl = String(input.dashboardUrl || "");
  const recipient = String(input.email || "").trim();
  if (!recipient) throw new TypeError("Invalid reminder recipient.");
  const text = [
    `Hello, your InigoSync ${visitType} is coming up. ${title}.`,
    `Visit ID: ${visitId}`,
    `Sport: ${sport}`,
    `Court: ${[court, courtUnit].filter(Boolean).join(" · ")}`,
    `Scheduled time: ${startLabel}–${endLabel} (Asia/Manila)`,
    timing,
    balanceLine,
    `My Bookings: ${dashboardUrl}`,
  ].filter(Boolean).join("\n");
  const safeBalance = isStart && dueAmount > 0
    ? `<p><strong>Balance due at check-in:</strong> ${escapeHtml(php(dueAmount))}</p>`
    : "";
  const safeUrl = escapeHtml(dashboardUrl);
  const safeCourt = escapeHtml([court, courtUnit].filter(Boolean).join(" · "));

  return {
    to: [recipient],
    subject: `${title} · InigoSync`,
    text,
    html: `<div style="margin:0;background:#f4f1e9;padding:28px 12px;font-family:Arial,sans-serif;color:#20251f"><div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4dfd3;border-radius:16px;overflow:hidden"><div style="background:#183d32;padding:22px 26px;color:#fff"><div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#e4bd69">Iñigos Sport Center</div><div style="font-size:23px;font-weight:700;margin-top:7px">InigoSync</div></div><div style="padding:26px"><p style="font-size:17px;margin:0 0 8px">${escapeHtml(title)}</p><p style="color:#626a61;line-height:1.6;margin:0 0 20px">Here are the details for your ${escapeHtml(visitType)}.</p><div style="background:#f7f6f1;border:1px solid #e9e5da;border-radius:12px;padding:16px;line-height:1.8"><strong>Visit ID:</strong> ${visitId}<br><strong>Sport:</strong> ${escapeHtml(sport)}<br><strong>Court:</strong> ${safeCourt}<br><strong>Scheduled time:</strong> ${escapeHtml(startLabel)} – ${escapeHtml(endLabel)} (Asia/Manila)<br><strong>${isStart ? "Starts" : "Ends"}:</strong> ${escapeHtml(isStart ? startLabel : endLabel)} (Asia/Manila)</div>${safeBalance}<p style="margin:24px 0 8px"><a href="${safeUrl}" style="display:inline-block;background:#183d32;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700">View My Bookings</a></p><p style="font-size:12px;color:#737970;line-height:1.5">This reminder was sent by InigoSync for your scheduled visit.</p></div></div></div>`,
  };
}

