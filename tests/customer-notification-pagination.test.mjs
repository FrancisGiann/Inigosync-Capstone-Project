import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');

test('customer notification loader backs up to the last valid page when the feed shrinks', async () => {
  const start = source.indexOf('    async function loadCustomerNotifications() {');
  const end = source.indexOf('    document.querySelector(\'[data-dash-notif-prev]\')', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const context = {
    notifList: { innerHTML: '', querySelectorAll: () => [] },
    notifDot: { hidden: true, textContent: '', setAttribute(name, value) { this[name] = value; } },
    notifUnread: { textContent: '' }, notifPagination: { hidden: false }, notifPageNumbers: {},
    notifSelect: { value: 'none' }, notifSelectedLabel: { textContent: '' }, notifMarkSelected: { disabled: false },
    notifPage: 2, notifTotalCount: 0, notifGeneration: 0, notifItems: [],
    selectedNotifKeys: new Set(), NOTIF_LIMIT: 10, syncCustomerNotificationSelection() {},
    renderCustomerPageNumbers() {}, notificationTime: () => 'Today',
    window: { inigosyncProfile: {}, escapeHtml: String, sb: { rpc: async (_name, args) => {
      calls.push(args.p_offset);
      return { data: { rows: [{ key: `page-${args.p_offset}`, title: 'Remaining notice', read_at: null }], total_count: 10, unread_count: 1 }, error: null };
    } } },
    document: { querySelector: () => ({ disabled: false }) }, Number, String, console,
  };
  runInNewContext(`${source.slice(start, end)}\nglobalThis.load = loadCustomerNotifications;`, context);
  await context.load();

  assert.deepEqual(calls, [20, 0]);
  assert.equal(context.notifPage, 0);
  assert.match(context.notifList.innerHTML, /Remaining notice/);
});
