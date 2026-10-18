import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20261018130000_owner_staff_position_only.sql', import.meta.url), 'utf8');
const owner = await readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');
const page = await readFile(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8');

test('owner staff action edits position only and keeps staff details read-only', () => {
    assert.match(owner, /data-admin-staff-command="edit">Change position</);
    assert.match(owner, /\.update\(\{ position \}\)/);
    assert.doesNotMatch(owner, /\.update\(fullPatch\)|\.update\(\{ full_name, position \}\)/);
    assert.match(page, /data-admin-staff-details-view/);
    assert.match(page, /data-admin-staff-edit-position/);
    assert.doesNotMatch(page, /data-admin-staff-edit-(?:name|address|birthdate|gender|emergency-name|emergency-number)/);
});

test('database guard allow-lists staff position and status updates for active owners', () => {
    assert.match(migration, /before update on public\.profiles/i);
    assert.match(migration, /old\.role\s*=\s*'staff'/i);
    assert.match(migration, /internal\.is_active_owner\(\(select auth\.uid\(\)\)\)/i);
    assert.match(migration, /to_jsonb\(new\)\s*-\s*array\['position',\s*'status',\s*'updated_at'\][\s\S]*?is distinct from\s*\(to_jsonb\(old\)\s*-\s*array\['position',\s*'status',\s*'updated_at'\]\)/i,
        'every column except position, status, and the system timestamp is compared against the old row');
    const allowedColumns = migration.match(/array\[([^\]]+)\]/i)?.[1] || '';
    for (const personalField of ['first_name', 'middle_name', 'last_name', 'phone', 'full_name', 'avatar_url', 'address', 'birthdate', 'gender', 'contact_num', 'emergency_contact_name', 'emergency_contact_number']) {
        assert.doesNotMatch(allowedColumns, new RegExp(`\\b${personalField}\\b`, 'i'), `${personalField} is not owner-editable`);
    }
    assert.match(migration, /auth\.jwt\(\)->>'role'\)[\s\S]*?is distinct from 'service_role'/i,
        'service-managed onboarding and account operations remain supported');
});
