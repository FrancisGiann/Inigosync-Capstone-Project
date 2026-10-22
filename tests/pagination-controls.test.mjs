import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const ownerScript = (await readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const staffScript = await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');
const customerScript = await readFile(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
const [ownerHtml, staffHtml, customerHtml] = await Promise.all([
    readFile(new URL('../Pages/owner_dashboard.html', import.meta.url), 'utf8'),
    readFile(new URL('../Pages/staff_dashboard.html', import.meta.url), 'utf8'),
    readFile(new URL('../Pages/user_dashboard.html', import.meta.url), 'utf8'),
]);

function fakeElement() {
    const attributes = new Map();
    return {
        children: [],
        listeners: {},
        disabled: false,
        hidden: false,
        className: '',
        textContent: '',
        innerHTML: '',
        replaceChildren(...children) { this.children = children; },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        addEventListener(name, callback) { this.listeners[name] = callback; },
        hasAttribute(name) { return attributes.has(name); },
    };
}

function ownerPageNumberRenderer() {
    const start = ownerScript.indexOf('    function renderOwnerPageNumbers(');
    const end = ownerScript.indexOf('\n\n    // ------------------------------------------------------------------\n    // Panel switching', start);
    assert.ok(start >= 0 && end > start, 'owner page-number renderer is present');
    const context = { document: { createElement: () => fakeElement() } };
    runInNewContext(`${ownerScript.slice(start, end)}\nglobalThis.render = renderOwnerPageNumbers;`, context);
    return { render: context.render, document: context.document };
}

test('owner numbered pagination marks the active page and always renders the last page', () => {
    const { render } = ownerPageNumberRenderer();
    const container = fakeElement();
    render(container, 8, 20, () => {});
    const buttons = container.children.filter(child => child.tagName !== 'span' && child.className.includes('owner-page-number'));
    assert.deepEqual(buttons.map(button => button.textContent), ['1', '7', '8', '9', '20']);
    assert.equal(buttons.find(button => button.getAttribute('aria-current') === 'page')?.textContent, '8');
    assert.equal(buttons.at(-1).getAttribute('aria-label'), 'Page 20');
});

test('numbered pagers omit Page X of Y labels across dashboards', () => {
    assert.doesNotMatch(ownerHtml + staffHtml + customerHtml, /Page\s+\d+\s+of\s+\d+/);
    assert.doesNotMatch(ownerScript + staffScript + customerScript, /Page\s+\$\{[^}]+\}\s+of\s+\$\{/);
});

test('a newer owner review page request wins over an older in-flight request', async () => {
    const start = ownerScript.indexOf('    async function loadOwnerReviewBrowser(force = false) {');
    const end = ownerScript.indexOf('    function renderFeaturedReviewSlots()', start);
    assert.ok(start >= 0 && end > start, 'owner review browser loader is present');

    const requests = [];
    const list = fakeElement();
    const pager = fakeElement();
    const previous = fakeElement();
    const next = fakeElement();
    const pageNumbers = fakeElement();
    const elements = new Map([
        ['[data-owner-review-prev]', previous],
        ['[data-owner-review-next]', next],
        ['[data-owner-review-page-numbers]', pageNumbers],
    ]);
    const context = {
        ownerReviewBrowser: list,
        ownerReviewBrowserPager: pager,
        ownerReviewBrowserLoading: false,
        ownerReviewBrowserLoaded: false,
        ownerReviewBrowserPage: 0,
        ownerReviewBrowserFilter: 'all',
        ownerReviewBrowserRequest: 0,
        featuredReviewDetails: new Map(),
        REVIEW_PAGE_SIZE: 10,
        document: {
            querySelector: selector => elements.get(selector) || null,
            createElement: () => fakeElement(),
        },
        window: {
            escapeHtml: value => String(value),
            sb: {
                from() {
                    let resolveRequest;
                    const request = { offset: null, promise: new Promise(resolve => { resolveRequest = resolve; }), resolve: value => resolveRequest(value) };
                    requests.push(request);
                    const query = {
                        select() { return this; },
                        order() { return this; },
                        range(offset) { request.offset = offset; return this; },
                        then(resolve, reject) { return request.promise.then(resolve, reject); },
                    };
                    return query;
                },
            },
        },
        console,
    };
    const { render } = ownerPageNumberRenderer();
    context.renderOwnerPageNumbers = render;
    runInNewContext(`${ownerScript.slice(start, end)}\nglobalThis.load = loadOwnerReviewBrowser;`, context);

    const firstRequest = context.load(false);
    context.ownerReviewBrowserPage = 1;
    const secondRequest = context.load(true);
    assert.deepEqual(requests.map(request => request.offset), [0, 10]);

    requests[1].resolve({ data: [{ id: 'page-two', rating: 5, comment: 'Second page', created_at: '2026-10-01T00:00:00Z' }], count: 20, error: null });
    await secondRequest;
    requests[0].resolve({ data: [{ id: 'page-one', rating: 5, comment: 'First page', created_at: '2026-09-01T00:00:00Z' }], count: 20, error: null });
    await firstRequest;

    assert.match(list.innerHTML, /Second page/);
    assert.doesNotMatch(list.innerHTML, /First page/);
    assert.equal(pageNumbers.children.find(button => button.getAttribute('aria-current') === 'page')?.textContent, '2');
    assert.equal(list.getAttribute('aria-busy'), 'false');
});
