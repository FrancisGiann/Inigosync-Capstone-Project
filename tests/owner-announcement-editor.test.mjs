import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8');
const js = await readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261021110257_owner_update_scheduled_announcement.sql', import.meta.url), 'utf8');
const announcementPanel = html.match(/<section class="admin-panel" data-admin-panel="announcement">([\s\S]*?)<\/section>/)?.[1] || '';

test('announcement list is the panel entry point and creation opens a three-step modal', () => {
  assert.ok(announcementPanel, 'announcement panel exists');
  assert.ok(announcementPanel.indexOf('data-owner-announcement-new') < announcementPanel.indexOf('data-owner-announcement-list'));
  assert.match(announcementPanel, /class="admin-card-head"[\s\S]*?data-owner-announcement-new/);
  assert.doesNotMatch(announcementPanel, /data-owner-announcement-refresh/);
  assert.doesNotMatch(js, /data-owner-announcement-refresh/);
  assert.match(announcementPanel, /Publish a new announcement/);
  assert.match(html, /role="dialog" aria-modal="true"[^>]*data-owner-announcement-form/);
  assert.deepEqual([...html.matchAll(/data-owner-announcement-step="(\d)"/g)].map(([, step]) => step), ['1', '2', '3']);
  assert.match(html, /data-owner-announcement-publish-at[^>]*>/);
  assert.match(js, /localManilaDateTimeToIso/);
  assert.match(js, /timeZone: 'Asia\/Manila'/);
  assert.match(js, /panel\.hidden = !isActive/);
  assert.equal([...html.matchAll(/data-owner-announcement-wizard-next/g)].length, 1);
  assert.match(html, /data-owner-announcement-wizard-next disabled>Next/);
  assert.match(js, /announcementNext\.hidden = announcementWizardStep === 3;[\s\S]*?announcementNext\.disabled = announcementWizardStep === 1 && !hasAnnouncementContent\(\)/);
  assert.match(js, /announcementNext\.disabled = !hasAnnouncementContent\(\)/);
  assert.match(js, /const announcementNext = document\.querySelector\('\[data-owner-announcement-wizard-next\]'\)/);
  assert.match(js, /announcementNext\?\.addEventListener\('click'/);
});

test('only scheduled rows get edit actions and edits use the scheduled update RPC', () => {
  assert.match(js, /const editAction = status === 'scheduled' \?/);
  assert.match(js, /data-owner-announcement-edit/);
  assert.match(js, /item\.status === 'scheduled' && new Date\(item\.publish_at\) > new Date\(\)/);
  assert.match(js, /owner_update_scheduled_announcement/);
  assert.match(js, /owner_publish_announcement/);
  assert.equal([...html.matchAll(/data-owner-announcement-next/g)].length, 1, 'the generic next hook belongs only to the pager');
  assert.match(js, /document\.querySelector\('\[data-owner-announcement-next\]'\)\?\.addEventListener\('click'/);
  assert.match(js, /function closeAnnouncementModal\(force = false\)/);
  assert.match(js, /\(!force && announcementSaving\)/);
  assert.match(js, /announcementForm\.querySelectorAll\('button, input, textarea, select'\)/);
});

test('scheduled update RPC requires an active admin and atomically rejects published rows', () => {
  assert.match(migration, /p\.role\s*=\s*'admin'\s+and p\.status\s*=\s*'active'/i);
  assert.match(migration, /p_audience is null\s+or p_audience not in/i);
  assert.match(migration, /update internal\.app_announcements a[\s\S]*?where a\.id = p_id and a\.publish_at > pg_catalog\.clock_timestamp\(\)/i);
  assert.match(migration, /p_publish_at <= pg_catalog\.clock_timestamp\(\)/i);
  assert.match(migration, /revoke all on function public\.owner_update_scheduled_announcement\([^;]+ from public, anon;/i);
  assert.match(migration, /grant execute on function public\.owner_update_scheduled_announcement\([^;]+ to authenticated;/i);
});
