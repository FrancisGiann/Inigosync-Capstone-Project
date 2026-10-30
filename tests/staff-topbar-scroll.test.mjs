import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');
const start = source.indexOf('    // Match the landing/customer dashboards: hide the sticky topbar');
const end = source.indexOf('    staffNotifPrev?.addEventListener', start);
assert.ok(start >= 0 && end > start, 'staff topbar scroll controller is present');
const controller = source.slice(start, end);

function createHarness() {
    const listeners = new Map();
    const classes = new Set();
    const attributes = new Map();
    let activeElement = null;
    let scrollY = 0;
    let profileCloseCount = 0;
    let notificationCloseCount = 0;
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
    const bodyClasses = new Set();
    const context = {
        document: {
            body: { classList: { contains: name => bodyClasses.has(name) } },
            get activeElement() { return activeElement; },
            querySelector: selector => selector === '.staff-topbar' ? topbar : null,
        },
        window: {
            get scrollY() { return scrollY; },
            addEventListener: (name, callback) => listeners.set(`window:${name}`, callback),
            requestAnimationFrame: callback => callback(),
        },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe() {}
        },
        closeProfileMenu: () => { profileCloseCount += 1; },
        closeStaffNotifMenu: () => { notificationCloseCount += 1; },
    };
    runInNewContext(controller, context);

    return {
        classes, attributes, listeners, topbar, bodyClasses,
        setScrollY(value) { scrollY = value; listeners.get('window:scroll')(); },
        focus(element = { insideTopbar: true, blur() { activeElement = null; } }) {
            activeElement = element;
            listeners.get('topbar:focusin')();
            return element;
        },
        focusOut() { listeners.get('topbar:focusout')(); },
        resetCloseCounts() { profileCloseCount = 0; notificationCloseCount = 0; },
        get activeElement() { return activeElement; },
        get closeCounts() { return [profileCloseCount, notificationCloseCount]; },
    };
}

test('staff topbar hides while scrolling down and returns after reverse scroll', () => {
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

test('header control focus reveals the bar and hiding closes menus and blurs focus', () => {
    const harness = createHarness();
    harness.setScrollY(120);
    const focusedControl = harness.focus();
    assert.ok(!harness.classes.has('is-hidden'));
    assert.ok(!harness.attributes.has('inert'));

    harness.resetCloseCounts();
    harness.setScrollY(145);
    assert.ok(harness.classes.has('is-hidden'));
    assert.deepEqual(harness.closeCounts, [1, 1]);
    assert.equal(focusedControl.insideTopbar, true);
    assert.equal(harness.activeElement, null);

    harness.setScrollY(125);
    assert.ok(!harness.classes.has('is-hidden'));
    assert.ok(!harness.attributes.has('inert'));
});

test('topbar stays visible near the page top and while the mobile sidebar is open', () => {
    const harness = createHarness();
    harness.setScrollY(40);
    assert.ok(!harness.classes.has('is-hidden'));

    harness.bodyClasses.add('staff-sidebar-open');
    harness.setScrollY(100);
    assert.ok(!harness.classes.has('is-hidden'));
});
