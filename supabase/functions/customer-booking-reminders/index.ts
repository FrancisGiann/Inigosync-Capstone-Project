import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { buildCustomerBookingReminderEmail } from "../_shared/customer-booking-reminder-email.mjs";
import { deliverCustomerBookingReminder, missingCustomerBookingReminderSettings } from "../_shared/customer-booking-reminder-smtp.mjs";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ message: "Method not allowed." }, 405);
  const supplied = req.headers.get("x-customer-booking-reminder-secret") || "";
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const smtpUsername = Deno.env.get("CUSTOMER_BOOKING_SMTP_USERNAME") || "";
  const smtpAppPassword = Deno.env.get("CUSTOMER_BOOKING_SMTP_APP_PASSWORD") || "";
  const from = Deno.env.get("CUSTOMER_BOOKING_REMINDER_FROM_EMAIL") || smtpUsername;
  const dashboardUrl = Deno.env.get("CUSTOMER_BOOKING_DASHBOARD_URL")
    || "https://inigossportcenter.com/Pages/user_dashboard.html";
  if (!url || !serviceKey) return json({ message: "Worker is not configured." }, 503);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authorized, error: authorizationError } = await admin.rpc("verify_customer_booking_reminder_worker", {
    p_token: supplied,
  });
  if (authorizationError || authorized !== true) return json({ message: "Unauthorized." }, 401);

  const { data: due, error: listError } = await admin.rpc("claim_customer_booking_reminders");
  if (listError) {
    console.error("Could not claim customer booking reminders", "database_error");
    return json({ message: "Could not claim reminders." }, 503);
  }
  let safeDashboardUrl = "";
  try {
    const parsed = new URL(dashboardUrl || "");
    if (parsed.protocol !== "https:") throw new Error("HTTPS required");
    parsed.hash = "bookings";
    safeDashboardUrl = parsed.toString();
  } catch {
    safeDashboardUrl = "";
  }
  const missingSettings = missingCustomerBookingReminderSettings({
    smtpUsername, smtpAppPassword, from, dashboardUrl: safeDashboardUrl,
  });
  if (!Array.isArray(due) || due.length === 0) {
    return json({ sent: 0, deferred: 0, missing_settings: missingSettings });
  }
  if (missingSettings.length) {
    for (const reminder of Array.isArray(due) ? due : []) {
      if (Number.isSafeInteger(Number(reminder?.booking_id)) && typeof reminder?.claim_token === "string") {
        await admin.rpc("release_customer_booking_reminder", {
          p_booking_id: Number(reminder.booking_id), p_claim_token: reminder.claim_token,
        });
      }
    }
    return json({ message: "Email delivery is not configured.", missing_settings: missingSettings }, 503);
  }

  let sent = 0;
  let deferred = 0;
  for (const reminder of Array.isArray(due) ? due : []) {
    const bookingId = Number(reminder?.booking_id);
    const claimToken = reminder?.claim_token;
    if (!Number.isSafeInteger(bookingId) || typeof claimToken !== "string") {
      deferred++;
      continue;
    }
    const { data: refreshed, error: refreshError } = await admin.rpc("refresh_customer_booking_reminder", {
      p_booking_id: bookingId, p_claim_token: claimToken,
    });
    const current = Array.isArray(refreshed) ? refreshed[0] : null;
    if (refreshError || !current || typeof current.email !== "string" || !current.email.trim()) {
      await admin.rpc("release_customer_booking_reminder", {
        p_booking_id: bookingId, p_claim_token: claimToken,
      });
      if (refreshError) console.error("Could not refresh customer booking reminder", "database_error");
      deferred++;
      continue;
    }
    try {
      const email = buildCustomerBookingReminderEmail({
        bookingId, sport: current.sport, court: current.court,
        startsAt: current.starts_at, amountDue: current.amount_due,
        dashboardUrl: safeDashboardUrl, email: current.email,
      });
      await deliverCustomerBookingReminder({
        connectTls: () => Deno.connectTls({ hostname: "smtp.gmail.com", port: 465 }),
        smtpUsername, smtpAppPassword, from, email,
      });
      const { data: completed, error: completeError } = await admin.rpc("complete_customer_booking_reminder", {
        p_booking_id: bookingId,
        p_claim_token: claimToken,
      });
      if (completeError || completed !== true) {
        // SMTP offers no idempotency key: timeout after DATA or a lost completion update can duplicate accepted mail on retry.
        console.error("Could not record customer booking reminder delivery", completeError ? "database_error" : "stale_claim");
        deferred++;
      } else {
        sent++;
      }
    } catch (error) {
      await admin.rpc("release_customer_booking_reminder", {
        p_booking_id: bookingId,
        p_claim_token: claimToken,
      });
      console.error("Customer booking reminder delivery deferred", error instanceof Error && "reason" in error ? error.reason : "smtp_error");
      deferred++;
    }
  }
  return json({ sent, deferred });
});
