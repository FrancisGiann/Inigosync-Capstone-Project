import { createClient } from 'npm:@supabase/supabase-js@2.95.0';
import { hasVerifiedEmailSession } from '../_shared/email-mfa.ts';
import { canInviteStaff } from '../invite-staff/_shared/authorize-owner.ts';

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
      || Object.keys(parsed).some(key => key !== 'user_id')) throw new Error('Invalid request.');
    payload = parsed as Record<string, unknown>;
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Invalid request.' }, 400); }

  const targetId = typeof payload.user_id === 'string' && /^[0-9a-f-]{36}$/i.test(payload.user_id) ? payload.user_id : '';
  if (!targetId) return json({ error: 'Choose a valid pending staff account.' }, 400);

  const lockId = crypto.randomUUID();
  const { data: claimed, error: claimError } = await admin.rpc('claim_pending_staff_cancellation', {
    p_staff_id: targetId,
    p_lock_id: lockId,
  });
  if (claimError) return json({ error: 'Could not safely claim this pending account for cancellation. Please try again.' }, 503);
  if (claimed === 'walk_in_activity') {
    return json({ error: 'This account is linked to walk-in records. Cancellation would erase its staff attribution, so the account was left unchanged.' }, 409);
  }
  if (claimed !== 'claimed') return json({ error: 'This account is no longer pending setup or another recovery/cancellation is in progress. Refresh the staff list and retry if it is still pending.' }, 409);

  const { data: target, error: targetError } = await admin.auth.admin.getUserById(targetId);
  if (targetError || !target.user) {
    await admin.from('staff_onboarding_credentials').update({ recovery_lock_id: null, recovery_lock_until: null })
      .eq('user_id', targetId).eq('recovery_lock_id', lockId);
    return json({ error: 'Could not verify the pending staff sign-in account. No account data was deleted.' }, 500);
  }

  // Recheck immediately before Auth deletion as well as inside the locked SQL
  // claim. walk_in_booking.staff_id is ON DELETE SET NULL, so never rely on FK
  // behavior to preserve this attribution.
  const { count: walkInCount, error: walkInCheckError } = await admin.from('walk_in_booking')
    .select('walkin_id', { count: 'exact', head: true }).eq('staff_id', targetId);
  if (walkInCheckError || (walkInCount || 0) > 0) {
    await admin.from('staff_onboarding_credentials').update({ recovery_lock_id: null, recovery_lock_until: null })
      .eq('user_id', targetId).eq('recovery_lock_id', lockId);
    if (walkInCheckError) return json({ error: 'Could not verify whether this account has walk-in records. The account was left unchanged; retry after resolving the verification issue.' }, 503);
    return json({ error: 'This account is linked to walk-in records. Cancellation would erase its staff attribution, so the account was left unchanged.' }, 409);
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(targetId);
  if (deleteError) {
    // Retain the pending account for retry if Auth deletion fails. Releasing
    // this claim lets onboarding/recovery resume; if release fails, the lease
    // expires after ten minutes.
    await admin.from('staff_onboarding_credentials').update({ recovery_lock_id: null, recovery_lock_until: null })
      .eq('user_id', targetId).eq('recovery_lock_id', lockId);
    return json({ error: 'The account could not be deleted. It remains pending; refresh and retry after checking its current state.' }, 409);
  }

  return json({ success: true, deleted: true });
});
