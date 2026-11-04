import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = (await readFile(new URL('../supabase/migrations/20261104150000_fix_walkin_extension_guard_record_field.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('extension guard reads only the identifier present on the triggering reservation table', () => {
    const functionStart = migration.indexOf('create or replace function internal.guard_open_booking_extension()');
    const functionEnd = migration.indexOf('\n$$;', functionStart);
    assert.ok(functionStart >= 0 && functionEnd > functionStart);
    const definition = migration.slice(functionStart, functionEnd);

    assert.match(definition, /if tg_table_name='booking' then\s+v_source:='booking';\s+v_id:=new\.booking_id;\s+elsif tg_table_name='walk_in_booking' then\s+v_source:='walkin';\s+v_id:=new\.walkin_id;/);
    assert.doesNotMatch(definition, /case when tg_table_name[\s\S]*new\.booking_id[\s\S]*new\.walkin_id/);
    assert.match(definition, /create or replace function internal\.guard_open_booking_extension\(\)[\s\S]*security definer set search_path = ''/);
    assert.match(migration, /revoke all on function internal\.guard_open_booking_extension\(\) from public,anon,authenticated,service_role/);
});
