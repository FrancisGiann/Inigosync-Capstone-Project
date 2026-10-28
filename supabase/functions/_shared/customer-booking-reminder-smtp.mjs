const MAILBOX_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/i;

export function parseReminderMailbox(value, { allowDisplayName = false } = {}) {
  if (typeof value !== "string" || /[\r\n\x00-\x1f\x7f]/.test(value)) return null;
  const input = value.trim();
  if (!input) return null;

  let address = input;
  let displayName = "";
  const angleAddress = input.match(/^(.*?)\s*<([^<>]+)>$/);
  if (angleAddress) {
    if (!allowDisplayName) return null;
    displayName = angleAddress[1].trim().replace(/^"|"$/g, "");
    address = angleAddress[2].trim();
    if (!displayName || displayName.length > 100 || /[<>]/.test(displayName)) return null;
  }
  if (!MAILBOX_PATTERN.test(address) || address.length > 254) return null;
  return { address, displayName };
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function wrapBase64(value) {
  return value.match(/.{1,76}/g)?.join("\r\n") || "";
}

function safeHeaderText(value, label) {
  if (typeof value !== "string" || /[\r\n\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

export function buildCustomerBookingReminderMimeMessage({ from, to, subject, text, html, messageId }) {
  const sender = parseReminderMailbox(from, { allowDisplayName: true });
  const recipient = parseReminderMailbox(to);
  if (!sender || !recipient) throw new TypeError("Invalid email address.");
  const safeSubject = safeHeaderText(subject, "subject");
  if (typeof text !== "string" || typeof html !== "string") throw new TypeError("Invalid email content.");
  const id = messageId || `<${crypto.randomUUID()}@inigossportcenter.com>`;
  if (!/^<[A-Za-z0-9._-]+@[A-Za-z0-9.-]+>$/.test(id)) throw new TypeError("Invalid message ID.");

  const boundary = `inigossync_${crypto.randomUUID().replaceAll("-", "")}`;
  const fromHeader = sender.displayName
    ? `=?UTF-8?B?${base64Utf8(sender.displayName)}?= <${sender.address}>`
    : sender.address;
  const textBody = wrapBase64(base64Utf8(text.replace(/\r?\n/g, "\r\n")));
  const htmlBody = wrapBase64(base64Utf8(html.replace(/\r?\n/g, "\r\n")));
  const message = [
    `From: ${fromHeader}`,
    `To: ${recipient.address}`,
    `Subject: ${safeSubject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${id}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    textBody,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    htmlBody,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return { sender: sender.address, recipient: recipient.address, message };
}

export function missingCustomerBookingReminderSettings(input) {
  const missing = [];
  if (!input.smtpUsername) missing.push("CUSTOMER_BOOKING_SMTP_USERNAME");
  if (!input.smtpAppPassword) missing.push("CUSTOMER_BOOKING_SMTP_APP_PASSWORD");
  if (!input.from) missing.push("CUSTOMER_BOOKING_REMINDER_FROM_EMAIL (or SMTP username)");
  if (!input.dashboardUrl) missing.push("CUSTOMER_BOOKING_DASHBOARD_URL (must be HTTPS)");
  return missing;
}

export class SmtpDeliveryError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "SmtpDeliveryError";
    this.reason = reason;
  }
}

async function readSmtpLine(connection, reader) {
  while (true) {
    const end = reader.pending.indexOf("\r\n");
    if (end >= 0) {
      const line = reader.pending.slice(0, end);
      reader.pending = reader.pending.slice(end + 2);
      return line;
    }
    if (reader.pending.length > 8192) throw new SmtpDeliveryError("response_too_large");
    const buffer = new Uint8Array(1024);
    const size = await connection.read(buffer);
    if (size === null) throw new SmtpDeliveryError("connection_closed");
    if (size === 0) continue;
    reader.pending += reader.decoder.decode(buffer.subarray(0, size), { stream: true });
  }
}

async function readSmtpResponse(connection, reader) {
  let responseCode;
  for (let index = 0; index < 20; index++) {
    const line = await readSmtpLine(connection, reader);
    const match = line.match(/^(\d{3})([ -])/);
    if (!match) throw new SmtpDeliveryError("invalid_server_response");
    const code = Number(match[1]);
    if (responseCode !== undefined && responseCode !== code) {
      throw new SmtpDeliveryError("invalid_server_response");
    }
    responseCode = code;
    if (match[2] === " ") return code;
  }
  throw new SmtpDeliveryError("response_too_large");
}

async function writeSmtp(connection, value) {
  const bytes = new TextEncoder().encode(value);
  let offset = 0;
  while (offset < bytes.length) offset += await connection.write(bytes.subarray(offset));
}

export async function deliverCustomerBookingReminder({
  connectTls, smtpUsername, smtpAppPassword, from, email, timeoutMs = 15000,
}) {
  const account = parseReminderMailbox(smtpUsername);
  const recipient = parseReminderMailbox(email?.to?.[0]);
  const mime = buildCustomerBookingReminderMimeMessage({
    from,
    to: email?.to?.[0],
    subject: email?.subject,
    text: email?.text,
    html: email?.html,
  });
  if (!account || !recipient || typeof smtpAppPassword !== "string" || !smtpAppPassword.trim()
    || /[\r\n\x00]/.test(smtpAppPassword)) {
    throw new SmtpDeliveryError("invalid_mail_configuration");
  }

  let connection;
  let timedOut = false;
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      try {
        connection?.close();
      } catch {
        // The connection may already have closed.
      }
      reject(new SmtpDeliveryError("timeout"));
    }, timeoutMs);
  });
  const operation = (async () => {
    connection = await connectTls();
    if (timedOut) {
      connection.close();
      throw new SmtpDeliveryError("timeout");
    }
    const reader = { pending: "", decoder: new TextDecoder() };
    const expect = async (expected, reason) => {
      const code = await readSmtpResponse(connection, reader);
      if (!expected.includes(code)) throw new SmtpDeliveryError(reason);
    };
    await expect([220], "greeting_rejected");
    await writeSmtp(connection, "EHLO inigosportcenter.com\r\n");
    await expect([250], "ehlo_rejected");
    const auth = btoa(`\0${account.address}\0${smtpAppPassword.trim()}`);
    await writeSmtp(connection, `AUTH PLAIN ${auth}\r\n`);
    await expect([235], "authentication_rejected");
    await writeSmtp(connection, `MAIL FROM:<${mime.sender}>\r\n`);
    await expect([250], "sender_rejected");
    await writeSmtp(connection, `RCPT TO:<${mime.recipient}>\r\n`);
    await expect([250, 251], "recipient_rejected");
    await writeSmtp(connection, "DATA\r\n");
    await expect([354], "data_rejected");
    const smtpMessage = mime.message.replace(/\r?\n/g, "\r\n").replace(/\r\n\./g, "\r\n..");
    await writeSmtp(connection, `${smtpMessage}.\r\n`);
    await expect([250], "message_rejected");
  })();

  try {
    await Promise.race([operation, timeout]);
  } catch (error) {
    if (timedOut) throw new SmtpDeliveryError("timeout");
    if (error instanceof SmtpDeliveryError) throw error;
    throw new SmtpDeliveryError("smtp_connection_error");
  } finally {
    clearTimeout(timeoutId);
    try {
      connection?.close();
    } catch {
      // The connection may already have closed.
    }
  }
}
