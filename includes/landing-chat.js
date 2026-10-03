// Local, deterministic FAQ for the public landing page. Answers only use
// verified page details and the current Courts & Pricing cards; no message is
// sent to a server and all user/database text is rendered as text nodes.
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
        email: { href: 'mailto:itsrosem8@gmail.com', label: 'itsrosem8@gmail.com' }
    });

    function normalize(value) {
        return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    }

    function answerQuestion(question, context = {}) {
        const query = normalize(question);
        const bookingIntent = /\b(book|booking|reserve|reservation)\b/.test(query);
        const contactIntent = /\b(phone|call|contact|email|reach|telephone)\b/.test(query);
        if (!bookingIntent && !contactIntent && /\b(where|located|location|address|directions|map|find us)\b/.test(query)) {
            return {
                text: 'Iñigos Sports Center is at Brgy. Bocohan, Diversion Road, Lucena City, Quezon, Philippines.',
                links: [LINKS.location, LINKS.directions]
            };
        }
        if (contactIntent) {
            return { text: 'You can reach the sports center by phone or email:', links: [LINKS.phone, LINKS.email] };
        }
        if (/\b(hours?|open|close|operating|schedule)\b/.test(query)) {
            return {
                text: 'I can’t confirm current operating hours from this page. Please contact the sports center directly:',
                links: [LINKS.phone, LINKS.email]
            };
        }
        if (/\b(book|booking|reserve|reservation|how do i)\b/.test(query)) {
            return {
                text: 'Choose “Book a court” on the page to log in or create an account, then continue through the booking flow to select a court and available time. Current court listings are here:',
                links: [LINKS.courts]
            };
        }
        if (/\b(price|pricing|rate|rates|cost|costs|how much|fee|fees)\b/.test(query)) {
            return courtsAnswer(context, true);
        }
        if (/\b(sport|sports|court|courts|offer|available|play)\b/.test(query)) {
            return courtsAnswer(context, false);
        }
        return {
            text: 'I can help with booking, current sports and rates, directions, contact details, or operating hours. For anything else, please contact the sports center:',
            links: [LINKS.phone, LINKS.email]
        };
    }

    function courtsAnswer(context, includeRates) {
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
            return name ? (includeRates ? `${name} — ${rate || 'Rate not shown'}` : name) : '';
        }).filter(Boolean);
        return {
            text: includeRates
                ? `Current sports and rates shown in Courts & Pricing (${items.length}): ${items.join('; ')}.`
                : `The Courts & Pricing section currently lists ${items.length} sports: ${items.join(', ')}.`,
            links: [LINKS.courts]
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
    const form = document.querySelector('[data-landing-chat-form]');
    const input = document.querySelector('#landingChatInput');
    const log = document.querySelector('[data-landing-chat-log]');
    const prompts = document.querySelector('.landing-chat-prompts');
    const courtGrid = document.querySelector('[data-court-grid]');
    if (!launcher || !dialog || !backdrop || !closeButton || !form || !input || !log || !courtGrid) return;

    let returnFocus = launcher;
    let fallbackOpen = false;
    let backgroundState = [];

    function setBackgroundIsolation(isolated) {
        if (isolated) {
            backgroundState = [...document.body.children]
                .filter(node => node !== dialog && node !== backdrop)
                .map(node => ({
                    node,
                    ariaHidden: node.getAttribute('aria-hidden'),
                    inert: node.hasAttribute('inert')
                }));
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
        input.focus();
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

    function restoreFocus() {
        launcher.classList.remove('is-obscured');
        (returnFocus?.isConnected ? returnFocus : launcher).focus({ preventScroll: true });
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
        const failed = Boolean(courtGrid.querySelector('[data-content-retry]'));
        return {
            loading: courtGrid.getAttribute('aria-busy') === 'true',
            failed,
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
    });
    backdrop.addEventListener('click', closeChat);
    document.addEventListener('keydown', event => {
        if (!fallbackOpen) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            closeChat();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
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
    form.addEventListener('submit', event => {
        event.preventDefault();
        const question = input.value.trim();
        if (!question) return;
        appendMessage(question, 'user');
        input.value = '';
        if (prompts) prompts.remove();
        const answer = answerQuestion(question, currentCourtContext());
        appendMessage(answer.text, 'assistant', answer.links);
        input.focus();
    });
    prompts?.addEventListener('click', event => {
        const prompt = event.target.closest('[data-chat-prompt]');
        if (!prompt) return;
        input.value = prompt.dataset.chatPrompt || '';
        form.requestSubmit();
    });
    dialog.addEventListener('click', event => {
        const anchor = event.target.closest('a[href^="#"]');
        if (anchor || event.target.closest('.landing-chat-attribution a')) closeChat();
    });
})();
