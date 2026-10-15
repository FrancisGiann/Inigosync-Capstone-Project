export function normalizePhilippineMobile(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !/^[+()0-9 .-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (/^09[0-9]{9}$/.test(digits)) return `+63${digits.slice(1)}`;
  if (/^639[0-9]{9}$/.test(digits)) return `+${digits}`;
  if (/^9[0-9]{9}$/.test(digits)) return `+63${digits}`;
  return null;
}
