// Fixed, local FAQs for signed-in customers. Answers use the current
// dashboard flow and existing venue contact details; no free-text is sent.
(function () {
    'use strict';

    const ANSWERS = Object.freeze({
        booking: 'Open Book a Court, choose a sport and court, then select an available date and time. Review your booking and payment choice before continuing to checkout.',
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
    const answer = document.querySelector('[data-customer-faq-answer]');
    if (!launcher || !overlay || !dialog || !closeButton || !answer) return;

    const questions = [...dialog.querySelectorAll('[data-customer-faq-question]')];
    let returnFocus = launcher;

    function renderAnswer(key) {
        answer.replaceChildren();
        const paragraph = document.createElement('span');
        paragraph.textContent = ANSWERS[key] || '';
        answer.append(paragraph);
        if (key === 'contact') {
            answer.append(document.createElement('br'), document.createElement('br'));
            LINKS.forEach((item, index) => {
                if (index) answer.append(document.createTextNode(' · '));
                const link = document.createElement('a');
                link.href = item.href;
                link.textContent = item.label;
                if (item.external) {
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                }
                answer.append(link);
            });
        }
        answer.hidden = !ANSWERS[key];
    }

    function openFaq() {
        if (!overlay.hidden) return;
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : launcher;
        answer.replaceChildren();
        answer.hidden = true;
        questions.forEach(question => question.setAttribute('aria-expanded', 'false'));
        overlay.hidden = false;
        launcher.setAttribute('aria-expanded', 'true');
        document.body.classList.add('customer-faq-open');
        (questions[0] || dialog).focus({ preventScroll: true });
    }

    function closeFaq() {
        if (overlay.hidden) return;
        overlay.hidden = true;
        launcher.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('customer-faq-open');
        (returnFocus?.isConnected ? returnFocus : launcher).focus({ preventScroll: true });
    }

    launcher.addEventListener('click', openFaq);
    closeButton.addEventListener('click', closeFaq);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) closeFaq();
    });
    questions.forEach(question => {
        question.addEventListener('click', () => {
            questions.forEach(item => item.setAttribute('aria-expanded', String(item === question)));
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
