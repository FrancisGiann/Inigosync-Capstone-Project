import { createClient } from 'npm:@supabase/supabase-js@2.95.0';
import { validateStaffInvite } from './_shared/validate-staff.ts';
import { canInviteStaff } from './_shared/authorize-owner.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: { user }, error: authError } = await admin.auth.getUser(token);
  if (authError || !user) return json({ error: 'Not authenticated' }, 401);
  const { data: caller, error: callerError } = await admin.from('profiles').select('role,status').eq('id', user.id).single();
  if (callerError || !canInviteStaff(caller)) return json({ error: 'Only an active owner can invite staff accounts.' }, 403);
  let details;
  try {
    const payload = await req.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid invitation.');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    details = validateStaffInvite(payload, today);
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Invalid invitation.' }, 400); }
  const { data: existingProfile, error: lookupError } = await admin.from('profiles').select('id').eq('email', details.email).maybeSingle();
  if (lookupError) return json({ error: 'Could not verify whether this email already has an account.' }, 500);
  if (existingProfile) return json({ error: 'An account already uses this email. Update its staff profile instead.' }, 409);
  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(details.email, { data: { full_name: details.full_name } });
  if (inviteError || !invited?.user) return json({ error: 'Could not send the invitation. Verify the email and try again.' }, 400);
  // The auth trigger creates a customer profile first. Promotion and the required
  // staff details are one UPDATE; role authorization never reads user metadata.
  const { data: saved, error: profileError } = await admin.from('profiles').update(details).eq('id', invited.user.id).select('id').single();
  if (profileError || !saved) {
    // Compensate only the Auth user created by this request. Never target an
    // existing account: inviteUserByEmail returned this exact fresh user ID.
    const { error: cleanupError } = await admin.auth.admin.deleteUser(invited.user.id);
    if (cleanupError) return json({ error: 'The invitation profile could not be saved and its new Auth invitation could not be removed. No staff access was granted; contact the owner to recover this invitation.' }, 500);
    return json({ error: 'The invitation profile could not be saved. The new invitation was removed; please try again.' }, 500);
  }
  return json({ success: true, id: invited.user.id, email: details.email });
});
