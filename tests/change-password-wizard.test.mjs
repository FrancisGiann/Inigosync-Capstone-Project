import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const sources = {
    customer: await readFile(new URL('../includes/Dashboard.js', import.meta.url), 'utf8'),
    owner: await readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8'),
    staff: await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8'),
};

function extractFlow(role, source) {
    const starts = {
        customer: '// Change Password — verify the current password before entering step 2',
        owner: '// Change Password — 2-step wizard (Revision A1, decision A9)',
        staff: '// ---- Change Password — 2-step wizard (decision S9) ----',
    };
    const ends = {
        customer: '\n});',
        owner: '    // Owner review inbox reads only',
        staff: '    async function fetchBalanceReturnRow',
    };
    const start = source.indexOf(starts[role]);
    assert.notEqual(start, -1, `${role} wizard block exists`);
    const end = source.indexOf(ends[role], start);
    assert.notEqual(end, -1, `${role} wizard block end exists`);
    return source.slice(start, end);
}

class FakeElement {
    constructor(dataset = {}) {
        this.dataset = dataset;
        this.listeners = new Map();
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.textContent = '';
        this.attributes = new Map();
        const classes = new Set();
        this.classList = {
            toggle(name, force) {
                const enabled = force === undefined ? !classes.has(name) : force;
                if (enabled) classes.add(name);
                else classes.delete(name);
                return enabled;
            },
            contains: (name) => classes.has(name),
        };
    }

    addEventListener(name, listener) {
        const listeners = this.listeners.get(name) || [];
        listeners.push(listener);
        this.listeners.set(name, listeners);
    }

    setAttribute(name, value) { this.attributes.set(name, value); }
    async dispatch(name) {
        const results = [];
        for (const listener of this.listeners.get(name) || []) results.push(listener({ target: this }));
        return Promise.all(results);
    }
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function makeWizard(role, { signIn, confirm = true } = {}) {
    const prefix = { customer: 'dash', owner: 'admin', staff: 'staff' }[role];
    const saveSelector = `[data-${prefix}-settings-save="password"]`;
    const current = new FakeElement();
    const fresh = new FakeElement();
    const confirmation = new FakeElement();
    const next = new FakeElement();
    const back = role === 'staff' ? null : new FakeElement();
    const save = new FakeElement();
    const panels = [1, 2].map((number) => new FakeElement({ [`${prefix}PwStep`]: String(number) }));
    const indicators = [1, 2].map((number) => new FakeElement({ [`${prefix}PwStepIndicator`]: String(number) }));
    const passwordRules = ['length', 'upper', 'lower', 'number', 'special'].map((pwRule) => new FakeElement({ pwRule }));
    const rules = new FakeElement();
    rules.querySelectorAll = () => passwordRules;
    const cancel = new FakeElement({ adminSettingsCancel: 'password' });
    const selectors = new Map([
        [`[data-${prefix}-pw-current]`, current],
        [`[data-${prefix}-pw-new]`, fresh],
        [`[data-${prefix}-pw-confirm]`, confirmation],
        [`[data-${prefix}-pw-next]`, next],
        [`[data-${prefix}-pw-back]`, back],
        [saveSelector, save],
        [`[data-${prefix}-pw-rules]`, rules],
    ]);
    const lists = new Map([
        [`[data-${prefix}-pw-step]`, panels],
        [`[data-${prefix}-pw-step-indicator]`, indicators],
        ...(role === 'owner' ? [['[data-admin-settings-cancel]', [cancel]]] : []),
        ...(role === 'staff' ? [['[data-staff-settings-cancel="password"]', [cancel]]] : []),
    ]);
    const authCalls = { signIn: 0, update: 0 };
    const confirmCalls = { count: 0 };
    const session = { user: { id: 'account-1', email: 'account@example.test' } };
    const window = {
        inigosyncProfile: { id: 'account-1', email: 'account@example.test' },
        InigoToast: { show() {} },
        confirm: () => confirm,
        sb: {
            auth: {
                async getSession() { return { data: { session }, error: null }; },
                async signInWithPassword(credentials) {
                    authCalls.signIn += 1;
                    assert.equal(credentials.email, session.user.email);
                    return signIn ? signIn(credentials, authCalls.signIn) : { data: { user: session.user }, error: null };
                },
                async updateUser() { authCalls.update += 1; return { error: null }; },
                async signOut() { return { error: null }; },
            },
        },
    };
    const context = {
        window,
        document: {
            querySelector: (selector) => selectors.get(selector) || null,
            querySelectorAll: (selector) => lists.get(selector) || [],
        },
        confirmSettingsChange: async () => { confirmCalls.count += 1; return confirm; },
        recordOwnerActivity() {},
    };
    runInNewContext(extractFlow(role, sources[role]), context);
    return { current, fresh, confirmation, next, back, save, panels, cancel, authCalls, confirmCalls };
}

for (const role of ['customer', 'owner', 'staff']) {
    test(`${role} wizard rejects a wrong current password, advances after verification, and rechecks before saving`, async () => {
        const wizard = makeWizard(role, {
            signIn: async (_credentials, call) => call === 1
                ? { data: { user: { id: 'account-1' } }, error: { message: 'Invalid credentials' } }
                : { data: { user: { id: 'account-1' } }, error: null },
        });
        wizard.current.value = 'Wrong123!';
        await wizard.current.dispatch('input');
        await wizard.next.dispatch('click');
        assert.equal(wizard.panels[0].classList.contains('is-active'), true);
        assert.equal(wizard.panels[1].classList.contains('is-active'), false);

        await wizard.next.dispatch('click');
        assert.equal(wizard.panels[1].classList.contains('is-active'), true);

        for (const invalidPassword of [
            'Abcdef1',
            'StrongPassword123!',
            'abcdef1!', // missing uppercase
            'ABCDEFG1!', // missing lowercase
            'Abcdefg!', // missing digit
            'Abcdef12', // missing special character
        ]) {
            wizard.fresh.value = invalidPassword;
            wizard.confirmation.value = invalidPassword;
            await wizard.fresh.dispatch('input');
            await wizard.confirmation.dispatch('input');
            await wizard.save.dispatch('click');
        }
        assert.equal(wizard.authCalls.update, 0, 'policy failure must stop before updateUser');

        wizard.fresh.value = 'Strong1!';
        wizard.confirmation.value = 'Strong1!';
        await wizard.fresh.dispatch('input');
        await wizard.confirmation.dispatch('input');
        await wizard.save.dispatch('click');
        assert.equal(wizard.authCalls.signIn, 3, 'wrong-password attempt, successful Next check, and save-time recheck');
        assert.equal(wizard.authCalls.update, 1);
    });
}

test('owner Cancel invalidates a pending successful Next verification', async () => {
    const pending = deferred();
    const wizard = makeWizard('owner', { signIn: () => pending.promise });
    wizard.current.value = 'Correct123!';
    await wizard.current.dispatch('input');
    const nextOperation = wizard.next.dispatch('click');
    await Promise.resolve();
    await wizard.cancel.dispatch('click');
    pending.resolve({ data: { user: { id: 'account-1' } }, error: null });
    await nextOperation;
    assert.equal(wizard.panels[0].classList.contains('is-active'), true);
    assert.equal(wizard.panels[1].classList.contains('is-active'), false);
    assert.equal(wizard.current.value, '');
});

for (const role of ['customer', 'owner', 'staff']) {
    test(`${role} Back/Cancel during save reauthentication prevents updateUser and restores the wizard`, async () => {
        const pendingSaveVerification = deferred();
        const wizard = makeWizard(role, {
            signIn: (_credentials, call) => call === 2
                ? pendingSaveVerification.promise
                : Promise.resolve({ data: { user: { id: 'account-1' } }, error: null }),
        });
        wizard.current.value = 'Correct123!';
        await wizard.current.dispatch('input');
        await wizard.next.dispatch('click');
        wizard.fresh.value = 'Strong1!';
        wizard.confirmation.value = 'Strong1!';
        await wizard.fresh.dispatch('input');
        await wizard.confirmation.dispatch('input');
        assert.equal(wizard.save.disabled, false, 'valid matching password should enable Save');

        const saveOperation = wizard.save.dispatch('click');
        for (let attempt = 0; attempt < 20 && wizard.authCalls.signIn < 2; attempt += 1) await Promise.resolve();
        if (role === 'customer') assert.equal(wizard.confirmCalls.count, 1, 'customer save confirmation should resolve before reauthentication');
        assert.equal(wizard.authCalls.signIn, 2, 'save-time reauthentication should be pending');

        if (role === 'staff') await wizard.cancel.dispatch('click');
        else await wizard.back.dispatch('click');
        pendingSaveVerification.resolve({ data: { user: { id: 'account-1' } }, error: null });
        await saveOperation;

        assert.equal(wizard.authCalls.update, 0, 'a canceled save must not reach updateUser');
        assert.equal(wizard.panels[0].classList.contains('is-active'), true);
        assert.equal(wizard.panels[1].classList.contains('is-active'), false);
        assert.equal(wizard.save.disabled, true, 'hidden save control must be returned to its non-saving state');
        assert.equal(wizard.next.textContent, 'Next');
    });
}

for (const role of ['customer', 'owner', 'staff']) {
    test(`${role} wizard ignores a verification after the current password is edited`, async () => {
        const pending = deferred();
        const wizard = makeWizard(role, { signIn: () => pending.promise });
        wizard.current.value = 'FirstPass1!';
        await wizard.current.dispatch('input');
        const nextOperation = wizard.next.dispatch('click');
        await Promise.resolve();
        wizard.current.value = 'ChangedPass1!';
        await wizard.current.dispatch('input');
        pending.resolve({ data: { user: { id: 'account-1' } }, error: null });
        await nextOperation;
        assert.equal(wizard.panels[0].classList.contains('is-active'), true);
        assert.equal(wizard.panels[1].classList.contains('is-active'), false);
    });
}
