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
      || Object.keys(parsed).length !== 2
      || !Object.hasOwn(parsed, 'user_id') || !Object.hasOwn(parsed, 'action')) throw new Error('Invalid request.');
    payload = parsed as Record<string, unknown>;
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Invalid request.' }, 400); }

  const targetId = typeof payload.user_id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.user_id)
    ? payload.user_id
    : '';
  const action = payload.action;
  if (!targetId || (action !== 'archive' && action !== 'restore')) return json({ error: 'Choose a valid staff account and archive or restore action.' }, 400);
  if (targetId === user.id) return json({ error: 'You cannot archive or restore your own account.' }, 403);

  const { data: target, error: targetError } = await admin.from('profiles')
    .select('id,role,status,archived_at').eq('id', targetId).maybeSingle();
  if (targetError) return json({ error: 'Could not verify this staff account.' }, 500);
  if (!target || target.role !== 'staff' || target.status !== 'disabled') {
    return json({ error: 'Only a disabled staff account can be archived or restored. Refresh the staff list and retry.' }, 409);
  }
  if (action === 'archive' && target.archived_at) return json({ error: 'This staff account is already archived.' }, 409);
  if (action === 'restore' && !target.archived_at) return json({ error: 'This staff account is not archived.' }, 409);

  // The database trigger permits archive-marker changes only from service_role,
  // and the status constraint prevents an archived account from being activated.
  // Conditional writes make retries and concurrent owner actions fail closed.
  let update = admin.from('profiles').update({ archived_at: action === 'archive' ? new Date().toISOString() : null })
    .eq('id', targetId).eq('role', 'staff').eq('status', 'disabled');
  update = action === 'archive' ? update.is('archived_at', null) : update.not('archived_at', 'is', null);
  const { data: updated, error: updateError } = await update.select('id').maybeSingle();
  if (updateError) return json({ error: 'Could not update this staff account. No history was changed.' }, 503);
  if (!updated) return json({ error: 'This account changed before the request completed. Refresh the staff list and retry.' }, 409);

  return json({ success: true, archived: action === 'archive' });
});
