export type AbstractPhoneResult =
  | { status: "valid"; normalized: string }
  | { status: "invalid"; reason: "invalid" | "not_mobile" | "inactive" | "status_unknown" }
  | { status: "unavailable"; retryAfterSeconds?: number };

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

export function interpretAbstractPhonePayload(payload: unknown, expected: string): AbstractPhoneResult {
  if (!payload || typeof payload !== "object") return { status: "unavailable" };
  const data = payload as Record<string, unknown>;
  const validation = data.phone_validation && typeof data.phone_validation === "object"
    ? data.phone_validation as Record<string, unknown> : null;
  const carrier = data.phone_carrier && typeof data.phone_carrier === "object"
    ? data.phone_carrier as Record<string, unknown> : null;
  const location = data.phone_location && typeof data.phone_location === "object"
    ? data.phone_location as Record<string, unknown> : null;
  const format = data.phone_format && typeof data.phone_format === "object"
    ? (data.phone_format as Record<string, unknown>).international : null;
  if (!validation || typeof validation.is_valid !== "boolean"
      || typeof validation.line_status !== "string"
      || !carrier || !location || typeof location.country_code !== "string"
      || typeof carrier.line_type !== "string" || typeof format !== "string")
    return { status: "unavailable" };
  if (!validation.is_valid) return { status: "invalid", reason: "invalid" };
  const lineStatus = validation.line_status.trim().toLowerCase();
  if (lineStatus === "inactive") return { status: "invalid", reason: "inactive" };
  if (lineStatus !== "active") return { status: "invalid", reason: "status_unknown" };
  const normalizedResult = normalizePhilippineMobile(format);
  if (!normalizedResult || normalizedResult !== expected || location.country_code.toUpperCase() !== "PH")
    return { status: "invalid", reason: "invalid" };
  if (carrier.line_type.trim().toLowerCase() !== "mobile") return { status: "invalid", reason: "not_mobile" };
  return { status: "valid", normalized: expected };
}

export async function validateWithAbstract(
  phone: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<AbstractPhoneResult> {
  const normalized = normalizePhilippineMobile(phone);
  if (!normalized) return { status: "invalid", reason: "invalid" };
  if (!apiKey) return { status: "unavailable" };

  const url = new URL("https://phoneintelligence.abstractapi.com/v1/");
  let response: Response;
  try {
    response = await fetcher(url, { method: "POST", cache: "no-store",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ phone: normalized }), signal: AbortSignal.timeout(8000) });
  } catch {
    return { status: "unavailable" };
  }
  if (response.status === 429) return { status: "unavailable", retryAfterSeconds: 60 };
  if (!response.ok) return { status: "unavailable" };
  let payload: unknown;
  try { payload = await response.json(); } catch { return { status: "unavailable" }; }
  return interpretAbstractPhonePayload(payload, normalized);
}
