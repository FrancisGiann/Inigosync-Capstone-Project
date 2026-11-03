import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');
const start = source.indexOf('    // Match the customer and staff portals: reveal the sticky owner header');
const end = source.indexOf('    // Logout is wired in includes/authGuard.js', start);
assert.ok(start >= 0 && end > start, 'owner topbar scroll controller is present');
const controller = source.slice(start, end);

function createHarness() {
    const listeners = new Map();
    const classes = new Set();
    const attributes = new Map();
    const bodyClasses = new Set();
    const animationFrames = [];
    let activeElement = null;
    let scrollY = 0;
    let profileCloseCount = 0;
    const topbar = {
        classList: {
            add: name => classes.add(name),
            remove: name => classes.delete(name),
        },
        addEventListener: (name, callback) => listeners.set(`topbar:${name}`, callback),
        contains: element => element?.insideTopbar === true,
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: name => attributes.delete(name),
    };
    runInNewContext(controller, {
        document: {
            body: { classList: { contains: name => bodyClasses.has(name) } },
            get activeElement() { return activeElement; },
            querySelector: selector => selector === '.admin-topbar' ? topbar : null,
        },
        window: {
            get scrollY() { return scrollY; },
            addEventListener: (name, callback) => listeners.set(`window:${name}`, callback),
            requestAnimationFrame: callback => animationFrames.push(callback),
        },
        MutationObserver: class { observe() {} },
        closeProfileMenu: () => { profileCloseCount += 1; },
    });
    return {
        classes, attributes, listeners, bodyClasses,
        setScrollY(value) {
            scrollY = value;
            listeners.get('window:scroll')();
            while (animationFrames.length) animationFrames.shift()();
        },
        focus() {
            const control = { insideTopbar: true, blur() { activeElement = null; } };
            activeElement = control;
            listeners.get('topbar:focusin')();
            return control;
        },
        get activeElement() { return activeElement; },
        get profileCloseCount() { return profileCloseCount; },
        resetProfileCloseCount() { profileCloseCount = 0; },
    };
}

test('owner topbar hides on sustained downward scroll and returns on reverse scroll', () => {
    const harness = createHarness();
    harness.setScrollY(120);
    assert.ok(harness.classes.has('is-hidden'));
    assert.equal(harness.attributes.get('aria-hidden'), 'true');
    assert.equal(harness.attributes.get('inert'), '');

    harness.setScrollY(100);
    assert.ok(!harness.classes.has('is-hidden'));
    assert.ok(!harness.attributes.has('aria-hidden'));
    assert.ok(!harness.attributes.has('inert'));
});

test('owner header controls remain accessible and hiding closes the profile menu', () => {
    const harness = createHarness();
    harness.setScrollY(120);
    const focusedControl = harness.focus();
    assert.ok(!harness.classes.has('is-hidden'));
    assert.ok(!harness.attributes.has('inert'));

    harness.resetProfileCloseCount();
    harness.setScrollY(145);
    assert.ok(harness.classes.has('is-hidden'));
    assert.equal(harness.profileCloseCount, 1);
    assert.equal(harness.activeElement, null);
    assert.equal(focusedControl.insideTopbar, true);

    harness.setScrollY(125);
    assert.ok(!harness.classes.has('is-hidden'));
    assert.ok(!harness.attributes.has('inert'));
});

test('owner topbar stays visible near the page top and while the mobile sidebar is open', () => {
    const harness = createHarness();
    harness.setScrollY(40);
    assert.ok(!harness.classes.has('is-hidden'));

    harness.bodyClasses.add('admin-sidebar-open');
    harness.setScrollY(100);
    assert.ok(!harness.classes.has('is-hidden'));
});
