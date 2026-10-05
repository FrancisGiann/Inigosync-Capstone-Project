// Fixed, local FAQs for signed-in customers. Answers use the current
// dashboard flow and existing venue contact details; no free-text is sent.
(function () {
    'use strict';

    const ANSWERS = Object.freeze({
        booking: 'Open Book a Court, choose a sport and court, then select an available date and time. Review your booking and payment choice before continuing to checkout.',
        sports: 'Open Book a Court to see the current sports, courts, and rates. The booking review shows the amount for your selected court and time before checkout.',
        cart: 'Yes. Add another booking from the booking flow. The dashboard currently allows up to eight court bookings in one checkout; your selected items appear in the booking cart.',
        payment: 'Choose a downpayment or full payment option on the booking screen. It shows the current percentage and estimated amount before checkout. A remaining balance, if any, is paid at check-in.',
        records: 'Open My Bookings to see your bookings and statuses. Open Receipts to view payment acknowledgments and linked walk-in visits.',
        policy: 'Customers cannot cancel bookings themselves, and completed payments are non-refundable. For the current check-in grace period and no-show policy, read the notice at the top of My Bookings.',
        contact: 'Iñigos Sports Center is at Brgy. Bocohan, Diversion Road, Lucena City, Quezon, Philippines. Call +63 928 154 6876, email itsrosem8@gmail.com, or open the map:'
    });
    const LINKS = Object.freeze([
        { label: 'Call the sports center', href: 'tel:+639281546876' },
        { label: 'Email the sports center', href: 'mailto:itsrosem8@gmail.com' },
        { label: 'View directions', href: 'https://www.google.com/maps?q=I%C3%B1igos%20Sports%20Center%20Brgy.%20Bocohan%20Lucena%20City&z=15', external: true }
    ]);

    const launcher = document.querySelector('[data-customer-faq-open]');
    const overlay = document.querySelector('[data-customer-faq-overlay]');
    const dialog = document.querySelector('[data-customer-faq-dialog]');
    const closeButton = document.querySelector('[data-customer-faq-close]');
    const log = document.querySelector('[data-customer-faq-log]');
    if (!launcher || !overlay || !dialog || !closeButton || !log) return;

    const questions = [...dialog.querySelectorAll('[data-customer-faq-question]')];
    let returnFocus = launcher;
    let drag = null;
    let wasMoved = false;
    let suppressClickUntil = 0;

    function placeLauncher(left, top) {
        const margin = 8;
        const maxLeft = Math.max(margin, window.innerWidth - launcher.offsetWidth - margin);
        const maxTop = Math.max(margin, window.innerHeight - launcher.offsetHeight - margin);
        launcher.style.left = `${Math.min(maxLeft, Math.max(margin, left))}px`;
        launcher.style.top = `${Math.min(maxTop, Math.max(margin, top))}px`;
        launcher.style.right = 'auto';
        launcher.style.bottom = 'auto';
    }

    launcher.addEventListener('pointerdown', event => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        const rect = launcher.getBoundingClientRect();
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
        launcher.setPointerCapture(event.pointerId);
    });
    launcher.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.id) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 7) return;
        drag.moved = true;
        wasMoved = true;
        launcher.classList.add('is-dragging');
        placeLauncher(drag.left + dx, drag.top + dy);
    });
    function finishDrag(event) {
        if (!drag || event.pointerId !== drag.id) return;
        if (drag.moved) suppressClickUntil = Date.now() + 500;
        drag = null;
        launcher.classList.remove('is-dragging');
    }
    launcher.addEventListener('pointerup', finishDrag);
    launcher.addEventListener('pointercancel', finishDrag);
    window.addEventListener('resize', () => {
        if (!wasMoved) return; // CSS keeps the default lower-right position responsive.
        const rect = launcher.getBoundingClientRect();
        placeLauncher(rect.left, rect.top);
    });

    function appendMessage(text, role) {
        const message = document.createElement('p');
        message.className = `customer-faq-message is-${role}`;
        message.textContent = text;
        log.append(message);
        log.scrollTop = log.scrollHeight;
        return message;
    }

    function renderAnswer(key) {
        if (!ANSWERS[key]) return;
        const message = appendMessage(ANSWERS[key], 'assistant');
        if (key === 'contact') {
            message.append(document.createElement('br'), document.createElement('br'));
            LINKS.forEach((item, index) => {
                if (index) message.append(document.createTextNode(' · '));
                const link = document.createElement('a');
                link.href = item.href;
                link.textContent = item.label;
                if (item.external) {
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                }
                message.append(link);
            });
        }
        log.scrollTop = log.scrollHeight;
    }

    function openFaq() {
        if (!overlay.hidden) return;
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : launcher;
        log.replaceChildren();
        appendMessage('Hi! I can help with booking, sports and rates, payments, receipts, directions, or contact details.', 'assistant');
        overlay.hidden = false;
        launcher.hidden = true;
        launcher.setAttribute('aria-expanded', 'true');
        document.body.classList.add('customer-faq-open');
        (questions[0] || dialog).focus({ preventScroll: true });
    }

    function closeFaq() {
        if (overlay.hidden) return;
        overlay.hidden = true;
        launcher.hidden = false;
        launcher.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('customer-faq-open');
        (returnFocus?.isConnected ? returnFocus : launcher).focus({ preventScroll: true });
    }

    launcher.addEventListener('click', event => {
        if (Date.now() < suppressClickUntil) {
            event.preventDefault();
            return;
        }
        openFaq();
    });
    closeButton.addEventListener('click', closeFaq);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) closeFaq();
    });
    questions.forEach(question => {
        question.addEventListener('click', () => {
            appendMessage(question.textContent.trim(), 'user');
            renderAnswer(question.dataset.customerFaqQuestion);
        });
    });
    document.addEventListener('keydown', event => {
        if (overlay.hidden) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            closeFaq();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...dialog.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
            .filter(element => element.getClientRects().length > 0);
        if (!focusable.length) {
            event.preventDefault();
            dialog.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!dialog.contains(document.activeElement)
            || (event.shiftKey && document.activeElement === first)
            || (!event.shiftKey && document.activeElement === last)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        }
    }, true);
})();
