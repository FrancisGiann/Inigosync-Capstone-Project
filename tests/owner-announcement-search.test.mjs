import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8');
const js = await readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261021110306_owner_search_announcements.sql', import.meta.url), 'utf8');
const panel = html.match(/<section class="admin-panel" data-admin-panel="announcement">([\s\S]*?)<\/section>/)?.[1] || '';

test('announcement list exposes accessible text and status filters with a matching count', () => {
  assert.match(panel, /<label[^>]*>[\s\S]*?Search announcements[\s\S]*?data-owner-announcement-search/);
  assert.match(panel, /type="search"[^>]*maxlength="200"[^>]*data-owner-announcement-search/);
  assert.match(panel, /<option value="">All<\/option>[\s\S]*?<option value="published">Published<\/option>[\s\S]*?<option value="scheduled">Scheduled<\/option>/);
  assert.match(panel, /data-owner-announcement-count role="status" aria-live="polite"/);
});

test('client sends filters to the paged RPC and invalidates responses on filter changes', () => {
  assert.match(js, /rpc\('owner_search_announcements'/);
  assert.match(js, /p_search: search \|\| null/);
  assert.match(js, /p_status: status \|\| null/);
  assert.match(js, /announcementGeneration \+= 1/);
  assert.match(js, /setTimeout\(\(\) => \{[\s\S]*?loadOwnerAnnouncements\(\);[\s\S]*?\}, 250\)/);
  assert.match(js, /announcementPage = 0/);
  assert.match(js, /No announcements match these filters\./);
  assert.match(js, /const editAction = status === 'scheduled'/);
});

test('server filters literal case-insensitive substrings before pagination and returns filtered totals to active admins only', () => {
  assert.match(migration, /p\.role = 'admin'[\s\S]*?p\.status = 'active'/i);
  assert.match(migration, /strpos\(pg_catalog\.lower\(a\.title\), pg_catalog\.lower\(search_term\)\) > 0/);
  assert.match(migration, /strpos\(pg_catalog\.lower\(a\.body\), pg_catalog\.lower\(search_term\)\) > 0/);
  assert.match(migration, /case when a\.publish_at <= pg_catalog\.now\(\) then 'published' else 'scheduled' end as status/i);
  assert.match(migration, /from filtered\s+order by created_at desc, id desc\s+offset p_offset\s+limit p_limit/i);
  assert.match(migration, /jsonb_agg\(pg_catalog\.to_jsonb\(page\) order by page\.created_at desc, page\.id desc\)/i);
  assert.match(migration, /'total_count', \(select pg_catalog\.count\(\*\) from filtered\)/);
  assert.match(migration, /revoke all on function public\.owner_search_announcements\([^;]+ from public, anon;/i);
  assert.match(migration, /grant execute on function public\.owner_search_announcements\([^;]+ to authenticated;/i);
});
