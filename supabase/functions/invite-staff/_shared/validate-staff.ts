const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSITIONS = new Set(['Secretary', 'Court Attendant']);

export function validateStaffInvite(value: unknown): { email: string; position: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Enter a valid staff email and position.');
  const input = value as Record<string, unknown>;
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const position = typeof input.position === 'string' ? input.position.trim() : '';
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new Error('Enter a valid personal email address.');
  if (!POSITIONS.has(position)) throw new Error('Choose a valid staff position.');
  return { email, position };
}

export function generateTemporaryPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
