import { createClient } from 'npm:@supabase/supabase-js@2.95.0';
import { hasVerifiedEmailSession } from '../_shared/email-mfa.ts';
import { canInviteStaff } from './_shared/authorize-owner.ts';
import { generateTemporaryPassword, sha256Hex, validateStaffInvite } from './_shared/validate-staff.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

async function sendTemporaryPasswordEmail(input: { email: string; position: string; password: string; loginUrl: string; from: string; apiKey: string }) {
  const email = escapeHtml(input.email);
  const position = escapeHtml(input.position);
  const password = escapeHtml(input.password);
  const loginUrl = escapeHtml(input.loginUrl);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: input.from,
      to: [input.email],
      subject: 'Your InigoSync staff account',
      text: `Your ${input.position} staff account is ready.\n\nLogin: ${input.loginUrl}\nEmail: ${input.email}\nTemporary password: ${input.password}\n\nAfter signing in and completing email verification, change this password and complete your personal information before using the staff dashboard.`,
      html: `<p>Your <strong>${position}</strong> staff account is ready.</p><p><a href="${loginUrl}">Sign in to InigoSync</a></p><p>Email: <strong>${email}</strong><br>Temporary password: <strong>${password}</strong></p><p>After signing in and completing email verification, change this password and complete your personal information before using the staff dashboard.</p>`,
    }),
  });
  if (!response.ok) throw new Error('Email delivery failed.');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const resendKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('STAFF_ONBOARDING_FROM_EMAIL');
  const loginUrl = Deno.env.get('STAFF_ONBOARDING_LOGIN_URL');
  if (!url || !serviceKey || !anonKey || !resendKey || !from || !loginUrl) {
    return json({ error: 'Staff account email delivery is not configured. Contact the system administrator.' }, 503);
  }
  try { if (new URL(loginUrl).protocol !== 'https:') throw new Error('invalid'); }
  catch { return json({ error: 'Staff account email delivery is not configured. Contact the system administrator.' }, 503); }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const token = req.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json({ error: 'Not authenticated.' }, 401);
  const { data: { user }, error: authError } = await admin.auth.getUser(token);
  if (authError || !user) return json({ error: 'Not authenticated.' }, 401);
  if (!await hasVerifiedEmailSession(admin, token, user.id)) return json({ error: 'Verify your email before managing staff accounts.' }, 403);
  const { data: caller, error: callerError } = await admin.from('profiles').select('role,status').eq('id', user.id).single();
  if (callerError || !canInviteStaff(caller)) return json({ error: 'Only an active owner can create staff accounts.' }, 403);

  let details: { email: string; position: string };
  try {
    const body = await req.text();
    if (!body || body.length > 4096) throw new Error('Invalid request.');
    details = validateStaffInvite(JSON.parse(body));
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Invalid request.' }, 400); }

  // Profile lookup gives a clear response for normal existing accounts. The
  // Auth create call below remains the final atomic duplicate check, including
  // accounts that have no profile row; its error path never modifies a user.
  const { data: existingProfile, error: lookupError } = await admin.from('profiles').select('id').ilike('email', details.email).maybeSingle();
  if (lookupError) return json({ error: 'Could not verify whether this email already has an account.' }, 500);
  if (existingProfile) return json({ error: 'An account already uses this email. It was left unchanged.' }, 409);

  const temporaryPassword = generateTemporaryPassword();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: details.email,
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: {},
  });
  if (createError || !created.user) {
    if (/already|registered|exists/i.test(createError?.message || '')) return json({ error: 'An account already uses this email. It was left unchanged.' }, 409);
    return json({ error: 'Could not create the staff account. Please try again.' }, 400);
  }

  const userId = created.user.id;
  try {
    const { data: saved, error: profileError } = await admin.from('profiles').update({
      role: 'staff', position: details.position, status: 'pending', onboarding_complete: false, full_name: '',
    }).eq('id', userId).select('id').single();
    if (profileError || !saved) throw new Error('profile');

    const { error: credentialError } = await admin.from('staff_onboarding_credentials').insert({
      user_id: userId,
      temporary_password_hash: await sha256Hex(temporaryPassword),
    });
    if (credentialError) throw new Error('credential');

    await sendTemporaryPasswordEmail({ email: details.email, position: details.position, password: temporaryPassword, loginUrl, from, apiKey: resendKey });
    return json({ success: true, email: details.email });
  } catch (_) {
    // Remove only the fresh Auth user returned by createUser. Deleting it
    // cascades the profile and private credential row; existing accounts
    // cannot reach this compensation path.
    const { error: cleanupError } = await admin.auth.admin.deleteUser(userId);
    if (cleanupError) return json({ error: 'The new account could not be rolled back after setup failed. No staff access was granted; contact the system administrator.' }, 500);
    return json({ error: 'Staff email delivery or setup failed. The new account was removed; verify the mail configuration and try again.' }, 502);
  }
});
