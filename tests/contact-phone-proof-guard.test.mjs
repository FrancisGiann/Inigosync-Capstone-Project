import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrations = [
  "../supabase/migrations/20260929040335_fix_contact_phone_missing_proof.sql",
];

for (const migrationPath of migrations) {
  test(`contact number trigger rejects absent proof in ${migrationPath.split("/").at(-1)}`, async () => {
    const migration = await readFile(new URL(migrationPath, import.meta.url), "utf8");
    const match = migration.match(/create or replace function internal\.guard_contact_phone_validation\(\)([\s\S]*?)\$\$;/i);
    assert.ok(match, "migration must define the guarded trigger function");
    const body = match[1];
    assert.match(body, /delete from internal\.contact_phone_validation_proofs[\s\S]*?returning true into v_proof;/i);
    assert.match(body, /if\s+v_proof\s+is distinct from\s+true\s+then/i,
      "SQL NULL from DELETE RETURNING must fail closed");
    assert.doesNotMatch(body, /if\s+not\s+v_proof\s+then/i,
      "nullable boolean must not use IF NOT as the proof check");
  });
}
