// Fixed, local FAQ for the public landing page. Answers use verified project
// behavior and current Courts & Pricing cards; no message is sent to a server.
(function () {
    'use strict';

    const LINKS = Object.freeze({
        courts: { href: '#courts', label: 'View Courts & Pricing' },
        location: { href: '#location', label: 'View the map' },
        directions: {
            href: 'https://www.google.com/maps/dir/?api=1&destination=Inigo%27s%20Sports%20Center%20Lucena&destination_place_id=ChIJYWSThmFMvTMRnoWVEJzixOY',
            label: 'Get directions'
        },
        phone: { href: 'tel:+639281546876', label: '+63 928 154 6876' },
        email: { href: 'mailto:itsrosem8@gmail.com', label: 'itsrosem8@gmail.com' },
        terms: { href: 'Pages/terms.html', label: 'Read Terms & Conditions' }
    });

    function courtsAnswer(context) {
        if (context.loading || context.failed) {
            return {
                text: 'The live Courts & Pricing list is unavailable right now, so I can’t give a reliable sports or rate list. Please try that section again or contact the sports center:',
                links: [LINKS.courts, LINKS.phone]
            };
        }
        const courts = Array.isArray(context.courts) ? context.courts : [];
        if (!courts.length) {
            return {
                text: 'There are no active sports listed in Courts & Pricing right now. Please contact the sports center to check availability:',
                links: [LINKS.courts, LINKS.phone]
            };
        }
        const items = courts.map(court => {
            const name = String(court.name || '').trim();
            const rate = String(court.rate || '').trim();
            return name ? `${name} — ${rate || 'Rate not shown'}` : '';
        }).filter(Boolean);
        return {
            text: `Current sports and rates shown in Courts & Pricing (${items.length}): ${items.join('; ')}. Rates and availability are confirmed after sign-in.`,
            links: [LINKS.courts]
        };
    }

    const ANSWERS = Object.freeze({
        booking: () => ({
            text: 'Choose one sport, court, date, and consecutive time range. Your selection stays in this browser tab and does not reserve a court. Log in or create a customer account before continuing to payment; availability and pricing are checked again after sign-in.',
            links: [LINKS.courts]
        }),
        sports: courtsAnswer,
        cart: () => ({
            text: 'The landing page handles one sport and court booking at a time. Select its date and one consecutive time range, then log in or create a customer account to continue. Your selection is not a reservation until availability is confirmed after sign-in.',
            links: [LINKS.courts]
        }),
        payment: () => ({
            text: 'You must log in or create a customer account before payment. After sign-in, review the booking and choose the available downpayment or full-payment option. PayMongo shows the amount before checkout; any remaining balance for a downpayment is due at check-in.',
            links: []
        }),
        records: () => ({
            text: 'Your booking history, statuses, payment acknowledgments, and linked walk-in visits are available in My Bookings and Receipts after you sign in to your customer account.',
            links: []
        }),
        policy: () => ({
            text: 'Bookings cannot be cancelled through self-service, and completed payments are non-refundable. The published Terms & Conditions state a 30-minute grace period and no-show cancellation; sign in and check the notice at the top of My Bookings for the current venue grace period. No-show bookings are not refunded or rescheduled.',
            links: [LINKS.terms]
        }),
        location: () => ({
            text: 'Iñigos Sports Center is on Lucena Diversion Road (AH26), Brgy. Bocohan, Lucena City, Quezon, Philippines. Call +63 928 154 6876 or email itsrosem8@gmail.com.',
            links: [LINKS.location, LINKS.directions, LINKS.phone, LINKS.email]
        })
    });

    function answerQuestion(key, context = {}) {
        return ANSWERS[key]?.(context) || {
            text: 'Choose a question below for help with booking, sports and rates, payments, records, policies, or location.',
            links: []
        };
    }

    const api = Object.freeze({ answerQuestion });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.InigoLandingChat = api;

    if (typeof document === 'undefined') return;
    const launcher = document.querySelector('[data-landing-chat-open]');
    const dialog = document.querySelector('[data-landing-chat]');
    const closeButton = document.querySelector('[data-landing-chat-close]');
    const backdrop = document.querySelector('[data-landing-chat-backdrop]');
    const log = document.querySelector('[data-landing-chat-log]');
    const prompts = document.querySelector('.landing-chat-prompts');
    const courtGrid = document.querySelector('[data-court-grid]');
    if (!launcher || !dialog || !backdrop || !closeButton || !log || !prompts || !courtGrid) return;
    const questions = [...prompts.querySelectorAll('[data-chat-question]')];

    let returnFocus = launcher;
    let fallbackOpen = false;
    let backgroundState = [];

    function setBackgroundIsolation(isolated) {
        if (isolated) {
            backgroundState = [...document.body.children]
                .filter(node => node !== dialog && node !== backdrop)
                .map(node => ({ node, ariaHidden: node.getAttribute('aria-hidden'), inert: node.hasAttribute('inert') }));
            backgroundState.forEach(({ node }) => {
                node.setAttribute('aria-hidden', 'true');
                node.setAttribute('inert', '');
            });
            return;
        }
        backgroundState.forEach(({ node, ariaHidden, inert }) => {
            if (ariaHidden === null) node.removeAttribute('aria-hidden');
            else node.setAttribute('aria-hidden', ariaHidden);
            if (!inert) node.removeAttribute('inert');
        });
        backgroundState = [];
    }

    function restoreFocus() {
        launcher.classList.remove('is-obscured');
        (returnFocus?.isConnected ? returnFocus : launcher).focus({ preventScroll: true });
    }

    function openChat() {
        if (dialog.open) return;
        returnFocus = launcher;
        let openedNatively = false;
        if (typeof dialog.showModal === 'function') {
            try {
                dialog.showModal();
                openedNatively = dialog.open;
            } catch { /* Use the accessible in-page modal fallback below. */ }
        }
        if (!openedNatively) {
            fallbackOpen = true;
            dialog.classList.add('is-fallback-open');
            dialog.setAttribute('open', '');
            dialog.setAttribute('aria-modal', 'true');
            backdrop.hidden = false;
            document.body.classList.add('landing-chat-scroll-lock');
            setBackgroundIsolation(true);
        }
        (questions[0] || closeButton).focus();
    }

    function closeChat() {
        if (!fallbackOpen && typeof dialog.close === 'function' && dialog.open) dialog.close();
        else {
            dialog.removeAttribute('open');
            dialog.removeAttribute('aria-modal');
            dialog.classList.remove('is-fallback-open');
            backdrop.hidden = true;
            fallbackOpen = false;
            document.body.classList.remove('landing-chat-scroll-lock');
            setBackgroundIsolation(false);
            restoreFocus();
        }
    }

    function appendMessage(text, role, links = []) {
        const message = document.createElement('p');
        message.className = `landing-chat-message is-${role}`;
        message.textContent = text;
        for (const linkData of links) {
            message.append(document.createTextNode(' '));
            const link = document.createElement('a');
            link.textContent = linkData.label;
            link.href = linkData.href;
            if (linkData.href.startsWith('https://')) {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }
            message.append(link);
        }
        log.append(message);
        log.scrollTop = log.scrollHeight;
    }

    function currentCourtContext() {
        const cards = [...courtGrid.querySelectorAll('.court-card')];
        return {
            loading: courtGrid.getAttribute('aria-busy') === 'true',
            failed: Boolean(courtGrid.querySelector('[data-content-retry]')),
            courts: cards.map(card => ({
                name: card.querySelector('h3')?.textContent || '',
                rate: card.querySelector('.court-rate')?.textContent || ''
            }))
        };
    }

    launcher.addEventListener('click', openChat);
    closeButton.addEventListener('click', closeChat);
    dialog.addEventListener('close', restoreFocus);
    dialog.addEventListener('click', event => {
        if (event.target === dialog) closeChat();
        const anchor = event.target.closest('a[href^="#"]');
        if (anchor || event.target.closest('.landing-chat-attribution a')) closeChat();
    });
    backdrop.addEventListener('click', closeChat);
    prompts.addEventListener('click', event => {
        const question = event.target.closest('[data-chat-question]');
        if (!question) return;
        appendMessage(question.textContent.trim(), 'user');
        const answer = answerQuestion(question.dataset.chatQuestion, currentCourtContext());
        appendMessage(answer.text, 'assistant', answer.links);
    });
    document.addEventListener('keydown', event => {
        if (!fallbackOpen) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            closeChat();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...dialog.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
            .filter(node => node.getClientRects().length > 0);
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
