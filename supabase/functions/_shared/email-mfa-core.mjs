// Dependency-injected core so challenge and temporary-session behavior can
// be tested without connecting to live Supabase Auth or Postgres.
export async function verifyEmailChallenge({ admin, emailAuth, userId, sessionId, challengeId, code, remember, deviceHash }) {
  const { data: challengeRows, error: challengeError } = await admin.rpc('email_mfa_get_challenge', {
    p_user_id: userId, p_session_id: sessionId, p_challenge_id: challengeId,
  });
  const challenge = Array.isArray(challengeRows) ? challengeRows[0] : null;
  if (challengeError || !challenge) return { status: 400, message: 'This verification code expired. Sign in again to get a new code.' };

  const { data: attemptAllowed, error: attemptError } = await admin.rpc('email_mfa_record_attempt', {
    p_user_id: userId, p_session_id: sessionId, p_challenge_id: challengeId,
  });
  if (attemptError) return { status: 503, message: 'Email verification is temporarily unavailable.' };
  if (attemptAllowed !== true) return { status: 400, message: 'This verification code expired. Sign in again to get a new code.' };

  const { data: verified, error: verifyError } = await emailAuth.auth.verifyOtp({
    email: challenge.email, token: code, type: 'email',
  });
  if (verifyError || !verified.user || verified.user.id !== userId || !verified.session?.access_token) {
    if (verified.session?.access_token) {
      const { error: revokeError } = await emailAuth.auth.signOut({ scope: 'local' });
      if (revokeError) return { status: 503, message: 'The temporary verification session could not be safely closed. Please sign in again.' };
    }
    return { status: 400, message: 'That code did not match or has expired. Check the code and try again.' };
  }

  // The OTP API creates a separate AAL1 session. Revoke it before proof is
  // attached to the original password/OAuth session; otherwise fail closed.
  const { error: revokeError } = await emailAuth.auth.signOut({ scope: 'local' });
  if (revokeError) return { status: 503, message: 'Email was verified, but this session could not be safely completed. Please sign in again.' };

  const { data: completed, error: completeError } = await admin.rpc('email_mfa_finish', {
    p_user_id: userId, p_session_id: sessionId, p_challenge_id: challengeId,
    p_remember: remember, p_device_hash: deviceHash,
  });
  if (completeError || completed !== true)
    return { status: 400, message: 'This verification attempt expired. Sign in and request a new code.' };
  return { status: 200, body: { verified: true, remembered: remember } };
}
