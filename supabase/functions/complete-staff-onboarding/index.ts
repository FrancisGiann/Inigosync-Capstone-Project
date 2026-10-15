import { createClient } from 'npm:@supabase/supabase-js@2.95.0';
import { hasVerifiedEmailSession } from '../_shared/email-mfa.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const PASSWORD_SPECIAL_PATTERN = /[ !"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
    && value >= '1900-01-01'
    && value <= new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const token = req.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!url || !serviceKey || !anonKey) return json({ error: 'Staff setup is temporarily unavailable.' }, 503);
  if (!token) return json({ error: 'Sign in to continue.' }, 401);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json({ error: 'Your session expired. Sign in again.' }, 401);
  if (!await hasVerifiedEmailSession(admin, token, authData.user.id)) return json({ error: 'Complete email verification before staff setup.' }, 403);

  let payload: Record<string, unknown>;
  try {
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    payload = body as Record<string, unknown>;
  } catch { return json({ error: 'Invalid staff setup request.' }, 400); }

  const fullName = typeof payload.full_name === 'string' ? payload.full_name.trim().replace(/\s+/g, ' ') : '';
  const password = typeof payload.password === 'string' ? payload.password : '';
  const birthdate = payload.birthdate;
  const address = typeof payload.address === 'string' ? payload.address.trim() : '';
  const gender = typeof payload.gender === 'string' ? payload.gender : '';
  const emergencyName = typeof payload.emergency_contact_name === 'string' ? payload.emergency_contact_name.trim() : '';
  if (!fullName || fullName.length > 120 || !isValidDate(birthdate)) return json({ error: 'Enter your full name and a valid birthdate.' }, 400);
  if (address.length > 250 || emergencyName.length > 120) return json({ error: 'One of the personal information fields is too long.' }, 400);
  if (gender && !['Male', 'Female', 'Prefer not to say'].includes(gender)) return json({ error: 'Choose a valid gender option.' }, 400);
  if (password.length < 8 || password.length > 15 || !/[A-Z]/.test(password) || !/[a-z]/.test(password)
    || !/[0-9]/.test(password) || !PASSWORD_SPECIAL_PATTERN.test(password)) {
    return json({ error: 'Your new password must meet every listed requirement.' }, 400);
  }

  const userId = authData.user.id;
  const { data: profile, error: profileError } = await admin.from('profiles')
    .select('role,status,onboarding_complete,email').eq('id', userId).maybeSingle();
  if (profileError || !profile || profile.role !== 'staff' || profile.status !== 'pending' || profile.onboarding_complete !== false) {
    return json({ error: 'This staff account does not need first-time setup.' }, 409);
  }

  // Verify the selected password against Auth, then compare its digest with
  // the server-stored random starter-password digest. Passwords never enter
  // logs, and a client cannot mark setup complete using the temporary one.
  const credentials = await admin.from('staff_onboarding_credentials')
    .select('temporary_password_hash').eq('user_id', userId).maybeSingle();
  if (credentials.error || !credentials.data?.temporary_password_hash) return json({ error: 'Staff setup is temporarily unavailable.' }, 503);
  const passwordHash = await sha256Hex(password);
  if (passwordHash === credentials.data.temporary_password_hash) return json({ error: 'Choose a new password before continuing.' }, 400);
  const passwordAuth = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: passwordLogin, error: passwordError } = await passwordAuth.auth.signInWithPassword({ email: profile.email, password });
  if (passwordError || passwordLogin.user?.id !== userId) return json({ error: 'Save your new password before completing setup.' }, 400);

  const { data: completedProfile, error: updateError } = await admin.from('profiles').update({
    full_name: fullName,
    address: address || null,
    birthdate,
    gender: gender || null,
    emergency_contact_name: emergencyName || null,
    status: 'active',
    onboarding_complete: true,
  }).eq('id', userId).eq('status', 'pending').eq('onboarding_complete', false)
    .select('id').maybeSingle();
  if (updateError) return json({ error: 'Your details could not be saved. Please try again.' }, 500);
  if (!completedProfile) return json({ error: 'This account is no longer pending setup. Contact the system administrator.' }, 409);

  // Clear the private temporary-password proof only after the conditional
  // pending-to-active transition is confirmed. If an owner disabled the
  // account concurrently, the update returns no row and leaves this untouched.
  await admin.from('staff_onboarding_credentials').delete().eq('user_id', userId);
  return json({ success: true });
});
