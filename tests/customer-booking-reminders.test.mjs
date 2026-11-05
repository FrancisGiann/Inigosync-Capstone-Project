import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCustomerBookingReminderEmail } from '../supabase/functions/_shared/customer-booking-reminder-email.mjs';
import { buildCustomerBookingReminderMimeMessage, deliverCustomerBookingReminder, missingCustomerBookingReminderSettings, parseReminderMailbox, SmtpDeliveryError } from '../supabase/functions/_shared/customer-booking-reminder-smtp.mjs';

const baseMigration = await readFile(new URL('../supabase/migrations/20261027142608_create_customer_booking_reminders.sql', import.meta.url), 'utf8');
const forwardMigration = await readFile(new URL('../supabase/migrations/20261027145158_harden_customer_booking_reminder_leases.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261104070412_customer_visit_reminders.sql', import.meta.url), 'utf8');
const feed = migration.match(/create or replace function internal\.notification_feed\([\s\S]*?\$\$;/i)?.[0] || '';
const claim = migration.match(/create or replace function public\.claim_customer_visit_reminders\([\s\S]*?\$\$;/i)?.[0] || '';
const forwardClaim = claim;
const forwardRefresh = migration.match(/create or replace function public\.refresh_customer_visit_reminder\([\s\S]*?\$\$;/i)?.[0] || '';
const forwardInvoke = forwardMigration.match(/create or replace function internal\.invoke_customer_booking_reminder_worker\([\s\S]*?\$\$;/i)?.[0] || '';
const worker = await readFile(new URL('../supabase/functions/customer-booking-reminders/index.ts', import.meta.url), 'utf8');
const emailHelper = await readFile(new URL('../supabase/functions/_shared/customer-booking-reminder-email.mjs', import.meta.url), 'utf8');
const smtpHelper = await readFile(new URL('../supabase/functions/_shared/customer-booking-reminder-smtp.mjs', import.meta.url), 'utf8');
const config = await readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8');

test('customer feed is restricted to announcements, scoped maintenance, and timestamped visit reminders', () => {
  assert.ok(feed, 'customer feed replacement exists');
  assert.match(feed, /where a\.publish_at<=now\(\) and creator\.role='admin'[\s\S]*?p_role='customer' and a\.audience in \('both','customers'\)/i);
  assert.match(feed, /from internal\.customer_maintenance_notices n[\s\S]*?n\.customer_id=p_user_id/i);
  assert.match(feed, /visit-reminder:[\s\S]*?to_char\(r\.event_at at time zone 'UTC'/i);
  assert.match(feed, /r\.customer_id=p_user_id/i);
  assert.match(feed, /r\.event_at=v\.time_date[\s\S]*?v\.time_date<=now\(\)\+interval '30 minutes'/i);
  assert.match(feed, /r\.event_at=v\.end_at[\s\S]*?v\.end_at<=now\(\)\+interval '10 minutes'/i);
  assert.doesNotMatch(feed, /booking-reminder:|r\.created_at,'#bookings'.*5 hours/i);
});

test('private reminder tables enable RLS without client policies or grants', () => {
  assert.match(migration, /alter table internal\.customer_visit_reminders enable row level security/i);
  assert.match(baseMigration, /alter table internal\.customer_booking_reminders enable row level security/i);
  assert.match(baseMigration, /alter table internal\.customer_maintenance_notices enable row level security/i);
  assert.match(migration, /revoke all on internal\.customer_visit_reminders from public,anon,authenticated/i);
  assert.match(baseMigration, /revoke all on internal\.customer_booking_reminders from public, anon, authenticated/i);
  assert.match(baseMigration, /revoke all on internal\.customer_maintenance_notices from public,anon,authenticated/i);
  assert.doesNotMatch(`${migration}\n${baseMigration}`, /create policy .*customer_visit_reminders|create policy .*customer_booking_reminders|create policy .*customer_maintenance_notices/i);
});

test('maintenance notifications only target confirmed bookings overlapping their court unit', () => {
  assert.match(baseMigration, /insert into internal\.customer_maintenance_notices[\s\S]*?join public\.booking b on b\.court_unit_inventory_id=m\.court_unit_id/i);
  assert.match(baseMigration, /b\.status='confirmed' and b\.time_date>now\(\)/i);
  assert.match(baseMigration, /b\.time_date<m\.ends_at and b\.end_at>m\.starts_at/i);
  assert.match(baseMigration, /b\.customer_id,b\.booking_id,[\s\S]*?'Maintenance affects your booking'/i);
});

test('reminder claims use schedule-versioned 30-minute start and 10-minute active end windows', () => {
  assert.ok(claim, 'service-only claim RPC exists');
  assert.match(claim, /b\.status='confirmed' and b\.checked_in_at is null and b\.time_date>now\(\)/i);
  assert.match(claim, /b\.time_date<=now\(\)\+interval '30 minutes'/i);
  assert.match(claim, /b\.status='confirmed' and b\.checked_in_at is not null and b\.checked_out_at is null/i);
  assert.match(claim, /b\.end_at>now\(\) and b\.end_at<=now\(\)\+interval '10 minutes'/i);
  assert.match(claim, /w\.status='confirmed' and w\.checked_in_at is not null and w\.checked_out_at is null/i);
  assert.match(claim, /w\.end_at>now\(\) and w\.end_at<=now\(\)\+interval '10 minutes'/i);
  assert.match(migration, /primary key\(visit_type,visit_id,event_type,event_at\)/i);
  assert.match(claim, /r\.event_at=v\.starts_at[\s\S]*?r\.event_at=v\.end_at/i);
  assert.match(claim, /on conflict do nothing/i);
  assert.match(claim, /for update of r skip locked/i);
  assert.match(claim, /email_claim_token=gen_random_uuid\(\)/i);
  assert.match(migration, /refresh_customer_visit_reminder[\s\S]*?r\.event_at=p_event_at[\s\S]*?v\.time_date=p_event_at[\s\S]*?v\.end_at=p_event_at/i);
  assert.match(migration, /complete_customer_visit_reminder[\s\S]*?event_at=p_event_at[\s\S]*?email_claim_token=p_claim_token/i);
  assert.match(migration, /release_customer_visit_reminder[\s\S]*?event_at=p_event_at[\s\S]*?email_claim_token=p_claim_token/i);
  assert.match(migration, /claim_customer_booking_reminders\(\)[\s\S]*?begin\s+return;/i);
});

test('bounded SMTP batches and per-item lease renewal prevent overlapping slow sends', () => {
  const smtpTimeout = Number(smtpHelper.match(/timeoutMs = (\d+)/)?.[1]);
  const leaseMinutes = Number(forwardClaim.match(/email_claimed_at<now\(\)-interval '(\d+) minutes'/)?.[1]);
  for (const definition of [claim, forwardClaim]) {
    const batchSize = Number(definition.match(/limit (\d+)/i)?.[1]);
    assert.equal(batchSize, 5);
    assert.ok(batchSize * smtpTimeout < leaseMinutes * 60_000,
      'the worst-case serialized batch duration stays below the stale-claim lease');
  }
  assert.match(forwardRefresh, /set email_claimed_at=now\(\),email_snapshot=jsonb_build_object/i);
  assert.match(forwardRefresh, /r\.email_claim_token=p_claim_token/i);

  const sendDurations = Array.from({ length: 5 }, () => smtpTimeout);
  const lease = leaseMinutes * 60_000;
  let now = 0;
  const claimedAt = Array(5).fill(0);
  for (let index = 0; index < sendDurations.length; index++) {
    claimedAt[index] = now; // refresh_customer_visit_reminder renews ownership before each send
    assert.ok(now - claimedAt[index] < lease, 'the refreshed item remains owned while its SMTP send is in flight');
    now += sendDurations[index];
  }
  assert.ok(now < lease, 'a second minute-level cron invocation cannot reclaim the original batch mid-send');
  const reclaimableAtNextCron = claimedAt.filter((at) => 60_000 - at >= lease);
  assert.deepEqual(reclaimableAtNextCron, [], 'a minute-level overlapping cron cannot reclaim this batch');
});

test('scheduled invocation uses a validated per-environment Vault endpoint', () => {
  const originalInvoke = baseMigration.match(/create or replace function internal\.invoke_customer_booking_reminder_worker\([\s\S]*?\$\$;/i)?.[0] || '';
  assert.ok(forwardInvoke);
  for (const definition of [originalInvoke, forwardInvoke]) {
    assert.match(definition, /v\.name='customer_booking_reminder_function_url'/);
    assert.match(definition, /function_url is null[\s\S]*?function_url !~\*/i);
    assert.ok(definition.includes("https://[a-z0-9-]+\\.supabase\\.co/functions/v1/customer-booking-reminders$"));
    assert.match(definition, /url := function_url/);
    assert.doesNotMatch(definition, /xrlwtnwamboucihsamrr/);
  }
});

test('reminder includes booking details and only renders a positive remaining balance', () => {
  assert.match(feed, /coalesce\(v\.sports,'Sport'\)\|\|' · '\|\|coalesce\(v\.courts,'Court'\)/i);
  assert.match(feed, /coalesce\(v\.amount_total,0\)>coalesce\(v\.amount_paid,0\)/i);
  assert.match(worker, /buildCustomerBookingReminderEmail/);
  assert.match(emailHelper, /Asia\/Manila/);
});

test('worker is secret-authenticated and configured for scheduled invocation', () => {
  assert.match(worker, /x-customer-booking-reminder-secret/);
  assert.match(worker, /verify_customer_booking_reminder_worker/);
  assert.match(worker, /CUSTOMER_BOOKING_SMTP_USERNAME/);
  assert.match(worker, /CUSTOMER_BOOKING_SMTP_APP_PASSWORD/);
  assert.match(worker, /CUSTOMER_BOOKING_REMINDER_FROM_EMAIL/);
  assert.match(worker, /CUSTOMER_BOOKING_DASHBOARD_URL/);
  assert.match(worker, /https:\/\/inigossportcenter\.com\/Pages\/user_dashboard\.html/);
  assert.match(worker, /parsed\.protocol !== "https:"/);
  assert.match(worker, /parsed\.hash = "bookings"/);
  assert.match(worker, /release_customer_visit_reminder/);
  assert.match(worker, /refresh_customer_visit_reminder/);
  assert.match(worker, /p_event_at: eventAt/);
  assert.match(worker, /p_event_type: eventType/);
  assert.match(worker, /const eventAt = reminder\?\.event_at/);
  assert.match(worker, /email: current\.email/);
  assert.match(worker, /if \(refreshError \|\| !current[\s\S]*?continue;/i);
  assert.match(config, /\[functions\.customer-booking-reminders\][\s\S]*?verify_jwt = false/i);
});

test('SMTP delivery uses authenticated implicit TLS and keeps the authorized reminder lifecycle', () => {
  const auth = worker.indexOf('if (authorizationError || authorized !== true)');
  const claimIndex = worker.indexOf('claim_customer_visit_reminders');
  const send = worker.indexOf('await deliverCustomerBookingReminder({');
  assert.ok(auth >= 0 && claimIndex > auth && send > claimIndex);
  assert.match(worker, /connectTls: \(\) => Deno\.connectTls\(\{ hostname: "smtp\.gmail\.com", port: 465 \}\)/);
  assert.match(smtpHelper, /AUTH PLAIN \$\{auth\}/);
  assert.match(smtpHelper, /MAIL FROM:<\$\{mime\.sender\}>/);
  assert.match(smtpHelper, /RCPT TO:<\$\{mime\.recipient\}>/);
  assert.match(smtpHelper, /DATA\\r\\n/);
  assert.match(smtpHelper, /timeoutMs = 15000/);
  assert.match(worker, /refresh_customer_visit_reminder/);
  assert.match(worker, /complete_customer_visit_reminder/);
  assert.match(worker, /release_customer_visit_reminder/);
  assert.match(worker, /SMTP offers no idempotency key/);
  assert.doesNotMatch(worker, /RESEND_API_KEY|api\.resend\.com|Idempotency-Key/);
  assert.doesNotMatch(worker, /console\.(?:log|error)\([^\n]*(?:smtpAppPassword|smtpUsername|current\.email)/i);
});

test('SMTP client preserves Gmail plus recipients in MIME and the SMTP envelope', async () => {
  const transcript = [
    '220 smtp ready\r\n',
    '250-smtp hello\r\n250 AUTH PLAIN\r\n',
    '235 authenticated\r\n',
    '250 sender ok\r\n',
    '251 recipient ok\r\n',
    '354 send data\r\n',
    '250 queued\r\n',
  ].join('');
  const writes = [];
  let closed = false;
  const connection = {
    async read(buffer) {
      if (!this.bytes) this.bytes = new TextEncoder().encode(transcript);
      if (!this.bytes.length) return null;
      const size = Math.min(buffer.length, this.bytes.length);
      buffer.set(this.bytes.subarray(0, size));
      this.bytes = this.bytes.subarray(size);
      return size;
    },
    async write(bytes) {
      writes.push(new TextDecoder().decode(bytes));
      return bytes.length;
    },
    close() { closed = true; },
  };
  const deliveryReceipt = await deliverCustomerBookingReminder({
    connectTls: async () => connection,
    smtpUsername: 'bookings@example.test', smtpAppPassword: 'test-app-password',
    from: 'InigoSync <bookings@example.test>', email: {
      to: ['customer+staff1@gmail.com'], subject: 'Booking reminder', text: 'Line one\n.Line two', html: '<p>Reminder</p>',
    },
  });
  assert.equal(closed, true);
  assert.equal(writes[0], 'EHLO inigosportcenter.com\r\n');
  assert.match(writes[1], /^AUTH PLAIN /);
  assert.match(writes[2], /^MAIL FROM:<bookings@example\.test>/);
  assert.match(writes[3], /^RCPT TO:<customer\+staff1@gmail\.com>/);
  assert.equal(writes[4], 'DATA\r\n');
  assert.match(writes[5], /multipart\/alternative/);
  assert.match(writes[5], /\r\nTo: customer\+staff1@gmail\.com\r\n/);
  assert.match(deliveryReceipt.messageId, /^<[^>]+@inigossportcenter\.com>$/);
  assert.ok(writes[5].includes(`Message-ID: ${deliveryReceipt.messageId}`));
  assert.doesNotMatch(writes[5], /\r\n\.Line two/);
  assert.match(writes[5], /\r\n\.\r\n$/);
  assert.equal(writes.some((write) => write.includes('test-app-password')), false);

  const rejected = { ...connection, async read(buffer) {
    const bytes = new TextEncoder().encode('220 ready\r\n250 hello\r\n535 rejected\r\n');
    const size = Math.min(buffer.length, bytes.length);
    buffer.set(bytes.subarray(0, size));
    this.read = async () => null;
    return size;
  } };
  await assert.rejects(deliverCustomerBookingReminder({
    connectTls: async () => rejected,
    smtpUsername: 'bookings@example.test', smtpAppPassword: 'fake-secret',
    from: 'bookings@example.test', email: { to: ['customer@example.test'], subject: 'x', text: 'x', html: '<p>x</p>' },
  }), (error) => error instanceof SmtpDeliveryError && error.reason === 'authentication_rejected');
});

test('SMTP protocol timeout closes the connection and returns a stable category', async () => {
  let closed = false;
  const connection = {
    async read() { return await new Promise(() => {}); },
    async write(bytes) { return bytes.length; },
    close() { closed = true; },
  };
  await assert.rejects(deliverCustomerBookingReminder({
    connectTls: async () => connection, timeoutMs: 10,
    smtpUsername: 'bookings@example.test', smtpAppPassword: 'fake-secret',
    from: 'bookings@example.test', email: { to: ['customer@example.test'], subject: 'x', text: 'x', html: '<p>x</p>' },
  }), (error) => error instanceof SmtpDeliveryError && error.reason === 'timeout');
  assert.equal(closed, true);
});

test('SMTP timeout after DATA terminator reports an ambiguous delivery outcome', async () => {
  const writes = [];
  const transcript = new TextEncoder().encode([
    '220 ready\r\n', '250 hello\r\n', '235 authenticated\r\n',
    '250 sender ok\r\n', '251 recipient ok\r\n', '354 send data\r\n',
  ].join(''));
  let transcriptOffset = 0;
  let closed = false;
  const connection = {
    async read(buffer) {
      if (transcriptOffset < transcript.length) {
        const size = Math.min(buffer.length, transcript.length - transcriptOffset);
        buffer.set(transcript.subarray(transcriptOffset, transcriptOffset + size));
        transcriptOffset += size;
        return size;
      }
      return await new Promise(() => {});
    },
    async write(bytes) { writes.push(new TextDecoder().decode(bytes)); return bytes.length; },
    close() { closed = true; },
  };
  await assert.rejects(deliverCustomerBookingReminder({
    connectTls: async () => connection, timeoutMs: 10,
    smtpUsername: 'bookings@example.test', smtpAppPassword: 'fake-secret',
    from: 'bookings@example.test', email: { to: ['customer@example.test'], subject: 'x', text: 'x', html: '<p>x</p>' },
  }), (error) => error instanceof SmtpDeliveryError && error.reason === 'delivery_outcome_unknown');
  assert.equal(writes.some((write) => write.endsWith('.\r\n')), true);
  assert.equal(closed, true);
});

test('SMTP final rejection after DATA is definitive and remains eligible for cleanup', async () => {
  const transcript = new TextEncoder().encode([
    '220 ready\r\n', '250 hello\r\n', '235 authenticated\r\n',
    '250 sender ok\r\n', '251 recipient ok\r\n', '354 send data\r\n',
    '550 message rejected\r\n',
  ].join(''));
  let transcriptOffset = 0;
  const connection = {
    async read(buffer) {
      const size = Math.min(buffer.length, transcript.length - transcriptOffset);
      if (!size) return null;
      buffer.set(transcript.subarray(transcriptOffset, transcriptOffset + size));
      transcriptOffset += size;
      return size;
    },
    async write(bytes) { return bytes.length; },
    close() {},
  };
  await assert.rejects(deliverCustomerBookingReminder({
    connectTls: async () => connection,
    smtpUsername: 'bookings@example.test', smtpAppPassword: 'fake-secret',
    from: 'bookings@example.test', email: { to: ['customer@example.test'], subject: 'x', text: 'x', html: '<p>x</p>' },
  }), (error) => error instanceof SmtpDeliveryError && error.reason === 'message_rejected');
});

test('SMTP partial message write followed by a write error is an ambiguous outcome', async () => {
  const transcript = new TextEncoder().encode([
    '220 ready\r\n', '250 hello\r\n', '235 authenticated\r\n',
    '250 sender ok\r\n', '251 recipient ok\r\n', '354 send data\r\n',
  ].join(''));
  let transcriptOffset = 0;
  let messageWriteCount = 0;
  let messageWriteStarted = false;
  const connection = {
    async read(buffer) {
      const size = Math.min(buffer.length, transcript.length - transcriptOffset);
      if (!size) return null;
      buffer.set(transcript.subarray(transcriptOffset, transcriptOffset + size));
      transcriptOffset += size;
      return size;
    },
    async write(bytes) {
      const value = new TextDecoder().decode(bytes);
      if (value.includes('multipart/alternative')) messageWriteStarted = true;
      if (messageWriteStarted) {
        messageWriteCount += 1;
        if (messageWriteCount === 1) return Math.max(1, Math.floor(bytes.length / 2));
        throw new Error('simulated socket failure after partial write');
      }
      return bytes.length;
    },
    close() {},
  };
  await assert.rejects(deliverCustomerBookingReminder({
    connectTls: async () => connection,
    smtpUsername: 'bookings@example.test', smtpAppPassword: 'fake-secret',
    from: 'bookings@example.test', email: { to: ['customer@example.test'], subject: 'x', text: 'x', html: '<p>x</p>' },
  }), (error) => error instanceof SmtpDeliveryError && error.reason === 'delivery_outcome_unknown');
  assert.equal(messageWriteCount, 2);
});

test('SMTP timeout racing a completed message write remains ambiguous', async () => {
  const transcript = new TextEncoder().encode([
    '220 ready\r\n', '250 hello\r\n', '235 authenticated\r\n',
    '250 sender ok\r\n', '251 recipient ok\r\n', '354 send data\r\n',
  ].join(''));
  let transcriptOffset = 0;
  let messageWriteCompleted = false;
  const connection = {
    async read(buffer) {
      const size = Math.min(buffer.length, transcript.length - transcriptOffset);
      if (!size) return await new Promise(() => {});
      buffer.set(transcript.subarray(transcriptOffset, transcriptOffset + size));
      transcriptOffset += size;
      return size;
    },
    async write(bytes) {
      const value = new TextDecoder().decode(bytes);
      if (value.includes('multipart/alternative')) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        messageWriteCompleted = true;
      }
      return bytes.length;
    },
    close() {},
  };
  await assert.rejects(deliverCustomerBookingReminder({
    connectTls: async () => connection, timeoutMs: 10,
    smtpUsername: 'bookings@example.test', smtpAppPassword: 'fake-secret',
    from: 'bookings@example.test', email: { to: ['customer@example.test'], subject: 'x', text: 'x', html: '<p>x</p>' },
  }), (error) => error instanceof SmtpDeliveryError && error.reason === 'delivery_outcome_unknown');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(messageWriteCompleted, true);
});

test('empty cron runs stay successful while reporting missing setting names only', () => {
  const emptyWork = worker.indexOf('if (!Array.isArray(due) || due.length === 0)');
  const missingWork = worker.indexOf('const missingSettings = missingCustomerBookingReminderSettings');
  assert.ok(emptyWork > missingWork);
  assert.match(worker, /return json\(\{ sent: 0, deferred: 0, missing_settings: missingSettings \}\);/);
  assert.match(worker, /if \(missingSettings\.length\)[\s\S]*?return json\(\{ message: "Email delivery is not configured\.", missing_settings: missingSettings \}, 503\)/);
  assert.deepEqual(missingCustomerBookingReminderSettings({ smtpUsername: '', smtpAppPassword: '', from: '', dashboardUrl: '' }), [
    'CUSTOMER_BOOKING_SMTP_USERNAME',
    'CUSTOMER_BOOKING_SMTP_APP_PASSWORD',
    'CUSTOMER_BOOKING_REMINDER_FROM_EMAIL (or SMTP username)',
    'CUSTOMER_BOOKING_DASHBOARD_URL (must be HTTPS)',
  ]);
  assert.deepEqual(missingCustomerBookingReminderSettings({ smtpUsername: 'sender', smtpAppPassword: 'secret', from: 'sender', dashboardUrl: 'https://example.test' }), []);
});

test('email content refreshes after rescheduling and uses current balance without provider idempotency', () => {
  const original = buildCustomerBookingReminderEmail({
    visitId: 52, visitType: 'booking', eventType: 'starting_soon',
    sport: 'Basketball', court: 'Court A', startsAt: '2026-10-28T04:00:00Z', endsAt: '2026-10-28T05:00:00Z',
    amountDue: 400, dashboardUrl: 'https://example.test/Pages/user_dashboard.html#bookings', email: 'old@example.test',
  });
  const refreshed = buildCustomerBookingReminderEmail({
    visitId: 52, visitType: 'booking', eventType: 'starting_soon',
    sport: 'Badminton', court: 'Court B', startsAt: '2026-10-28T07:00:00Z', endsAt: '2026-10-28T08:00:00Z',
    amountDue: 0, dashboardUrl: 'https://example.test/Pages/user_dashboard.html#bookings', email: 'current@example.test',
  });
  assert.notEqual(original.text, refreshed.text);
  assert.match(original.text, /Balance due at check-in:/);
  assert.match(original.text, /400\.00/);
  assert.doesNotMatch(refreshed.text, /Balance due at check-in/);
  assert.equal(Object.hasOwn(refreshed, 'idempotencyKey'), false);
  assert.deepEqual(refreshed.to, ['current@example.test']);
  assert.equal(parseReminderMailbox(refreshed.to[0]).address, 'current@example.test');
});

test('SMTP MIME is multipart, UTF-8 encoded, and rejects header or address injection', () => {
  const content = buildCustomerBookingReminderEmail({
    visitId: 7, visitType: 'walkin', eventType: 'ending_soon',
    sport: '<img src=x>', court: 'Court & One', startsAt: '2026-10-28T04:00:00Z', endsAt: '2026-10-28T05:00:00Z',
    amountDue: 400, dashboardUrl: 'https://example.test/dashboard#bookings', email: 'customer@example.test',
  });
  assert.match(content.html, /&lt;img src=x&gt;/);
  assert.match(content.html, /Court &amp; One/);
  assert.doesNotMatch(content.html, /Balance due at check-in/);
  const mime = buildCustomerBookingReminderMimeMessage({
    from: 'InigoSync <bookings@example.test>', to: content.to[0], subject: content.subject,
    text: content.text, html: content.html, messageId: '<booking.7@example.test>',
  });
  assert.equal(mime.sender, 'bookings@example.test');
  assert.equal(mime.recipient, 'customer@example.test');
  assert.match(mime.message, /Content-Type: multipart\/alternative;/);
  assert.match(mime.message, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(mime.message, /Content-Type: text\/html; charset="UTF-8"/);
  assert.match(mime.message, /=?UTF-8\?B\?SW5pZ29TeW5j\?= <bookings@example\.test>/);
  assert.equal(parseReminderMailbox('victim@example.test\r\nBcc: attacker@example.test'), null);
  assert.throws(() => buildCustomerBookingReminderMimeMessage({
    from: 'InigoSync\r\nBcc: attacker@example.test <bookings@example.test>',
    to: 'customer@example.test', subject: content.subject, text: content.text, html: content.html,
  }), /Invalid email address/);
  assert.throws(() => buildCustomerBookingReminderMimeMessage({
    from: 'bookings@example.test', to: 'customer@example.test\r\nBcc: attacker@example.test',
    subject: content.subject, text: content.text, html: content.html,
  }), /Invalid email address/);
});
