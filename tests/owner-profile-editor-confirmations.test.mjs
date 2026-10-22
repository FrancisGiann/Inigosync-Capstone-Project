import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = (await readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const html = (await readFile(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

class FakeElement {
    constructor(value = '') {
        this.value = value;
        this.hidden = false;
        this.disabled = false;
        this.listeners = new Map();
        this.children = new Map();
    }
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    querySelector(selector) { return this.children.get(selector) || null; }
    querySelectorAll() { return []; }
    closest() { return this.modal || null; }
    async dispatch(type, event = {}) {
        for (const listener of this.listeners.get(type) || []) await listener({ target: this, currentTarget: this, ...event });
    }
}

test('declining owner profile discard keeps the draft and leaves the modal open', async () => {
    const profileButton = new FakeElement();
    const modal = new FakeElement();
    modal.hidden = false;
    profileButton.modal = modal;
    modal.children.set('[data-admin-settings-cancel="profile"]', profileButton);
    const fields = new Map([
        ['[data-admin-settings-name]', new FakeElement('Unsaved owner name')],
        ['[data-admin-settings-mobile]', new FakeElement('')],
        ['[data-admin-settings-address]', new FakeElement('Saved address')],
        ['[data-admin-settings-birthdate]', new FakeElement('')],
        ['[data-admin-settings-gender]', new FakeElement('')],
        ['[data-admin-settings-civil-status]', new FakeElement('')],
        ['[data-admin-settings-profile-modal]', modal],
    ]);
    let confirmationCount = 0;
    let closeCount = 0;
    const document = {
        querySelector(selector) { return fields.get(selector) || null; },
        querySelectorAll(selector) { return selector === '[data-admin-settings-cancel="profile"]' ? [profileButton] : []; },
    };
    const context = {
        document,
        window: {
            inigosyncProfile: { full_name: 'Saved owner name', contact_num: '', address: 'Saved address', birthdate: null, gender: '', civil_status: '' },
            validatePhMobile: () => ({ valid: true, normalized: '' }),
            InigoOwnerUI: {
                async confirm() { confirmationCount += 1; return false; },
                close() { closeCount += 1; modal.hidden = true; },
            },
        },
        renderAdminProfile() {},
        paintOwnerDetails() {},
    };
    const start = source.indexOf('    let ownerProfileClosePending = false;');
    const end = source.indexOf('    const accountModals =', start);
    assert.ok(start >= 0 && end > start, 'owner profile close guard exists');
    runInNewContext(source.slice(start, end), context);

    await profileButton.dispatch('click');

    assert.equal(confirmationCount, 1, 'Cancel asks once before discarding');
    assert.equal(closeCount, 0, 'declining discard does not close the modal');
    assert.equal(modal.hidden, false, 'the profile editor remains open');
    assert.equal(fields.get('[data-admin-settings-name]').value, 'Unsaved owner name', 'the edited value remains in the field');

    const laterCancelHandler = source.slice(source.indexOf("document.querySelectorAll('[data-admin-settings-cancel]')"));
    assert.doesNotMatch(laterCancelHandler, /mode === 'profile'/, 'the password cancel handler cannot repaint profile fields behind the guarded handler');
    assert.match(source, /modal\.querySelector\('\[data-admin-settings-cancel="profile"\]'\)\?\.click\(\)/, 'backdrop dismissal routes through the guarded Cancel control');
    assert.match(source, /accountModals\.find\(modal => !modal\.hidden\)\?\.querySelector\('\[data-admin-settings-cancel="profile"\]'\)\?\.click\(\)/, 'Escape routes through the guarded Cancel control');
});

test('owner avatar upload and removal confirm before writing the saved profile photo', () => {
    const uploadStart = source.indexOf("adminAvatarFileInput.addEventListener('change'");
    const uploadConfirm = source.indexOf("title: 'Save profile photo?'", uploadStart);
    const uploadWrite = source.indexOf('saveAdminAvatarUrl(dataUrl)', uploadConfirm);
    assert.ok(uploadStart >= 0 && uploadConfirm > uploadStart && uploadWrite > uploadConfirm, 'cropped avatar must be confirmed before persistence');

    const removeStart = source.indexOf("adminAvatarRemoveBtn?.addEventListener('click'");
    const removeConfirm = source.indexOf("title: 'Remove profile photo?'", removeStart);
    const removeWrite = source.indexOf('saveAdminAvatarUrl(null)', removeConfirm);
    assert.ok(removeStart >= 0 && removeConfirm > removeStart && removeWrite > removeConfirm, 'avatar removal must be confirmed before persistence');
    assert.match(html, /data-admin-avatar-upload-trigger/);
    assert.match(html, /data-admin-avatar-remove/);
});

test('delayed owner detail loading preserves open-editor changes and refreshes untouched fields and baseline', async () => {
    let resolveProfile;
    const profileLoad = new Promise(resolve => { resolveProfile = resolve; });
    const modal = new FakeElement();
    modal.hidden = true;
    const profile = {
        id: 'owner-1',
        full_name: 'Saved owner name',
        contact_num: '09171234567',
        address: 'Old address',
        birthdate: '1990-01-01',
        gender: 'woman',
    };
    const selectors = [
        ['[data-admin-settings-profile-modal]', modal],
        ['[data-admin-settings-name]', new FakeElement('Saved owner name')],
        ['[data-admin-settings-email]', new FakeElement()],
        ['[data-admin-profile-full-name]', new FakeElement()],
        ['[data-admin-settings-mobile]', new FakeElement('09171234567')],
        ['[data-admin-settings-address]', new FakeElement('Old address')],
        ['[data-admin-settings-birthdate]', new FakeElement('1990-01-01')],
        ['[data-admin-settings-gender]', new FakeElement('woman')],
        ['[data-admin-settings-civil-status]', new FakeElement('')],
        ['[data-admin-profile-email]', new FakeElement()],
        ['[data-admin-profile-mobile]', new FakeElement()],
        ['[data-admin-profile-birthdate]', new FakeElement()],
        ['[data-admin-profile-member-since]', new FakeElement()],
    ];
    const fieldMap = new Map(selectors);
    const document = {
        querySelector(selector) { return fieldMap.get(selector) || null; },
        querySelectorAll() { return []; },
    };
    const window = {
        inigosyncProfile: profile,
        escapeHtml: value => String(value),
        validatePhMobile(value) {
            const raw = String(value || '');
            if (/^09\d{9}$/.test(raw)) return { valid: true, normalized: `+63${raw.slice(1)}` };
            if (/^\+639\d{9}$/.test(raw)) return { valid: true, normalized: raw };
            return { valid: false, normalized: raw };
        },
        sb: {
            from(table) {
                if (table === 'profiles') return {
                    select() { return this; },
                    eq() { return this; },
                    single() { return profileLoad; },
                };
                return {
                    select() { return this; },
                    eq() { return this; },
                    maybeSingle() { return Promise.resolve({ data: { civil_status: 'married' }, error: null }); },
                };
            },
        },
        InigoToast: { show() {} },
    };
    const ownerMobileMessage = { textContent: '', dataset: {}, classList: { remove() {} } };
    const adminAvatarRemoveBtn = null;
    const computeAdminStaffAge = () => null;
    const editGuard = extractFrom(source, '    let ownerProfileClosePending = false;', '    async function cancelOwnerProfileEditing');
    const renderFunctions = extractFrom(source, '    function renderAdminProfile(profile, preserveEditorDraft = false) {', '    function formatOwnerPhoneValidationDate');
    const memberSinceLoader = extractFrom(source, '    function formatAdminMemberSince(createdAt) {', "    document.addEventListener('inigosync:profile-ready', loadAdminProfileMemberSince);");
    const context = { document, window, console, ownerMobileMessage, adminAvatarRemoveBtn, computeAdminStaffAge, ownerProfileEditBaseline: null };
    runInNewContext(`${editGuard}\n${renderFunctions}\n${memberSinceLoader}\nglobalThis.load = loadAdminProfileMemberSince; globalThis.dirty = ownerProfileDraftHasChanges; globalThis.baseline = () => ownerProfileEditBaseline; globalThis.setBaseline = value => { ownerProfileEditBaseline = value; };`, context);

    const load = context.load();
    await Promise.resolve();
    modal.hidden = false;
    context.setBaseline({ ...profile });
    fieldMap.get('[data-admin-settings-name]').value = 'Draft owner name';
    fieldMap.get('[data-admin-settings-mobile]').value = '09181234567';
    resolveProfile({
        data: { contact_num: '+639171234567', address: 'Server address', birthdate: '1990-01-01', gender: 'woman' },
        error: null,
    });
    await load;

    assert.equal(profile.address, 'Server address', 'async server values update the saved profile model');
    assert.equal(fieldMap.get('[data-admin-settings-name]').value, 'Draft owner name', 'the edited name is not repainted');
    assert.equal(fieldMap.get('[data-admin-settings-mobile]').value, '09181234567', 'the edited mobile remains in the field');
    assert.equal(fieldMap.get('[data-admin-settings-address]').value, 'Server address', 'an untouched field receives the loaded saved value');
    assert.equal(fieldMap.get('[data-admin-settings-civil-status]').value, 'married', 'late private details populate an untouched field');
    assert.equal(context.baseline().address, 'Server address', 'the edit baseline advances to the loaded saved value');
    assert.equal(context.baseline().civil_status, 'married', 'private details are included in the baseline');
    assert.equal(context.dirty(), true, 'the remaining user edits still compare as dirty');
});

function extractFrom(sourceText, startMarker, endMarker) {
    const start = sourceText.indexOf(startMarker);
    const end = sourceText.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `source block exists: ${startMarker}`);
    return sourceText.slice(start, end);
}
