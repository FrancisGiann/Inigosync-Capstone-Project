export function canInviteStaff(profile: { role?: unknown; status?: unknown } | null | undefined) {
  return profile?.role === 'admin' && profile.status === 'active';
}
