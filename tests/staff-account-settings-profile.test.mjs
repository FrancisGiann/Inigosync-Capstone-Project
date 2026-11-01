import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const html = await readFile(new URL('../Pages/staff_dashboard.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');
const phoneFunction = await readFile(new URL('../supabase/functions/validate-contact-phone/index.ts', import.meta.url), 'utf8');
const css = await readFile(new URL('../Style/staff_dashboard.css', import.meta.url), 'utf8');

test('staff settings exposes phone fields through the explicit edit/save/cancel flow', () => {
    for (const field of ['name', 'address', 'birthdate', 'emergency-name']) {
        assert.match(html, new RegExp(`data-staff-settings-${field}[^>]*readonly`), `${field} starts read-only`);
    }
    for (const field of ['mobile', 'emergency-number']) {
        assert.match(html, new RegExp(`data-staff-settings-${field}[^>]*aria-describedby`), `${field} has accessible phone guidance`);
    }
    assert.match(source, /input.readOnly = !staffSettingsEditing/,
        'phone fields become editable only in profile edit mode');
    assert.match(html, /data-staff-settings-gender[^>]*disabled/, 'gender remains disabled');
    assert.match(html, /data-staff-settings-edit="profile"/, 'Edit action exists');
    assert.match(html, /data-staff-settings-save="profile" hidden/, 'Save starts hidden');
    assert.match(html, /data-staff-settings-cancel="profile" hidden/, 'Cancel starts hidden');
    assert.match(source, /if \(!staffSettingsEditing \|\| !window\.sb \|\| !window\.inigosyncProfile \|\| staffPhoneValidationBusy\) return;/,
        'save handler refuses calls unless the account is in edit mode');
    assert.match(html, /data-staff-settings-profile-modal hidden[\s\S]*?role="dialog" aria-modal="true" aria-labelledby="staffProfileModalTitle"[\s\S]*?data-staff-settings-name[\s\S]*?data-staff-settings-save="profile"/,
        'personal information fields and save action are inside an accessible dialog');
    assert.match(html, /<\/main>\s*<\/div>\s*<\/div>\s*<div class="staff-modal-overlay" data-staff-settings-profile-modal/,
        'the profile overlay is a page-level dialog outside the inert dashboard shell');
    const profileSummary = html.slice(html.indexOf('class="staff-account-personal"'), html.indexOf('<!-- Change Password'));
    for (const field of ['name', 'mobile', 'address', 'birthdate', 'gender', 'emergency-name', 'emergency-number']) {
        assert.match(profileSummary, new RegExp(`data-staff-settings-display-${field}`), `${field} appears in the saved-value summary`);
    }
    assert.doesNotMatch(profileSummary, /<input\b|<textarea\b|<select\b/, 'the card summary is read-only and inputs remain in the popup');
    assert.match(source, /\[data-staff-settings-display-mobile\]'\s*,\s*profile\.contact_num/,
        'profile rendering refreshes the saved-value summary after updates');
    assert.match(source, /staffSettingsEditBtn\?\.addEventListener\('click',[\s\S]*?setStaffSettingsEditing\(true\)[\s\S]*?staffSettingsProfileModal\.hidden = false/,
        'Edit opens the dialog in profile edit mode');
    const profileSaveHandler = source.slice(source.indexOf("staffSettingsSaveProfileBtn.addEventListener('click'"));
    assert.match(profileSaveHandler, /if \(!await confirmStaffAction\('Save these personal information changes\?'[\s\S]*?\) return;[\s\S]*?update\(fullPatch\)/,
        'confirmation cancellation exits before the database update and leaves the dialog open');
    assert.match(source, /event\.key === 'Escape'[\s\S]*?cancelStaffSettingsProfileEdit\(\)/,
        'Escape cancels the draft and closes the profile dialog');
    assert.match(source, /event\.target === staffSettingsProfileModal\) cancelStaffSettingsProfileEdit\(\)/,
        'clicking the backdrop cancels and closes the profile dialog');
    assert.match(source, /function updateStaffModalBackground\(\)[\s\S]*?document\.querySelector\('\[data-staff-settings-profile-modal\]'\)[\s\S]*?profileModal && !profileModal\.hidden/,
        'opening the profile dialog inerts the dashboard shell');
    assert.match(source, /staffConfirmModal && !staffConfirmModal\.hidden\) containStaffDialogTab\(event, staffConfirmDialog\)[\s\S]*?profileModal && !profileModal\.hidden\) containStaffDialogTab\(event, profileDialog\)/,
        'focus containment prioritizes a nested confirmation dialog over the profile dialog');
    assert.match(css, /\.staff-form-actions\s+\[data-staff-settings-save="profile"\]\[hidden\][\s\S]*?display:\s*none;/,
        'author-level button styles do not override hidden profile controls');
    assert.match(css, /\.staff-account-personal\s*>\s*\[data-staff-settings-edit="profile"\]\[hidden\]\s*\{\s*display:\s*none;/,
        'the account card Edit action stays hidden while the modal is open');
    assert.match(css, /\.staff-avatar-upload-actions\s+\[data-staff-avatar-remove\]\[hidden\][\s\S]*?display:\s*none;/,
        'author-level button styles do not expose Remove Photo without an avatar');
    assert.match(html, /data-staff-avatar-upload-trigger>Upload Photo<\/button>[\s\S]*?data-staff-avatar-remove hidden[^>]*>Remove Photo<\/button>[\s\S]*?data-staff-avatar-file/,
        'the photo card exposes direct upload, conditional removal, and file selection');
    assert.match(html, /data-staff-avatar-preview role="img" aria-live="polite"/,
        'the card preview announces whether an avatar is present');
    assert.doesNotMatch(html, /data-staff-avatar-edit|data-staff-avatar-modal|Edit Profile Photo/,
        'the separate photo editor and Edit action are removed');
    assert.match(source, /avatarPreview\.setAttribute\('aria-label', avatarUrl[\s\S]*?No profile photo; initials placeholder:/,
        'the card preview label explains when initials are standing in for a missing photo');
    assert.match(source, /if \(staffAvatarRemoveBtn\.hidden \|\| !isRenderableStaffAvatarUrl\(window\.inigosyncProfile\?\.avatar_url\)\) return;/,
        'removal is unavailable when there is no renderable avatar');
});

test('staff self-service profile payload only contains mutable fields and is scoped to the current profile', () => {
    const start = source.indexOf('            const fullPatch = {', source.indexOf('const staffSettingsSaveProfileBtn'));
    const end = source.indexOf('\n            };', start);
    assert.ok(start >= 0 && end > start, 'mutable profile patch exists');
    const patch = source.slice(start, end);
    assert.match(patch, /contact_num,/);
    assert.match(patch, /address:/);
    assert.match(patch, /emergency_contact_name:/);
    assert.match(patch, /emergency_contact_number,/);
    assert.doesNotMatch(patch, /full_name|birthdate|gender/);
    assert.match(source, /update\(fullPatch\)\.eq\('id', profileId\)/, 'the update targets the captured current profile id');
    assert.match(source, /update\(\{ contact_num \}\)\.eq\('id', profileId\)/,
        'legacy-schema fallback writes only the supported mutable phone field');
});

test('staff profile photo crop and removal both require confirmation before persistence', () => {
    const crop = source.indexOf('const croppedBlob = await window.InigoImageTools.openCropEditor(file', source.indexOf('staffAvatarFileInput.addEventListener'));
    const uploadConfirm = source.indexOf("confirmStaffAction('Save this photo as your profile photo?'", crop);
    const uploadWrite = source.indexOf('saveStaffAvatarUrl(dataUrl, profileId)', uploadConfirm);
    assert.ok(crop >= 0 && uploadConfirm > crop && uploadWrite > uploadConfirm,
        'photo is adjustable before the confirmation and persistence steps');

    const removeHandler = source.indexOf("confirmStaffAction('Are you sure you want to remove your profile photo?'");
    const removeWrite = source.indexOf('saveStaffAvatarUrl(null, profileId)', removeHandler);
    assert.ok(removeHandler >= 0 && removeWrite > removeHandler, 'removal requires confirmation before persistence');
    assert.match(source, /typeof value === 'string' && value\.length > 0 && \(value\.startsWith\('data:'\) \|\| value\.startsWith\('https:\/\/'\)\)/,
        'avatar rendering continues to allow only data and HTTPS URLs');
});

test('all staff dashboard confirmations use the accessible in-page alert dialog', () => {
    assert.match(html, /data-staff-confirm-modal hidden/);
    assert.match(html, /role="alertdialog" aria-modal="true" aria-labelledby="staffConfirmTitle" aria-describedby="staffConfirmText"/);
    assert.match(html, /data-staff-confirm-cancel/);
    assert.match(html, /data-staff-confirm-accept/);
    assert.match(css, /\.staff-modal-overlay\[hidden\]\s*\{\s*display:\s*none;/);
    assert.match(css, /\.staff-confirm-overlay\s*\{\s*z-index:\s*90;/);
    assert.doesNotMatch(source, /window\.confirm\s*\(/, 'staff dashboard has no native confirm prompts');
    for (const message of [
        'Save this photo as your profile photo?',
        'Are you sure you want to remove your profile photo?',
        'Save these personal information changes?',
        'Are you sure you want to save this new password?',
    ]) assert.ok(source.includes(message), `confirmation message exists for: ${message}`);
    assert.ok((source.match(/await confirmStaffAction\(/g) || []).length >= 7, 'profile, payment, and account confirmation flows await the custom dialog');
    assert.match(source, /await confirmStaffAction\('Discard your unsaved profile changes\?'/,
        'profile dismissal confirms before discarding an edited draft');
    assert.match(source, /event\.key === 'Escape'[\s\S]*?closeStaffConfirm\(false\)/);
    assert.match(source, /event\.key === 'Tab'[\s\S]*?last\?\.focus\(\)/);
});

test('emergency contact saves require current server format and availability confirmation', () => {
    assert.match(html, /data-staff-settings-emergency-number[^>]*aria-invalid="false"[^>]*aria-describedby="staff-emergency-phone-status"/);
    assert.match(html, /data-staff-emergency-phone-status[^>]*data-state="neutral"[^>]*aria-live="polite"/);
    assert.match(css, /data-validation-state="valid"[\s\S]*?border-color:\s*var\(--color-court-green\)/);
    assert.match(css, /data-validation-state="invalid"[\s\S]*?border-color:\s*var\(--color-alert\)/);
    assert.match(css, /\.staff-phone-status\[data-state="neutral"\][\s\S]*?color:\s*var\(--color-ink-faint\)/);
    assert.match(source, /window\.sb\.functions\.invoke\('validate-contact-phone'[\s\S]*?body:\s*\{\s*phone:\s*localCheck\.normalized,\s*purpose:\s*'emergency'\s*\}/);
    assert.match(source, /state.warning = data.available === false/);
    assert.match(source, /Already saved · shared allowed/);
    assert.match(source, /setStaffEmergencyPhoneStatus\(state\.warning \? 'warning' : 'valid'/);
    assert.match(source, /const proofIsFresh = state\.phase === 'valid'[\s\S]*?if \(proofIsFresh\) return true;/,
        'a duplicate emergency contact remains valid to save when its availability proof is fresh');
    assert.match(css, /\.staff-phone-status\[data-state="warning"\][\s\S]*?color:\s*#9a6700/,
        'duplicate emergency contact status uses the warning color');
    assert.match(source, /Date\.now\(\) - state\.validatedAt < 4 \* 60 \* 1000/);
    assert.match(source, /function ensureStaffEmergencyPhoneValidated\(\)/);
    assert.equal((source.match(/if \(!ensureStaffEmergencyPhoneValidated\(\)\) return;/g) || []).length, 2,
        'emergency-number freshness is checked before and after the confirmation dialog');
    assert.match(source, /request !== state\.request/);
    assert.match(source, /window\.validatePhMobile\(staffEmergencyNumberInput\.value\.trim\(\)\)\?\.normalized !== localCheck\.normalized/);
    assert.match(source, /update\(fullPatch\)\.eq\('id', profileId\)/, 'validated profile data remains scoped to the current profile');
    assert.doesNotMatch(source, /from\('profiles'\)\.select\([^\n]*contact_num[^\n]*\).*emergency/i,
        'the client does not query profile phone numbers for availability');
});

test('staff contact-number checks explain unapplied database setup responses', () => {
    assert.match(source, /async function staffPhoneFunctionErrorMessage\(error,[\s\S]*?context\.clone\(\)\.json\(\)[\s\S]*?body\?\.message/,
        'staff settings reads the Edge Function response instead of hiding database setup errors');
    assert.match(phoneFunction, /Phone availability database setup is incomplete\. Apply the latest Supabase migrations\./,
        'an unapplied phone availability migration has a clear remediation message');
    assert.match(source, /No profile changes were saved\./,
        'an unavailable backend still blocks the profile save');
});

test('delayed profile renders preserve mutable drafts while editing and repaint them after cancel', () => {
    const helperStart = source.indexOf('    function isRenderableStaffAvatarUrl(value) {');
    const helperEnd = source.indexOf('    async function saveStaffAvatarUrl', helperStart);
    const renderStart = source.indexOf('    function renderStaffProfile(profile) {');
    const renderEnd = source.indexOf("\n    document.addEventListener('inigosync:profile-ready'", renderStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart && renderStart > helperEnd && renderEnd > renderStart,
        'profile renderer and avatar URL helper exist');

    const selectors = [
        '[data-staff-profile-position]', '[data-staff-profile-email]', '[data-staff-profile-mobile]',
        '[data-staff-settings-display-name]', '[data-staff-settings-display-mobile]',
        '[data-staff-settings-display-address]', '[data-staff-settings-display-birthdate]',
        '[data-staff-settings-display-gender]', '[data-staff-settings-display-emergency-name]',
        '[data-staff-settings-display-emergency-number]',
        '[data-staff-settings-name]', '[data-staff-settings-mobile]', '[data-staff-settings-address]',
        '[data-staff-settings-birthdate]', '[data-staff-settings-gender]',
        '[data-staff-settings-emergency-name]', '[data-staff-settings-emergency-number]',
    ];
    const elements = new Map(selectors.map(selector => [selector, { value: '', textContent: '' }]));
    const preview = { label: '', setAttribute(name, value) { if (name === 'aria-label') this.label = value; } };
    const document = {
        querySelectorAll(selector) { return selector === '.staff-avatar' || selector === '[data-staff-profile-name]' ? [] : []; },
        querySelector(selector) { return selector === '[data-staff-avatar-preview]' ? preview : elements.get(selector) || null; },
    };
    const context = {
        document,
        window: { escapeHtml: value => String(value) },
        staffAvatarRemoveBtn: { hidden: true },
        staffSettingsEditing: true,
    };
    const helpers = source.slice(helperStart, helperEnd);
    const renderer = source.slice(renderStart, renderEnd);
    runInNewContext(`${helpers}\n${renderer}\nglobalThis.paint = renderStaffProfile;`, context);

    elements.get('[data-staff-settings-mobile]').value = 'draft mobile';
    elements.get('[data-staff-settings-address]').value = 'draft address';
    elements.get('[data-staff-settings-emergency-name]').value = 'draft emergency name';
    elements.get('[data-staff-settings-emergency-number]').value = 'draft emergency number';
    const delayedProfile = {
        full_name: 'Current Name', email: 'staff@example.test', contact_num: 'saved mobile',
        address: 'saved address', birthdate: '2000-01-01', gender: 'Female',
        emergency_contact_name: 'Saved emergency name', emergency_contact_number: 'saved emergency number',
    };
    context.paint(delayedProfile);
    assert.equal(preview.label, 'No profile photo; initials placeholder: CN');
    assert.equal(elements.get('[data-staff-settings-mobile]').value, 'draft mobile');
    assert.equal(elements.get('[data-staff-settings-address]').value, 'draft address');
    assert.equal(elements.get('[data-staff-settings-emergency-name]').value, 'draft emergency name');
    assert.equal(elements.get('[data-staff-settings-emergency-number]').value, 'draft emergency number');
    assert.equal(elements.get('[data-staff-settings-display-name]').textContent, 'Current Name');
    assert.equal(elements.get('[data-staff-settings-display-address]').textContent, 'saved address');

    context.staffSettingsEditing = false;
    context.paint(delayedProfile);
    delayedProfile.avatar_url = 'https://example.test/avatar.jpg';
    context.paint(delayedProfile);
    assert.equal(preview.label, 'Current profile photo');
    delete delayedProfile.avatar_url;
    context.paint(delayedProfile);
    assert.equal(preview.label, 'No profile photo; initials placeholder: CN');
    assert.equal(elements.get('[data-staff-settings-mobile]').value, 'saved mobile');
    assert.equal(elements.get('[data-staff-settings-address]').value, 'saved address');
    assert.equal(elements.get('[data-staff-settings-emergency-name]').value, 'Saved emergency name');
    assert.equal(elements.get('[data-staff-settings-emergency-number]').value, 'saved emergency number');
    Object.assign(delayedProfile, { contact_num: '+639171234567', address: 'New address', emergency_contact_name: 'New contact' });
    context.paint(delayedProfile);
    assert.equal(elements.get('[data-staff-settings-display-mobile]').textContent, '+639171234567');
    assert.equal(elements.get('[data-staff-settings-display-address]').textContent, 'New address');
    assert.equal(elements.get('[data-staff-settings-display-emergency-name]').textContent, 'New contact');
});

function createStaffMobileAvailabilityHarness(invoke) {
    const start = source.indexOf('    const staffMobileAvailability = {', source.indexOf('const staffSettingsMobileInput ='));
    const end = source.indexOf("    staffSettingsMobileInput?.addEventListener('input', scheduleStaffMobileAvailability);", start);
    assert.ok(start >= 0 && end > start, 'production mobile availability handler exists');
    const refreshStart = source.indexOf('    function currentStaffMobileNormalized() {', end);
    const refreshEnd = source.indexOf("    if (staffSettingsMobileInput) staffSettingsMobileInput.addEventListener('input', refreshStaffPhoneValidationUi);", refreshStart);
    assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, 'production mobile status refresh exists');
    const input = {
        value: '', dataset: {}, attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
    };
    const classes = new Set();
    const status = {
        dataset: {}, textContent: '',
        classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); } },
        get hasError() { return classes.has('is-error'); },
    };
    const callbacks = new Map();
    let timerId = 0;
    const context = {
        document: { querySelector(selector) {
            if (selector === '[data-staff-settings-mobile]') return input;
            if (selector === '[data-staff-phone-status]') return status;
            return null;
        } },
        window: {
            validatePhMobile(raw) {
                const digits = String(raw).replace(/\D/g, '');
                return /^09\d{9}$/.test(digits)
                    ? { valid: true, normalized: digits }
                    : { valid: false, message: 'Invalid format' };
            },
            sb: { functions: { invoke } },
        },
        setTimeout(callback) { const id = ++timerId; callbacks.set(id, callback); return id; },
        clearTimeout(id) { callbacks.delete(id); },
        AbortController,
    };
    runInNewContext(`
        const staffSettingsMobileInput = document.querySelector('[data-staff-settings-mobile]');
        const staffPhoneStatus = document.querySelector('[data-staff-phone-status]');
        ${source.slice(start, end)}
        ${source.slice(refreshStart, refreshEnd)}
        globalThis.checkMobile = scheduleStaffMobileAvailability;
        globalThis.refreshMobile = refreshStaffPhoneValidationUi;
    `, context);
    return {
        context, input, status,
        async runTimer() {
            const [id, callback] = callbacks.entries().next().value || [];
            assert.ok(callback, 'a debounced validation request is scheduled');
            callbacks.delete(id);
            await callback();
        },
    };
}

test('staff primary contact availability distinguishes duplicate, available, invalid, and service failure', async () => {
    const duplicate = createStaffMobileAvailabilityHarness(async () => ({
        data: { valid: false, reason: 'in_use' }, error: null,
    }));
    duplicate.input.value = '09171234567';
    duplicate.context.checkMobile();
    await duplicate.runTimer();
    assert.equal(duplicate.input.dataset.phoneAvailability, 'duplicate');
    assert.equal(duplicate.input.dataset.checkedPhone, undefined);
    assert.equal(duplicate.input.attributes['aria-invalid'], 'true');
    assert.equal(duplicate.status.dataset.state, 'in_use');
    assert.match(duplicate.status.textContent, /already registered in this app/i);
    assert.match(duplicate.status.textContent, /cannot use as primary contact/i);
    const duplicateMessage = duplicate.status.textContent;
    duplicate.context.refreshMobile();
    assert.equal(duplicate.status.textContent, duplicateMessage, 'refresh retains the duplicate explanation');
    assert.match(css, /\[data-staff-settings-mobile\]\[data-phone-availability="duplicate"\][\s\S]*?border-color:\s*var\(--color-alert\)/,
        'duplicate primary numbers retain the red invalid border');
    assert.match(css, /\[data-staff-settings-mobile\]\[data-phone-availability="failed"\][\s\S]*?border-color:\s*var\(--color-alert\)/,
        'service failures retain the red invalid border');

    const available = createStaffMobileAvailabilityHarness(async () => ({
        data: { valid: true, normalized: '+639171234567' }, error: null,
    }));
    available.input.value = '09171234567';
    available.context.checkMobile();
    await available.runTimer();
    assert.equal(available.input.dataset.phoneAvailability, 'available');
    assert.equal(available.input.dataset.checkedPhone, '09171234567');
    assert.equal(available.input.attributes['aria-invalid'], 'false');
    assert.equal(available.status.dataset.state, 'available');

    const invalid = createStaffMobileAvailabilityHarness(async () => assert.fail('invalid format must not call the service'));
    invalid.input.value = '0912';
    invalid.context.checkMobile();
    assert.equal(invalid.input.dataset.phoneAvailability, 'invalid');
    assert.equal(invalid.input.attributes['aria-invalid'], 'true');
    assert.equal(invalid.status.dataset.state, 'invalid');
    assert.match(invalid.status.textContent, /invalid format/i);

    const failure = createStaffMobileAvailabilityHarness(async () => ({ data: null, error: new Error('offline') }));
    failure.input.value = '09171234567';
    failure.context.checkMobile();
    await failure.runTimer();
    assert.equal(failure.input.dataset.phoneAvailability, 'failed');
    assert.equal(failure.input.dataset.checkedPhone, undefined);
    assert.equal(failure.input.attributes['aria-invalid'], 'true');
    assert.equal(failure.status.dataset.state, 'error');
    assert.match(failure.status.textContent, /check failed/i);
    assert.doesNotMatch(failure.status.textContent, /already registered/i);
    const failureMessage = failure.status.textContent;
    failure.context.refreshMobile();
    assert.equal(failure.status.textContent, failureMessage, 'refresh retains the service-failure message');
});

test('staff primary contact availability ignores a stale response after the draft changes', async () => {
    let resolveFirst;
    const calls = [];
    const harness = createStaffMobileAvailabilityHarness((name, options) => {
        calls.push(options);
        if (calls.length === 1) return new Promise(resolve => { resolveFirst = resolve; });
        return Promise.resolve({ data: { valid: true, normalized: '+639131234567' }, error: null });
    });
    harness.input.value = '09171234567';
    harness.context.checkMobile();
    const staleRequest = harness.runTimer();
    await Promise.resolve();

    harness.input.value = '09131234567';
    harness.context.checkMobile();
    resolveFirst({ data: { valid: false, reason: 'in_use' }, error: null });
    await staleRequest;
    assert.equal(harness.status.dataset.state, 'checking');
    assert.equal(harness.input.dataset.phoneAvailability, '');

    await harness.runTimer();
    assert.equal(calls.length, 2);
    assert.equal(harness.input.dataset.phoneAvailability, 'available');
    assert.equal(harness.input.dataset.checkedPhone, '09131234567');
    assert.equal(harness.status.dataset.state, 'available');
});
