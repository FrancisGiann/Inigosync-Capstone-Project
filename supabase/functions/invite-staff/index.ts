import { createClient } from 'npm:@supabase/supabase-js@2.95.0';
import { hasVerifiedEmailSession } from '../_shared/email-mfa.ts';
import { canInviteStaff } from './_shared/authorize-owner.ts';
import { generateTemporaryPassword, sha256Hex, validateStaffInvite } from './_shared/validate-staff.ts';
import { buildStaffOnboardingEmail } from '../_shared/staff-onboarding-email.mjs';
import { deliverSmtpEmail, SmtpDeliveryError } from '../_shared/customer-booking-reminder-smtp.mjs';
import { emailDomainCanReceiveMail } from '../_shared/email-domain.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !serviceKey || !anonKey) return json({ error: 'Staff account service is not configured. Contact the system administrator.' }, 503);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const token = req.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json({ error: 'Not authenticated.' }, 401);
  const { data: { user }, error: authError } = await admin.auth.getUser(token);
  if (authError || !user) return json({ error: 'Not authenticated.' }, 401);
  if (!await hasVerifiedEmailSession(admin, token, user.id)) return json({ error: 'Verify your email before managing staff accounts.' }, 403);
  const { data: caller, error: callerError } = await admin.from('profiles').select('role,status').eq('id', user.id).single();
  if (callerError || !canInviteStaff(caller)) return json({ error: 'Only an active owner can create staff accounts.' }, 403);

  let details: { email: string; position: string };
  let checkEmail = false;
  try {
    const body = await req.text();
    if (!body || body.length > 4096) throw new Error('Invalid request.');
    const parsedBody = JSON.parse(body);
    if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
      checkEmail = parsedBody.check_email === true;
      if (parsedBody.check_email !== undefined && typeof parsedBody.check_email !== 'boolean') throw new Error('Invalid request.');
      if (checkEmail && Object.keys(parsedBody).some(key => !['email', 'position', 'check_email'].includes(key))) throw new Error('Invalid request.');
    }
    details = validateStaffInvite(parsedBody);
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Invalid request.' }, 400); }

  try {
    if (!await emailDomainCanReceiveMail(details.email)) {
      return json({ error: 'This email domain has no mail route. Check the address and try again.' }, 400);
    }
  } catch {
    return json({ error: 'Could not verify the email domain right now. Please try again.' }, 503);
  }

  // Profile lookup finds normal application accounts. The Auth create call
  // below remains the final atomic duplicate check; its error path never
  // modifies an existing user.
  const { data: existingProfile, error: lookupError } = await admin.from('profiles').select('id').eq('email', details.email).maybeSingle();
  if (lookupError) return json({ error: 'Could not verify whether this email already has an account.' }, 500);
  if (checkEmail) {
    // This restricted database function rechecks owner status and performs a
    // bounded exact lookup in auth.users, independent of public signup limits.
    const { data: authEmailExists, error: authLookupError } = await admin.rpc('owner_auth_email_exists', {
      p_owner_id: user.id,
      p_email: details.email,
    });
    if (authLookupError) return json({ error: 'Could not verify whether this email already has an account.' }, 500);
    if (typeof authEmailExists !== 'boolean') return json({ error: 'Could not verify whether this email already has an account.' }, 500);
    return json({ exists: Boolean(existingProfile) || authEmailExists });
  }
  if (existingProfile) return json({ error: 'An account already uses this email. It was left unchanged.' }, 409);

  // Reuse the already configured Gmail SMTP account used by booking reminders.
  // Check all delivery configuration before creating an Auth user.
  const smtpUsername = Deno.env.get('CUSTOMER_BOOKING_SMTP_USERNAME') || '';
  const smtpAppPassword = Deno.env.get('CUSTOMER_BOOKING_SMTP_APP_PASSWORD') || '';
  const from = Deno.env.get('CUSTOMER_BOOKING_REMINDER_FROM_EMAIL') || smtpUsername;
  const loginUrl = Deno.env.get('STAFF_ONBOARDING_LOGIN_URL') || 'https://inigossportcenter.com/index.html';
  if (!smtpUsername || !smtpAppPassword || !from) {
    return json({ error: 'Staff account email delivery is not configured. Contact the system administrator.' }, 503);
  }
  try { if (new URL(loginUrl).protocol !== 'https:') throw new Error('invalid'); }
  catch { return json({ error: 'Staff account email delivery is not configured. Contact the system administrator.' }, 503); }

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

    const email = buildStaffOnboardingEmail({ email: details.email, position: details.position, password: temporaryPassword, loginUrl });
    await deliverSmtpEmail({
      connectTls: () => Deno.connectTls({ hostname: 'smtp.gmail.com', port: 465 }),
      smtpUsername, smtpAppPassword, from, email,
    });
    return json({ success: true, email: details.email });
  } catch (error) {
    if (error instanceof SmtpDeliveryError && error.reason === 'delivery_outcome_unknown') {
      return json({
        success: true,
        email: details.email,
        delivery_uncertain: true,
        message: `The account for ${details.email} remains pending, but SMTP did not confirm whether the email was delivered. Ask the staff member to check their inbox. If the message is not there, they should choose “Forgot password?” on the login page, reset the password from that inbox, then sign in and complete setup. Do not create another account.`,
      }, 202);
    }
    // Remove only the fresh Auth user returned by createUser. Deleting it
    // cascades the profile and private credential row; existing accounts
    // cannot reach this compensation path.
    const { error: cleanupError } = await admin.auth.admin.deleteUser(userId);
    if (cleanupError) return json({ error: 'The new account could not be rolled back after setup failed. No staff access was granted; contact the system administrator.' }, 500);
    return json({ error: 'Staff email delivery or setup failed. The new account was removed; verify the mail configuration and try again.' }, 502);
  }
});
