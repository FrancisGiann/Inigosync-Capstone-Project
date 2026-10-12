const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sessionIdFromValidatedJwt(token: string): string | null {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return null;
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')));
    return typeof claims.session_id === 'string' && UUID.test(claims.session_id) ? claims.session_id : null;
  } catch { return null; }
}

// Call only after Supabase Auth has validated this bearer JWT with getUser().
// Never accept a user/session ID from request JSON for authorization.
export async function hasVerifiedEmailSession(admin: any, token: string, userId: string): Promise<boolean> {
  // Edge handlers call this only after Auth validates the bearer token. Keep
  // deployed user-JWT traffic working while the guarded functions are staged;
  // the service-only switch makes proof mandatory atomically with activation.
  const { data: enforcementEnabled, error: enforcementError } = await admin.rpc('email_mfa_enforcement_enabled');
  if (enforcementError || typeof enforcementEnabled !== 'boolean') return false;
  if (!enforcementEnabled) return true;

  const sessionId = sessionIdFromValidatedJwt(token);
  if (!sessionId) return false;
  // This database check also requires a live, accepted primary AMR for this
  // exact session, so passwordless OTP/recovery sessions cannot pass guards.
  const { data, error } = await admin.rpc('email_mfa_check_session', {
    p_user_id: userId,
    p_session_id: sessionId,
  });
  return !error && data === true;
}
