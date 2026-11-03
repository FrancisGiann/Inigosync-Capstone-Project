import { createClient } from 'npm:@supabase/supabase-js@2.95.0';
import { hasVerifiedEmailSession } from '../_shared/email-mfa.ts';
import { deliverSmtpEmail, SmtpDeliveryError } from '../_shared/customer-booking-reminder-smtp.mjs';

const ALLOWED_ORIGINS = new Set(['https://inigossportcenter.com', 'https://www.inigossportcenter.com', 'http://localhost:5500', 'http://127.0.0.1:5500', 'http://127.0.0.1:4178']);
const ITERATIONS = 600_000;
const PASSWORD_PATTERN = /^(?=.{8,15}$)(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])(?=.*[ !"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]).+$/s;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINKED_EMAIL_DOMAIN_SUGGESTIONS: Record<string, string> = {
  'gmail.co': 'gmail.com',
  'gmail.con': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gmial.com': 'gmail.com',
  'gmil.com': 'gmail.com',
};

function linkedEmailFormatError(email: string): string | null {
  if (!email || email.length > 254) return 'Enter a valid email address.';
  const at = email.lastIndexOf('@');
  if (at < 1 || at !== email.indexOf('@')) return 'Enter a valid email address.';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return 'Enter a valid email address.';
  const suggestion = LINKED_EMAIL_DOMAIN_SUGGESTIONS[domain];
  if (suggestion) return `Check the email domain. Did you mean ${suggestion}?`;
  const labels = domain.split('.');
  const validLabel = (label: string) => label.length <= 63 && /^[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?$/i.test(label);
  const finalLabel = labels.at(-1) || '';
  const validTopLevelLabel = /^[A-Z]{2,63}$/i.test(finalLabel)
    || /^xn--[A-Z0-9](?:[A-Z0-9-]{0,57}[A-Z0-9])?$/i.test(finalLabel);
  if (domain.length > 253 || labels.length < 2 || !labels.every(validLabel) || !validTopLevelLabel) {
    return 'Enter a valid email address.';
  }
  return null;
}

function headers(origin: string | null) {
  return { 'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://inigossportcenter.com',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' };
}
function json(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' } });
}
function hex(bytes: Uint8Array) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
function bytesFromHex(value: string) {
  const clean = value.startsWith('\\x') ? value.slice(2) : value;
  if (!/^(?:[0-9a-f]{2})+$/i.test(clean)) throw new Error('Credential unavailable.');
  return Uint8Array.from(clean.match(/.{2}/g) || [], part => Number.parseInt(part, 16));
}
function randomBytes(size: number) { const b = new Uint8Array(size); crypto.getRandomValues(b); return b; }
function randomCode() {
  const ceiling = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000; let n: number;
  do { n = new DataView(randomBytes(4).buffer).getUint32(0); } while (n >= ceiling);
  return String(n % 1_000_000).padStart(6, '0');
}
async function digest(name: string, value: string) {
  if (name === 'SHA-256') return hex(new Uint8Array(await crypto.subtle.digest(name, new TextEncoder().encode(value))));
  throw new Error('Unsupported digest.');
}
async function deriveHmacPepper(serviceRoleKey: string): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(serviceRoleKey), 'HKDF', false, ['deriveBits']);
  const salt = new TextEncoder().encode('InigoSync/server-secret-derivation/v1');
  const info = new TextEncoder().encode('owner-email-alias-auth/hmac-pepper/v1');
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, material, 256));
}
async function hmac(secret: Uint8Array, value: string) {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))));
}
async function hashPassword(password: string, salt: Uint8Array, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
function equalBytes(a: Uint8Array, b: Uint8Array) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }
function tokenSessionId(token: string): string | null {
  try { const p = token.split('.')[1]; if (!p) return null; const s = p.replace(/-/g, '+').replace(/_/g, '/'); const c = JSON.parse(atob(s.padEnd(Math.ceil(s.length / 4) * 4, '=')));
    return typeof c.session_id === 'string' && UUID.test(c.session_id) ? c.session_id : null; } catch { return null; }
}
function escapeHtml(s: string) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
function mailTemplate({ title, preheader, intro, code, detail }: { title: string; preheader: string; intro: string; code?: string; detail?: string }) {
  const codeHtml = code ? `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin:0 0 22px"><tr><td class="em-codebox" align="center" bgcolor="#F7F0E4" style="background-color:#F7F0E4;border:1px solid #E6D8C2;border-radius:14px;padding:22px 16px 24px"><div class="em-eyebrow" style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;font-weight:bold;letter-spacing:1.4px;text-transform:uppercase;color:#B93E08">Your verification code</div><div class="em-code" style="padding-top:8px;font-family:'Courier New',Courier,monospace;font-size:38px;line-height:48px;font-weight:bold;letter-spacing:10px;text-indent:10px;color:#1F1B16">${code}</div></td></tr></table>` : '';
  const detailHtml = detail ? `<p style="margin:12px 0 0;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:21px;color:#6B6055">${detail}</p>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style type="text/css">@media only screen and (max-width:620px){.em-shell{width:100%!important}.em-pad{padding-left:24px!important;padding-right:24px!important}.em-h1{font-size:24px!important;line-height:32px!important}.em-code{font-size:32px!important;letter-spacing:8px!important;text-indent:8px!important}}@media(prefers-color-scheme:dark){.em-page{background-color:#14110d!important}.em-card{background-color:#201a14!important}.em-hairline{border-color:#3a332b!important}.em-h1,.em-strong{color:#F4EFE6!important}.em-text,.em-muted{color:#C9C2B4!important}.em-eyebrow{color:#FF8A4C!important}.em-codebox{background-color:#191410!important;border-color:#3a332b!important}.em-code{color:#F4EFE6!important}}</style></head><body class="em-page" style="margin:0;padding:0;width:100%;background-color:#F7F0E4"><div style="display:none;font-size:1px;color:#F7F0E4;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${preheader}&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;</div><table role="presentation" class="em-page" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background-color:#F7F0E4"><tr><td align="center" style="padding:32px 12px"><table role="presentation" class="em-shell" border="0" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:600px;border-collapse:collapse"><tr><td align="center" bgcolor="#14110d" style="background-color:#14110d;border-radius:16px 16px 0 0;padding:28px 24px 24px"><span style="display:block;font-family:'Arial Narrow',Arial,Helvetica,sans-serif;font-size:27px;line-height:32px;font-weight:bold;letter-spacing:.4px;color:#F4EFE6">I&ntilde;igo<span style="color:#FF6115">Sync</span></span><span style="display:block;padding-top:6px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;letter-spacing:1.2px;text-transform:uppercase;color:#C9C2B4">I&ntilde;igos Sports Center &middot; Lucena City</span></td></tr><tr><td bgcolor="#FF6115" style="background-color:#FF6115;font-size:0;line-height:0;height:4px">&nbsp;</td></tr><tr><td class="em-card em-pad" align="left" bgcolor="#FFFFFF" style="background-color:#FFFFFF;border-radius:0 0 16px 16px;padding:36px 40px 32px"><h1 class="em-h1" style="margin:0 0 16px;font-family:'Arial Narrow',Arial,Helvetica,sans-serif;font-size:28px;line-height:34px;font-weight:bold;letter-spacing:.2px;color:#1F1B16">${title}</h1><p class="em-text" style="margin:0 0 24px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:26px;color:#4A423A">${intro}</p>${codeHtml}${code ? '<p class="em-muted" style="margin:0 0 22px;font-family:\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:21px;color:#6B6055">This code can only be used once and expires in 5 minutes.</p>' : ''}<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse"><tr><td class="em-hairline" style="border-top:1px solid #E6D8C2;font-size:0;line-height:0;height:1px">&nbsp;</td></tr></table>${detailHtml}<p class="em-muted" style="margin:12px 0 0;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:21px;color:#6B6055">If you did not request this, you can ignore this message.</p></td></tr></table></td></tr></table></body></html>`;
  return { html, text: `${title}\n\n${intro}${code ? `\n\nYour code: ${code}\nExpires in 5 minutes.` : ''}${detail ? `\n\n${detail}` : ''}\n\nIf you did not request this, ignore this message.` };
}
async function sendMail(to: string, subject: string, content: ReturnType<typeof mailTemplate>) {
  const username = Deno.env.get('CUSTOMER_BOOKING_SMTP_USERNAME') || '';
  const password = Deno.env.get('CUSTOMER_BOOKING_SMTP_APP_PASSWORD') || '';
  const from = Deno.env.get('CUSTOMER_BOOKING_REMINDER_FROM_EMAIL') || username;
  if (!username || !password || !from) throw new Error('smtp_not_configured');
  const senderAddress = from.match(/<([^<>]+)>/)?.[1] || from;
  return deliverSmtpEmail({ connectTls: () => Deno.connectTls({ hostname: 'smtp.gmail.com', port: 465 }), smtpUsername: username, smtpAppPassword: password, from: `IñigoSync <${senderAddress}>`,
    email: { to: [to], subject, text: content.text, html: content.html } });
}
function deliveryFailure(error: unknown, origin: string | null, context: Record<string, unknown> = {}) {
  if (error instanceof SmtpDeliveryError && error.reason === 'delivery_outcome_unknown') return json({ ...context, sent: false, delivery_uncertain: true, message: 'Delivery is not confirmed. Check the inbox before retrying.' }, 200, origin);
  console.error('[owner-linked-auth] SMTP delivery failed', error instanceof SmtpDeliveryError ? error.reason : 'smtp_error');
  return json({ ...context, sent: false, delivery_failed: true, message: 'The message could not be sent. Wait a minute, then retry.' }, 200, origin);
}
function validId(v: unknown): v is string { return typeof v === 'string' && UUID.test(v); }
async function requireCaller(req: Request, admin: any) {
  const token = req.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]; if (!token) return null;
  const { data, error } = await admin.auth.getUser(token); if (error || !data?.user) return null;
  const sessionId = tokenSessionId(token); return sessionId ? { token, user: data.user, sessionId } : null;
}
async function isActiveOwner(admin: any, userId: string) {
  const { data, error } = await admin.from('profiles').select('id,role,status,email').eq('id', userId).maybeSingle();
  return !error && data?.role === 'admin' && data.status === 'active' ? data : null;
}
async function allowCodeIssue(admin: any, pepper: Uint8Array, req: Request, email: string) {
  const ip = req.headers.get('cf-connecting-ip');
  if (!ip || ip.length > 100) return { ok: false, unavailable: true };
  const [emailKey, ipKey] = await Promise.all([hmac(pepper, `email:${email}`), hmac(pepper, `ip:${ip}`)]);
  const { data, error } = await admin.rpc('owner_email_login_rate_limit', { p_email_hash: `\\x${emailKey}`, p_ip_hash: `\\x${ipKey}` });
  return error ? { ok: false, unavailable: true } : { ok: data === true, emailKey };
}
async function sendAliasNotice(admin: any, ownerId: string, aliasId: string, origin: string | null) {
  const { data, error } = await admin.rpc('owner_email_begin_link_notice', { p_user_id: ownerId, p_alias_id: aliasId });
  const n = Array.isArray(data) ? data[0] : null;
  if (error || !n?.email) return { success: false, delivery_status: 'failed', message: 'The linked-email notice could not be prepared.' };
  if (n.should_send !== true) return { success: n.delivery_status === 'sent', sent: n.delivery_status === 'sent', delivery_status: n.delivery_status,
    message: n.delivery_status === 'sent' ? 'The linked-email notice was already sent.' : 'A recent delivery attempt is still being processed. Check the inbox before retrying.' };
  try {
    await sendMail(n.email, 'An email account was linked to your IñigoSync owner account', mailTemplate({ title: 'Email account linked', preheader: 'An email address was linked to your IñigoSync owner account.',
      intro: `The email address <strong class="em-strong" style="color:#1F1B16">${escapeHtml(n.email)}</strong> was linked to your I&ntilde;igoSync owner account.`,
      detail: 'You can set a separate sign-in password for this email from Owner Account Settings. This message contains no password.' }));
    await admin.rpc('owner_email_finish_link_notice', { p_user_id: ownerId, p_alias_id: aliasId, p_delivery_status: 'sent' });
    return { success: true, sent: true, delivery_status: 'sent' };
  } catch (e) {
    const status = e instanceof SmtpDeliveryError && e.reason === 'delivery_outcome_unknown' ? 'uncertain' : 'failed';
    await admin.rpc('owner_email_finish_link_notice', { p_user_id: ownerId, p_alias_id: aliasId, p_delivery_status: status });
    if (status === 'uncertain') return { success: false, sent: false, delivery_uncertain: true, delivery_status: status, delivery_retry: true, message: 'Delivery is not confirmed. Check the inbox before retrying.' };
    console.error('[owner-linked-auth] link notice delivery failed', e instanceof SmtpDeliveryError ? e.reason : 'smtp_error');
    return { success: false, sent: false, delivery_failed: true, delivery_status: status, delivery_retry: true, message: 'The notice could not be sent. Wait a minute, then retry.' };
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: headers(origin) });
  if (req.method !== 'POST') return json({ message: 'Method not allowed.' }, 405, origin);
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ message: 'Request origin is not allowed.' }, 403, origin);
  const url = Deno.env.get('SUPABASE_URL'); const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return json({ message: 'Linked email sign-in is not configured.' }, 503, origin);
  let pepper: Uint8Array;
  try { pepper = await deriveHmacPepper(key); }
  catch { return json({ message: 'Linked email sign-in is not configured.' }, 503, origin); }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  let body: Record<string, unknown>;
  try { const b = await req.json(); if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error(); body = b as Record<string, unknown>; }
  catch { return json({ message: 'Invalid linked email request.' }, 400, origin); }
  const action = body.action;

  if (action === 'login') {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''; const password = typeof body.password === 'string' ? body.password : '';
    if (!EMAIL.test(email) || email.length > 254 || password.length > 128) return json({ message: 'Email or password was not accepted.' }, 401, origin);
    const ip = req.headers.get('cf-connecting-ip'); if (!ip || ip.length > 100) return json({ message: 'Linked email sign-in is temporarily unavailable.' }, 503, origin);
    const [ek, ik] = await Promise.all([hmac(pepper, `email:${email}`), hmac(pepper, `ip:${ip}`)]);
    const { data: allowed, error: rateError } = await admin.rpc('owner_email_login_rate_limit', { p_email_hash: `\\x${ek}`, p_ip_hash: `\\x${ik}` });
    if (rateError) { console.error('[owner-linked-auth] rate limiter unavailable'); return json({ message: 'Linked email sign-in is temporarily unavailable.' }, 503, origin); }
    if (allowed !== true) return json({ message: 'Too many sign-in attempts. Wait 15 minutes and try again.' }, 429, origin);
    const { data: rows, error } = await admin.rpc('owner_email_get_credential', { p_email: email }); const c = Array.isArray(rows) ? rows[0] : null;
    let matches = false;
    try { const salt = c?.password_salt ? bytesFromHex(c.password_salt) : randomBytes(16); const rounds = Math.min(Math.max(Number(c?.password_iterations) || ITERATIONS, ITERATIONS), 1_000_000);
      const derived = await hashPassword(password, salt, rounds); if (c?.password_hash) matches = equalBytes(derived, bytesFromHex(c.password_hash)); } catch { matches = false; }
    if (error || !c || !matches || !validId(c.alias_id) || !validId(c.user_id)) return json({ message: 'Email or password was not accepted.' }, 401, origin);
    const [{ data: owner, error: userError }, profile] = await Promise.all([admin.auth.admin.getUserById(c.user_id), isActiveOwner(admin, c.user_id)]);
    const canonical = owner?.user?.email?.trim().toLowerCase();
    if (userError || !profile || !owner?.user?.email_confirmed_at || !canonical || String(c.email).toLowerCase() !== email) return json({ message: 'Email or password was not accepted.' }, 401, origin);
    const { error: clearError } = await admin.rpc('owner_email_reset_login_limit', { p_email_hash: `\\x${ek}` });
    if (clearError) return json({ message: 'Linked email sign-in is temporarily unavailable.' }, 503, origin);
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email: canonical }); const tokenHash = link?.properties?.hashed_token;
    if (linkError || !tokenHash) { console.error('[owner-linked-auth] broker session issuance failed'); return json({ message: 'Linked email sign-in is temporarily unavailable.' }, 503, origin); }
    const ticket = hex(randomBytes(32)); const ticketHash = await digest('SHA-256', ticket);
    const { data: stored, error: ticketError } = await admin.rpc('owner_email_create_ticket', { p_ticket_hash: `\\x${ticketHash}`, p_user_id: c.user_id, p_alias_id: c.alias_id, p_version: c.credential_version, p_expires_at: new Date(Date.now() + 90_000).toISOString() });
    if (ticketError || stored !== true) return json({ message: 'Linked email sign-in is temporarily unavailable.' }, 503, origin);
    return json({ token_hash: tokenHash, broker_ticket: ticket, linked_email: email, owner_id: c.user_id }, 200, origin);
  }

  const caller = await requireCaller(req, admin); if (!caller) return json({ message: 'Sign in again to continue.' }, 401, origin);
  if (!await isActiveOwner(admin, caller.user.id)) return json({ message: 'This owner account is not active.' }, 403, origin);
  const verified = await hasVerifiedEmailSession(admin, caller.token, caller.user.id);
  const aliasId = validId(body.alias_id) ? body.alias_id : '';

  if (action === 'list-aliases') {
    if (!verified) return json({ message: 'Complete account verification before viewing linked email settings.' }, 403, origin);
    const { data, error } = await admin.rpc('owner_email_list_aliases', { p_user_id: caller.user.id });
    if (error) return json({ message: 'Linked email settings are temporarily unavailable.' }, 503, origin);
    return json({ aliases: data || [] }, 200, origin);
  }
  if (action === 'check-email-availability') {
    if (!verified) return json({ message: 'Complete account verification before checking linked email availability.' }, 403, origin);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const formatError = linkedEmailFormatError(email);
    if (formatError) return json({ message: formatError }, 400, origin);
    const { data, error } = await admin.rpc('owner_email_check_availability', {
      p_user_id: caller.user.id, p_session_id: caller.sessionId, p_email: email,
    });
    if (error || typeof data !== 'boolean') return json({ message: 'Email availability is temporarily unavailable.' }, 503, origin);
    return json({ available: data }, 200, origin);
  }
  if (action === 'begin-add-email') {
    if (!verified) return json({ message: 'Complete account verification before adding a linked email.' }, 403, origin);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const formatError = linkedEmailFormatError(email);
    if (formatError) return json({ message: formatError }, 400, origin);
    const issueLimit = await allowCodeIssue(admin, pepper, req, email);
    if (issueLimit.unavailable) return json({ message: 'Email verification is temporarily unavailable.' }, 503, origin);
    if (!issueLimit.ok) return json({ message: 'Too many verification messages were requested. Wait 15 minutes and try again.' }, 429, origin);
    const id = crypto.randomUUID(); const challenge = crypto.randomUUID(); const code = randomCode();
    const hash = await hmac(pepper, `alias:${caller.user.id}:${caller.sessionId}:${id}:${challenge}:${code}`);
    const { data: started, error } = await admin.rpc('owner_email_begin_alias_verification', { p_user_id: caller.user.id, p_session_id: caller.sessionId, p_alias_id: id, p_email: email, p_challenge_id: challenge, p_code_hash: `\\x${hash}`, p_expires_at: new Date(Date.now() + 5 * 60_000).toISOString() });
    if (error || started !== true) return json({ message: 'That email cannot be linked. Check that it is not already in use and try again.' }, 409, origin);
    try { await sendMail(email, 'Verify an email for your IñigoSync owner account', mailTemplate({ title: 'Verify this email address', preheader: 'Enter this code to link this email to your owner account. It expires in 5 minutes.', intro: `Enter this code in Owner Account Settings to link <strong class="em-strong" style="color:#1F1B16">${escapeHtml(email)}</strong>.`, code, detail: 'This code proves access to the email address. It does not set a password.' }));
      return json({ alias_id: id, challenge_id: challenge, email, sent: true }, 200, origin);
    } catch (e) { return deliveryFailure(e, origin, { alias_id: id, challenge_id: challenge, email }); }
  }
  if (action === 'verify-alias-code') {
    if (!verified) return json({ message: 'Complete account verification before linking this email.' }, 403, origin);
    const challenge = validId(body.challenge_id) ? body.challenge_id : ''; const code = typeof body.code === 'string' ? body.code.replace(/\s/g, '') : '';
    if (!aliasId || !challenge || !/^\d{6}$/.test(code)) return json({ message: 'Enter the 6-digit code sent to the new email.' }, 400, origin);
    const codeHash = await hmac(pepper, `alias:${caller.user.id}:${caller.sessionId}:${aliasId}:${challenge}:${code}`);
    const { data, error } = await admin.rpc('owner_email_verify_alias_code', { p_user_id: caller.user.id, p_session_id: caller.sessionId, p_alias_id: aliasId, p_challenge_id: challenge, p_code_hash: `\\x${codeHash}` });
    if (error || data !== true) return json({ message: 'That code did not match or has expired. Check it and try again.' }, 400, origin);
    const notice = await sendAliasNotice(admin, caller.user.id, aliasId, origin);
    return json({ linked: true, ...notice }, 200, origin);
  }
  if (action === 'begin-password-setup') {
    if (!verified || !aliasId) return json({ message: 'Complete account verification before setting a linked email password.' }, 403, origin);
    const { data: credentials, error: credentialError } = await admin.rpc('owner_email_get_alias_credential', {
      p_user_id: caller.user.id, p_alias_id: aliasId,
    });
    const credential = Array.isArray(credentials) ? credentials[0] : null;
    const credentialVersion = Number(credential?.credential_version);
    if (credentialError || !credential || credential.alias_id !== aliasId || credential.user_id !== caller.user.id
      || !Number.isSafeInteger(credentialVersion) || credentialVersion < 1 || typeof credential.email !== 'string') {
      return json({ message: 'Could not start password setup. Try again.' }, 409, origin);
    }
    const hasPassword = typeof credential.password_hash === 'string';
    let currentPasswordEmailKey = '';
    if (hasPassword) {
      const currentPassword = typeof body.current_password === 'string' ? body.current_password : '';
      if (!currentPassword || currentPassword.length > 128) return json({ message: 'Current password is incorrect.' }, 401, origin);
      const ip = req.headers.get('cf-connecting-ip');
      if (!ip || ip.length > 100) return json({ message: 'Password verification is temporarily unavailable.' }, 503, origin);
      const email = credential.email.trim().toLowerCase();
      const [emailKey, ipKey] = await Promise.all([hmac(pepper, `email:${email}`), hmac(pepper, `ip:${ip}`)]);
      const { data: allowed, error: rateError } = await admin.rpc('owner_email_login_rate_limit', { p_email_hash: `\\x${emailKey}`, p_ip_hash: `\\x${ipKey}` });
      if (rateError) return json({ message: 'Password verification is temporarily unavailable.' }, 503, origin);
      if (allowed !== true) return json({ message: 'Too many password attempts. Wait 15 minutes and try again.' }, 429, origin);
      let matches = false;
      try {
        const salt = credential?.password_salt ? bytesFromHex(credential.password_salt) : randomBytes(16);
        const rounds = Math.min(Math.max(Number(credential?.password_iterations) || ITERATIONS, ITERATIONS), 1_000_000);
        const derived = await hashPassword(currentPassword, salt, rounds);
        if (credential?.password_hash) matches = equalBytes(derived, bytesFromHex(credential.password_hash));
      } catch { matches = false; }
      if (!matches) return json({ message: 'Current password is incorrect.' }, 401, origin);
      currentPasswordEmailKey = emailKey;
    } else if (credential.password_hash !== null || credential.password_salt !== null || credential.password_iterations !== null) {
      return json({ message: 'Could not start password setup. Try again.' }, 409, origin);
    }
    const challenge = crypto.randomUUID();
    const { data, error } = await admin.rpc('owner_email_begin_password_challenge', {
      p_user_id: caller.user.id, p_session_id: caller.sessionId, p_alias_id: aliasId,
      p_challenge_id: challenge, p_code_hash: null, p_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      p_credential_version: credentialVersion, p_password_change: hasPassword,
    });
    if (error || data !== true) return json({ message: 'Could not start password setup. Try again.' }, 409, origin);
    if (currentPasswordEmailKey) {
      const { error: resetError } = await admin.rpc('owner_email_reset_login_limit', { p_email_hash: `\\x${currentPasswordEmailKey}` });
      if (resetError) return json({ message: 'Password verification is temporarily unavailable.' }, 503, origin);
    }
    return json({ challenge_id: challenge, ready: true }, 200, origin);
  }
  if (action === 'save-password') {
    if (!verified || !aliasId || !validId(body.challenge_id)) return json({ message: 'Complete password setup verification before saving this password.' }, 403, origin);
    const password = typeof body.password === 'string' ? body.password : ''; if (!PASSWORD_PATTERN.test(password)) return json({ message: 'Use a password that meets every listed requirement.' }, 400, origin);
    const { data: credentials, error: credentialError } = await admin.rpc('owner_email_get_alias_credential', {
      p_user_id: caller.user.id, p_alias_id: aliasId,
    });
    const credential = Array.isArray(credentials) ? credentials[0] : null;
    const credentialVersion = Number(credential?.credential_version);
    if (credentialError || !credential || credential.alias_id !== aliasId || credential.user_id !== caller.user.id
      || !Number.isSafeInteger(credentialVersion) || credentialVersion < 1) {
      return json({ message: 'Password setup verification expired. Reopen Set password and try again.' }, 400, origin);
    }
    const salt = randomBytes(16); const hash = await hashPassword(password, salt);
    const { data, error } = await admin.rpc('owner_email_save_password', {
      p_user_id: caller.user.id, p_session_id: caller.sessionId, p_alias_id: aliasId,
      p_challenge_id: body.challenge_id, p_salt: `\\x${hex(salt)}`, p_hash: `\\x${hex(hash)}`,
      p_iterations: ITERATIONS, p_credential_version: credentialVersion,
    });
    if (error || data !== true) return json({ message: 'Password setup verification expired. Reopen Set password and try again.' }, 400, origin);
    return json({ success: true }, 200, origin);
  }
  if (action === 'remove-alias') {
    if (!verified || !aliasId) return json({ message: 'Complete account verification before removing a linked email.' }, 403, origin);
    const { data, error } = await admin.rpc('owner_email_remove_alias', { p_user_id: caller.user.id, p_session_id: caller.sessionId, p_alias_id: aliasId });
    if (error || data !== true) return json({ message: 'That linked email could not be removed.' }, 409, origin);
    return json({ success: true }, 200, origin);
  }
  if (action === 'send-link-notice') {
    if (!verified || !aliasId) return json({ message: 'Complete account verification before sending linked email notices.' }, 403, origin);
    return json(await sendAliasNotice(admin, caller.user.id, aliasId, origin), 200, origin);
  }
  if (action === 'begin-login-code' || action === 'resend-login-code') {
    const ticket = action === 'begin-login-code' && typeof body.broker_ticket === 'string' && /^[0-9a-f]{64}$/i.test(body.broker_ticket) ? await digest('SHA-256', body.broker_ticket) : hex(new Uint8Array(32));
    const challenge = crypto.randomUUID(); const code = randomCode();
    const hash = await hmac(pepper, `login:${caller.user.id}:${caller.sessionId}:${challenge}:${code}`);
    const { data: rows, error } = await admin.rpc('owner_email_begin_login_challenge', { p_user_id: caller.user.id, p_session_id: caller.sessionId, p_ticket_hash: `\\x${ticket}`, p_challenge_id: challenge, p_code_hash: `\\x${hash}`, p_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), p_force: action === 'resend-login-code' });
    const c = Array.isArray(rows) ? rows[0] : null;
    if (error || !c?.email || !c.challenge_id) return json({ message: 'Linked email sign-in was not accepted. Start again.' }, 401, origin);
    if (c.sent !== true) return json({ challenge_id: c.challenge_id, email: c.email, sent: false }, 200, origin);
    try { await sendMail(c.email, 'Your IñigoSync sign-in code', mailTemplate({ title: 'Finish signing in', preheader: 'Enter this one-time code to finish signing in.', intro: 'Enter this one-time code to finish signing in to your I&ntilde;igoSync owner account.', code }));
      return json({ challenge_id: c.challenge_id, email: c.email, sent: true }, 200, origin);
    } catch (e) { return deliveryFailure(e, origin, { challenge_id: c.challenge_id, email: c.email }); }
  }
  if (action === 'verify-login-code') {
    const challenge = validId(body.challenge_id) ? body.challenge_id : ''; const code = typeof body.code === 'string' ? body.code.replace(/\s/g, '') : '';
    if (!challenge || !/^\d{6}$/.test(code)) return json({ message: 'Enter the 6-digit code sent to the linked email.' }, 400, origin);
    const hash = await hmac(pepper, `login:${caller.user.id}:${caller.sessionId}:${challenge}:${code}`);
    const { data, error } = await admin.rpc('owner_email_verify_login_code', { p_user_id: caller.user.id, p_session_id: caller.sessionId, p_challenge_id: challenge, p_code_hash: `\\x${hash}` });
    if (error || data !== true) return json({ message: 'That code did not match or has expired. Check the linked email and try again.' }, 400, origin);
    return json({ verified: true }, 200, origin);
  }
  return json({ message: 'Invalid linked email request.' }, 400, origin);
});
