import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhilippineMobile } from "../supabase/functions/validate-contact-phone/_shared/ph-mobile.ts";
import { phoneValidationPreflight } from "../supabase/functions/validate-contact-phone/_shared/http.ts";

test("normalizes only Philippine mobile formats", () => {
  const normalized = "+639171234567";
  assert.equal(normalizePhilippineMobile("0917 123 4567"), normalized);
  assert.equal(normalizePhilippineMobile("+63 (917) 123-4567"), normalized);
  assert.equal(normalizePhilippineMobile("639171234567"), normalized);
  assert.equal(normalizePhilippineMobile("9171234567"), normalized);
  assert.equal(normalizePhilippineMobile("+14155552671"), null);
  assert.equal(normalizePhilippineMobile("0917123456"), null);
  assert.equal(normalizePhilippineMobile("09abc1234567"), null);
});

test("contact check preflight accepts authenticated requests", () => {
  const preflight = phoneValidationPreflight();
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-headers"), /authorization/i);
});
