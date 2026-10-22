import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20261022095549_owner_private_civil_status.sql', import.meta.url), 'utf8');

test('owner civil status is constrained to supported values and protected by owner-only RLS', () => {
    assert.match(migration, /create table if not exists public\.owner_private_details/i);
    assert.match(migration, /civil_status is null or civil_status in\s*\('Single', 'Married', 'Separated', 'Widowed', 'Prefer not to say'\)/i);
    assert.match(migration, /enable row level security/i);
    assert.match(migration, /revoke all on public\.owner_private_details from public, anon/i);
    assert.match(migration, /grant select, insert, update on public\.owner_private_details to authenticated/i);
    for (const operation of ['select', 'insert', 'update']) {
        assert.match(migration, new RegExp(`for ${operation} to authenticated`, 'i'), `${operation} has an explicit authenticated policy`);
        assert.match(migration, /user_id = \(select auth\.uid\(\)\) and internal\.is_active_owner\(\(select auth\.uid\(\)\)\)/i,
            `${operation} is scoped to the active owner’s own row`);
    }
    assert.doesNotMatch(migration, /grant [^;]*delete on public\.owner_private_details/i, 'browser clients cannot delete private rows');
    assert.doesNotMatch(migration, /for delete to authenticated/i, 'there is no authenticated delete policy');
});
