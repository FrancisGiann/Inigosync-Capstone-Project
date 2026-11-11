// Keep password-entry fields from exposing their contents through clipboard
// actions, including while an existing visibility toggle shows the text.
(function () {
    'use strict';

    const PASSWORD_ENTRY_SELECTOR = 'input[type="password"], input[data-password-entry]';
    const CLIPBOARD_SHORTCUTS = new Set(['c', 'x', 'v', 'insert']);

    function markPasswordEntries(root) {
        if (root instanceof Element && root.matches('input[type="password"]')) {
            root.setAttribute('data-password-entry', '');
        }

        if (root.querySelectorAll) {
            root.querySelectorAll('input[type="password"]').forEach((input) => {
                input.setAttribute('data-password-entry', '');
            });
        }
    }

    function isPasswordEntry(target) {
        return target instanceof Element && target.closest(PASSWORD_ENTRY_SELECTOR) !== null;
    }

    function blockClipboardEvent(event) {
        if (!isPasswordEntry(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    function blockClipboardShortcut(event) {
        if (!isPasswordEntry(event.target)) return;

        const key = String(event.key || '').toLowerCase();
        const hasClipboardModifier = event.ctrlKey || event.metaKey;
        const isClipboardKey = hasClipboardModifier && CLIPBOARD_SHORTCUTS.has(key)
            || event.shiftKey && (key === 'insert' || key === 'delete');

        if (isClipboardKey) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }

    markPasswordEntries(document);

    // Mark future password fields too. The marker survives a UI visibility
    // toggle that changes the input's type to text.
    if (typeof MutationObserver === 'function' && document.documentElement) {
        new MutationObserver((records) => {
            records.forEach((record) => {
                record.addedNodes.forEach(markPasswordEntries);
                if (record.type === 'attributes' && record.target.matches('input[type="password"]')) {
                    record.target.setAttribute('data-password-entry', '');
                }
            });
        }).observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['type']
        });
    }

    ['copy', 'cut', 'paste', 'drop', 'dragstart', 'contextmenu'].forEach((type) => {
        document.addEventListener(type, blockClipboardEvent, true);
    });
    document.addEventListener('keydown', blockClipboardShortcut, true);
})();
