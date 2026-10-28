// Fixed, local FAQs for signed-in customers. Answers use the current
// dashboard flow and existing venue contact details; no free-text is sent.
(function () {
    'use strict';

    const LINKS = Object.freeze({
        booking: { label: 'Open Book a Court', href: '#booking', nav: 'booking' },
        bookings: { label: 'Open My Bookings & Visits', href: '#bookings', nav: 'bookings' },
        receipts: { label: 'Open Receipts', href: '#receipts', nav: 'receipts' },
        terms: { label: 'Read Terms & Conditions', href: 'terms.html' },
        directions: {
            label: 'Get directions',
            href: 'https://www.google.com/maps/dir/?api=1&destination=Inigo%27s%20Sports%20Center%20Lucena&destination_place_id=ChIJYWSThmFMvTMRnoWVEJzixOY',
            external: true
        },
        phone: { label: '+63 928 154 6876', href: 'tel:+639281546876' },
        email: { label: 'itsrosem8@gmail.com', href: 'mailto:itsrosem8@gmail.com' }
    });

    function courtsAnswer(context) {
        if (context.failed) {
            return {
                text: 'The current sports and rates are unavailable right now. Open Book a Court to try again or contact the sports center:',
                links: [LINKS.booking, LINKS.phone]
            };
        }
        const courts = Array.isArray(context.courts) ? context.courts : [];
        if (!courts.length) {
            return {
                text: 'There are no active sports listed right now. Please contact the sports center to check availability:',
                links: [LINKS.booking, LINKS.phone]
            };
        }
        const items = courts.map(court => {
            const name = String(court.sportName || court.name || '').trim();
            const rate = String(context.rateHint?.(court) || '').trim() || 'Rate not shown';
            return name ? `${name} — ${rate}` : '';
        }).filter(Boolean);
        return {
            text: `Current sports and rates (${items.length}): ${items.join('; ')}. The rate for your selected court and time is shown in the booking review.`,
            links: [LINKS.booking]
        };
    }

    function answerQuestion(key, context = {}) {
        const answers = {
            booking: {
                text: 'Choose a sport and court, add dates and consecutive time ranges, then review your booking and payment choice. Your booking is confirmed after online payment is verified.',
                links: [LINKS.booking]
            },
            sports: courtsAnswer(context),
            cart: {
                text: 'Yes. Add as many court bookings as you need to your booking cart, then review them together before checkout.',
                links: [LINKS.booking]
            },
            payment: {
                text: 'Choose the available downpayment or full-payment option in the booking review. PayMongo shows any method-dependent processing fee and the final total before you authorize payment; a remaining balance, if any, is due at check-in.',
                links: [LINKS.booking]
            },
            records: {
                text: 'Open My Bookings & Visits to see online bookings, linked walk-in visits, and their statuses. Open Receipts to find and view payment acknowledgments.',
                links: [LINKS.bookings, LINKS.receipts]
            },
            policy: {
                text: 'Bookings cannot be cancelled through self-service, and completed payments are non-refundable. The Terms & Conditions state a 30-minute grace period and no-show cancellation. Check the notice at the top of My Bookings & Visits for the current venue grace period; no-show bookings are not refunded or rescheduled.',
                links: [LINKS.terms, LINKS.bookings]
            },
            location: {
                text: 'Iñigos Sports Center is on Lucena Diversion Road (AH26), Brgy. Bocohan, Lucena City, Quezon, Philippines. Call +63 928 154 6876 or email itsrosem8@gmail.com.',
                links: [LINKS.directions, LINKS.phone, LINKS.email]
            }
        };
        return answers[key] || {
            text: 'Choose a question below for help with booking, sports and rates, payments, records, policies, or location.',
            links: []
        };
    }

    function canAppendAsyncAnswer(requestedSession, currentSession, isOpen) {
        return isOpen && requestedSession === currentSession;
    }

    const api = Object.freeze({ answerQuestion, canAppendAsyncAnswer });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.InigoCustomerFaq = api;
    if (typeof document === 'undefined') return;

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
    let faqSession = 0;

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

    function appendAnswer(answer) {
        const message = appendMessage(answer.text, 'assistant');
        (answer.links || []).forEach((item, index) => {
            if (index) message.append(document.createTextNode(' · '));
            const link = document.createElement('a');
            link.href = item.href;
            link.textContent = item.label;
            if (item.nav) link.dataset.customerFaqNav = item.nav;
            if (item.external) {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }
            message.append(link);
        });
        log.scrollTop = log.scrollHeight;
    }

    async function renderAnswer(key, session) {
        if (key !== 'sports') {
            appendAnswer(answerQuestion(key));
            return;
        }
        try {
            const data = window.InigoCourtsData;
            if (!data?.getCourts) throw new Error('Court data is unavailable');
            const courts = await data.getCourts();
            if (!canAppendAsyncAnswer(session, faqSession, !overlay.hidden)) return;
            appendAnswer(answerQuestion(key, { courts, rateHint: data.rateHint }));
        } catch {
            if (!canAppendAsyncAnswer(session, faqSession, !overlay.hidden)) return;
            appendAnswer(answerQuestion(key, { failed: true }));
        }
    }

    function openFaq() {
        if (!overlay.hidden) return;
        faqSession += 1;
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : launcher;
        log.replaceChildren();
        appendMessage('Hi! Choose a question below. Your booking is confirmed after online payment is verified.', 'assistant');
        overlay.hidden = false;
        launcher.hidden = true;
        launcher.setAttribute('aria-expanded', 'true');
        document.body.classList.add('customer-faq-open');
        (questions[0] || dialog).focus({ preventScroll: true });
    }

    function closeFaq() {
        if (overlay.hidden) return;
        faqSession += 1;
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
        question.addEventListener('click', async () => {
            appendMessage(question.textContent.trim(), 'user');
            await renderAnswer(question.dataset.customerFaqQuestion, faqSession);
        });
    });
    log.addEventListener('click', event => {
        const link = event.target.closest('[data-customer-faq-nav]');
        if (!link) return;
        event.preventDefault();
        const navigation = document.querySelector(`[data-dash-nav="${link.dataset.customerFaqNav}"]`);
        closeFaq();
        navigation?.click();
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
