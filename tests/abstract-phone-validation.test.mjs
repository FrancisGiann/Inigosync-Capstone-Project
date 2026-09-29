import test from "node:test";
import assert from "node:assert/strict";
import {
  interpretAbstractPhonePayload,
  normalizePhilippineMobile,
  validateWithAbstract,
} from "../supabase/functions/validate-contact-phone/_shared/abstract-phone.ts";
import { phoneValidationPreflight, phoneValidationUnavailable } from "../supabase/functions/validate-contact-phone/_shared/http.ts";

const normalized = "+639171234567";
const validPayload = {
  phone_number: "639171234567",
  phone_format: { international: normalized, national: "0917 123 4567" },
  phone_carrier: { line_type: "mobile" },
  phone_location: { country_code: "PH" },
  phone_validation: { is_valid: true, line_status: "active" },
};

test("normalizes only Philippine mobile formats", () => {
  assert.equal(normalizePhilippineMobile("0917 123 4567"), normalized);
  assert.equal(normalizePhilippineMobile("+63 (917) 123-4567"), normalized);
  assert.equal(normalizePhilippineMobile("639171234567"), normalized);
  assert.equal(normalizePhilippineMobile("9171234567"), normalized);
  assert.equal(normalizePhilippineMobile("+14155552671"), null);
  assert.equal(normalizePhilippineMobile("0917123456"), null);
  assert.equal(normalizePhilippineMobile("09abc1234567"), null);
});

test("accepts only matching valid PH mobile response", () => {
  assert.deepEqual(interpretAbstractPhonePayload(validPayload, normalized), {
    status: "valid", normalized,
  });
  assert.deepEqual(interpretAbstractPhonePayload({
    ...validPayload, phone_carrier: { line_type: "landline" },
  }, normalized), { status: "invalid", reason: "not_mobile" });
  assert.deepEqual(interpretAbstractPhonePayload({
    ...validPayload, phone_location: { country_code: "US" },
  }, normalized), { status: "invalid", reason: "invalid" });
  assert.deepEqual(interpretAbstractPhonePayload({
    ...validPayload, phone_format: { international: "+639171234568" },
  }, normalized), { status: "invalid", reason: "invalid" });
  assert.deepEqual(interpretAbstractPhonePayload({
    ...validPayload, phone_validation: { is_valid: false, line_status: "active" },
  }, normalized), { status: "invalid", reason: "invalid" });
  assert.deepEqual(interpretAbstractPhonePayload({
    ...validPayload, phone_validation: { is_valid: true, line_status: "inactive" },
  }, normalized), { status: "invalid", reason: "inactive" });
  assert.deepEqual(interpretAbstractPhonePayload({
    ...validPayload, phone_validation: { is_valid: true, line_status: "unknown" },
  }, normalized), { status: "invalid", reason: "status_unknown" });
  assert.deepEqual(interpretAbstractPhonePayload({
    ...validPayload, phone_validation: { is_valid: true },
  }, normalized), { status: "unavailable" });
  assert.deepEqual(interpretAbstractPhonePayload({ valid: true }, normalized), { status: "unavailable" });
});

test("calls Phone Intelligence with bearer auth and phone in a POST body", async () => {
  let captured;
  const result = await validateWithAbstract("09171234567", "abstract-test-secret", async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify(validPayload), { status: 200 });
  });
  assert.deepEqual(result, { status: "valid", normalized });
  assert.equal(captured.url, "https://phoneintelligence.abstractapi.com/v1/");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers.authorization, "Bearer abstract-test-secret");
  assert.deepEqual(JSON.parse(captured.options.body), { phone: normalized });
  assert.equal(captured.url.includes(normalized), false);
  assert.equal(captured.url.includes("abstract-test-secret"), false);
});

test("fails closed on provider errors and does not call provider for malformed input", async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return new Response("{}", { status: 429 }); };
  assert.deepEqual(await validateWithAbstract("bad", "key", fetcher), {
    status: "invalid", reason: "invalid",
  });
  assert.equal(calls, 0);
  assert.deepEqual(await validateWithAbstract("09171234567", "key", fetcher), {
    status: "unavailable", retryAfterSeconds: 60,
  });
  assert.equal(calls, 1);
  assert.deepEqual(await validateWithAbstract("09171234567", "", fetcher), { status: "unavailable" });
  assert.equal(calls, 1);
  assert.deepEqual(await validateWithAbstract("09171234567", "key", async () => {
    throw new Error("network unavailable");
  }), { status: "unavailable" });
});

test("provider-unavailable responses retain wildcard CORS and Retry-After", async () => {
  const response = phoneValidationUnavailable(60);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("retry-after"), "60");
  assert.match((await response.json()).message, /temporarily unavailable/);

  const preflight = phoneValidationPreflight();
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-headers"), /authorization/i);
});
