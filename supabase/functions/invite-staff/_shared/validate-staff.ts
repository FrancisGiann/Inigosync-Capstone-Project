const EMAIL_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const POSITIONS = new Set(['Secretary', 'Court Attendant']);

export function validateStaffInvite(value: unknown): { email: string; position: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Enter a valid staff email and position.');
  const input = value as Record<string, unknown>;
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const position = typeof input.position === 'string' ? input.position.trim() : '';
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new Error('Enter a valid personal email address with a complete domain.');
  if (!POSITIONS.has(position)) throw new Error('Choose a valid staff position.');
  return { email, position };
}

const TEMPORARY_PASSWORD_UPPERCASE = 'ABCDEFHJKMNPQRTUVWXYZ';
const TEMPORARY_PASSWORD_LOWERCASE = TEMPORARY_PASSWORD_UPPERCASE.toLowerCase();
const TEMPORARY_PASSWORD_DIGITS = '3479';
const TEMPORARY_PASSWORD_EXTRA = '-';
const TEMPORARY_PASSWORD_ALPHABET = `${TEMPORARY_PASSWORD_UPPERCASE}${TEMPORARY_PASSWORD_LOWERCASE}${TEMPORARY_PASSWORD_DIGITS}${TEMPORARY_PASSWORD_EXTRA}`;
const TEMPORARY_PASSWORD_LENGTH = 16;

function secureRandomIndex(maxExclusive: number, randomValues: (bytes: Uint8Array) => Uint8Array): number {
  const acceptLimit = Math.floor(256 / maxExclusive) * maxExclusive;
  while (true) {
    const byte = randomValues(new Uint8Array(1))[0];
    if (byte < acceptLimit) return byte % maxExclusive;
  }
}

export function generateTemporaryPassword(
  randomValues: (bytes: Uint8Array) => Uint8Array = bytes => crypto.getRandomValues(bytes),
): string {
  const chars = [
    TEMPORARY_PASSWORD_UPPERCASE[secureRandomIndex(TEMPORARY_PASSWORD_UPPERCASE.length, randomValues)],
    TEMPORARY_PASSWORD_LOWERCASE[secureRandomIndex(TEMPORARY_PASSWORD_LOWERCASE.length, randomValues)],
    TEMPORARY_PASSWORD_DIGITS[secureRandomIndex(TEMPORARY_PASSWORD_DIGITS.length, randomValues)],
    TEMPORARY_PASSWORD_EXTRA[secureRandomIndex(TEMPORARY_PASSWORD_EXTRA.length, randomValues)],
  ];
  while (chars.length < TEMPORARY_PASSWORD_LENGTH) {
    chars.push(TEMPORARY_PASSWORD_ALPHABET[secureRandomIndex(TEMPORARY_PASSWORD_ALPHABET.length, randomValues)]);
  }

  // Shuffle the required character classes so the password has no fixed prefix.
  for (let index = chars.length - 1; index > 0; index--) {
    const swapIndex = secureRandomIndex(index + 1, randomValues);
    [chars[index], chars[swapIndex]] = [chars[swapIndex], chars[index]];
  }
  return chars.join('');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
