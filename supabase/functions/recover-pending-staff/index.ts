import { createClient } from 'npm:@supabase/supabase-js@2.95.0';
import { hasVerifiedEmailSession } from '../_shared/email-mfa.ts';
import { canInviteStaff } from '../invite-staff/_shared/authorize-owner.ts';
import { generateTemporaryPassword, sha256Hex, validateStaffInvite } from '../invite-staff/_shared/validate-staff.ts';
import { emailDomainCanReceiveMail } from '../_shared/email-domain.mjs';
import { buildStaffOnboardingEmail, staffResendSubject } from '../_shared/staff-onboarding-email.mjs';
import { deliverSmtpEmail, SmtpDeliveryError } from '../_shared/customer-booking-reminder-smtp.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey || !Deno.env.get('SUPABASE_ANON_KEY')) return json({ error: 'Staff account service is not configured. Contact the system administrator.' }, 503);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const token = req.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json({ error: 'Not authenticated.' }, 401);
  const { data: { user }, error: authError } = await admin.auth.getUser(token);
  if (authError || !user) return json({ error: 'Not authenticated.' }, 401);
  if (!await hasVerifiedEmailSession(admin, token, user.id)) return json({ error: 'Verify your email before managing staff accounts.' }, 403);
  const { data: caller, error: callerError } = await admin.from('profiles').select('role,status').eq('id', user.id).single();
  if (callerError || !canInviteStaff(caller)) return json({ error: 'Only an active owner can manage staff accounts.' }, 403);

  let payload: Record<string, unknown>;
  try {
    const text = await req.text();
    if (!text || text.length > 4096) throw new Error('Invalid request.');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).some(key => !['user_id', 'email'].includes(key))) throw new Error('Invalid request.');
    payload = parsed as Record<string, unknown>;
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Invalid request.' }, 400); }

  const targetId = typeof payload.user_id === 'string' && /^[0-9a-f-]{36}$/i.test(payload.user_id) ? payload.user_id : '';
  if (!targetId) return json({ error: 'Choose a valid pending staff account.' }, 400);
  let email: string;
  try { email = validateStaffInvite({ email: payload.email, position: 'Secretary' }).email; }
  catch (error) { return json({ error: error instanceof Error ? error.message : 'Enter a valid email address.' }, 400); }

  try {
    if (!await emailDomainCanReceiveMail(email)) return json({ error: 'This email domain has no mail route. Check the address and try again.' }, 400);
  } catch { return json({ error: 'Could not verify the email domain right now. Please try again.' }, 503); }

  const { data: profile, error: profileError } = await admin.from('profiles')
    .select('id,email,position,role,status,onboarding_complete').eq('id', targetId).maybeSingle();
  if (profileError || !profile) return json({ error: 'Could not find that staff account.' }, 404);
  if (profile.role !== 'staff' || profile.status !== 'pending' || profile.onboarding_complete !== false) {
    return json({ error: 'Only staff accounts awaiting setup can have their email corrected or setup message resent.' }, 409);
  }
  const { data: { user: targetAuthUser }, error: targetAuthError } = await admin.auth.admin.getUserById(targetId);
  if (targetAuthError || !targetAuthUser?.email) return json({ error: 'Could not verify the pending staff sign-in account.' }, 500);

  const { data: duplicateProfile, error: duplicateProfileError } = await admin.from('profiles')
    .select('id').eq('email', email).neq('id', targetId).maybeSingle();
  if (duplicateProfileError) return json({ error: 'Could not verify whether this email already has an account.' }, 500);
  const { data: authEmailExists, error: authLookupError } = await admin.rpc('owner_auth_email_exists', {
    p_owner_id: user.id, p_email: email,
  });
  if (authLookupError || typeof authEmailExists !== 'boolean') return json({ error: 'Could not verify whether this email already has an account.' }, 500);
  const emailAlreadyBelongsToTarget = email === targetAuthUser.email.trim().toLowerCase();
  if (duplicateProfile || (authEmailExists && !emailAlreadyBelongsToTarget)) {
    return json({ error: 'Another account already uses this email. The pending staff account was left unchanged.' }, 409);
  }

  const smtpUsername = Deno.env.get('CUSTOMER_BOOKING_SMTP_USERNAME') || '';
  const smtpAppPassword = Deno.env.get('CUSTOMER_BOOKING_SMTP_APP_PASSWORD') || '';
  const from = Deno.env.get('CUSTOMER_BOOKING_REMINDER_FROM_EMAIL') || smtpUsername;
  const loginUrl = Deno.env.get('STAFF_ONBOARDING_LOGIN_URL') || 'https://inigossportcenter.com/index.html';
  if (!smtpUsername || !smtpAppPassword || !from) return json({ error: 'Staff account email delivery is not configured. Contact the system administrator.' }, 503);
  try { if (new URL(loginUrl).protocol !== 'https:') throw new Error('invalid'); }
  catch { return json({ error: 'Staff account email delivery is not configured. Contact the system administrator.' }, 503); }

  const lockId = crypto.randomUUID();
  const { data: claimed, error: claimError } = await admin.rpc('claim_pending_staff_recovery', {
    p_staff_id: targetId,
    p_lock_id: lockId,
  });
  if (claimError) return json({ error: 'Could not safely claim this pending account for recovery. Please try again.' }, 503);
  if (claimed !== true) return json({ error: 'This account is no longer pending or another recovery is in progress. Wait a few minutes and refresh the staff list.' }, 409);

  let recoveryLockReleaseFailed = false;
  let acceptedMessageId: string | null = null;
  try {
    const temporaryPassword = generateTemporaryPassword();
    const { error: authUpdateError } = await admin.auth.admin.updateUserById(targetId, {
      email,
      email_confirm: true,
      password: temporaryPassword,
    });
    if (authUpdateError) {
      if (/already|registered|exists/i.test(authUpdateError.message)) return json({ error: 'Another account already uses this email. The pending staff account was left unchanged.' }, 409);
      return json({ error: 'Could not update the pending staff sign-in. The account remains pending; try again.' }, 502);
    }

    // The DB activation trigger checks the claim until delivery completes.
    const { data: syncedProfile, error: profileUpdateError } = await admin.from('profiles').update({ email })
      .eq('id', targetId).eq('status', 'pending').eq('onboarding_complete', false).select('id').maybeSingle();
    if (profileUpdateError) return json({ error: 'The sign-in email changed, but the staff profile could not be synchronized. The account remains pending; retry this correction.', email_saved: true }, 500);
    if (!syncedProfile) return json({ error: 'This account is no longer pending setup. No setup email was sent; contact the system administrator.', email_saved: true }, 409);
    const { data: syncedCredential, error: credentialError } = await admin.from('staff_onboarding_credentials')
      .update({ temporary_password_hash: await sha256Hex(temporaryPassword) })
      .eq('user_id', targetId).eq('recovery_lock_id', lockId)
      .gt('recovery_lock_until', new Date().toISOString()).select('user_id').maybeSingle();
    if (credentialError || !syncedCredential) {
      return json({ error: 'The setup credential could not be synchronized while the recovery claim was active. The account remains pending; retry after the lock expires.', email_saved: true }, 500);
    }

    const emailMessage = buildStaffOnboardingEmail({
      email, position: profile.position, password: temporaryPassword, loginUrl,
      subject: staffResendSubject(),
    });
    const smtpReceipt = await deliverSmtpEmail({
      connectTls: () => Deno.connectTls({ hostname: 'smtp.gmail.com', port: 465 }),
      smtpUsername, smtpAppPassword, from, email: emailMessage,
    });
    acceptedMessageId = smtpReceipt?.messageId || null;
  } catch (error) {
    if (error instanceof SmtpDeliveryError && error.reason === 'delivery_outcome_unknown') {
      return json({ success: true, email, pending: true, delivery_uncertain: true,
        message: `The account remains pending, but delivery to ${email} is uncertain. Check that inbox before retrying. If no message arrived, wait up to 10 minutes before retrying; a retry replaces the temporary password.` }, 202);
    }
    return json({ error: `The account remains pending, but the setup email was not confirmed as sent to ${email}. Retry here after checking mail delivery settings.`, email_saved: true }, 502);
  } finally {
    // If an invocation is terminated before this release, the ten-minute
    // lease expires and a later owner retry can reclaim it safely.
    try {
      const { error: releaseError } = await admin.from('staff_onboarding_credentials').update({
        recovery_lock_id: null, recovery_lock_until: null,
      }).eq('user_id', targetId).eq('recovery_lock_id', lockId);
      recoveryLockReleaseFailed = Boolean(releaseError);
    } catch {
      recoveryLockReleaseFailed = true;
    }
  }
  return json(recoveryLockReleaseFailed
    ? {
      success: true, email, pending: true, delivery_status: 'smtp_accepted', message_id: acceptedMessageId, recovery_lock_release_pending: true,
      message: `Mail server accepted setup email for ${email}. Account remains pending; wait up to 10 minutes before retrying.`,
    }
    : { success: true, email, pending: true, delivery_status: 'smtp_accepted', message_id: acceptedMessageId });
});
