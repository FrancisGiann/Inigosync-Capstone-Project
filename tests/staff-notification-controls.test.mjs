import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');

test('staff notification selection modes match page items and enable the read action', () => {
    const start = source.indexOf('    function syncStaffNotificationSelection() {');
    const end = source.indexOf('    function staffNotificationCategoryLabel(value) {', start);
    assert.ok(start >= 0 && end > start);
    const selected = new Set();
    const checkboxes = [
        { dataset: { staffNotifSelectRow: 'unread-1' }, checked: false, closest: () => ({ classList: { toggle() {} } }) },
        { dataset: { staffNotifSelectRow: 'read-1' }, checked: false, closest: () => ({ classList: { toggle() {} } }) },
        { dataset: { staffNotifSelectRow: 'unread-2' }, checked: false, closest: () => ({ classList: { toggle() {} } }) },
    ];
    const context = {
        staffNotifList: { querySelectorAll: () => checkboxes },
        staffNotifSelectedLabel: { textContent: '' },
        staffNotifMarkSelected: { disabled: true },
        staffNotifMarkSelectedInProgress: false,
        selectedStaffNotifKeys: selected,
        staffNotifItems: [
            { key: 'unread-1', read_at: null },
            { key: 'read-1', read_at: '2026-10-06T01:40:00Z' },
            { key: 'unread-2', read_at: null },
        ],
    };
    runInNewContext(`${source.slice(start, end)}\nglobalThis.select = applyStaffNotificationSelection;`, context);

    context.select('unread');
    assert.deepEqual(Array.from(selected), ['unread-1', 'unread-2']);
    assert.equal(context.staffNotifSelectedLabel.textContent, '2 selected');
    assert.equal(context.staffNotifMarkSelected.disabled, false);
    assert.deepEqual(checkboxes.map(item => item.checked), [true, false, true]);
    context.select('read');
    assert.deepEqual(Array.from(selected), ['read-1']);
    context.select('none');
    assert.deepEqual(Array.from(selected), []);
    assert.equal(context.staffNotifMarkSelected.disabled, true);
});

test('staff notification loader requests the selected page and updates pagination state', async () => {
    const start = source.indexOf('    async function loadStaffNotifications() {');
    const end = source.indexOf('    if (staffNotifTrigger && staffNotif) {', start);
    assert.ok(start >= 0 && end > start);
    const calls = [];
    const context = {
        staffNotifList: { innerHTML: '', querySelectorAll: () => [], addEventListener() {} },
        staffNotifDot: { hidden: true },
        staffNotifSelect: { value: 'all', addEventListener() {} },
        staffNotifSelectedLabel: { textContent: '' },
        staffNotifMarkSelected: { disabled: false },
        staffNotifPagination: { hidden: false },
        staffNotifPageLabel: { textContent: '' },
        staffNotifPrev: { disabled: false },
        staffNotifNext: { disabled: false },
        staffNotifGeneration: 0,
        staffNotifUnreadCount: 0,
        staffNotifPage: 2,
        staffNotifTotalCount: 0,
        staffNotifItems: [],
        selectedStaffNotifKeys: new Set(['old-selection']),
        STAFF_NOTIF_LIMIT: 10,
        staffNotifMarkSelectedInProgress: false,
        syncStaffNotificationSelection() {},
        renderStaffNotification: item => `<div class="notice">${item.title}</div>`,
        window: {
            escapeHtml: value => String(value),
            sb: { rpc: async (name, args) => {
                calls.push({ name, args });
                return { data: { rows: [{ key: 'older-1', title: 'Older notice', read_at: null }], total_count: 23, unread_count: 4 }, error: null };
            } },
        },
        Math, Number, String, console,
    };
    runInNewContext(`${source.slice(start, end)}\nglobalThis.load = loadStaffNotifications;`, context);
    await context.load();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'staff_list_notifications');
    assert.equal(calls[0].args.p_offset, 20);
    assert.equal(calls[0].args.p_limit, 10);
    assert.equal(context.staffNotifPageLabel.textContent, 'Page 3 of 3');
    assert.equal(context.staffNotifPagination.hidden, false);
    assert.equal(context.staffNotifPrev.disabled, false);
    assert.equal(context.staffNotifNext.disabled, true);
    assert.match(context.staffNotifList.innerHTML, /Older notice/);
    assert.deepEqual(Array.from(context.selectedStaffNotifKeys), []);
    assert.equal(context.staffNotifSelect.value, 'none');
});

test('staff notification page controls move backward and forward within available pages', () => {
    const start = source.indexOf('    staffNotifPrev?.addEventListener(\'click\'');
    const end = source.indexOf('    staffNotifList?.addEventListener(\'click\', async event => {', start);
    assert.ok(start >= 0 && end > start);
    const handlers = {};
    const loadedPages = [];
    const context = {
        staffNotifPrev: { addEventListener: (_name, fn) => { handlers.previous = fn; } },
        staffNotifNext: { addEventListener: (_name, fn) => { handlers.next = fn; } },
        staffNotifPage: 0,
        staffNotifTotalCount: 25,
        STAFF_NOTIF_LIMIT: 10,
        staffNotifMarkSelected: { addEventListener() {} },
        loadStaffNotifications: () => loadedPages.push(context.staffNotifPage),
    };
    context.handlers = handlers;
    runInNewContext(`${source.slice(start, end)}\nglobalThis.handlers = handlers;`, context);

    context.handlers.next();
    assert.equal(context.staffNotifPage, 1);
    assert.deepEqual(loadedPages, [1]);
    context.handlers.previous();
    assert.equal(context.staffNotifPage, 0);
    assert.deepEqual(loadedPages, [1, 0]);
    context.handlers.previous();
    assert.deepEqual(loadedPages, [1, 0], 'previous is inert on the first page');
});
