import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canInviteStaff } from '../supabase/functions/invite-staff/_shared/authorize-owner.ts';
import { validateStaffInvite } from '../supabase/functions/invite-staff/_shared/validate-staff.ts';
const birthdateTriggerFix = await readFile(new URL('../supabase/migrations/20261002033202_fix_staff_birthdate_promotion_trigger.sql', import.meta.url), 'utf8');
const inviteHandler = await readFile(new URL('../supabase/functions/invite-staff/index.ts', import.meta.url), 'utf8');
const valid = { email: 'staff@example.test', full_name: 'Court Staff', position: 'Court Attendant', birthdate: '1998-06-12', role: 'staff' };
test('staff invite accepts only the two positions and persists birthdate', () => {
  for (const position of ['Court Attendant', 'Secretary']) assert.equal(validateStaffInvite({ ...valid, position }, '2026-09-26').birthdate, valid.birthdate);
});
test('staff invite rejects elevated roles, unknown positions and invalid birthdates before sending email', () => {
  for (const patch of [{ role: 'admin' }, { position: 'Weekend Relief Staff' }, { birthdate: '' }, { birthdate: '2027-01-01' }, { birthdate: '2000-02-30' }]) assert.throws(() => validateStaffInvite({ ...valid, ...patch }, '2026-09-26'));
});

test('profile trigger requires a birthdate only when it is missing during staff promotion', () => {
  assert.match(birthdateTriggerFix, /if new\.role = 'staff' and new\.birthdate is null\s+and \(is_new_staff or \(tg_op = 'UPDATE' and old\.birthdate is distinct from new\.birthdate\)\) then/i);
  assert.match(birthdateTriggerFix, /new\.position, ''\) not in \('Secretary', 'Court Attendant'\)/i);
  assert.match(birthdateTriggerFix, /new\.birthdate > \(current_timestamp at time zone 'Asia\/Manila'\)::date/i);
});

test('only active admin profiles may create staff invitations', () => {
  assert.equal(canInviteStaff({ role: 'admin', status: 'active' }), true);
  for (const profile of [null, undefined, { role: 'staff', status: 'active' }, { role: 'admin', status: 'pending' }, { role: 'admin', status: 'disabled' }]) {
    assert.equal(canInviteStaff(profile), false);
  }
});

test('invitation endpoint authenticates owner, checks duplicates, and cleans up only its new user', () => {
  assert.match(inviteHandler, /admin\.auth\.getUser\(token\)/);
  assert.match(inviteHandler, /callerError \|\| !canInviteStaff\(caller\)/);
  assert.ok(inviteHandler.indexOf("select('id').eq('email', details.email)") < inviteHandler.indexOf('inviteUserByEmail('));
  assert.match(inviteHandler, /admin\.auth\.admin\.deleteUser\(invited\.user\.id\)/);
  assert.doesNotMatch(inviteHandler, /inviteError\?\.message|console\.(?:log|error)\(/);
});
