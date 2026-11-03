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
  const todayInManila = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const adultBirthdateCutoff = `${Number(todayInManila.slice(0, 4)) - 18}${todayInManila.slice(4)}`;
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
    && value >= '1900-01-01'
    && value <= adultBirthdateCutoff;
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

  const firstName = typeof payload.first_name === 'string' ? payload.first_name.trim().replace(/\s+/g, ' ') : '';
  const middleName = typeof payload.middle_name === 'string' ? payload.middle_name.trim().replace(/\s+/g, ' ') : '';
  const lastName = typeof payload.last_name === 'string' ? payload.last_name.trim().replace(/\s+/g, ' ') : '';
  const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ');
  const password = typeof payload.password === 'string' ? payload.password : '';
  const birthdate = payload.birthdate;
  const address = typeof payload.address === 'string' ? payload.address.trim() : '';
  const gender = typeof payload.gender === 'string' ? payload.gender : '';
  const civilStatus = typeof payload.civil_status === 'string' ? payload.civil_status : '';
  const contactNum = typeof payload.contact_num === 'string' ? payload.contact_num.trim() : '';
  const emergencyName = typeof payload.emergency_contact_name === 'string' ? payload.emergency_contact_name.trim() : '';
  const emergencyNumber = typeof payload.emergency_contact_number === 'string' ? payload.emergency_contact_number.trim() : '';
  if (!firstName || !lastName || firstName.length > 80 || middleName.length > 80 || lastName.length > 80
    || fullName.length > 120 || !isValidDate(birthdate)) return json({ error: 'Enter your first and last name and a birthdate showing you are at least 18.' }, 400);
  if (!address || address.length > 250 || emergencyName.length > 120) return json({ error: 'Enter a valid address and check the length of your personal information.' }, 400);
  if (!['Male', 'Female', 'Prefer not to say'].includes(gender)) return json({ error: 'Choose a valid gender option.' }, 400);
  if (!['Single', 'Married', 'Separated', 'Widowed', 'Prefer not to say'].includes(civilStatus)) return json({ error: 'Choose a valid civil status.' }, 400);
  if (contactNum && !/^\+639\d{9}$/.test(contactNum)) return json({ error: 'Validate a valid Philippine mobile number before finishing setup.' }, 400);
  if (emergencyNumber && !/^\+639\d{9}$/.test(emergencyNumber)) return json({ error: 'Enter a valid Philippine emergency contact mobile number.' }, 400);
  if (payload.privacy_policy_accepted !== true) return json({ error: 'Read and agree to the Privacy Policy before finishing setup.' }, 400);
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
    .select('temporary_password_hash,recovery_lock_until').eq('user_id', userId).maybeSingle();
  if (credentials.error || !credentials.data?.temporary_password_hash) return json({ error: 'Staff setup is temporarily unavailable.' }, 503);
  if (credentials.data.recovery_lock_until && Date.parse(credentials.data.recovery_lock_until) > Date.now()) {
    return json({ error: 'An owner is correcting this account email. Wait a few minutes, then sign in again.' }, 409);
  }
  const passwordHash = await sha256Hex(password);
  if (passwordHash === credentials.data.temporary_password_hash) return json({ error: 'Choose a new password before continuing.' }, 400);
  const passwordAuth = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: passwordLogin, error: passwordError } = await passwordAuth.auth.signInWithPassword({ email: profile.email, password });
  if (passwordError || passwordLogin.user?.id !== userId) return json({ error: 'Save your new password before completing setup.' }, 400);

  const { data: completed, error: updateError } = await admin.rpc('complete_staff_onboarding_profile', {
    p_user_id: userId,
    p_full_name: fullName,
    p_first_name: firstName,
    p_middle_name: middleName || null,
    p_last_name: lastName,
    p_contact_num: contactNum || null,
    p_address: address || null,
    p_birthdate: birthdate,
    p_gender: gender || null,
    p_emergency_contact_name: emergencyName || null,
    p_emergency_contact_number: emergencyNumber || null,
    p_civil_status: civilStatus,
  });
  if (updateError) {
    const { data: latestCredential } = await admin.from('staff_onboarding_credentials')
      .select('recovery_lock_until').eq('user_id', userId).maybeSingle();
    if (latestCredential?.recovery_lock_until && Date.parse(latestCredential.recovery_lock_until) > Date.now()) {
      return json({ error: 'An owner is correcting this account email. Wait a few minutes, then sign in again.' }, 409);
    }
    return json({ error: 'Your details could not be saved. Please try again.' }, 500);
  }
  if (completed !== true) return json({ error: 'This account is no longer pending setup. Contact the system administrator.' }, 409);

  // Clear the private temporary-password proof only after the conditional
  // pending-to-active transition is confirmed. If an owner disabled the
  // account concurrently, the update returns no row and leaves this untouched.
  await admin.from('staff_onboarding_credentials').delete().eq('user_id', userId);
  return json({ success: true });
});
