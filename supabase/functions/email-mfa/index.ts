import { createClient } from 'npm:@supabase/supabase-js@2.95.0';
import { verifyEmailChallenge } from '../_shared/email-mfa-core.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
const DEVICE_SECRET_PATTERN = /^[a-f0-9]{64}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JwtClaims = { sub?: string; session_id?: string; exp?: number };
type MfaPayload = {
  action?: unknown;
  remember?: unknown;
  activity?: unknown;
  device_secret?: unknown;
  challenge_id?: unknown;
  code?: unknown;
};

function decodeValidatedClaims(token: string): JwtClaims | null {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return null;
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')));
    return payload && typeof payload === 'object' ? payload as JwtClaims : null;
  } catch (_) { return null; }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function cleanDeviceSecret(value: unknown): string | null {
  return typeof value === 'string' && DEVICE_SECRET_PATTERN.test(value) ? value.toLowerCase() : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ message: 'Method not allowed.' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const token = req.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!url || !serviceKey || !anonKey) return json({ message: 'Email verification is not configured yet.' }, 503);
  if (!token) return json({ message: 'Sign in to continue.' }, 401);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  // Validate the signature and expiry with Auth before trusting locally decoded
  // claims such as session_id. Never accept a client-supplied user/session ID.
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  const claims = decodeValidatedClaims(token);
  if (authError || !authData.user || claims?.sub !== authData.user.id || !UUID_PATTERN.test(claims?.session_id || '')) {
    return json({ message: 'Your session has expired. Sign in again.' }, 401);
  }

  let payload: MfaPayload;
  try {
    const value = await req.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid payload');
    payload = value as MfaPayload;
  } catch (_) { return json({ message: 'Invalid email verification request.' }, 400); }

  const userId = authData.user.id;
  const sessionId = claims.session_id!;
  const action = payload.action;
  if (!['begin', 'verify', 'check', 'revoke'].includes(String(action))) {
    return json({ message: 'Invalid email verification request.' }, 400);
  }

  // signInWithOtp/verifyOtp can create a valid Auth session without a password
  // or OAuth login. Only an accepted primary session may start, check, or
  // complete the custom email second step. Revocation remains available so a
  // caller can clear stale proof even after their primary session expires.
  if (action !== 'revoke') {
    const { data: hasPrimaryAuth, error: primaryAuthError } = await admin.rpc('email_mfa_has_primary_auth', {
      p_user_id: userId,
      p_session_id: sessionId,
    });
    if (primaryAuthError) {
      console.error('[email-mfa] primary authentication check failed', primaryAuthError.message);
      return json({ message: 'Email verification is temporarily unavailable.' }, 503);
    }
    if (hasPrimaryAuth !== true) {
      return json({ message: 'Sign in with your password or Google account before verifying your email.' }, 403);
    }
  }

  if (action === 'check' || action === 'revoke') {
    const rpc = action === 'check' ? 'email_mfa_check_session' : 'email_mfa_revoke_session';
    const { data, error } = await admin.rpc(rpc, { p_user_id: userId, p_session_id: sessionId });
    if (error) {
      console.error('[email-mfa] session check failed', error.message);
      return json({ message: 'Email verification is temporarily unavailable.' }, 503);
    }
    if (action === 'check' && data === true) {
      const deviceSecret = cleanDeviceSecret(payload.device_secret);
      if (payload.activity === true) {
        const { error: touchSessionError } = await admin.rpc('email_mfa_touch_session', {
          p_user_id: userId,
          p_session_id: sessionId,
        });
        if (touchSessionError) console.warn('[email-mfa] verified session activity was not refreshed', touchSessionError.message);
      }
      if (deviceSecret) {
        const { error: touchError } = await admin.rpc('email_mfa_touch_device', {
          p_user_id: userId,
          p_device_hash: `\\x${await sha256Hex(deviceSecret)}`,
        });
        if (touchError) console.warn('[email-mfa] trusted device activity was not refreshed', touchError.message);
      }
    }
    return json({ verified: action === 'check' ? data === true : true });
  }

  const { data: profile, error: profileError } = await admin.from('profiles')
    .select('email, role, status, onboarding_complete').eq('id', userId).maybeSingle();
  const canVerifyEmail = profile?.status === 'active'
    || (profile?.role === 'staff' && profile?.status === 'pending' && profile?.onboarding_complete === false);
  if (profileError || !profile || !canVerifyEmail
    || !['customer', 'staff', 'admin'].includes(profile.role)
    || !authData.user.email || profile.email?.toLowerCase() !== authData.user.email.toLowerCase()) {
    return json({ message: 'This account cannot complete email verification. Contact the front desk.' }, 403);
  }

  const remember = payload.remember === true;
  // An existing trusted-device secret can skip the email code regardless of
  // this login's checkbox. The checkbox only controls creating trust after
  // a successful code verification.
  const deviceSecret = cleanDeviceSecret(payload.device_secret);
  const deviceHash = deviceSecret ? `\\x${await sha256Hex(deviceSecret)}` : null;

  if (action === 'begin') {
    const challengeId = crypto.randomUUID();
    const { data: alreadyTrusted, error: beginError } = await admin.rpc('email_mfa_begin', {
      p_user_id: userId,
      p_session_id: sessionId,
      p_email: authData.user.email,
      p_challenge_id: challengeId,
      p_remember: remember,
      p_device_hash: deviceHash,
    });
    if (beginError) {
      console.error('[email-mfa] could not start challenge', beginError.message);
      return json({ message: 'Could not start email verification. Please try again.' }, 503);
    }
    const beginState = Array.isArray(alreadyTrusted) ? alreadyTrusted[0] : alreadyTrusted;
    if (beginState?.verified === true) return json({ verified: true, remembered: beginState.remembered === true });
    if (!beginState?.challenge_id) {
      console.error('[email-mfa] challenge start returned an invalid state');
      return json({ message: 'Could not start email verification. Please try again.' }, 503);
    }
    if (beginState.send_email !== true) return json({ verified: false, challenge_id: beginState.challenge_id, resent: false });

    // This deliberately uses the project's existing Auth email delivery
    // settings and template. Its OTP is verified server-side below, and the
    // temporary email-only session is immediately revoked before any proof is
    // granted to the original password/OAuth session.
    const emailAuth = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: sendError } = await emailAuth.auth.signInWithOtp({
      email: authData.user.email,
      options: { shouldCreateUser: false },
    });
    if (sendError) {
      await admin.rpc('email_mfa_cancel_challenge', {
        p_user_id: userId, p_session_id: sessionId, p_challenge_id: beginState.challenge_id,
      });
      console.error('[email-mfa] Auth email delivery failed', sendError.message);
      return json({ message: 'We could not send the verification code. Please wait a moment and try again.' }, 503);
    }
    return json({ verified: false, challenge_id: beginState.challenge_id, resent: true });
  }

  const challengeId = typeof payload.challenge_id === 'string' && UUID_PATTERN.test(payload.challenge_id)
    ? payload.challenge_id : '';
  const code = typeof payload.code === 'string' ? payload.code.replace(/\s/g, '') : '';
  if (!challengeId || !/^\d{6}$/.test(code)) return json({ message: 'Enter the 6-digit code we emailed you.' }, 400);

  const emailAuth = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await verifyEmailChallenge({ admin, emailAuth, userId, sessionId, challengeId, code, remember, deviceHash });
  return result.body ? json(result.body, result.status) : json({ message: result.message }, result.status);
});
