// IñigoSync — Customer Dashboard controller
// Handles: sidebar/topbar panel switching, mobile sidebar toggle, profile
// dropdown, the notifications dropdown, the feedback modal, the 5-step
// Book a Court flow, time-slot and
// payment-option selection with a live summary recalculation, My Bookings (no
// cancellation), the Receipts panel's payment acknowledgment list + filters,
// Account Settings' name-part fields, and the 2-step Change Password
// wizard.
//
// This file implements the customer dashboard navigation, feedback,
// notifications, booking wizard, receipts, and settings flows.
// (§5 booking wizard, §6 my-bookings chip removal, §7 receipts, §9 account
// settings — decisions D3/D4/D5/D8) of the redesign in
// InigoSync_Dashboard_Feedback_v6.md, AND "Revision 2" (implementation_plan.md,
// decisions R1-R6 — post-feedback-v6 corrections):
//   R3 — My Bookings drops cancellation entirely (no Cancel control
//        anywhere) in favor of the real no-cancellation/no-refund and
//        date-specific "Unattended" policy stated in
//        Pages/user_dashboard.html's two policy notices.
//   R4 — "Unattended" is DERIVED for display only, never written to the
//        database — see displayStatusFor() further below for the full
//        reasoning (booking.status's CHECK constraint, the 23514 error
//        branch on the booking INSERT below, and why this can't safely be
//        persisted from this repo).
//   R5 — Receipts renders saved payment acknowledgments only; unpaid
//        bookings do not create receipt cards — see renderReceipts() below.
//
// Booking (including its court dropdown), My Bookings, Receipts, Profile,
// and Settings talk to the real Supabase database. Booking court options
// read the `court`/`sport` tables via window.InigoCourtsData
// (includes/courtsData.js; see docs/QA_AUDIT_REPORT.md P0#8). The
// Booking wizard's Step 1 preview is built from
// window.InigoCourtsData.resolveCourtUnits(), ported from
// includes/landingPage.js into includes/courtsData.js (implementation_plan.md
// D2) so that file stays untouched. Notifications are derived from the
// customer's own `booking` rows (no `notification` table — D6). Feedback
// writes to the `feedback` table (supabase/migrations/20261004085347_customer_feedback.sql),
// failing honestly with a toast if that migration hasn't been applied yet.
// Receipts (Revision 2, R5) use saved acknowledgment RPCs plus the existing
// account-scoped booking rows; unpaid reservations never become receipts.
// Account Settings' three
// name boxes read/write profiles.first_name/middle_name/last_name
// (database/schema/008_profile_name_parts.sql) while keeping full_name — the
// column the owner/staff dashboards still read — in sync (D3). Everything
// else here (panel switching, hero carousel) is UI-only, same as before.

document.addEventListener('DOMContentLoaded', () => {
    const panels = document.querySelectorAll('[data-dash-panel]');
    const navButtons = document.querySelectorAll('[data-dash-nav]');
    const titleEl = document.querySelector('[data-dash-title]');
    const subtitleEl = document.querySelector('[data-dash-subtitle]');

    const panelMeta = {
        overview: { title: 'Dashboard', subtitle: "Welcome back, here's what's happening with your bookings." },
        // 'courts' removed (§1/D1) — the standalone Courts panel is gone;
        // its content now lives inside 'overview' (§4/D2), which already has
        // its own entry above.
        booking: { title: 'Book a Court', subtitle: 'Choose a sport, court, and time, then review your bookings.' },
        bookings: { title: 'My Bookings & Visits', subtitle: 'Track online bookings and walk-in visits linked to your account.' },
        receipts: { title: 'Receipts', subtitle: 'Review payments and open a receipt for its full details.' },
        profile: { title: 'My Profile', subtitle: 'Your personal details and booking history at a glance.' },
        settings: { title: 'Account Settings', subtitle: 'Update your personal details and manage your password.' },
    };

    function setActivePanel(name) {
        if (name !== 'booking') {
            closeBookingPayment(false);
            closeBookingCartDetails(false);
            closeBookingModal(false);
        }
        panels.forEach((panel) => {
            panel.classList.toggle('is-active', panel.dataset.dashPanel === name);
        });

        // Resume at the booking summary when selections are ready; otherwise
        // start the guided selection flow at its first step.
        if (name === 'booking') {
            goToBookStep(bookingCart?.length ? 4 : 1);
            if (bookingState.court && bookingState.date) refreshTimePickers(true);
        }
        if (typeof renderBookingCart === 'function') renderBookingCart();

        document.querySelectorAll('[data-dash-nav]').forEach((btn) => {
            // Only sidebar links get the highlighted state (topbar/profile
            // menu shortcuts to the same panel shouldn't visually toggle).
            if (btn.closest('.dash-nav')) {
                const isActive = btn.dataset.dashNav === name;
                btn.classList.toggle('is-active', isActive);
                if (isActive) btn.setAttribute('aria-current', 'page');
                else btn.removeAttribute('aria-current');
            }
        });

        const meta = panelMeta[name];
        if (meta && titleEl && subtitleEl) {
            titleEl.textContent = meta.title;
            subtitleEl.textContent = meta.subtitle;
        }

        // Refresh when customers return to My Bookings so the notice uses the
        // current venue rule and date-specific status rules stay recent.
        if (name === 'bookings') refreshMyBookings({ forceCurrentRule: true });

        closeMobileSidebar();
        closeProfileMenu();
        closeNotifMenu();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    async function getFunctionErrorMessage(error, fallback) {
        const response = error?.context;
        if (response && typeof response.clone === 'function') {
            try {
                const body = await response.clone().json();
                if (typeof body?.message === 'string' && body.message.trim()) return body.message.trim().slice(0, 300);
            } catch (_) { /* Keep the SDK message when the response is not JSON. */ }
        }
        return typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : fallback;
    }

    navButtons.forEach((btn) => {
        btn.addEventListener('click', () => setActivePanel(btn.dataset.dashNav));
    });

    // ------------------------------------------------------------------
    // Mobile sidebar toggle
    // ------------------------------------------------------------------
    const mobileToggle = document.querySelector('[data-dash-mobile-toggle]');
    const scrim = document.querySelector('[data-dash-scrim]');
    const dashboardShell = document.querySelector('.dash-shell');
    const dashboardSidebar = document.querySelector('[data-dash-sidebar]');
    const sidebarCollapse = document.querySelector('[data-dash-sidebar-collapse]');
    const mobileBreakpoint = window.matchMedia('(max-width: 860px)');

    function setDesktopSidebarCollapsed(collapsed) {
        if (!dashboardShell || !dashboardSidebar) return;
        dashboardShell.classList.toggle('dash-sidebar-collapsed', collapsed);
        if (sidebarCollapse) {
            const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
            sidebarCollapse.setAttribute('aria-label', label);
            sidebarCollapse.setAttribute('title', label);
            sidebarCollapse.setAttribute('aria-expanded', String(!collapsed));
        }
    }

    document.querySelectorAll('.dash-nav-link').forEach((button) => {
        const label = button.textContent.trim().replace(/\s+/g, ' ');
        if (label && !button.hasAttribute('aria-label')) button.setAttribute('aria-label', label);
        if (label) button.setAttribute('title', label);
    });
    if (sidebarCollapse) sidebarCollapse.addEventListener('click', () => {
        const collapsed = !dashboardShell?.classList.contains('dash-sidebar-collapsed');
        setDesktopSidebarCollapsed(collapsed);
        sidebarCollapse.focus();
    });

    function syncSidebarBreakpoint() {
        if (mobileBreakpoint.matches) setDesktopSidebarCollapsed(false);
    }
    mobileBreakpoint.addEventListener('change', syncSidebarBreakpoint);
    syncSidebarBreakpoint();

    function closeMobileSidebar() {
        document.body.classList.remove('dash-sidebar-open');
        if (mobileToggle) mobileToggle.setAttribute('aria-expanded', 'false');
    }

    if (mobileToggle) {
        mobileToggle.addEventListener('click', () => {
            const isOpen = document.body.classList.toggle('dash-sidebar-open');
            mobileToggle.setAttribute('aria-expanded', String(isOpen));
        });
    }
    if (scrim) {
        scrim.addEventListener('click', closeMobileSidebar);
    }

    // Match the landing page's scroll-direction header behavior. The
    // dashboard page scrolls at window level; focus and the mobile drawer
    // keep the complete title/control bar available while navigating.
    const dashTopbar = document.querySelector('.dash-topbar');
    if (dashTopbar) {
        let previousY = Math.max(0, window.scrollY);
        let directionAnchor = previousY;
        let previousDirection = 0;
        let syncPending = false;
        const setDashTopbarHidden = (hidden) => {
            if (hidden) {
                // A focused control or open dropdown must not be left inside
                // a bar that is moving out of view. The menus remain fully
                // usable until a downward scroll reaches the hide threshold.
                closeProfileMenu();
                closeNotifMenu();
                const activeElement = document.activeElement;
                if (dashTopbar.contains(activeElement)) activeElement.blur?.();
                dashTopbar.classList.add('is-hidden');
                dashTopbar.setAttribute('aria-hidden', 'true');
                dashTopbar.setAttribute('inert', '');
                return;
            }

            dashTopbar.classList.remove('is-hidden');
            dashTopbar.removeAttribute('aria-hidden');
            dashTopbar.removeAttribute('inert');
        };
        const syncDashTopbar = () => {
            syncPending = false;
            const y = Math.max(0, window.scrollY);
            const direction = Math.sign(y - previousY);
            if (direction && direction !== previousDirection) {
                directionAnchor = previousY;
                previousDirection = direction;
            }
            const keepVisible = y < 96 || document.body.classList.contains('dash-sidebar-open');
            if (keepVisible || (direction < 0 && directionAnchor - y >= 12)) setDashTopbarHidden(false);
            else if (direction > 0 && y - directionAnchor >= 12) setDashTopbarHidden(true);
            previousY = y;
        };
        window.addEventListener('scroll', () => {
            if (!syncPending) {
                syncPending = true;
                window.requestAnimationFrame(syncDashTopbar);
            }
        }, { passive: true });
        dashTopbar.addEventListener('focusin', () => setDashTopbarHidden(false));
        dashTopbar.addEventListener('focusout', () => window.requestAnimationFrame(syncDashTopbar));
        new MutationObserver(syncDashTopbar).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    // ------------------------------------------------------------------
    // Overview — featured hero banner (auto-rotating, same interval /
    // crossfade / pause-on-hover / reduced-motion pattern as the landing
    // page's includes/home-showcase.js carousel, reimplemented here since
    // this markup is scoped to the dashboard).
    //
    // Revision A1 (implementation_plan.md, decision A5) — slides now come
    // from the SAME `public.event` rows the owner dashboard's Media Manager
    // edits and the landing page's hero already reads (via
    // includes/landingPage.js's window.InigoContent), so an owner's slide
    // edit shows up here too. This file does NOT load includes/landingPage.js
    // (that file wires the landing page's own theme toggle/nav/scroll-spy —
    // pulling it in here would double-register those against markup that
    // doesn't exist on this page) — it runs one small, self-contained
    // fetch instead. The 3 static `<article data-dash-hero-slide>` articles
    // already in Pages/user_dashboard.html are the no-JS/fetch-failed/
    // zero-rows fallback: wireHeroCarousel() below runs against whatever is
    // in the DOM at the time it's called, static or fetched, with the exact
    // same looping track/auto-advance/reduced-motion behaviour either way.
    // ------------------------------------------------------------------
    const heroEl = document.querySelector('[data-dash-hero]');

    if (heroEl) {
        const heroContainer = heroEl.querySelector('.dash-hero-container');
        const heroPrevious = heroEl.querySelector('[data-dash-hero-prev]');
        const heroNext = heroEl.querySelector('[data-dash-hero-next]');
        const heroPause = heroEl.querySelector('[data-dash-hero-pause]');
        const heroReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        const heroHoverCapable = window.matchMedia('(hover: hover)');

        let heroTimer = null;
        let heroAnimating = false;
        let heroPaused = heroReducedMotion.matches;

        // Slides are cards in a horizontal track. Rotate the first card to the
        // end after its leftward transition so the carousel loops without
        // cloning event content or changing the published event order.
        function wireHeroCarousel() {
            if (!heroContainer || heroContainer.children.length === 0) return;

            function clearHeroAutoplay() {
                if (heroTimer) clearTimeout(heroTimer);
                heroTimer = null;
            }

            function startHeroAutoplay() {
                clearHeroAutoplay();
                if (heroPaused || heroReducedMotion.matches || document.hidden || heroContainer.children.length < 2
                    || heroEl.contains(document.activeElement)
                    || (heroHoverCapable.matches && heroEl.matches(':hover'))) return;
                heroTimer = setTimeout(() => moveHeroNext(true), 5000);
            }

            function syncHeroPauseButton() {
                if (!heroPause) return;
                const multiple = heroContainer.children.length > 1;
                const paused = heroPaused || heroReducedMotion.matches || !multiple;
                heroPause.hidden = !multiple;
                heroPause.innerHTML = paused
                    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 12 7-12 7z"/></svg>'
                    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>';
                heroPause.setAttribute('aria-label', paused ? 'Play slideshow' : 'Pause slideshow');
                heroPause.setAttribute('aria-pressed', String(paused));
                heroPause.disabled = !multiple || heroReducedMotion.matches;
            }

            function distanceForOneCard() {
                const slide = heroContainer.firstElementChild;
                if (!slide) return 0;
                const gap = parseFloat(getComputedStyle(heroContainer).columnGap) || 0;
                return slide.getBoundingClientRect().width + gap;
            }

            function moveHeroNext(automatic = false) {
                if (heroAnimating || heroContainer.children.length < 2) return;
                heroAnimating = true;
                heroContainer.style.transitionDuration = automatic ? '' : '420ms';
                heroContainer.style.transform = `translateX(-${distanceForOneCard()}px)`;
                const finish = () => {
                    heroContainer.removeEventListener('transitionend', finish);
                    heroContainer.append(heroContainer.firstElementChild);
                    heroContainer.style.transition = 'none';
                    heroContainer.style.transform = 'translateX(0)';
                    void heroContainer.offsetHeight;
                    heroContainer.style.removeProperty('transition');
                    heroContainer.style.removeProperty('transition-duration');
                    heroAnimating = false;
                    startHeroAutoplay();
                };
                heroContainer.addEventListener('transitionend', finish, { once: true });
                window.setTimeout(() => { if (heroAnimating) finish(); }, 750);
            }

            function moveHeroPrevious() {
                if (heroAnimating || heroContainer.children.length < 2) return;
                clearHeroAutoplay();
                heroAnimating = true;
                heroContainer.style.transition = 'none';
                heroContainer.prepend(heroContainer.lastElementChild);
                heroContainer.style.transform = `translateX(-${distanceForOneCard()}px)`;
                void heroContainer.offsetHeight;
                heroContainer.style.removeProperty('transition');
                heroContainer.style.transform = 'translateX(0)';
                const finish = () => { heroAnimating = false; startHeroAutoplay(); };
                heroContainer.addEventListener('transitionend', finish, { once: true });
                window.setTimeout(() => { if (heroAnimating) finish(); }, 750);
            }

            if (heroPrevious) heroPrevious.hidden = heroContainer.children.length < 2;
            if (heroNext) heroNext.hidden = heroContainer.children.length < 2;
            syncHeroPauseButton();
            heroPrevious?.addEventListener('click', moveHeroPrevious);
            heroNext?.addEventListener('click', () => moveHeroNext(false));
            heroPause?.addEventListener('click', () => {
                if (heroReducedMotion.matches) return;
                heroPaused = !heroPaused;
                syncHeroPauseButton();
                if (heroPaused) clearHeroAutoplay();
                else startHeroAutoplay();
            });
            heroEl.addEventListener('keydown', (event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                if (event.key === 'ArrowRight') moveHeroNext(false);
                else moveHeroPrevious();
            });

            heroEl.addEventListener('mouseenter', clearHeroAutoplay);
            heroEl.addEventListener('mouseleave', startHeroAutoplay);
            heroEl.addEventListener('focusin', clearHeroAutoplay);
            heroEl.addEventListener('focusout', () => {
                setTimeout(() => {
                    if (!heroEl.contains(document.activeElement)) startHeroAutoplay();
                }, 0);
            });
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) clearHeroAutoplay();
                else startHeroAutoplay();
            });
            heroReducedMotion.addEventListener('change', () => {
                if (heroReducedMotion.matches) heroPaused = true;
                syncHeroPauseButton();
                startHeroAutoplay();
            });

            startHeroAutoplay();
        }

        // Same "only allow https:// or the project's own relative paths"
        // rule includes/owner_dashboard.js's court/slide renderers apply
        // (implementation_plan.md's security requirements) — event.image_url
        // is admin-supplied (Media Manager), so this is defense in depth
        // against a javascript:/data: URL ever reaching an <img src> here,
        // even though the only writers today (the owner dashboard's own
        // upload/URL-paste flow) already gate this on their own side too.
        function isSafeHeroImageUrl(url) {
            const value = String(url || '').trim();
            if (!value) return false;
            if (/^https:\/\//i.test(value)) return true;
            if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
            if (value.startsWith('//')) return false;
            return true;
        }

        function renderHeroSlidesFromEvents(events) {
            if (!heroContainer) return;
            heroContainer.innerHTML = events.map((ev, i) => {
                const title = window.escapeHtml(ev.title || '');
                const tag = window.escapeHtml(ev.tag || 'Featured');
                const meta = window.escapeHtml(ev.meta || '');
                const media = (ev.image_url && isSafeHeroImageUrl(ev.image_url))
                    ? `<img src="${window.escapeHtml(ev.image_url)}" alt="${title}" class="dash-hero-image" loading="${i === 0 ? 'eager' : 'lazy'}">`
                    : `<div class="dash-hero-image" aria-hidden="true" style="background: linear-gradient(135deg, var(--color-bg-elevated), var(--color-bg-card));"></div>`;
                return `
                    <article class="dash-hero-slide" data-dash-hero-slide="${i}">
                        ${media}
                        <div class="dash-hero-scrim">
                            <div class="dash-hero-text">
                                <span class="dash-hero-tag">${tag}</span>
                                <h3 class="dash-hero-title">${title}</h3>
                                <p class="dash-hero-meta">${meta}</p>
                            </div>
                        </div>
                    </article>
                `;
            }).join('');

        }


        function loadHeroSlides() {
            if (!window.sb) {
                wireHeroCarousel();
                return;
            }
            window.sb.from('event')
                .select('id,title,meta,tag,image_url,display_order')
                .eq('is_published', true)
                .order('display_order')
                .then(({ data, error }) => {
                    if (error) {
                        console.error('[dashboard] failed to load hero slides — showing the built-in fallback instead.', error);
                    } else if (data && data.length > 0) {
                        renderHeroSlidesFromEvents(data);
                    }
                    // Zero rows (or an error above) — the 3 static
                    // <article data-dash-hero-slide> fallback slides already
                    // in the page are left exactly as they are.
                    wireHeroCarousel();
                }, (err) => {
                    console.error('[dashboard] hero slides request failed — showing the built-in fallback instead.', err);
                    wireHeroCarousel();
                });
        }

        loadHeroSlides();
    }

    // ------------------------------------------------------------------
    // Profile dropdown
    // ------------------------------------------------------------------
    const profile = document.querySelector('[data-dash-profile]');
    const profileTrigger = document.querySelector('[data-dash-profile-trigger]');

    function closeProfileMenu() {
        if (profile) profile.removeAttribute('data-open');
        if (profileTrigger) profileTrigger.setAttribute('aria-expanded', 'false');
    }

    if (profileTrigger && profile) {
        profileTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = profile.hasAttribute('data-open');
            // Keeps this dropdown and the notifications one (below) from
            // fighting each other — opening either closes the other.
            // closeNotifMenu is a hoisted function declaration defined
            // further down this file, so this reference is safe: it only
            // ever runs later, on click, by which point the whole script has
            // finished executing.
            closeNotifMenu();
            if (isOpen) {
                profile.removeAttribute('data-open');
                profileTrigger.setAttribute('aria-expanded', 'false');
            } else {
                profile.setAttribute('data-open', '');
                profileTrigger.setAttribute('aria-expanded', 'true');
            }
        });

        document.addEventListener('click', (e) => {
            if (!profile.contains(e.target)) closeProfileMenu();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeProfileMenu();
        });
    }

    // Logout is wired in includes/authGuard.js (real Supabase sign-out).

    // ------------------------------------------------------------------
    // Notifications come from the account-scoped server feed so every item
    // has durable read state. Booking refreshes also refresh this feed.
    // ------------------------------------------------------------------
    const notif = document.querySelector('[data-dash-notif]');
    const notifTrigger = document.querySelector('[data-dash-notif-trigger]');
    const notifList = document.querySelector('[data-dash-notif-list]');
    const notifDot = document.querySelector('[data-dash-notif-dot]');
    const notifUnread = document.querySelector('[data-dash-notif-unread]');
    const notifPagination = document.querySelector('[data-dash-notif-pagination]');
    const notifPageNumbers = document.querySelector('[data-dash-notif-page-numbers]');
    const NOTIF_LIMIT = 10;
    let notifPage = 0;
    let notifTotalCount = 0;
    let notifGeneration = 0;
    let notifItems = [];
    const selectedNotifKeys = new Set();
    const notifSelect = document.querySelector('[data-dash-notif-select]');
    const notifSelectedLabel = document.querySelector('[data-dash-notif-selected]');
    const notifMarkSelected = document.querySelector('[data-dash-notif-mark-selected]');

    function renderCustomerPageNumbers(currentPage, pageCount) {
        if (!notifPageNumbers) return;
        const pages = pageCount <= 7
            ? Array.from({ length: pageCount }, (_, index) => index + 1)
            : [1, ...(currentPage > 3 ? ['gap'] : []),
                ...Array.from({ length: 3 }, (_, index) => currentPage - 1 + index).filter(page => page > 1 && page < pageCount),
                ...(currentPage < pageCount - 2 ? ['gap'] : []), pageCount];
        notifPageNumbers.replaceChildren(...pages.map(page => {
            if (page === 'gap') {
                const gap = document.createElement('span');
                gap.className = 'dash-page-gap';
                gap.setAttribute('aria-hidden', 'true');
                gap.textContent = '…';
                return gap;
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'dash-mini-btn dash-page-number';
            button.textContent = String(page);
            button.setAttribute('aria-label', `Page ${page}`);
            if (page === currentPage) {
                button.setAttribute('aria-current', 'page');
                button.disabled = true;
            } else button.addEventListener('click', () => { notifPage = page - 1; loadCustomerNotifications(); });
            return button;
        }));
    }

    function syncCustomerNotificationSelection() {
        const checkboxes = notifList?.querySelectorAll('[data-dash-notif-select-row]') || [];
        checkboxes.forEach(checkbox => {
            checkbox.checked = selectedNotifKeys.has(checkbox.dataset.dashNotifSelectRow);
            checkbox.closest('.dash-notif-row')?.classList.toggle('is-selected', checkbox.checked);
        });
        if (notifSelectedLabel) notifSelectedLabel.textContent = `${selectedNotifKeys.size} selected`;
        if (notifMarkSelected) notifMarkSelected.disabled = selectedNotifKeys.size === 0;
    }

    function closeNotifMenu() {
        if (notif) notif.removeAttribute('data-open');
        if (notifTrigger) notifTrigger.setAttribute('aria-expanded', 'false');
    }

    if (notifTrigger && notif) {
        notifTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = notif.hasAttribute('data-open');
            // Same "don't fight the other dropdown" rule as above, in the
            // other direction.
            closeProfileMenu();
            if (isOpen) {
                closeNotifMenu();
            } else {
                notif.setAttribute('data-open', '');
                notifTrigger.setAttribute('aria-expanded', 'true');
                loadCustomerNotifications();
            }
        });

        document.addEventListener('click', (e) => {
            if (!notif.contains(e.target)) closeNotifMenu();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeNotifMenu();
        });
    }

    function renderNotifications() {
        loadCustomerNotifications();
    }

    function notificationTime(value) {
        const date = new Date(value);
        return Number.isNaN(date.valueOf()) ? 'Date unavailable' : date.toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });
    }

    async function loadCustomerNotifications() {
        if (!notifList || !window.sb || !window.inigosyncProfile) return;
        const generation = ++notifGeneration;
        selectedNotifKeys.clear();
        if (notifSelect) notifSelect.value = 'none';
        syncCustomerNotificationSelection();
        notifList.innerHTML = '<p class="dash-notif-empty">Loading notifications…</p>';
        try {
            const { data, error } = await window.sb.rpc('customer_list_notifications', {
                p_search: '',
                p_offset: notifPage * NOTIF_LIMIT,
                p_limit: NOTIF_LIMIT,
            });
            if (generation !== notifGeneration) return;
            if (error) throw error;
            const result = Array.isArray(data) ? data[0] : data;
            if (!result || !Array.isArray(result.rows)) throw new Error('The notifications response is incomplete.');
            notifTotalCount = Number(result.total_count) || 0;
            const persistentItems = result.rows.map(item => ({
                key: String(item.key || ''), title: String(item.title || 'Notification'), body: String(item.body || ''),
                category: String(item.category || 'Update'), created_at: item.created_at || null,
                read_at: item.read_at || null, href: item.href || '',
            }));
            notifItems = persistentItems;
            const persistentHtml = persistentItems.map(item => `<div class="dash-notif-row dash-notif-persistent${item.read_at ? ' is-read' : ' is-unread'}" data-dash-notif-key="${window.escapeHtml(item.key)}"><input type="checkbox" class="dash-notif-select-row" data-dash-notif-select-row="${window.escapeHtml(item.key)}" aria-label="Select ${window.escapeHtml(item.title)}"><button type="button" class="dash-notif-item" data-dash-notif-open data-dash-notif-href="${window.escapeHtml(item.href)}"><span class="dash-notif-dot ${window.escapeHtml(item.category.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))}" aria-hidden="true"></span><span class="dash-notif-item-body"><strong>${window.escapeHtml(item.title)}</strong><span>${window.escapeHtml(item.body)}</span><small>${window.escapeHtml(item.category)} · ${window.escapeHtml(notificationTime(item.created_at))} · ${item.read_at ? 'Read' : 'Unread'}</small></span></button></div>`).join('');
            notifList.innerHTML = persistentHtml || '<p class="dash-notif-empty">No notifications yet.</p>';
            syncCustomerNotificationSelection();
            const unreadCount = Number(result.unread_count) || 0;
            if (notifUnread) notifUnread.textContent = unreadCount ? `${unreadCount} unread` : '';
            if (notifDot) notifDot.hidden = unreadCount === 0;
            const pageCount = Math.max(1, Math.ceil(notifTotalCount / NOTIF_LIMIT));
            if (notifPagination) notifPagination.hidden = pageCount <= 1;
            renderCustomerPageNumbers(notifPage + 1, pageCount);
            const prev = document.querySelector('[data-dash-notif-prev]');
            const next = document.querySelector('[data-dash-notif-next]');
            if (prev) prev.disabled = notifPage === 0;
            if (next) next.disabled = (notifPage + 1) * NOTIF_LIMIT >= notifTotalCount;
        } catch (error) {
            if (generation !== notifGeneration) return;
            notifItems = [];
            selectedNotifKeys.clear();
            syncCustomerNotificationSelection();
            console.error('[dashboard] notifications could not be loaded', error);
            notifList.innerHTML = '<p class="dash-notif-empty">Notifications could not be loaded. Try again.</p>';
            if (notifDot) notifDot.hidden = true;
        }
    }

    document.querySelector('[data-dash-notif-prev]')?.addEventListener('click', () => { if (notifPage > 0) { notifPage -= 1; loadCustomerNotifications(); } });
    document.querySelector('[data-dash-notif-next]')?.addEventListener('click', () => { if ((notifPage + 1) * NOTIF_LIMIT < notifTotalCount) { notifPage += 1; loadCustomerNotifications(); } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadCustomerNotifications(); });
    document.addEventListener('inigosync:profile-ready', loadCustomerNotifications);
    window.setInterval(() => { if (!document.hidden) loadCustomerNotifications(); }, 60000);

    if (notifList) {
        notifList.addEventListener('change', (e) => {
            const checkbox = e.target.closest('[data-dash-notif-select-row]');
            if (!checkbox) return;
            if (checkbox.checked) selectedNotifKeys.add(checkbox.dataset.dashNotifSelectRow);
            else selectedNotifKeys.delete(checkbox.dataset.dashNotifSelectRow);
            syncCustomerNotificationSelection();
        });
        notifList.addEventListener('click', (e) => {
            const openButton = e.target.closest('[data-dash-notif-open]');
            const persistent = openButton?.closest('[data-dash-notif-key]');
            if (persistent) {
                const key = persistent.dataset.dashNotifKey;
                openButton.disabled = true;
                window.sb.rpc('mark_notification_read', { p_key: key }).then(({ data, error }) => {
                    if (error || data === false) throw error || new Error('Notification could not be marked read.');
                    const href = openButton.dataset.dashNotifHref || '';
                    void loadCustomerNotifications();
                    if (href) {
                        try {
                            const target = new URL(href, window.location.href);
                            if (target.origin === window.location.origin) {
                                const panelName = target.searchParams.get('panel') || target.hash.replace(/^#/, '');
                                const hasPanel = Array.from(document.querySelectorAll('[data-dash-panel]')).some(panel => panel.dataset.dashPanel === panelName);
                                if (panelName && hasPanel) setActivePanel(panelName);
                                else if (target.href !== window.location.href) window.location.assign(target.href);
                            }
                        } catch (navigationError) {
                            console.warn('[dashboard] notification link could not be opened', navigationError);
                        }
                    }
                }).catch(error => {
                    openButton.disabled = false;
                    console.error('[dashboard] notification read state could not be saved', error);
                    window.InigoToast?.show('Could not mark notification as read.', true);
                });
                return;
            }
        });
    }

    notifSelect?.addEventListener('change', () => {
        selectedNotifKeys.clear();
        const mode = notifSelect.value;
        notifItems.filter(item => mode === 'all' || (mode === 'read' && item.read_at) || (mode === 'unread' && !item.read_at))
            .forEach(item => selectedNotifKeys.add(item.key));
        syncCustomerNotificationSelection();
    });
    notifMarkSelected?.addEventListener('click', async () => {
        const keys = [...selectedNotifKeys];
        if (!keys.length || !window.sb) return;
        notifMarkSelected.disabled = true;
        try {
            const results = await Promise.all(keys.map(key => window.sb.rpc('mark_notification_read', { p_key: key })));
            const failed = results.find(result => result?.error || result?.data === false);
            if (failed) throw failed.error || new Error('A notification could not be marked as read.');
            await loadCustomerNotifications();
        } catch (error) {
            console.error('[dashboard] selected notifications could not be marked read', error);
            window.InigoToast?.show(error.message || 'Could not mark selected notifications as read.', true);
            await loadCustomerNotifications();
        } finally {
            notifMarkSelected.disabled = selectedNotifKeys.size === 0;
        }
    });

    // ------------------------------------------------------------------
    // Feedback modal (§2, D7 — implementation_plan.md). ONE modal, TWO
    // triggers already in the markup: the sidebar card's "Give Feedback"
    // button (desktop/tablet) and the topbar's standalone Feedback button
    // (mobile) — both carry [data-dash-feedback-open] and open this same
    // dialog. Open/close borrows the court viewer's fade-out timing
    // (includes/landingPage.js's createCourtViewer — 250ms) rather than the
    // simpler [data-open] dropdowns above, since this is a full dialog that
    // needs a `hidden` round-trip, not just an opacity toggle anchored to a
    // trigger.
    // ------------------------------------------------------------------
    const feedbackOverlay = document.querySelector('[data-dash-feedback-overlay]');
    const feedbackDialog = document.querySelector('[data-dash-feedback-dialog]');
    const feedbackMessageEl = document.querySelector('[data-dash-feedback-message]');
    const feedbackSubmitBtn = document.querySelector('[data-dash-feedback-submit]');
    const feedbackRatingError = document.querySelector('[data-dash-feedback-rating-error]');
    const feedbackStars = Array.from(document.querySelectorAll('[data-dash-feedback-star]'));

    const FEEDBACK_CLOSE_DELAY_MS = 250;
    let feedbackHideTimer = null;
    let feedbackLastFocused = null;
    let feedbackIsOpen = false;
    // Rating is required; null represents an unselected rating until one is
    // chosen.
    let feedbackRating = null;
    let existingFeedbackId = null;
    let feedbackLoadPending = false;
    let feedbackLoadFailed = false;
    let initialFeedbackSnapshot = null;

    function paintFeedbackStars(value) {
        feedbackStars.forEach((btn) => {
            const starValue = Number(btn.dataset.dashFeedbackStar);
            const isSelected = value !== null && starValue <= value;
            btn.classList.toggle('is-selected', isSelected);
            btn.setAttribute('aria-checked', String(value !== null && starValue === value));
        });
    }

    feedbackStars.forEach((btn) => {
        btn.addEventListener('click', () => {
            if (feedbackLoadPending) return;
            const value = Number(btn.dataset.dashFeedbackStar);
            feedbackRating = value;
            paintFeedbackStars(feedbackRating);
            if (feedbackRatingError) feedbackRatingError.hidden = feedbackRating !== null;
        });
        btn.addEventListener('keydown', (event) => {
            const key = event.key;
            if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(key)) return;
            event.preventDefault();
            const index = feedbackStars.indexOf(btn);
            const nextIndex = key === 'Home' ? 0
                : key === 'End' ? feedbackStars.length - 1
                    : (index + (key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1) + feedbackStars.length) % feedbackStars.length;
            feedbackStars[nextIndex]?.focus();
            feedbackStars[nextIndex]?.click();
        });
    });

    async function loadCustomerFeedback() {
        if (!window.sb || !window.inigosyncProfile) {
            feedbackLoadFailed = true;
            if (feedbackSubmitBtn) {
                feedbackSubmitBtn.disabled = false;
                feedbackSubmitBtn.textContent = 'Retry Load';
            }
            return;
        }
        feedbackLoadPending = true;
        feedbackLoadFailed = false;
        feedbackSubmitBtn && (feedbackSubmitBtn.disabled = true);
        if (feedbackSubmitBtn) feedbackSubmitBtn.textContent = 'Loading…';
        try {
            const { data, error } = await window.sb.from('feedback')
                .select('id, rating, message')
                .eq('profile_id', window.inigosyncProfile.id)
                .maybeSingle();
            if (error) throw error;
            const row = data || null;
            existingFeedbackId = row?.id || null;
            feedbackRating = row?.rating == null ? null : Number(row.rating);
            if (feedbackMessageEl) feedbackMessageEl.value = row?.message || '';
            initialFeedbackSnapshot = {
                rating: feedbackRating,
                message: (feedbackMessageEl?.value || '').trim(),
            };
            paintFeedbackStars(feedbackRating);
            if (feedbackRatingError) feedbackRatingError.hidden = true;
            if (feedbackSubmitBtn) feedbackSubmitBtn.textContent = row ? 'Save Feedback' : 'Submit Feedback';
            feedbackLoadFailed = false;
        } catch (error) {
            feedbackLoadFailed = true;
            console.error('[dashboard] feedback load failed', error);
            window.InigoToast?.show(isDashboardSchemaMismatch(error)
                ? "Feedback isn't set up yet — this needs a database update. Please try again later."
                : 'Could not load your feedback. Please try again.', true);
        } finally {
            feedbackLoadPending = false;
            if (feedbackSubmitBtn) {
                feedbackSubmitBtn.disabled = false;
                if (feedbackLoadFailed) feedbackSubmitBtn.textContent = 'Retry Load';
            }
        }
    }

    function openFeedbackModal(invoker) {
        if (!feedbackOverlay || !feedbackDialog) return;
        feedbackLastFocused = invoker || document.activeElement;
        closeProfileMenu();
        closeNotifMenu();

        if (feedbackHideTimer) {
            window.clearTimeout(feedbackHideTimer);
            feedbackHideTimer = null;
        }

        feedbackOverlay.hidden = false;
        // Force a synchronous layout flush so the browser commits the
        // hidden->visible state before [data-open] flips opacity to 1 —
        // same trick includes/landingPage.js's court viewer uses (see its
        // open()), otherwise the browser can batch both into one style
        // recalc and skip the fade entirely.
        void feedbackOverlay.offsetWidth;
        feedbackOverlay.setAttribute('data-open', '');
        feedbackIsOpen = true;
        feedbackDialog.focus();
        if (feedbackMessageEl) feedbackMessageEl.value = '';
        feedbackRating = null;
        existingFeedbackId = null;
        initialFeedbackSnapshot = null;
        paintFeedbackStars(null);
        if (feedbackRatingError) feedbackRatingError.hidden = true;
        if (feedbackSubmitBtn) feedbackSubmitBtn.textContent = 'Loading…';
        void loadCustomerFeedback();
    }

    let feedbackClosePending = false;
    let feedbackSubmitPending = false;
    function feedbackHasChanges() {
        if (!initialFeedbackSnapshot) return Boolean(feedbackMessageEl?.value.trim()) || feedbackRating !== null;
        return feedbackRating !== initialFeedbackSnapshot.rating
            || (feedbackMessageEl?.value || '').trim() !== initialFeedbackSnapshot.message;
    }
    async function closeFeedbackModal(force = false) {
        if (!feedbackIsOpen) return;
        if (!force && feedbackHasChanges()) {
            if (feedbackClosePending) return;
            feedbackClosePending = true;
            const accepted = await confirmSettingsChange('Discard your feedback draft?');
            feedbackClosePending = false;
            if (!accepted) return;
        }
        feedbackIsOpen = false;

        feedbackOverlay.removeAttribute('data-open');
        if (feedbackHideTimer) window.clearTimeout(feedbackHideTimer);
        feedbackHideTimer = window.setTimeout(() => {
            feedbackOverlay.hidden = true;
            feedbackHideTimer = null;
        }, FEEDBACK_CLOSE_DELAY_MS);

        if (feedbackLastFocused && typeof feedbackLastFocused.focus === 'function' && document.contains(feedbackLastFocused)) {
            feedbackLastFocused.focus();
        }
        feedbackLastFocused = null;
        if (feedbackMessageEl) feedbackMessageEl.value = '';
        feedbackRating = null;
        paintFeedbackStars(null);
    }

    document.querySelectorAll('[data-dash-feedback-open]').forEach((btn) => {
        btn.addEventListener('click', () => openFeedbackModal(btn));
    });

    document.querySelectorAll('[data-dash-feedback-close]').forEach((btn) => {
        btn.addEventListener('click', () => closeFeedbackModal());
    });

    if (feedbackOverlay) {
        // Backdrop click only — a click that starts and ends on the overlay
        // itself (not one that starts inside the dialog and merely
        // bubbles), same `e.target === root` guard as the court viewer.
        feedbackOverlay.addEventListener('click', (e) => {
            if (e.target === feedbackOverlay) closeFeedbackModal();
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && feedbackIsOpen && !e.defaultPrevented) { e.preventDefault(); closeFeedbackModal(); }
    });

    if (feedbackSubmitBtn) {
        feedbackSubmitBtn.addEventListener('click', async () => {
            if (feedbackSubmitPending) return;
            if (feedbackLoadPending) return;
            if (feedbackLoadFailed) {
                await loadCustomerFeedback();
                return;
            }
            const message = (feedbackMessageEl?.value || '').trim();
            if (feedbackRating === null || !Number.isInteger(feedbackRating) || feedbackRating < 1 || feedbackRating > 5) {
                if (feedbackRatingError) feedbackRatingError.hidden = false;
                feedbackStars[0]?.focus();
                return;
            }
            if (feedbackRatingError) feedbackRatingError.hidden = true;
            if (!window.sb || !window.inigosyncProfile) {
                window.InigoToast?.show('Unable to reach the server right now. Please try again shortly.', true);
                return;
            }

            const originalLabel = feedbackSubmitBtn.textContent;
            feedbackSubmitPending = true;
            if (!await confirmSettingsChange(existingFeedbackId ? 'Save changes to your feedback?' : 'Submit this feedback?')) { feedbackSubmitPending = false; return; }
            feedbackSubmitBtn.disabled = true;
            feedbackSubmitBtn.textContent = existingFeedbackId ? 'Saving…' : 'Submitting…';

            let error = null;
            try {
                const payload = { profile_id: window.inigosyncProfile.id, rating: feedbackRating, message: message || null };
                if (existingFeedbackId) {
                    ({ error } = await window.sb.from('feedback').update(payload).eq('id', existingFeedbackId).eq('profile_id', window.inigosyncProfile.id));
                } else {
                    ({ error } = await window.sb.from('feedback').insert(payload));
                    // A second tab can submit between the initial read and
                    // insert. The unique constraint arbitrates; recover by
                    // updating that account's row instead of creating a duplicate.
                    if (error?.code === '23505') {
                        const { data, error: lookupError } = await window.sb.from('feedback').select('id').eq('profile_id', window.inigosyncProfile.id).maybeSingle();
                        if (lookupError || !data?.id) throw lookupError || error;
                        existingFeedbackId = data.id;
                        ({ error } = await window.sb.from('feedback').update(payload).eq('id', data.id).eq('profile_id', window.inigosyncProfile.id));
                    }
                }
            } catch (requestError) {
                error = requestError;
            } finally {
                feedbackSubmitBtn.disabled = false;
                feedbackSubmitPending = false;
                feedbackSubmitBtn.textContent = originalLabel;
            }

            if (error) {
                console.error('[dashboard] feedback save failed', error);
                // isDashboardSchemaMismatch() (defined further below) turns
                // a missing table/column into a clear setup message rather
                // than a raw database error or a fake success toast.
                const friendlyMessage = isDashboardSchemaMismatch(error)
                    ? "Feedback isn't set up yet — this needs a database update. Please try again later."
                    : (error?.message || 'Could not submit your feedback. Please try again.');
                window.InigoToast?.show(friendlyMessage, true);
                return;
            }

            window.InigoToast?.show(existingFeedbackId ? 'Your feedback was updated.' : 'Thanks for your feedback!');
            if (feedbackMessageEl) feedbackMessageEl.value = '';
            feedbackRating = null;
            paintFeedbackStars(null);
            closeFeedbackModal(true);
        });
    }

    // ------------------------------------------------------------------

    // Theme toggle — includes/theme.js manages the data-theme attribute
    // and persistence; this just wires the profile-menu switch to it and keeps
    // the sun/moon icon in sync.
    // ------------------------------------------------------------------
    const themeToggleBtn = document.querySelector('[data-theme-toggle]');
    function syncThemeToggleUI(theme) {
        if (!themeToggleBtn) return;
        const isLight = theme === 'light';
        themeToggleBtn.setAttribute('aria-checked', String(isLight));
        themeToggleBtn.querySelectorAll('.sun-circle, .sun-line').forEach((el) => {
            el.style.display = isLight ? 'none' : '';
        });
        const moonPath = themeToggleBtn.querySelector('.moon-path');
        if (moonPath) moonPath.style.display = isLight ? '' : 'none';
    }
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            if (window.ThemeController) window.ThemeController.toggle();
        });
        document.addEventListener('themechange', (e) => syncThemeToggleUI(e.detail.theme));
        syncThemeToggleUI(document.documentElement.getAttribute('data-theme') || 'dark');
    }

    // Filter chips ("All/Pending/Confirmed/Completed/Cancelled") that used
    // to sit above the My Bookings table are removed outright per §6 of the
    // feedback doc — they were cosmetic-only (this used to just toggle
    // .is-active with a TODO), so no working behavior is lost. The Status
    // column and the rest of the table stay unchanged. .dash-filter-row/
    // .dash-chip/[data-dash-chip] aren't used anywhere else on this page
    // (grepped — only Pages/user_dashboard.html's now-removed markup and
    // Style/Dashboard.css's now-removed rules referenced them), so there is
    // nothing left here to wire.

    // ------------------------------------------------------------------
    // Booking Management (§5, D5) — a 3-step wizard (Select Sport & Court ->
    // Choose Date & Time -> Confirm), one step visible at a time. Reads the
    // same `court`/`sport` tables via window.InigoCourtsData
    // (includes/courtsData.js), which mirrors the fetch-with-static-fallback
    // pattern already proven in includes/landingPage.js. This replaces the
    // hardcoded court list the Booking select used to have — see
    // docs/QA_AUDIT_REPORT.md P0#8 ("three contradictory court lists"). The
    // OTHER two sources P0#8 mentions (the old standalone Courts panel and
    // the Overview widget) are now one and the same — see the Overview
    // Courts section further below (§4/D2).
    //
    // Part 3 (implementation_plan.md, "Multi-hour booking with availability
    // checking") replaced Step 2's 12 hardcoded <button data-dash-slot>
    // elements (three permanently `disabled` as pure mockup, and the grid
    // never regenerated per court or date) with a real, data-driven,
    // multi-hour RANGE picker backed by database/schema/
    // 012_booking_time_range.sql's new end_at/duration_minutes/court_unit
    // columns and its booking_no_overlap EXCLUDE constraint — see
    // refreshTimePickers()/fetchDayOccupancy() further below and that
    // migration's own header comment. Slot selection stores facility-local
    // whole hours and the chosen inventory unit for each cart item.
    // ------------------------------------------------------------------
    if (!window.InigoBusinessHours) {
        // Should never happen — includes/businessHours.js must load before
        // this file (see the <script> order in Pages/user_dashboard.html).
        console.error('[dashboard] window.InigoBusinessHours is missing — check that includes/businessHours.js loads before includes/Dashboard.js.');
    }

    const bookSelect = document.querySelector('[data-dash-book-select]');
    const bookDate = document.querySelector('[data-dash-book-date]');
    const bookingCalendar = document.querySelector('[data-dash-book-calendar]');
    const bookingCalendarTrigger = bookingCalendar?.querySelector('[data-dash-calendar-trigger]');
    const bookingCalendarPopup = bookingCalendar?.querySelector('[data-dash-calendar-popup]');
    const bookingCalendarGrid = bookingCalendar?.querySelector('[data-dash-calendar-grid]');
    const bookingCalendarTitle = bookingCalendar?.querySelector('[data-dash-calendar-title]');
    const bookingCalendarCount = bookingCalendar?.querySelector('[data-dash-calendar-count]');
    if (bookingCalendarPopup && bookingCalendarTrigger) {
        bookingCalendarPopup.classList.add('is-floating');
        document.body.appendChild(bookingCalendarPopup);
    }
    const bookSportGrid = document.querySelector('[data-dash-book-sports]');
    const bookCourtGrid = document.querySelector('[data-dash-book-courts]');
    const bookingModal = document.querySelector('[data-dash-booking-modal]');
    const bookingDialog = bookingModal?.querySelector('[role="dialog"]');
    const bookingCartBar = document.querySelector('[data-dash-book-cart-bar]');
    const bookingCartBarCount = document.querySelector('[data-dash-book-cart-bar-count]');
    const bookingCartBarItems = document.querySelector('[data-dash-book-cart-bar-items]');
    const bookingCartBarTotal = document.querySelector('[data-dash-book-cart-bar-total]');
    const bookingCartBarMore = document.querySelector('[data-dash-book-cart-bar-more]');
    const bookingCartDetailsModal = document.querySelector('[data-dash-book-cart-details-modal]');
    const bookingCartDetailsDialog = bookingCartDetailsModal?.querySelector('[role="dialog"]');
    const bookingCartDetailsList = document.querySelector('[data-dash-book-cart-details-list]');
    const bookingCartDetailsTotal = document.querySelector('[data-dash-book-cart-details-total]');
    const bookingCartDetailsCount = document.querySelector('[data-dash-book-cart-details-count]');
    const bookingCartDetailsButton = document.querySelector('[data-dash-book-cart-details]');
    const bookingCartDetailsProceed = document.querySelector('[data-dash-book-cart-details-proceed]');
    const bookingPaymentModal = document.querySelector('[data-dash-book-payment-modal]');
    const bookingPaymentDialog = bookingPaymentModal?.querySelector('[role="dialog"]');
    const bookingFeeConfirmation = document.querySelector('[data-dash-book-fee-confirmation]');
    const bookingFeeConfirmationDialog = bookingFeeConfirmation?.querySelector('[role="dialog"]');
    const bookingRemoveConfirmation = document.querySelector('[data-dash-book-remove-confirmation]');
    const bookingRemoveConfirmationDialog = bookingRemoveConfirmation?.querySelector('[role="alertdialog"]');
    const bookingRemoveConfirmationDescription = bookingRemoveConfirmation?.querySelector('[data-dash-book-remove-description]');
    const bookingFeeContinue = document.querySelector('[data-dash-book-fee-continue]');
    const bookingFeeQuestion = document.querySelector('[data-dash-book-fee-question]');
    const bookingNavButton = document.querySelector('[data-dash-nav="booking"]');
    const bookingCartProceed = document.querySelector('[data-dash-book-cart-proceed]');
    const bookingPanel = document.querySelector('[data-dash-panel="booking"]');
    const bookSlotsGrid = document.querySelector('[data-dash-book-slots]');
    const bookSlotStatus = document.querySelector('[data-dash-book-slot-status]');
    const bookSelectAllSlots = document.querySelector('[data-dash-book-select-all]');
    const paymentOptions = document.querySelectorAll('[data-dash-payment-option]');
    const paymentModeHint = document.querySelector('[data-dash-pay-mode-hint]');
    const bookSubmit = document.querySelector('[data-dash-book-submit]');
    const bookAddButton = document.querySelector('[data-dash-book-add]');
    const bookCartPanel = document.querySelector('[data-dash-book-cart]');
    const bookCartItemsEl = document.querySelector('[data-dash-book-cart-items]');
    const bookCartCountEl = document.querySelector('[data-dash-book-cart-count]');
    const bookCartEmpty = document.querySelector('[data-dash-book-cart-empty]');

    function syncBookingCartPosition() {
        if (!bookingCartBar || !bookingPanel) return;
        const rect = bookingPanel.getBoundingClientRect();
        const gutter = 8;
        const width = Math.max(0, Math.min(rect.width, window.innerWidth - gutter * 2));
        const left = Math.max(gutter, Math.min(rect.left, window.innerWidth - width - gutter));
        bookingCartBar.style.left = `${left}px`;
        bookingCartBar.style.width = `${width}px`;
    }

    window.addEventListener('resize', syncBookingCartPosition, { passive: true });
    window.addEventListener('scroll', syncBookingCartPosition, { passive: true });
    if (window.ResizeObserver && bookingPanel) {
        const bookingCartResizeObserver = new window.ResizeObserver(syncBookingCartPosition);
        bookingCartResizeObserver.observe(bookingPanel);
        if (dashboardShell) bookingCartResizeObserver.observe(dashboardShell);
    }
    if (window.MutationObserver && dashboardShell) {
        const bookingCartShellObserver = new window.MutationObserver(syncBookingCartPosition);
        bookingCartShellObserver.observe(dashboardShell, { attributes: true, attributeFilter: ['class', 'style'] });
    }

    // Booking dates belong to the facility calendar, regardless of the
    // customer's device timezone.
    function todayDateInputValue() {
        return window.InigoBusinessHours?.dateInManila?.() || new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
    }
    if (bookDate) {
        const todayStr = todayDateInputValue();
        bookDate.min = todayStr;
        if (!bookDate.value || bookDate.value < todayStr) bookDate.value = todayStr;
    }

    let bookingCalendarMonth = new Date(`${(bookDate?.value || todayDateInputValue()).slice(0, 7)}-01T00:00:00`);
    function positionBookingCalendar() {
        if (!bookingCalendarPopup || bookingCalendarPopup.hidden || !bookingCalendarTrigger) return;
        const triggerRect = bookingCalendarTrigger.getBoundingClientRect();
        const popupRect = bookingCalendarPopup.getBoundingClientRect();
        const gutter = 8;
        const width = popupRect.width;
        const height = popupRect.height;
        const left = Math.max(gutter, Math.min(triggerRect.right - width, window.innerWidth - width - gutter));
        const below = window.innerHeight - triggerRect.bottom - gutter;
        const above = triggerRect.top - gutter;
        let top = below >= height || below >= above ? triggerRect.bottom + 6 : triggerRect.top - height - 6;
        top = Math.max(gutter, Math.min(top, window.innerHeight - height - gutter));
        bookingCalendarPopup.style.left = `${left}px`;
        bookingCalendarPopup.style.top = `${top}px`;
    }
    function renderBookingCalendar() {
        if (!bookingCalendarGrid || !bookingCalendarTitle) return;
        const year = bookingCalendarMonth.getFullYear(); const month = bookingCalendarMonth.getMonth();
        bookingCalendarTitle.textContent = bookingCalendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        const first = new Date(year, month, 1); const start = new Date(year, month, 1 - first.getDay());
        const minDate = todayDateInputValue();
        bookingCalendarGrid.innerHTML = ['Su','Mo','Tu','We','Th','Fr','Sa'].map((d) => `<span class="dash-book-calendar-weekday" aria-hidden="true">${d}</span>`).join('')
            + Array.from({ length: 42 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); const key = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; const selected = bookingSelectedDates.has(key); const disabled = key < minDate || (editingBookingCartKey && key !== bookingState.date); const label = date.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric', year:'numeric' }); return `<button type="button" class="dash-book-calendar-day${date.getMonth() !== month ? ' is-outside' : ''}${selected ? ' is-selected' : ''}" data-dash-calendar-date="${key}" aria-label="${label}" aria-pressed="${selected}"${key === minDate ? ' aria-current="date"' : ''}${disabled ? ' disabled' : ''}>${date.getDate()}</button>`; }).join('');
        if (bookingCalendarCount) bookingCalendarCount.textContent = `${bookingSelectedDates.size} date${bookingSelectedDates.size === 1 ? '' : 's'} selected`;
        if (bookingCalendarTrigger) { bookingCalendarTrigger.textContent = bookingSelectedDates.size ? [...bookingSelectedDates].sort().map((d) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month:'short', day:'numeric' })).join(', ') : 'Choose dates'; bookingCalendarTrigger.setAttribute('aria-expanded', String(!bookingCalendarPopup?.hidden)); }
    }
    bookingCalendarPopup?.addEventListener('click', (event) => {
        // Selecting a date rerenders this grid and detaches the clicked node.
        // Stop bubbling before replacement so the document handler does not
        // mistake the old target for an outside click.
        event.stopPropagation();
        const target = event.target.closest('button'); if (!target) return;
        if (target.matches('[data-dash-calendar-done]')) { bookingCalendarPopup.hidden = true; bookingCalendarTrigger?.setAttribute('aria-expanded', 'false'); renderBookingCalendar(); bookingCalendarTrigger?.focus(); return; }
        if (target.matches('[data-dash-calendar-prev], [data-dash-calendar-next]')) { bookingCalendarMonth.setMonth(bookingCalendarMonth.getMonth() + (target.matches('[data-dash-calendar-prev]') ? -1 : 1)); renderBookingCalendar(); positionBookingCalendar(); return; }
        if (target.matches('[data-dash-calendar-date]') && !target.disabled) {
            const date = target.dataset.dashCalendarDate;
            if (editingBookingCartKey) {
                if (bookDate) bookDate.value = date;
                bookingState.date = date; bookingSelectedDates.clear(); bookingSelectedDates.add(date); bookingSelectionsByDate.clear(); bookingSelectionsByDate.set(date, []); bookingState.selectedHours = []; bookingAvailabilityByDate.clear();
            } else if (bookingSelectedDates.has(date)) {
                bookingSelectedDates.delete(date); bookingSelectionsByDate.delete(date); bookingAvailabilityByDate.delete(date);
                if (bookingState.date === date) bookingState.date = [...bookingSelectedDates].sort()[0] || '';
            } else { bookingSelectedDates.add(date); bookingSelectionsByDate.set(date, []); bookingState.date = date; if (bookDate) bookDate.value = date; }
            if (bookDate) bookDate.value = bookingState.date;
            bookingState.selectedHours = [...(bookingSelectionsByDate.get(bookingState.date) || [])];
            const run = window.InigoBookingSlots.groupConsecutiveHours(bookingState.selectedHours)[0]; bookingState.startHour = run?.startHour ?? null; bookingState.endHour = run ? run.endHourExclusive - 1 : null;
            renderBookingCalendar(); positionBookingCalendar(); refreshTimePickers(); updateSummary();
        }
    });
    bookingCalendarTrigger?.addEventListener('click', () => {
        bookingCalendarPopup.hidden = !bookingCalendarPopup.hidden;
        bookingCalendarTrigger.setAttribute('aria-expanded', String(!bookingCalendarPopup.hidden));
        if (!bookingCalendarPopup.hidden) { renderBookingCalendar(); positionBookingCalendar(); }
    });
    window.addEventListener('resize', positionBookingCalendar, { passive: true });
    window.addEventListener('scroll', positionBookingCalendar, { passive: true, capture: true });
    document.addEventListener('click', (event) => { if (bookingCalendarPopup && !bookingCalendarPopup.hidden && !bookingCalendarPopup.contains(event.target) && !bookingCalendarTrigger?.contains(event.target)) { bookingCalendarPopup.hidden = true; bookingCalendarTrigger?.setAttribute('aria-expanded', 'false'); renderBookingCalendar(); } });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && bookingCalendarPopup && !bookingCalendarPopup.hidden) { bookingCalendarPopup.hidden = true; bookingCalendarTrigger?.setAttribute('aria-expanded', 'false'); renderBookingCalendar(); bookingCalendarTrigger?.focus(); } });

    const summaryPayment = document.querySelector('[data-dash-summary-payment]');
    const summaryTotal = document.querySelector('[data-dash-summary-total]');
    const summaryGross = document.querySelector('[data-dash-summary-gross]');
    const summaryBalance = document.querySelector('[data-dash-summary-balance]');
    const paymentReceiptItems = document.querySelector('[data-dash-payment-receipt-items]');
    const paymentTermsAccepted = document.querySelector('[data-dash-payment-terms-accepted]');
    const paymentTermsDialog = document.querySelector('[data-dash-payment-terms-dialog]');
    const paymentTermsOpen = document.querySelector('[data-dash-payment-terms-accepted]');
    const paymentTermsAgree = document.querySelector('[data-dash-payment-terms-agree]');
    const paymentTermsDecline = document.querySelector('[data-dash-payment-terms-decline]');
    const paymentTermsStatus = document.querySelector('[data-dash-payment-terms-status]');
    let paymentAcceptanceSignature = null;
    let paymentTermsReturnFocus = null;
    let paymentTermsDialogAgreed = false;

    // Customer booking steps remain inline: sport, court, schedule, summary.
    const bookStepPanels = document.querySelectorAll('[data-dash-book-step]');

    // Step 2's compact preview uses the chosen inventory unit's image.
    const bookUnitWrap = document.querySelector('[data-dash-book-unit-wrap]');
    const bookUnitLabel = document.querySelector('[data-dash-book-unit-label]');
    const bookUnitSelect = document.querySelector('[data-dash-book-unit-select]');
    const bookUnitPreview = document.querySelector('[data-dash-book-unit-preview]');
    const bookUnitPreviewMedia = document.querySelector('[data-dash-book-unit-preview-media]');
    const bookUnitPreviewCaption = document.querySelector('[data-dash-book-unit-preview-caption]');

    // Court and rate start empty until window.InigoCourtsData.getCourts() resolves
    // below (populateBookSelect). Every court's rate is NULL in the live DB
    // today (the owner hasn't confirmed prices yet — see
    // database/seed/002_seed_content.sql), so "unknown rate" has to be a
    // first-class state here, not an assumed 300. `sport` is the selected
    // court's REAL related sport (e.g. "Bowling" for the "Bowling —
    // Duckpin" court, not a copy of the court name) — booking.sports is
    // NOT NULL, so this must never still be empty by the time a booking is
    // submitted; it is passed to the server checkout function. `unit` is the Step 1 preview's
    // currently resolved Court/Lane/Table label (window.InigoCourtsData
    // .resolveCourtUnits(), kept in sync by paintBookPreview() below) — used
    // chosen unit is included in cart items, since availability/overlap is checked PER UNIT, not per
    // sport (booking two different Basketball courts must not conflict with
    // each other). Selected hours are stored as facility-local whole-hour integers.
    let bookingState = {
        court: '',
        sport: '',
        rate: null,
        rateUnit: '/hr',
        rateDay: null,
        rateNight: null,
        nightRateStartsAt: null,
        date: bookDate ? bookDate.value : '',
        unit: null,
        unitId: null,
        startHour: null,
        endHour: null,
        selectedHours: [],
        sportSlug: '',
        paymentType: 'downpayment',
        // Overwritten once window.InigoAppSettings.getSettings() resolves
        // below — 50 is the same fallback that module itself uses when
        // `app_settings` doesn't exist yet, so this default is never
        // visibly wrong, just possibly stale for a moment on first load.
        downpaymentPct: window.InigoAppSettings ? window.InigoAppSettings.DEFAULT_SETTINGS.downpaymentPct : 50,
    };
    const bookingCart = [];
    const bookingSelectedDates = new Set(bookingState.date ? [bookingState.date] : []);
    const bookingSelectionsByDate = new Map(bookingState.date ? [[bookingState.date, []]] : []);
    const bookingAvailabilityByDate = new Map();
    let bookingCartSeq = 0;
    let bookingSummaryBackKey = null;
    let editingBookingCartKey = null;
    let addingBookingFromSummary = false;
    let plainSummaryBackMode = false;
    let bookingCartSaving = false;
    let landingDraftProfileReady = window.inigosyncProfile?.role === 'customer';
    let landingDraftCourtDataReady = false;
    let landingDraftSettingsReady = !window.InigoAppSettings;
    let landingDraftImportInFlight = false;
    let bookingFeeReturnFocus = null;
    let bookingFeeContinueAction = null;

    const downpaymentDesc = document.querySelector('[data-dash-payment-desc="downpayment"]');

    // ------------------------------------------------------------------
    // Step 1 dynamic court preview (§5, D5) — bookCourtsCache holds the same
    // normalized court objects populateBookSelect() below receives from
    // window.InigoCourtsData.getCourts() (quantity/unit/unitImages included,
    // unlike the <select>'s own <option data-*> attributes, which only carry
    // rate/rateUnit/sport), so a court can be looked up by name whenever the
    // preview needs to repaint. bookSelectedUnitIndex resets to 0 every time
    // the COURT changes (a new court's units always start at its first one).
    // ------------------------------------------------------------------
    let bookCourtsCache = [];
    let bookSelectedUnitIndex = 0;

    function findBookCourt(name) {
        return bookCourtsCache.find((c) => c.name === name) || null;
    }

    // Repaints the preview image + unit combo box for `court` (or a neutral
    // "select a court" placeholder when none is known yet — e.g. before
    // window.InigoCourtsData.getCourts() resolves). Reuses
    // courtPhotoMarkup()/window.InigoCourtsData.resolveCourtUnits() rather than a
    // second implementation — see that function's own header comment for
    // why "no photo yet" always renders the honest "Photo coming soon"
    // placeholder instead of a broken <img> or an invented URL. Also the
    // ONE place that keeps bookingState.unit in sync (Part 3/D3) — every
    // caller below (bookSelect's court change, the unit <select>'s own
    // change, and populateBookSelect()'s initial paint) always goes through
    // here, so availability and checkout use the selected unit even when
    // this optional visual preview has not mounted.
    function paintBookPreview(court, unitIndexOverride) {
        if (!court) {
            bookSelectedUnitIndex = 0;
            if (bookUnitPreviewMedia) bookUnitPreviewMedia.innerHTML = '<span class="dash-court-monogram" aria-hidden="true">?<small class="dash-court-photo-soon">Choose a court to preview it</small></span>';
            if (bookUnitPreviewCaption) bookUnitPreviewCaption.textContent = 'Choose a court to preview it.';
            if (bookUnitWrap) bookUnitWrap.hidden = true;
            if (bookUnitSelect) { bookUnitSelect.innerHTML = '<option value="">Choose a court</option>'; bookUnitSelect.disabled = true; }
            if (bookUnitPreview) bookUnitPreview.hidden = !bookingState.sportSlug;
            bookingState.unit = null;
            bookingState.unitId = null;
            bookingState.rateDay = null;
            bookingState.rateNight = null;
            bookingState.rate = null;
            bookingState.rateUnit = '/hr';
            return;
        }

        const resolved = window.InigoCourtsData
            ? window.InigoCourtsData.resolveCourtUnits(court)
            : { pickerLabel: '', units: [{ label: null, imageUrl: court.imageUrl }] };
        const units = resolved.units.length ? resolved.units : [{ label: null, imageUrl: court.imageUrl }];
        const hasExplicitUnit = Number.isInteger(unitIndexOverride) && unitIndexOverride >= 0 && unitIndexOverride < units.length;
        const index = hasExplicitUnit ? unitIndexOverride : -1;
        bookSelectedUnitIndex = Math.max(0, index);
        const unit = hasExplicitUnit ? units[index] : null;
        // Null only in the rare "quantity 0, no unit_images" fallback (see
        // window.InigoCourtsData.resolveCourtUnits()) — a real data gap, not
        // an error; fetchDayOccupancy()/the insert below both treat a null
        // unit as "nothing to disambiguate", same as a legacy pre-Part-3
        // booking.
        bookingState.unit = unit?.label || null;
        bookingState.unitId = unit?.id || null;
        bookingState.rateDay = unit?.rateDay ?? null;
        bookingState.rateNight = unit?.rateNight ?? null;
        bookingState.rateUnit = unit && (typeof unit.rateDay === 'number' || typeof unit.rateNight === 'number') ? (unit.rateUnit || court.rateUnit || '/hr') : (court.rateUnit || '/hr');
        bookingState.rate = unit ? (unit.rate ?? court.rate ?? null) : null;

        const monogram = window.InigoCourtsData ? window.InigoCourtsData.monogramFor(court.sportSlug, court.name) : '?';
        const alt = unit?.label ? `${court.name} — ${unit.label}` : court.name;
        if (bookUnitPreview) bookUnitPreview.hidden = false;
        if (bookUnitPreviewMedia) bookUnitPreviewMedia.innerHTML = unit
            ? courtPhotoMarkup(unit, monogram, alt)
            : '<span class="dash-court-monogram" aria-hidden="true">?<small class="dash-court-photo-soon">Choose a court to preview it</small></span>';
        if (bookUnitPreviewCaption) {
            if (!unit) {
                bookUnitPreviewCaption.textContent = 'Choose a court to preview it.';
            } else {
                const sportName = String(bookingState.sport || court.sportName || '').trim();
                const listingName = String(court.name || '').trim();
                const labels = sportName && sportName.toLocaleLowerCase() !== listingName.toLocaleLowerCase()
                    ? [sportName, listingName] : [listingName || sportName];
                if (unit.label) labels.push(unit.label);
                const rateUnit = unit.rateUnit || court.rateUnit || '/hr';
                const formatRate = (value) => `₱${Number(value).toLocaleString('en-PH', { maximumFractionDigits: 2 })}${rateUnit}`;
                const dayRate = unit.rateDay;
                const nightRate = unit.rateNight;
                let rateLabel = '';
                if (typeof dayRate === 'number' && Number.isFinite(dayRate)
                    && typeof nightRate === 'number' && Number.isFinite(nightRate)) {
                    rateLabel = dayRate === nightRate ? formatRate(dayRate) : `${formatRate(dayRate)} day · ${formatRate(nightRate)} night`;
                } else if (typeof unit.rate === 'number' && Number.isFinite(unit.rate)) {
                    rateLabel = formatRate(unit.rate);
                } else if (typeof court.rate === 'number' && Number.isFinite(court.rate)) {
                    rateLabel = formatRate(court.rate);
                }
                bookUnitPreviewCaption.textContent = `${labels.filter(Boolean).join(' · ')}${rateLabel ? ` · ${rateLabel}` : ''}`;
            }
        }

        // Same broken-photo-URL fallback as paintOverviewCourtMedia() below
        // — a typo'd unit_images URL degrades to the placeholder instead of
        // a broken-image icon.
        const img = bookUnitPreviewMedia?.querySelector('img[data-dash-book-photo]');
        if (img) {
            img.addEventListener('error', () => {
                img.remove();
                bookUnitPreviewMedia.insertAdjacentHTML('afterbegin', courtPhotoMarkup({ imageUrl: null }, monogram, alt));
            }, { once: true });
        }

        if (bookUnitLabel) bookUnitLabel.textContent = resolved.pickerLabel || 'Choose a unit';
        if (bookUnitSelect) {
            bookUnitSelect.innerHTML = '<option value="">Choose a court</option>' + units.map((u, i) => `<option value="${i}"${i === index ? ' selected' : ''}${u.id ? '' : ' disabled'}>${window.escapeHtml(u.label || `${court.name} ${i + 1}`)}${u.id ? '' : ' — unavailable online'}</option>`).join('');
            bookUnitSelect.disabled = false;
        }
        if (bookUnitWrap) bookUnitWrap.hidden = false;
    }

    // Looks up bookingState.court's full record and repaints the preview
    // from scratch (unit reset to its first one) — the one call site every
    // "the selected court just changed" path below uses, so the preview can
    // never fall out of sync with bookingState.
    function syncBookPreviewFromState() {
        bookSelectedUnitIndex = 0;
        paintBookPreview(findBookCourt(bookingState.court));
    }

    if (bookUnitSelect) {
        bookUnitSelect.addEventListener('change', () => {
            const court = findBookCourt(bookingState.court);
            if (!court) return;
            // A different unit can have entirely different availability,
            // so clear selected hours and reload occupancy for that unit.
            paintBookPreview(court, bookUnitSelect.value === '' ? undefined : Number(bookUnitSelect.value));
            resetTimeSelectionAndRender();
            updateSummary();
        });
    }

    let bookingModalTrigger = null;
    function openBookingModal(trigger) {
        if (!bookingModal || !bookingDialog) return;
        bookingModalTrigger = trigger || null;
        bookingModal.hidden = false;
        if (bookAddButton) bookAddButton.hidden = false;
        document.body.classList.add('dash-booking-modal-open');
        const firstControl = bookingDialog.querySelector('select:not(:disabled), input:not(:disabled), button:not(:disabled)');
        (firstControl || bookingDialog).focus();
    }

    function closeBookingModal(restoreFocus = true) {
        if (!bookingModal || bookingModal.hidden) return;
        bookingModal.hidden = true;
        if (bookAddButton) bookAddButton.hidden = true;
        document.body.classList.remove('dash-booking-modal-open');
        if (restoreFocus) {
            const target = bookingModalTrigger?.isConnected ? bookingModalTrigger : bookSportGrid?.querySelector('[data-dash-book-sport]');
            target?.focus();
        }
        bookingModalTrigger = null;
    }

    if (bookingModal) {
        bookingModal.addEventListener('click', (event) => {
            if (event.target.closest('[data-dash-booking-modal-close]')) closeBookingModal();
        });
        bookingModal.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeBookingModal();
                return;
            }
            if (event.key !== 'Tab' || !bookingDialog) return;
            const focusable = Array.from(bookingDialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'))
                .filter((el) => !el.hidden && el.getClientRects().length);
            if (!focusable.length) { event.preventDefault(); bookingDialog.focus(); return; }
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === bookingDialog)) {
                event.preventDefault(); last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault(); first.focus();
            }
        });
    }

    let bookingCartDetailsReturnFocus = null;
    let bookingPaymentReturnFocus = null;
    let bookWizardStep = 1;

    function renderBookWizard() {
        bookStepPanels.forEach((panel) => {
            const active = Number(panel.dataset.dashBookStep) === bookWizardStep;
            panel.classList.toggle('is-active', active);
            panel.hidden = !active;
        });
        document.querySelectorAll('[data-dash-book-progress-step]').forEach((step) => {
            const stepNumber = Number(step.dataset.dashBookProgressStep);
            step.classList.toggle('is-current', stepNumber === bookWizardStep);
            step.classList.toggle('is-complete', stepNumber < bookWizardStep);
            if (stepNumber === bookWizardStep) step.setAttribute('aria-current', 'step');
            else step.removeAttribute('aria-current');
        });
        const selectedCourt = findBookCourt(bookingState.court);
        const scheduleSummary = document.querySelector('[data-dash-book-schedule-summary]');
        if (scheduleSummary) {
            if (!selectedCourt) scheduleSummary.textContent = 'Choose a court, unit, and date first.';
            else {
                const sportName = String(bookingState.sport || '').trim();
                const listingName = String(selectedCourt.name || '').trim();
                const courtLabel = sportName && sportName.toLocaleLowerCase() !== listingName.toLocaleLowerCase()
                    ? `${sportName} · ${listingName}` : (listingName || sportName);
                scheduleSummary.textContent = `${courtLabel}${bookingState.unit ? ` · ${bookingState.unit}` : ''} · ${formatDate(bookingState.date)}`;
            }
        }
        const nextCourtButton = document.querySelector('[data-dash-book-next="3"]');
        if (nextCourtButton) nextCourtButton.disabled = !bookingState.court || !bookingState.unitId;
        const nextSportButton = document.querySelector('[data-dash-book-sport-next]');
        if (nextSportButton) nextSportButton.disabled = !bookingState.sportSlug;
        const paymentNextButton = document.querySelector('[data-dash-book-payment-next]');
        if (paymentNextButton) paymentNextButton.disabled = !bookingCart.length || bookingCartSaving;
        document.querySelectorAll('[data-dash-book-edit-cancel]').forEach((button) => {
            button.hidden = !editingBookingCartKey && !(addingBookingFromSummary && bookingCart.length);
            button.textContent = editingBookingCartKey ? 'Cancel edit' : 'Back to summary';
        });
    }

    function goToBookStep(step) {
        const nextStep = Number(step);
        if (!Number.isInteger(nextStep) || nextStep < 1 || nextStep > 5) return;
        const movingBackward = nextStep < bookWizardStep;
        if (!movingBackward && nextStep === 2 && !bookingState.sportSlug) return;
        if (!movingBackward && nextStep === 4 && !bookingCart.length) return;
        if (!movingBackward && nextStep === 3 && (!bookingState.court || !bookingState.unitId)) return;
        if (nextStep === 4) plainSummaryBackMode = false;
        bookWizardStep = nextStep;
        renderBookWizard();
        updateSummary();
        renderBookingCart();
    }

    function openBookingCartDetails() {
        if (!bookingCart.length || !bookingCartDetailsModal || !bookingCartDetailsDialog) return;
        bookingCartDetailsReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : bookingCartDetailsButton;
        bookingCartDetailsModal.hidden = false;
        document.body.classList.add('dash-book-cart-details-open');
        renderBookingCart();
        const closeButton = bookingCartDetailsDialog.querySelector('[data-dash-book-cart-details-close]');
        (closeButton || bookingCartDetailsDialog).focus({ preventScroll: true });
    }

    function closeBookingCartDetails(restoreFocus = true) {
        if (!bookingCartDetailsModal || bookingCartDetailsModal.hidden) return;
        bookingCartDetailsModal.hidden = true;
        document.body.classList.remove('dash-book-cart-details-open');
        renderBookingCart();
        if (restoreFocus) (bookingCartDetailsReturnFocus?.isConnected ? bookingCartDetailsReturnFocus : bookingCartDetailsButton)?.focus({ preventScroll: true });
        bookingCartDetailsReturnFocus = null;
    }

    function openBookingPayment() {
        if (!bookingPaymentModal || !bookingPaymentDialog || !bookingCart.length) return;
        const openedFromDetails = Boolean(bookingCartDetailsModal && !bookingCartDetailsModal.hidden);
        closeBookingModal(false);
        closeBookingCartDetails(false);
        bookingPaymentReturnFocus = openedFromDetails ? bookingCartProceed
            : document.activeElement instanceof HTMLElement ? document.activeElement : bookingCartProceed;
        bookWizardStep = 1;
        renderBookWizard();
        updateSummary();
        bookingPaymentModal.hidden = false;
        document.body.classList.add('dash-book-payment-open');
        renderBookingCart();
        const closeButton = bookingPaymentDialog.querySelector('[data-dash-book-payment-close]');
        (closeButton || bookingPaymentDialog).focus({ preventScroll: true });
    }

    function closeBookingPayment(restoreFocus = true) {
        if (!bookingPaymentModal || bookingPaymentModal.hidden) return;
        bookingPaymentModal.hidden = true;
        document.body.classList.remove('dash-book-payment-open');
        bookWizardStep = 1;
        renderBookWizard();
        renderBookingCart();
        if (restoreFocus) (bookingPaymentReturnFocus?.isConnected ? bookingPaymentReturnFocus : bookingCartProceed)?.focus({ preventScroll: true });
        bookingPaymentReturnFocus = null;
    }

    function openBookingFeeConfirmation({ question, continueLabel, returnFocus, onContinue } = {}) {
        if (!bookingFeeConfirmation || !bookingFeeConfirmationDialog || bookingCartSaving) return;
        if (!onContinue && !bookingCart.length) return;
        bookingFeeReturnFocus = returnFocus || bookSubmit;
        bookingFeeContinueAction = onContinue || (() => submitBookingCart());
        if (bookingFeeQuestion) bookingFeeQuestion.textContent = question || 'Would you like to continue to secure checkout?';
        if (bookingFeeContinue) bookingFeeContinue.textContent = continueLabel || 'Proceed to pay online';
        bookingFeeConfirmation.hidden = false;
        const cancelButton = bookingFeeConfirmation.querySelector('button[data-dash-book-fee-close]');
        (cancelButton || bookingFeeContinue || bookingFeeConfirmationDialog).focus({ preventScroll: true });
    }

    function closeBookingFeeConfirmation(restoreFocus = true) {
        if (!bookingFeeConfirmation || bookingFeeConfirmation.hidden) return;
        bookingFeeConfirmation.hidden = true;
        const target = bookingFeeReturnFocus;
        bookingFeeReturnFocus = null;
        bookingFeeContinueAction = null;
        if (restoreFocus) {
            const canRestore = target?.isConnected && !target.disabled && !target.closest('[hidden]')
                && target.getClientRects().length;
            if (canRestore) target.focus({ preventScroll: true });
            else if (!bookingPaymentModal?.hidden) bookingPaymentDialog?.focus({ preventScroll: true });
            else bookingNavButton?.focus({ preventScroll: true });
        }
    }

    function handleBookingDialogKeydown(event, dialog, close) {
        if (event.key === 'Escape') {
            event.preventDefault();
            close();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = Array.from(dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'))
            .filter((el) => !el.hidden && el.getClientRects().length);
        if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
            event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault(); first.focus();
        }
    }

    bookingCartDetailsButton?.addEventListener('click', openBookingCartDetails);
    bookingCartProceed?.addEventListener('click', openBookingPayment);
    bookingCartDetailsProceed?.addEventListener('click', openBookingPayment);
    bookingCartDetailsModal?.addEventListener('click', (event) => {
        if (event.target.closest('[data-dash-book-cart-details-close]')) closeBookingCartDetails();
        else if (event.target === bookingCartDetailsModal) closeBookingCartDetails();
    });
    bookingCartDetailsModal?.addEventListener('keydown', (event) => handleBookingDialogKeydown(event, bookingCartDetailsDialog, closeBookingCartDetails));
    bookingPaymentModal?.addEventListener('click', (event) => {
        if (event.target.closest('[data-dash-book-payment-close]') || event.target === bookingPaymentModal) closeBookingPayment();
    });
    bookingPaymentModal?.addEventListener('keydown', (event) => handleBookingDialogKeydown(event, bookingPaymentDialog, closeBookingPayment));
    bookingFeeConfirmation?.addEventListener('click', (event) => {
        if (event.target.closest('[data-dash-book-fee-close]') || event.target === bookingFeeConfirmation) closeBookingFeeConfirmation();
    });
    bookingFeeConfirmation?.addEventListener('keydown', (event) => handleBookingDialogKeydown(event, bookingFeeConfirmationDialog, closeBookingFeeConfirmation));
    document.querySelector('[data-dash-book-new]')?.addEventListener('click', () => {
        editingBookingCartKey = null;
        addingBookingFromSummary = true;
        resetBookingDatesForFreshDraft();
        bookingState.sportSlug = '';
        bookingState.court = '';
        bookingState.sport = '';
        bookingState.rate = null;
        bookingState.unit = null;
        bookingState.unitId = null;
        bookingState.selectedHours = [];
        bookSelect.value = '';
        bookSelect.disabled = true;
        paintBookPreview(null);
        renderSportChoices();
        resetTimeSelectionAndRender();
        goToBookStep(1);
    });

    async function editBookingCartItem(key, returnStep = 1) {
        if (bookingCartSaving) return;
        const item = bookingCart.find((candidate) => candidate.key === key);
        const court = item && bookCourtsCache.find((candidate) => String(candidate.id) === String(item.listingId));
        const unit = court && window.InigoCourtsData.resolveCourtUnits(court).units.find((candidate) => String(candidate.id) === String(item.unitId));
        if (!item || !court || !unit) {
            window.InigoToast?.show('This court unit is no longer listed. Remove this booking or refresh the page.', true);
            return;
        }
        editingBookingCartKey = key;
        addingBookingFromSummary = false;
        if (bookAddButton) bookAddButton.textContent = 'Save changes';
        bookingState.sportSlug = bookSportChoiceKey(court);
        renderSportChoices();
        const sportRadio = [...(bookSportGrid?.querySelectorAll('.dash-book-sport-radio') || [])]
            .find((radio) => radio.value === bookingState.sportSlug);
        if (sportRadio) sportRadio.checked = true;
        const courts = bookCourtsCache.filter((candidate) => bookSportChoiceKey(candidate) === bookingState.sportSlug);
        bookSelect.innerHTML = '<option value="">Choose a court</option>' + courts.map((candidate) => {
            const label = candidate.name;
            return `<option value="${window.escapeHtml(candidate.name)}" data-rate="${candidate.rate !== null ? window.escapeHtml(String(candidate.rate)) : ''}" data-rate-unit="${window.escapeHtml(candidate.rateUnit || '/hr')}" data-sport="${window.escapeHtml(candidate.sportName || candidate.name)}">${window.escapeHtml(label)}</option>`;
        }).join('');
        bookSelect.disabled = false;
        renderCourtChoices(courts);
        if (!selectBookCourtUnit(court.name, unit.id)) {
            editingBookingCartKey = null;
            if (bookAddButton) bookAddButton.textContent = 'Review booking';
            window.InigoToast?.show('This court unit could not be selected. Please try again.', true);
            updateSummary();
            return;
        }
        bookingState.date = item.date;
        if (bookDate) bookDate.value = item.date;
        bookingState.startHour = item.startHour;
        bookingState.endHour = item.endHour;
        bookingState.selectedHours = Array.from({ length: item.hours }, (_, index) => item.startHour + index);
        bookingSelectedDates.clear();
        bookingSelectedDates.add(item.date);
        bookingSelectionsByDate.clear();
        bookingSelectionsByDate.set(item.date, [...bookingState.selectedHours]);
        await refreshTimePickers(true);
        goToBookStep(returnStep);
        updateSummary();
        document.querySelector(`[data-dash-book-step="${returnStep}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    function cancelBookingCartEdit() {
        if ((!editingBookingCartKey && !(addingBookingFromSummary && bookingCart.length)) || bookingCartSaving) return;
        editingBookingCartKey = null;
        addingBookingFromSummary = false;
        if (bookAddButton) bookAddButton.textContent = 'Review booking';
        bookingState.selectedHours = [];
        bookingSelectionsByDate.set(bookingState.date, []);
        bookingState.startHour = null;
        bookingState.endHour = null;
        updateSummary();
        goToBookStep(4);
    }
    document.querySelectorAll('[data-dash-book-edit-cancel]').forEach((button) => button.addEventListener('click', cancelBookingCartEdit));

    function formatDate(value) {
        if (!value) return '—';
        const d = new Date(`${value}T00:00:00`);
        if (Number.isNaN(d.getTime())) return value;
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function hasKnownRate() {
        return (typeof bookingState.rateDay === 'number' && Number.isFinite(bookingState.rateDay))
            || (typeof bookingState.rate === 'number' && Number.isFinite(bookingState.rate));
    }

    function bookingHourlyAmount(hours) {
        if (!hasKnownRate() || hours <= 0 || bookingState.rateUnit !== '/hr') return null;
        const cutoff = bookingState.nightRateStartsAt;
        if (typeof bookingState.rateDay !== 'number' || typeof bookingState.rateNight !== 'number'
            || bookingState.rateDay === bookingState.rateNight) {
            const rate = typeof bookingState.rateDay === 'number' ? bookingState.rateDay : bookingState.rate;
            return typeof rate === 'number' ? rate * hours : null;
        }
        if (!cutoff || bookingState.startHour === null) return null;
        const match = /^(\d{2}):(\d{2})/.exec(String(cutoff));
        if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
        const cutoffMinutes = Number(match[1]) * 60 + Number(match[2]);
        let total = 0;
        for (let hour = bookingState.startHour; hour < bookingState.startHour + hours; hour += 1) {
            const start = hour * 60;
            const end = start + 60;
            const nightMinutes = Math.max(0, end - Math.max(start, cutoffMinutes));
            total += (60 - nightMinutes) / 60 * bookingState.rateDay + nightMinutes / 60 * bookingState.rateNight;
        }
        return total;
    }

    if (bookSelect) {
        bookSelect.addEventListener('change', () => {
            const opt = bookSelect.selectedOptions[0];
            bookingState.court = bookSelect.value;
            bookingState.sport = (opt && opt.dataset.sport) || bookingState.court;
            bookingState.rate = (opt && opt.dataset.rate) ? Number(opt.dataset.rate) : null;
            bookingState.rateUnit = (opt && opt.dataset.rateUnit) || '/hr';
            syncBookPreviewFromState();
            // A different court has different availability, so clear the
            // in-progress slot selection and refetch occupancy.
            resetTimeSelectionAndRender();
            updateSummary();
        });
    }

    if (bookDate) {
        bookDate.addEventListener('change', () => {
            // Belt-and-suspenders on top of the `min` attribute set above —
            // `min` stops most browsers' native date picker from offering a
            // past date, but doesn't stop every possible way a value gets
            // into this input (e.g. a very old browser, or manual entry
            // where supported). Clamped forward to today rather than just
            // rejected, so the field never sits on an invalid value.
            const todayStr = todayDateInputValue();
            if (!bookDate.value) {
                bookDate.value = bookingState.date || todayStr;
            } else if (bookDate.value < todayStr) {
                bookDate.value = todayStr;
                window.InigoToast?.show("You can't book a date in the past — showing today instead.", true);
            }
            if (editingBookingCartKey && bookDate.value !== bookingState.date) {
                bookingState.date = bookDate.value;
                bookingState.selectedHours = [];
                bookingState.startHour = null;
                bookingState.endHour = null;
                bookingSelectedDates.clear();
                bookingSelectedDates.add(bookingState.date);
                bookingSelectionsByDate.clear();
                bookingSelectionsByDate.set(bookingState.date, []);
                bookingAvailabilityByDate.clear();
                refreshTimePickers();
                updateSummary();
                return;
            }
            bookingSelectionsByDate.set(bookingState.date, [...bookingState.selectedHours]);
            bookingState.date = bookDate.value;
            bookingSelectedDates.add(bookingState.date);
            bookingState.selectedHours = [...(bookingSelectionsByDate.get(bookingState.date) || [])];
            const firstRun = window.InigoBookingSlots.groupConsecutiveHours(bookingState.selectedHours)[0];
            bookingState.startHour = firstRun?.startHour ?? null;
            bookingState.endHour = firstRun ? firstRun.endHourExclusive - 1 : null;
            refreshTimePickers();
            updateSummary();
        });
    }

    paymentOptions.forEach((option) => {
        const radio = option.querySelector('input[type="radio"]');
        radio?.addEventListener('change', () => {
            paymentOptions.forEach((o) => o.classList.remove('is-selected'));
            option.classList.add('is-selected');
            bookingState.paymentType = radio.dataset.dashPayment;
            if (paymentTermsAccepted) paymentTermsAccepted.checked = false;
            updateSummary();
        });
    });

    function closePaymentTermsDialog(accepted = false) {
        paymentTermsDialogAgreed = accepted;
        if (paymentTermsAccepted) paymentTermsAccepted.checked = accepted;
        updateSummary();
        if (paymentTermsDialog?.open) paymentTermsDialog.close();
        else if (!accepted) paymentTermsOpen?.focus({ preventScroll: true });
    }

    function openPaymentTermsDialog() {
        // The checkbox is only a request to review the terms. It stays unchecked
        // unless the customer explicitly chooses Agree in the dialog.
        if (paymentTermsAccepted) paymentTermsAccepted.checked = false;
        updateSummary();
        paymentTermsReturnFocus = paymentTermsOpen;
        if (paymentTermsDialog && !paymentTermsDialog.open) paymentTermsDialog.showModal();
        paymentTermsDecline?.focus({ preventScroll: true });
    }
    paymentTermsAccepted?.addEventListener('change', () => {
        if (paymentTermsAccepted.checked) openPaymentTermsDialog();
        else updateSummary();
    });
    paymentTermsAgree?.addEventListener('click', () => closePaymentTermsDialog(true));
    paymentTermsDecline?.addEventListener('click', () => closePaymentTermsDialog(false));
    paymentTermsDialog?.addEventListener('cancel', (event) => {
        event.preventDefault();
        closePaymentTermsDialog(false);
    });
    paymentTermsDialog?.addEventListener('click', (event) => {
        if (event.target === paymentTermsDialog) closePaymentTermsDialog(false);
    });
    paymentTermsDialog?.addEventListener('keydown', (event) => handleBookingDialogKeydown(
        event, paymentTermsDialog, () => closePaymentTermsDialog(false),
    ));
    paymentTermsDialog?.addEventListener('close', () => {
        if (!paymentTermsDialogAgreed && paymentTermsAccepted) paymentTermsAccepted.checked = false;
        paymentTermsDialogAgreed = false;
        updateSummary();
        const target = paymentTermsReturnFocus;
        paymentTermsReturnFocus = null;
        if (target?.isConnected && !target.disabled && !target.closest('[hidden]')) target.focus({ preventScroll: true });
    });

    // ------------------------------------------------------------------
    // Step 3 — hourly slot availability from booking_rules_for_date and
    // court_occupancy. Selection is fail-closed and checkout revalidates.
    //
    // RLS CAVEAT — direct booking-table SELECT policies stay unchanged. The
    // availability RPC returns only court/time occupancy, and database
    // exclusion remains the final race-safe guard. Its 23P01 response is
    // surfaced as a friendly conflict below.
    // ------------------------------------------------------------------
    let slotGridBookings = { ok: true, rows: [] };
    // Walk-ins from the same occupancy snapshot as slotGridBookings above.
    // Same { ok, rows } shape so every
    // reader that already checks slotGridBookings.ok can check this one the
    // same way.
    let slotGridWalkins = { ok: true, rows: [] };
    // The selected date's owner-managed hours, shared by the booking
    // pickers and their checkout preflight. The server revalidates every
    // checkout, but the customer should see the same daily window first.
    let bookingRules = null;
    // Bumped on every refreshTimePickers() call so a slow, now-superseded
    // fetch (rapid court/date/unit changes) can detect it's stale and drop
    // its own result instead of overwriting a newer render. Both this and
    // slotGridBookings above keep their Part 3 names (the "slot grid" they
    // once fed no longer exists as of Revision 5, D3) rather than a
    // cosmetic rename — they still gate the exact same race guard and hold
    // the exact same fetched rows for renderTimePickers() below.
    let slotGridRequestSeq = 0;
    let slotGridLoading = false;

    async function fetchDayOccupancy(courtName, dateStr) {
        if (!window.sb || !courtName || !dateStr) return { ok: false, rows: [] };
        if (!window.InigoBookingSlots) return { ok: false, rows: [] };
        const dayStart = window.InigoBookingSlots.localDateHourToIso(dateStr, 0);
        const dayEnd = window.InigoBookingSlots.localDateHourToIso(window.InigoBookingSlots.nextDate(dateStr), 0);
        let res;
        try {
            res = await window.sb.rpc('court_occupancy', {
                from_at: dayStart, to_at: dayEnd,
            });
        } catch (error) {
            console.error('[dashboard] failed to load occupancy for the time pickers', error);
            return { ok: false, rows: [] };
        }

        if (!res || res.error || !Array.isArray(res.data)) {
            console.error('[dashboard] failed to load occupancy for the time pickers', res?.error || 'Invalid occupancy response');
            return { ok: false, rows: [] };
        }
        const rows = res.data.filter((row) => sameCourtName(row?.courts, courtName));
        const validRows = rows.every((row) => {
            const start = new Date(row?.time_date);
            if (!row || Number.isNaN(start.getTime())) return false;
            if (row.end_at && Number.isNaN(new Date(row.end_at).getTime())) return false;
            const minutes = Number(row.duration_minutes);
            return Boolean(row.end_at) || row.duration_minutes == null || !Number.isFinite(minutes) || minutes > 0;
        });
        return validRows ? { ok: true, rows } : { ok: false, rows: [] };
    }

    function sameCourtName(a, b) {
        return String(a || '').trim().toLocaleLowerCase() === String(b || '').trim().toLocaleLowerCase();
    }

    function sameCourtUnit(a, b) {
        return String(a || '').trim().toLocaleLowerCase() === String(b || '').trim().toLocaleLowerCase();
    }

    function courtUnitsOverlap(a, b) {
        return !String(a || '').trim() || !String(b || '').trim() || sameCourtUnit(a, b);
    }

    function bookingSlotWindow(hour, dateBase) {
        const start = new Date(window.InigoBookingSlots.localDateHourToIso(bookingState.date, hour));
        return { start, end: new Date(start.getTime() + 60 * 60 * 1000) };
    }

    function bookingTimeWindow(row) {
        const start = new Date(row.time_date);
        if (row.end_at) {
            const end = new Date(row.end_at);
            if (!Number.isNaN(end.getTime())) return { start, end };
        }
        const minutesRaw = Number(row.duration_minutes);
        const minutes = Number.isFinite(minutesRaw) && minutesRaw > 0 ? minutesRaw : 60;
        return { start, end: new Date(start.getTime() + minutes * 60000) };
    }

    function bookingWindowsOverlap(a, b) {
        return a.start < b.end && b.start < a.end;
    }

    function isDashboardSchemaMismatch(error) {
        if (!error) return false;
        const code = error.code || '';
        const message = String(error.message || '').toLowerCase();
        return code === 'PGRST204' || code === 'PGRST205' || code === '42703' || code === '42P01'
            || message.includes('could not find') || message.includes('does not exist')
            || message.includes('schema cache');
    }

    // True when `hour` (on the currently selected date) has already
    // started — the customer's local "now", not the server's, since this
    // is purely a client-side UX guard (the DB doesn't know or care what a
    // browser's clock reads).
    function isSlotHourPast(hour) {
        const start = new Date(window.InigoBookingSlots.localDateHourToIso(bookingState.date, hour));
        return start.getTime() < Date.now();
    }

    function hoursRangeForRules(rules) {
        if (!rules || !rules.authoritative || rules.isClosed) return [];
        const open = Number(rules.openHour);
        const close = Number(rules.closeHour);
        if (!Number.isInteger(open) || !Number.isInteger(close) || open < 0 || close > 24 || close <= open) return [];
        return Array.from({ length: close - open }, (_, index) => open + index);
    }

    function bookingHoursRange() {
        return hoursRangeForRules(bookingRules);
    }

    function bookingRangeFitsRules(item, rules) {
        const open = Number(rules?.openHour);
        const close = Number(rules?.closeHour);
        return Boolean(rules?.authoritative) && rules.isClosed !== true
            && Number.isInteger(open) && Number.isInteger(close)
            && item.startHour >= open && item.endHour + 1 <= close;
    }

    // True when an active reservation overlaps this court and selected
    // unit. A missing/blank unit is a wildcard for either source, matching
    // the shared database constraint.
    function isSlotHourBooked(hour) {
        if (!slotGridBookings.ok) return false;
        const dateBase = new Date(`${bookingState.date}T00:00:00`);
        const slot = bookingSlotWindow(hour, dateBase);
        const currentUnit = bookingState.unit || '';
        const bookingMatch = slotGridBookings.rows.some((row) => {
            if (!courtUnitsOverlap(row.court_unit, currentUnit)) return false;
            return bookingWindowsOverlap(bookingTimeWindow(row), slot);
        });
        if (bookingMatch) return true;

        if (!slotGridWalkins.ok) return false;
        return slotGridWalkins.rows.some((row) => {
            return courtUnitsOverlap(row.court_unit, currentUnit)
                && bookingWindowsOverlap(bookingTimeWindow(row), slot);
        });
    }

    function slotHourStatus(hour) {
        if (!bookingHoursRange().includes(hour)) return 'closed';
        if (isSlotHourPast(hour)) return 'past';
        if (isSlotHourBooked(hour)) return 'booked';
        return 'available';
    }

    function isSlotHourInBookingCart(hour, date = bookingState.date) {
        const court = findBookCourt(bookingState.court);
        const unitId = String(bookingState.unitId || '');
        if (!unitId) return false;
        return bookingCart.some((item) => {
            const startHour = Number(item.startHour);
            const endHour = Number(item.endHour);
            if (item.key === editingBookingCartKey || item.date !== date
                || !item.unitId || String(item.unitId) !== unitId
                || !Number.isFinite(startHour) || !Number.isFinite(endHour)
                || startHour > hour || endHour < hour) return false;
            return court
                ? String(item.listingId || '') === String(court.id || '')
                : sameCourtName(item.court, bookingState.court);
        });
    }

    function renderTimePickers() {
        if (!bookSlotsGrid) return;
        if (!bookingState.court || !bookingState.unitId) {
            bookSlotsGrid.innerHTML = '';
            if (bookSlotStatus) bookSlotStatus.textContent = 'Select a court to check availability for your chosen dates.';
            return;
        }
        if (bookingState.date) bookingSelectionsByDate.set(bookingState.date, [...bookingState.selectedHours]);
        const dates = [...bookingSelectedDates].sort();
        const statusFor = (date, hour, availability) => {
            if (!availability?.rules?.authoritative) return 'checking';
            const hours = hoursRangeForRules(availability.rules);
            if (!hours.includes(hour)) return 'closed';
            if (new Date(window.InigoBookingSlots.localDateHourToIso(date, hour)).getTime() < Date.now()) return 'past';
            const slotStart = new Date(window.InigoBookingSlots.localDateHourToIso(date, hour));
            const slot = { start: slotStart, end: new Date(slotStart.getTime() + 3600000) };
            const rows = [...availability.bookings.rows, ...availability.walkins.rows];
            return rows.some((row) => courtUnitsOverlap(row.court_unit, bookingState.unit || '')
                && bookingWindowsOverlap(bookingTimeWindow(row), slot)) ? 'booked' : 'available';
        };
        let eligibleAcrossDates = 0; let selectedAcrossDates = 0;
        const earliestBlockByDate = new Map();
        const sections = dates.map((date) => {
            const availability = bookingAvailabilityByDate.get(date);
            const selection = new Set(bookingSelectionsByDate.get(date) || []);
            if (!availability || !availability.rules?.authoritative || !availability.bookings.ok || !availability.walkins.ok) {
                return `<section class="dash-book-day" data-dash-book-day="${window.escapeHtml(date)}"><h5>${window.escapeHtml(date)}</h5><p class="dash-form-hint">${slotGridLoading ? 'Checking availability…' : 'Availability could not be verified. Refresh and try again.'}</p></section>`;
            }
            const hours = hoursRangeForRules(availability.rules);
            const available = hours.filter((hour) => statusFor(date, hour, availability) === 'available' && !isSlotHourInBookingCart(hour, date));
            const earliestBlock = [];
            for (const hour of available) {
                if (earliestBlock.length && hour !== earliestBlock[earliestBlock.length - 1] + 1) break;
                earliestBlock.push(hour);
            }
            earliestBlockByDate.set(date, earliestBlock);
            const availableSet = new Set(available);
            const originallySelected = [...selection].filter((hour) => availableSet.has(hour)).sort((a, b) => a - b);
            const picked = [];
            for (const hour of originallySelected) {
                if (picked.length && hour !== picked[picked.length - 1] + 1) break;
                picked.push(hour);
            }
            eligibleAcrossDates += available.length; selectedAcrossDates += picked.length;
            selection.clear(); picked.forEach((hour) => selection.add(hour));
            bookingSelectionsByDate.set(date, picked);
            if (date === bookingState.date) {
                bookingState.selectedHours = [...picked];
                bookingState.startHour = picked[0] ?? null;
                bookingState.endHour = picked[picked.length - 1] ?? null;
            }
            const buttons = hours.map((hour) => {
                const serverStatus = statusFor(date, hour, availability);
                const status = serverStatus === 'available' && isSlotHourInBookingCart(hour, date) ? 'in-cart' : serverStatus;
                const selected = selection.has(hour) && status === 'available';
                const disabled = status !== 'available' || slotGridLoading;
                const label = window.InigoBusinessHours.formatHourRangeLabelShort(hour);
                const state = selected ? 'Selected' : status === 'available' ? 'Available' : status === 'in-cart' ? 'In summary' : status === 'booked' || status === 'past' ? 'Unavailable' : 'Unavailable';
                const spoken = status === 'past' ? 'Elapsed' : state;
                return `<button type="button" class="dash-book-slot is-${status}${selected ? ' is-selected' : ''}" data-dash-book-slot="${date}:${hour}" aria-label="${window.escapeHtml(label)}, ${spoken}${disabled ? ', unavailable' : ''}" aria-pressed="${selected}"${disabled ? ' disabled' : ''}><span class="dash-book-slot-time">${window.escapeHtml(label)}</span><span class="dash-book-slot-state" aria-hidden="true">${state}</span></button>`;
            }).join('') || '<p class="dash-res-state">No bookable hours are configured for this date.</p>';
            return `<section class="dash-book-day" data-dash-book-day="${window.escapeHtml(date)}"><div class="dash-book-day-heading"><h5>${window.escapeHtml(new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))}</h5><button type="button" class="dash-book-remove-day" data-dash-book-remove-day="${date}" aria-label="Remove ${date} from selected dates">Remove day</button></div><div class="dash-book-day-slots" role="group" aria-label="Available hourly times for ${date}">${buttons}</div></section>`;
        });
        const allSelected = eligibleAcrossDates > 0 && dates.every((date) => {
            const expected = earliestBlockByDate.get(date) || [];
            const selected = bookingSelectionsByDate.get(date) || [];
            return expected.length === selected.length && expected.every((hour, index) => selected[index] === hour);
        });
        const partial = selectedAcrossDates > 0 && !allSelected;
        bookSlotsGrid.innerHTML = `<label class="dash-book-select-all"><input type="checkbox" data-dash-book-select-all aria-label="Select the earliest continuous available block on each selected date"${allSelected ? ' checked' : ''}${partial ? ' data-indeterminate="true"' : ''}${slotGridLoading || !eligibleAcrossDates ? ' disabled' : ''}><span>Select continuous available times</span></label>` + (dates.length ? sections.join('') : '<p class="dash-form-hint">Choose a date to add it to your schedule.</p>');
        bookSlotsGrid.querySelectorAll?.('[data-indeterminate="true"]').forEach((checkbox) => { checkbox.indeterminate = true; });
        const selectedCount = [...bookingSelectionsByDate.values()].reduce((total, hours) => total + hours.length, 0);
        const allSelectedDatesVerified = dates.every((date) => {
            const availability = bookingAvailabilityByDate.get(date);
            return availability?.rules?.authoritative && availability.bookings.ok && availability.walkins.ok;
        });
        if (bookSlotStatus) bookSlotStatus.textContent = selectedCount
            ? `${selectedCount} hour${selectedCount === 1 ? '' : 's'} selected across ${[...bookingSelectionsByDate.values()].filter((hours) => hours.length).length} date${[...bookingSelectionsByDate.values()].filter((hours) => hours.length).length === 1 ? '' : 's'}. Each date has one continuous time range.`
            : 'Choose available hours on one or more dates. Booked, elapsed, and times already in your summary cannot be selected.';
        const currentAvailability = bookingAvailabilityByDate.get(bookingState.date);
        if (currentAvailability) {
            bookingRules = currentAvailability.rules;
            slotGridBookings = currentAvailability.bookings;
            slotGridWalkins = currentAvailability.walkins;
        }
        if (bookAddButton) {
            const canReturnToSummary = plainSummaryBackMode && bookingCart.length > 0;
            bookAddButton.disabled = bookingCartSaving || (!canReturnToSummary
                && (!bookingState.unitId || selectedCount === 0 || !allSelectedDatesVerified || slotGridLoading));
        }
    }

    async function refreshTimePickers(forceRules = false) {
        if (!bookSlotsGrid) return;
        const mySeq = ++slotGridRequestSeq;
        if (!bookingState.court || !bookingState.unitId || !bookingSelectedDates.size) { slotGridLoading = false; renderTimePickers(); return; }
        slotGridLoading = true;
        const datesToRefresh = [...bookingSelectedDates];
        datesToRefresh.forEach((date) => bookingAvailabilityByDate.delete(date));
        bookSlotsGrid.querySelectorAll?.('[data-dash-book-select-all], [data-dash-book-slot]').forEach((control) => { control.disabled = true; });
        if (bookSelectAllSlots) bookSelectAllSlots.disabled = true;
        renderTimePickers();
        if (bookSlotStatus) bookSlotStatus.textContent = 'Checking availability…';
        if (bookAddButton) bookAddButton.disabled = true;
        if (!window.InigoBusinessHours?.getForDate) {
            slotGridLoading = false;
            slotGridBookings = { ok: false, rows: [] }; slotGridWalkins = { ok: false, rows: [] }; bookingRules = null;
            renderTimePickers(); return;
        }
        let result, rules;
        try {
            const dates = datesToRefresh;
            const results = await Promise.all(dates.map(async (date) => {
                const [occupancy, rulesForDate] = await Promise.all([
                    fetchDayOccupancy(bookingState.court, date),
                    window.InigoBusinessHours.getForDate(date, { force: forceRules }),
                ]);
                return [date, { rules: rulesForDate, bookings: { ok: occupancy.ok, rows: occupancy.rows.filter((row) => row.source === 'online') },
                    walkins: { ok: occupancy.ok, rows: occupancy.rows.filter((row) => ['walkin', 'maintenance', 'checkout_hold'].includes(row.source)) } }];
            }));
            if (mySeq !== slotGridRequestSeq) return;
            results.forEach(([date, data]) => bookingAvailabilityByDate.set(date, data));
        } catch (error) {
            console.error('[dashboard] failed to refresh authoritative booking availability', error);
            if (mySeq !== slotGridRequestSeq) return;
            slotGridLoading = false;
            bookingAvailabilityByDate.set(bookingState.date, { rules: null, bookings: { ok: false, rows: [] }, walkins: { ok: false, rows: [] } });
            slotGridBookings = { ok: false, rows: [] };
            slotGridWalkins = { ok: false, rows: [] };
            bookingRules = null;
            renderTimePickers();
            return;
        }
        if (mySeq !== slotGridRequestSeq) return;
        slotGridLoading = false;
        renderTimePickers();
        updateSummary();
    }

    function resetTimeSelectionAndRender() {
        bookingSelectedDates.forEach((date) => bookingSelectionsByDate.set(date, []));
        bookingState.selectedHours = [];
        bookingState.startHour = null;
        bookingState.endHour = null;
        bookingAvailabilityByDate.clear();
        refreshTimePickers();
    }

    function resetBookingDatesForFreshDraft() {
        const date = bookingState.date || bookDate?.value || '';
        bookingSelectedDates.clear();
        bookingSelectionsByDate.clear();
        bookingAvailabilityByDate.clear();
        bookingState.selectedHours = [];
        bookingState.startHour = null;
        bookingState.endHour = null;
        if (date) {
            bookingSelectedDates.add(date);
            bookingSelectionsByDate.set(date, []);
        }
    }

    // Overview availability is a read-only sport-card and date-specific slot
    // viewer. It uses the same authoritative opening rules and occupancy RPC
    // as booking, but keeps all selections inside its dialog; opening it never
    // changes booking wizard/cart state.
    const overviewAvailability = document.querySelector('[data-dash-availability]');
    const availabilityDialog = document.querySelector('[data-dash-availability-dialog]');
    const availabilityDialogTitle = document.querySelector('[data-dash-availability-sport-title]');
    const availabilityUnitSelect = document.querySelector('[data-dash-availability-unit]');
    const availabilityUnitPhoto = document.querySelector('[data-dash-availability-photo]');
    const availabilityDateInput = document.querySelector('[data-dash-availability-date]');
    const availabilityStatus = document.querySelector('[data-dash-availability-status]');
    const availabilitySlots = document.querySelector('[data-dash-availability-slots]');
    const availabilitySelectedDate = document.querySelector('[data-dash-availability-selected-date]');
    if (availabilityDateInput) {
        const today = todayDateInputValue();
        availabilityDateInput.min = today;
        if (!availabilityDateInput.value || availabilityDateInput.value < today) availabilityDateInput.value = today;
    }
    let overviewAvailabilityGroups = new Map();
    let overviewAvailabilityEntries = [];
    let overviewAvailabilityRequest = 0;
    let availabilityReturnFocus = null;

    function overviewHourLabel(hour) {
        return window.InigoBusinessHours.formatHourRangeLabelShort(hour);
    }

    function renderOverviewAvailabilityCards(courts = bookCourtsCache) {
        if (!overviewAvailability) return;
        const groups = new Map();
        (courts || []).filter((court) => court.isActive !== false).forEach((court) => {
            const key = bookSportChoiceKey(court);
            const group = groups.get(key) || {
                key,
                name: isBowlingVariant(court) || sportKey(court) === 'bowling' ? court.name : court.sportName || court.name,
                courts: [],
            };
            group.courts.push(court);
            groups.set(key, group);
        });
        overviewAvailabilityGroups = groups;
        overviewAvailability.innerHTML = [...groups.values()].map((group) => {
            const coverCourt = group.courts.find((court) => court.imageUrl)
                || group.courts.find((court) => window.InigoCourtsData.resolveCourtUnits(court).units.some((unit) => unit.imageUrl))
                || group.courts[0];
            const coverUnit = window.InigoCourtsData.resolveCourtUnits(coverCourt).units.find((unit) => unit.imageUrl);
            const rawImage = coverCourt.imageUrl || coverUnit?.imageUrl || window.InigoVisuals?.sportCover(coverCourt.sportSlug || group.key);
            const coverUrl = rawImage && window.InigoVisuals?.venuePhoto(rawImage);
            const photo = coverUrl
                ? `<img src="${window.escapeHtml(coverUrl)}" alt="" loading="lazy">`
                : `<span class="dash-court-monogram" aria-hidden="true">${window.escapeHtml(window.InigoCourtsData.monogramFor(coverCourt.sportSlug || group.key, group.name))}</span>`;
            return `<article class="dash-availability-item"><button type="button" class="dash-availability-sport" data-dash-availability-open="${window.escapeHtml(group.key)}" aria-haspopup="dialog" aria-controls="dashAvailabilityDialog"><span class="dash-availability-photo">${photo}</span><span class="dash-availability-name">${window.escapeHtml(group.name)}</span><span class="dash-availability-action">View courts and times <span aria-hidden="true">→</span></span></button></article>`;
        }).join('') || '<p class="dash-res-state">No active sports are listed.</p>';
    }

    function showOverviewAvailabilityLoadError() {
        if (overviewAvailability) {
            overviewAvailability.innerHTML = '<div class="dash-availability-load-error"><p class="dash-res-state">Active sports could not be loaded.</p><button type="button" class="dash-link-btn" data-dash-availability-retry>Try again</button></div>';
        }
    }

    async function refreshOverviewAvailability() {
        if (!availabilityDialog?.open || !availabilityUnitSelect || !availabilityDateInput || !availabilitySlots || !availabilityStatus) return;
        const request = ++overviewAvailabilityRequest;
        const selectedEntry = overviewAvailabilityEntries[Number(availabilityUnitSelect.value)];
        const court = selectedEntry?.court;
        let date = availabilityDateInput.value;
        availabilitySelectedDate.textContent = date ? new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '';
        if (!court || !date) {
            availabilityStatus.textContent = 'Choose a court and date to check live slots.';
            availabilitySlots.innerHTML = '';
            availabilityUnitPhoto.innerHTML = '';
            return;
        }
        const today = todayDateInputValue();
        if (date < today) {
            availabilityDateInput.value = today;
            date = today;
        }
        availabilitySlots.innerHTML = '';
        availabilityStatus.textContent = 'Checking live availability…';
        const selectedUnit = selectedEntry?.unit;
        availabilitySelectedDate.textContent = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        const rawPhoto = selectedUnit?.imageUrl || court.imageUrl || window.InigoVisuals?.sportCover(court.sportSlug || sportKey(court));
        const photoUrl = rawPhoto && window.InigoVisuals?.venuePhoto(rawPhoto);
        const rateUnit = selectedUnit?.rateUnit || court.rateUnit || '/hr';
        const formatAvailabilityRate = (value) => `₱${Number(value).toLocaleString('en-PH', { maximumFractionDigits: 2 })}${rateUnit}`;
        const validRate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
        let rateCaption = 'Rate to be confirmed';
        const dayRate = selectedUnit?.rateDay;
        const nightRate = selectedUnit?.rateNight;
        if (validRate(dayRate) && validRate(nightRate)) {
            rateCaption = dayRate === nightRate
                ? formatAvailabilityRate(dayRate)
                : `${formatAvailabilityRate(dayRate)} day · ${formatAvailabilityRate(nightRate)} night`;
        } else if (validRate(dayRate)) {
            rateCaption = formatAvailabilityRate(dayRate);
        } else if (validRate(nightRate)) {
            rateCaption = `${formatAvailabilityRate(nightRate)} night`;
        } else if (validRate(court.rate)) {
            rateCaption = formatAvailabilityRate(court.rate);
        }
        availabilityUnitPhoto.innerHTML = photoUrl
            ? `<img src="${window.escapeHtml(photoUrl)}" alt="${window.escapeHtml(selectedUnit?.label || court.name)}" loading="eager"><span class="dash-availability-photo-label">${window.escapeHtml(rateCaption)}</span>`
            : `<div class="dash-availability-photo-fallback"><span class="dash-court-monogram" aria-hidden="true">${window.escapeHtml(window.InigoCourtsData.monogramFor(court.sportSlug || sportKey(court), selectedUnit?.label || court.name))}</span><span>${window.escapeHtml(rateCaption)}</span></div>`;
        const availabilityImage = availabilityUnitPhoto.querySelector('img');
        availabilityImage?.addEventListener('error', () => {
            if (!availabilityImage.isConnected) return;
            const label = selectedUnit?.label || court.name;
            availabilityUnitPhoto.innerHTML = `<div class="dash-availability-photo-fallback" aria-label="${window.escapeHtml(label)} image"><span class="dash-court-monogram" aria-hidden="true">${window.escapeHtml(window.InigoCourtsData.monogramFor(court.sportSlug || sportKey(court), label))}</span><span>${window.escapeHtml(rateCaption)}</span></div>`;
        }, { once: true });
        if (court.inventoryLoadFailed || !window.InigoCourtsData || !window.sb?.rpc
            || !window.InigoBusinessHours?.getForDate || !window.InigoBookingSlots) {
            availabilityStatus.textContent = 'Verified court inventory is unavailable. Use Change date to choose another date, or try again later.';
            return;
        }
        if (!selectedUnit) {
            availabilityStatus.textContent = 'A specific court number could not be verified for this sport.';
            return;
        }
        let rules;
        let occupancy;
        try {
            [rules, occupancy] = await Promise.all([
                window.InigoBusinessHours.getForDate(date, { force: true }),
                fetchDayOccupancy(court.name, date),
            ]);
        } catch (_) {
            if (request === overviewAvailabilityRequest) availabilityStatus.textContent = 'Live availability could not be verified. Use Change date to choose another date, or try again later.';
            return;
        }
        if (request !== overviewAvailabilityRequest || !availabilityDialog.open) return;
        if (!rules?.authoritative || !occupancy?.ok || !Array.isArray(occupancy?.rows)) {
            availabilityStatus.textContent = 'Live availability could not be verified. Use Change date to choose another date, or try again later.';
            return;
        }
        if (rules.isClosed) {
            availabilityStatus.textContent = 'The facility is closed on this date. Use Change date to choose another date.';
            return;
        }

        const openHour = Number(rules.openHour);
        const closeHour = Number(rules.closeHour);
        if (!Number.isInteger(openHour) || !Number.isInteger(closeHour) || closeHour <= openHour) {
            availabilityStatus.textContent = 'Opening hours could not be verified for this date. Use Change date to choose another date.';
            return;
        }
        const hours = Array.from({ length: closeHour - openHour }, (_, i) => openHour + i)
            .filter((hour) => date !== todayDateInputValue()
                || new Date(window.InigoBookingSlots.localDateHourToIso(date, hour)).getTime() >= Date.now());
        if (!hours.length) {
            availabilityStatus.textContent = 'There are no future bookable hours on this date. Use Change date to choose another date.';
            return;
        }
        const rows = occupancy.rows;
        const slotRows = hours.map((hour) => {
            const start = new Date(window.InigoBookingSlots.localDateHourToIso(date, hour));
            const end = new Date(start.getTime() + 60 * 60 * 1000);
            const isAvailable = !rows.some((row) =>
                courtUnitsOverlap(row.court_unit, selectedUnit.label)
                && bookingWindowsOverlap(bookingTimeWindow(row), { start, end }));
            const label = isAvailable ? 'Available' : 'Unavailable';
            return `<div class="dash-availability-slot${isAvailable ? ' is-available' : ''}" role="listitem"><strong>${window.escapeHtml(overviewHourLabel(hour))}</strong><span>${window.escapeHtml(label)}</span></div>`;
        });
        availabilitySlots.innerHTML = slotRows.join('');
        availabilityStatus.textContent = `Live hourly availability for ${selectedUnit.label}. Times use the venue’s current opening hours.`;
    }

    function renderOverviewAvailabilityUnits(group) {
        if (!availabilityUnitSelect) return;
        const courts = group?.courts || [];
        const listingNameCounts = new Map();
        courts.forEach((court) => listingNameCounts.set(court.name, (listingNameCounts.get(court.name) || 0) + 1));
        overviewAvailabilityEntries = courts.flatMap((court, listingIndex) => {
            const units = window.InigoCourtsData?.resolveCourtUnits(court).units || [];
            const duplicateNameSuffix = listingNameCounts.get(court.name) > 1
                ? ` (${court.id || `listing ${listingIndex + 1}`})` : '';
            return units.filter((unit) => unit.label).map((unit) => ({ court, unit, duplicateNameSuffix }));
        });
        const multipleListings = new Set(courts.map((court) => String(court.id || court.name))).size > 1;
        availabilityUnitSelect.innerHTML = overviewAvailabilityEntries.map(({ court, unit, duplicateNameSuffix }, index) => {
            const label = multipleListings ? `${court.name}${duplicateNameSuffix} · ${unit.label}` : unit.label;
            return `<option value="${index}">${window.escapeHtml(label)}</option>`;
        }).join('');
        availabilityUnitSelect.disabled = !overviewAvailabilityEntries.length;
    }

    function openOverviewAvailability(sportKey, opener) {
        const group = overviewAvailabilityGroups.get(sportKey);
        if (!group || !availabilityDialog || !availabilityUnitSelect || !availabilityDateInput) return;
        availabilityReturnFocus = opener;
        availabilityDialog.dataset.sportKey = sportKey;
        if (availabilityDialogTitle) availabilityDialogTitle.textContent = group.name;
        const today = todayDateInputValue();
        availabilityDateInput.min = today;
        if (!availabilityDateInput.value || availabilityDateInput.value < today) availabilityDateInput.value = today;
        renderOverviewAvailabilityUnits(group);
        if (!availabilityDialog.open) availabilityDialog.showModal();
        availabilityUnitSelect.focus();
        refreshOverviewAvailability();
    }

    overviewAvailability?.addEventListener('click', (event) => {
        const retryButton = event.target.closest('[data-dash-availability-retry]');
        if (retryButton) {
            if (!window.InigoCourtsData?.getCourts) {
                showOverviewAvailabilityLoadError();
                return;
            }
            retryButton.disabled = true;
            retryButton.textContent = 'Loading…';
            window.InigoCourtsData.getCourts({ force: true }).then((courts) => {
                renderOverviewAvailabilityCards(courts);
            }).catch((error) => {
                console.error('[dashboard] could not reload customer availability sports', error);
                showOverviewAvailabilityLoadError();
            });
            return;
        }
        const button = event.target.closest('[data-dash-availability-open]');
        if (button) openOverviewAvailability(button.dataset.dashAvailabilityOpen, button);
    });
    availabilityUnitSelect?.addEventListener('change', refreshOverviewAvailability);
    availabilityDateInput?.addEventListener('change', refreshOverviewAvailability);
    availabilityDialog?.querySelector('[data-dash-availability-change-date]')?.addEventListener('click', () => {
        availabilityReturnFocus = availabilityDateInput;
        availabilityDialog.close();
    });
    availabilityDialog?.querySelectorAll('[data-dash-availability-close]').forEach((button) => {
        button.addEventListener('click', () => availabilityDialog.close());
    });
    availabilityDialog?.addEventListener('click', (event) => {
        if (event.target === availabilityDialog) availabilityDialog.close();
    });
    availabilityDialog?.addEventListener('close', () => {
        overviewAvailabilityRequest += 1;
        availabilityReturnFocus?.focus();
        availabilityReturnFocus = null;
    });

    function updateSummary() {
        if (bookingState.date) bookingSelectionsByDate.set(bookingState.date, [...bookingState.selectedHours]);
        const pct = bookingState.downpaymentPct;
        const gross = bookingCart.reduce((sum, item) => sum + (Number.isFinite(item.estimatedTotal) ? item.estimatedTotal : 0), 0);
        const verifiedGross = bookingCart.length > 0 && bookingCart.every((item) => Number.isFinite(item.estimatedTotal) && item.estimatedTotal > 0);
        const acceptanceSignature = JSON.stringify({
            paymentType: bookingState.paymentType,
            pct,
            items: bookingCart.map((item) => [item.sport, item.court, item.unit, item.date, item.startHour, item.endHour, item.estimatedTotal]),
        });
        if (paymentAcceptanceSignature !== null && paymentAcceptanceSignature !== acceptanceSignature && paymentTermsAccepted) {
            paymentTermsAccepted.checked = false;
        }
        paymentAcceptanceSignature = acceptanceSignature;
        if (paymentTermsStatus) {
            const accepted = Boolean(paymentTermsAccepted?.checked);
            paymentTermsStatus.textContent = accepted ? 'Accepted for this selection' : 'Not accepted';
            paymentTermsStatus.classList.toggle('is-accepted', accepted);
        }
        const amount = verifiedGross && gross > 0 ? (bookingState.paymentType === 'full'
            ? gross : bookingCart.reduce((sum, item) => sum + (Number.isFinite(item.estimatedTotal)
                ? Math.round(item.estimatedTotal * pct) / 100 : 0), 0)) : null;
        const bookingGross = document.querySelector('[data-dash-booking-gross]');
        if (bookingGross) bookingGross.textContent = verifiedGross ? `₱${gross.toFixed(2)}` : 'Rate to be confirmed';
        if (summaryPayment) summaryPayment.textContent = bookingState.paymentType === 'full'
            ? 'Full payment' : `Downpayment (${pct}%)`;
        if (summaryGross) summaryGross.textContent = verifiedGross ? `₱${gross.toFixed(2)}` : 'Rate to be confirmed';
        if (summaryTotal) summaryTotal.textContent = amount !== null ? `₱${amount.toFixed(2)}` : '—';
        if (summaryBalance) summaryBalance.textContent = amount !== null ? `₱${Math.max(0, gross - amount).toFixed(2)}` : '—';
        if (downpaymentDesc) downpaymentDesc.textContent = `Pay ${pct}% securely now; pay the remaining balance at check-in.`;
        if (paymentReceiptItems) {
            paymentReceiptItems.innerHTML = bookingCart.map((item) => {
                const courtLabel = String(item.sport).toLocaleLowerCase() === String(item.court).toLocaleLowerCase()
                    ? item.court : `${item.sport} · ${item.court}`;
                const unitLabel = item.unit ? ` · ${item.unit}` : '';
                const time = `${window.InigoBusinessHours.formatHourLabel(item.startHour)} – ${window.InigoBusinessHours.formatHourLabel(item.endHour + 1)}`;
                const total = Number.isFinite(item.estimatedTotal) && item.estimatedTotal > 0
                    ? `₱${item.estimatedTotal.toFixed(2)}` : 'Rate to be confirmed';
                return `<li><div><strong>${window.escapeHtml(courtLabel)}${unitLabel ? ` · ${window.escapeHtml(item.unit)}` : ''}</strong><span>${window.escapeHtml(formatDate(item.date))} · ${window.escapeHtml(time)}</span></div><strong>${window.escapeHtml(total)}</strong></li>`;
            }).join('');
        }
        if (bookSubmit) {
            const ready = bookingCart.length > 0
                && bookingCart.every((item) => item.listingId && item.unitId && Number.isFinite(item.estimatedTotal) && item.estimatedTotal > 0);
            bookSubmit.disabled = !ready || bookingCartSaving || !paymentTermsAccepted?.checked;
            bookSubmit.textContent = bookingCartSaving ? 'Opening secure checkout…' : 'Proceed to pay online';
            if (paymentModeHint) paymentModeHint.textContent = bookingCart.length && !ready
                ? 'Every booking needs an available court unit and a confirmed rate before online checkout.'
                : 'Your booking will be confirmed after your online payment is verified.';
        }
        if (bookAddButton) {
            const canReturnToSummary = plainSummaryBackMode && bookingCart.length > 0;
            const draftHours = [...bookingSelectionsByDate.values()].reduce((total, hours) => total + hours.length, 0);
            const selectedDateList = [...bookingSelectedDates];
            const verifiedDraftDays = selectedDateList.every((date) => {
                const availability = bookingAvailabilityByDate.get(date);
                return availability?.rules?.authoritative && availability.bookings.ok && availability.walkins.ok;
            });
            bookAddButton.disabled = bookingCartSaving || (!canReturnToSummary && (!bookingState.unitId
                || !draftHours || !verifiedDraftDays || slotGridLoading));
        }
        renderBookWizard();
        renderBookingCart();
    }

    function setBookingDaySelection(date, hours) {
        const next = [...new Set(hours)].sort((a, b) => a - b);
        bookingSelectionsByDate.set(date, next);
        if (date === bookingState.date) {
            bookingState.selectedHours = next;
            const firstRun = window.InigoBookingSlots.groupConsecutiveHours(next)[0];
            bookingState.startHour = firstRun?.startHour ?? null;
            bookingState.endHour = firstRun ? firstRun.endHourExclusive - 1 : null;
        }
        renderTimePickers();
        updateSummary();
    }

    function bookingRunsByDate(selectedByDate) {
        return [...selectedByDate].flatMap(([date, hours]) =>
            window.InigoBookingSlots.groupConsecutiveHours(hours).map((run) => ({ date, run })));
    }

    if (bookSlotsGrid) {
        bookSlotsGrid.addEventListener('click', (event) => {
            const removeDay = event.target.closest('[data-dash-book-remove-day]');
            if (removeDay) {
                const date = removeDay.dataset.dashBookRemoveDay;
                bookingSelectedDates.delete(date);
                bookingSelectionsByDate.delete(date);
                bookingAvailabilityByDate.delete(date);
                if (bookingState.date === date) {
                    bookingState.date = [...bookingSelectedDates].sort()[0] || '';
                    if (bookDate) bookDate.value = bookingState.date;
                    bookingState.selectedHours = [...(bookingSelectionsByDate.get(bookingState.date) || [])];
                }
                renderBookingCalendar();
                renderTimePickers();
                updateSummary();
                return;
            }
            const button = event.target.closest('[data-dash-book-slot]');
            if (!button || button.disabled || slotGridLoading) return;
            const [date, rawHour] = String(button.dataset.dashBookSlot).split(':');
            const hour = Number(rawHour);
            const selected = [...new Set(bookingSelectionsByDate.get(date) || [])].sort((a, b) => a - b);
            if (selected.includes(hour)) {
                // Clicking within a selected range trims it at that hour; this
                // keeps the remaining draft contiguous and makes the first
                // selected hour an easy way to clear the range.
                setBookingDaySelection(date, selected.filter((selectedHour) => selectedHour < hour));
                return;
            }
            if (!selected.length) {
                setBookingDaySelection(date, [hour]);
                return;
            }
            const selectableHours = new Set([...bookSlotsGrid.querySelectorAll('[data-dash-book-slot]')]
                .filter((slot) => slot.dataset.dashBookSlot.startsWith(`${date}:`) && !slot.disabled)
                .map((slot) => Number(slot.dataset.dashBookSlot.split(':')[1])));
            const range = [...selected];
            const extendingEarlier = hour < selected[0];
            const first = extendingEarlier ? selected[0] - 1 : selected[selected.length - 1] + 1;
            const last = hour;
            let blocked = false;
            for (let nextHour = first; extendingEarlier ? nextHour >= last : nextHour <= last; nextHour += extendingEarlier ? -1 : 1) {
                if (!selectableHours.has(nextHour)) { blocked = true; break; }
                range.push(nextHour);
            }
            if (range.length === selected.length && blocked) {
                if (bookSlotStatus) bookSlotStatus.textContent = 'The range could not extend past the first unavailable hour. Your current selection was kept.';
                return;
            }
            setBookingDaySelection(date, range);
            if (blocked && bookSlotStatus) bookSlotStatus.textContent = 'Selection extended up to the first unavailable hour.';
        });
        bookSlotsGrid.addEventListener('change', (event) => {
            const checkbox = event.target.closest('[data-dash-book-select-all]');
            if (!checkbox || checkbox.disabled || slotGridLoading) return;
            for (const date of bookingSelectedDates) {
                const eligible = [...bookSlotsGrid.querySelectorAll('[data-dash-book-slot]')]
                    .filter((button) => button.dataset.dashBookSlot.startsWith(`${date}:`) && !button.disabled)
                    .map((button) => Number(button.dataset.dashBookSlot.split(':')[1]));
                const selected = new Set(bookingSelectionsByDate.get(date) || []);
                if (checkbox.checked) {
                    selected.clear();
                    let previous = null;
                    for (const hour of eligible) {
                        if (previous !== null && hour !== previous + 1) break;
                        selected.add(hour);
                        previous = hour;
                    }
                } else selected.clear();
                bookingSelectionsByDate.set(date, [...selected].sort((a, b) => a - b));
            }
            bookingState.selectedHours = [...(bookingSelectionsByDate.get(bookingState.date) || [])];
            renderTimePickers(); updateSummary();
        });
    }

    function selectedBookingCartItem(startHour, endHourExclusive, key = null) {
        const court = findBookCourt(bookingState.court);
        const units = court && window.InigoCourtsData ? window.InigoCourtsData.resolveCourtUnits(court).units : [];
        const selectedUnit = units.find((unit) => bookingState.unitId && String(unit.id) === String(bookingState.unitId));
        const start = startHour ?? bookingState.startHour;
        const endExclusive = endHourExclusive ?? (bookingState.endHour + 1);
        const endHour = endExclusive - 1;
        const hours = endExclusive - start;
        const startIso = window.InigoBookingSlots.localDateHourToIso(bookingState.date, start);
        const endIso = window.InigoBookingSlots.localDateHourToIso(bookingState.date, endExclusive);
        const total = bookingState.rateUnit === '/set'
            ? (typeof bookingState.rateDay === 'number' ? bookingState.rateDay * hours : null)
            : bookingHourlyAmount(hours);
        return {
            key: key || `item-${++bookingCartSeq}`,
            court: bookingState.court,
            sport: bookingState.sport || bookingState.court,
            listingId: (court || {}).id || null,
            unit: bookingState.unit || null,
            unitId: bookingState.unitId || null,
            resourceIds: selectedUnit?.resourceIds || [],
            date: bookingState.date,
            startHour: start,
            endHour,
            startIso,
            endIso,
            hours,
            rateUnit: bookingState.rateUnit,
            rateDay: bookingState.rateDay ?? bookingState.rate,
            rateNight: bookingState.rateNight,
            nightRateStartsAt: bookingState.nightRateStartsAt,
            rateQuantity: bookingState.rateUnit === '/set' ? hours : 1,
            paymentType: 'downpayment',
            estimatedTotal: total,
        };
    }

    function bookingCartItemsConflict(a, b) {
        const aStart = new Date(a.startIso), aEnd = new Date(a.endIso);
        const bStart = new Date(b.startIso), bEnd = new Date(b.endIso);
        if (!(aStart < bEnd && bStart < aEnd)) return false;
        const aResources = new Set(a.resourceIds || []);
        if (aResources.size && (b.resourceIds || []).some((id) => aResources.has(id))) return true;
        if (aResources.size && (b.resourceIds || []).length) return false;
        return String(a.listingId || '').toLowerCase() === String(b.listingId || '').toLowerCase()
            && courtUnitsOverlap(a.unit, b.unit);
    }

    function bookingItemRateBreakdown(item) {
        if (!Number.isFinite(item.estimatedTotal) || item.estimatedTotal <= 0) return 'Rate to be confirmed';
        if (item.rateUnit === '/set') return `${item.hours} set${item.hours === 1 ? '' : 's'} × ₱${Number(item.rateDay).toFixed(2)} per set`;
        if (typeof item.rateDay !== 'number' || !Number.isFinite(item.rateDay)) return 'Rate to be confirmed';
        const cutoffMatch = /^([0-2]\d):([0-5]\d)/.exec(String(item.nightRateStartsAt || ''));
        const cutoff = cutoffMatch ? Number(cutoffMatch[1]) * 60 + Number(cutoffMatch[2]) : null;
        let dayHours = 0;
        let nightHours = 0;
        for (let hour = item.startHour; hour <= item.endHour; hour += 1) {
            if (typeof item.rateNight !== 'number' || item.rateNight === item.rateDay || cutoff === null || (hour + 1) * 60 <= cutoff) dayHours += 1;
            else if (hour * 60 >= cutoff) nightHours += 1;
            else { dayHours += (cutoff - hour * 60) / 60; nightHours += ((hour + 1) * 60 - cutoff) / 60; }
        }
        const parts = [];
        if (dayHours) parts.push(`${dayHours}h day × ₱${Number(item.rateDay).toFixed(2)}/hr`);
        if (nightHours) parts.push(`${nightHours}h night × ₱${Number(item.rateNight).toFixed(2)}/hr`);
        return parts.join(' + ') || 'Rate to be confirmed';
    }

    function quoteCartItem(item) {
        const hours = item.endHour - item.startHour + 1;
        if (hours <= 0 || typeof item.rateDay !== 'number' || !Number.isFinite(item.rateDay)) return null;
        if (item.rateUnit === '/set') return Math.round(item.rateDay * hours * 100) / 100;
        if (item.rateUnit !== '/hr') return null;
        const match = /^([0-2]\d):([0-5]\d)/.exec(String(item.nightRateStartsAt || ''));
        const cutoff = match ? Number(match[1]) * 60 + Number(match[2]) : null;
        let total = 0;
        for (let hour = item.startHour; hour <= item.endHour; hour += 1) {
            const start = hour * 60;
            const end = start + 60;
            if (typeof item.rateNight !== 'number' || item.rateNight === item.rateDay || cutoff === null || end <= cutoff) total += item.rateDay;
            else if (start >= cutoff) total += item.rateNight;
            else total += (cutoff - start) / 60 * item.rateDay + (end - cutoff) / 60 * item.rateNight;
        }
        return Math.round(total * 100) / 100;
    }

    function applyCurrentUnitPricing(item, unit, court, nightRateStartsAt) {
        item.rateDay = unit?.rateDay ?? (typeof court?.rate === 'number' && Number.isFinite(court.rate) ? court.rate : null);
        item.rateNight = unit?.rateNight ?? null;
        item.rateUnit = unit && (typeof unit.rateDay === 'number' || typeof unit.rateNight === 'number')
            ? (unit.rateUnit || court.rateUnit || '/hr') : (court.rateUnit || '/hr');
        item.nightRateStartsAt = nightRateStartsAt || null;
        item.estimatedTotal = quoteCartItem(item);
        item.resourceIds = unit?.resourceIds || [];
    }

    function renderBookingCart() {
        if (!bookCartPanel || !bookCartItemsEl) return;
        bookCartPanel.hidden = false;
        if (bookCartCountEl) bookCartCountEl.textContent = `${bookingCart.length} item${bookingCart.length === 1 ? '' : 's'}`;
        if (bookCartEmpty) bookCartEmpty.hidden = bookingCart.length > 0;
        bookCartItemsEl.innerHTML = bookingCart.map((item) => {
            const unit = item.unit ? ` · ${item.unit}` : '';
            const time = `${window.InigoBusinessHours.formatHourLabel(item.startHour)} – ${window.InigoBusinessHours.formatHourLabel(item.endHour + 1)}`;
            const estimate = Number.isFinite(item.estimatedTotal) && item.estimatedTotal > 0 ? `₱${item.estimatedTotal.toFixed(2)}` : 'Rate to be confirmed';
            const courtLabel = String(item.sport).toLocaleLowerCase() === String(item.court).toLocaleLowerCase()
                ? item.court + unit : `${item.sport} · ${item.court}${unit}`;
            return `<li class="dash-book-cart-item"><div class="dash-book-cart-item-info"><strong>${window.escapeHtml(courtLabel)}</strong><span>${window.escapeHtml(formatDate(item.date))} · ${window.escapeHtml(time)} · ${item.hours} hour${item.hours === 1 ? '' : 's'}</span><span>${window.escapeHtml(bookingItemRateBreakdown(item))}</span><strong>${window.escapeHtml(estimate)}</strong></div><div class="dash-book-cart-item-actions"><button type="button" class="dash-btn-ghost" data-dash-book-cart-edit="${window.escapeHtml(item.key)}" aria-label="Edit ${window.escapeHtml(courtLabel)} booking"${bookingCartSaving ? ' disabled' : ''}>Edit</button><button type="button" class="dash-btn-ghost" data-dash-book-cart-remove="${window.escapeHtml(item.key)}" aria-label="Remove ${window.escapeHtml(courtLabel)} booking"${bookingCartSaving ? ' disabled' : ''}>Remove</button></div></li>`;
        }).join('');
        if (bookingCartBar) {
            const hasVerifiedTotals = bookingCart.length > 0 && bookingCart.every((item) => Number.isFinite(item.estimatedTotal) && item.estimatedTotal > 0);
            const cartTotal = hasVerifiedTotals ? bookingCart.reduce((sum, item) => sum + item.estimatedTotal, 0) : null;
            const itemSummary = (item) => {
                const unit = item.unit ? ` · ${item.unit}` : '';
                const time = `${window.InigoBusinessHours.formatHourLabel(item.startHour)}–${window.InigoBusinessHours.formatHourLabel(item.endHour + 1)}`;
                return `${item.court}${unit} · ${formatDate(item.date)} · ${time}`;
            };
            const reviewIsOpen = Boolean(bookingPaymentModal && !bookingPaymentModal.hidden);
            const detailsAreOpen = Boolean(bookingCartDetailsModal && !bookingCartDetailsModal.hidden);
            bookingCartBar.hidden = !bookingCart.length || !bookingPanel?.classList.contains('is-active')
                || reviewIsOpen || detailsAreOpen;
            if (!bookingCartBar.hidden) syncBookingCartPosition();
            if (bookingCartBarCount) bookingCartBarCount.textContent = `${bookingCart.length} booking${bookingCart.length === 1 ? '' : 's'} selected`;
            if (bookingCartBarTotal) bookingCartBarTotal.textContent = cartTotal === null ? 'Rate TBA' : `₱${cartTotal.toFixed(2)}`;
            if (bookingCartBarItems) bookingCartBarItems.innerHTML = bookingCart.slice(0, 2).map((item) => `<span title="${window.escapeHtml(itemSummary(item))}">${window.escapeHtml(itemSummary(item))}</span>`).join('');
            if (bookingCartBarMore) {
                bookingCartBarMore.hidden = bookingCart.length <= 2;
                bookingCartBarMore.textContent = bookingCart.length > 2 ? `+ ${bookingCart.length - 2} more booking${bookingCart.length === 3 ? '' : 's'}` : '';
            }
            if (bookingCartDetailsCount) bookingCartDetailsCount.textContent = `${bookingCart.length} selected booking${bookingCart.length === 1 ? '' : 's'}`;
            if (bookingCartDetailsList) bookingCartDetailsList.innerHTML = bookingCart.map((item) => {
                const total = Number.isFinite(item.estimatedTotal) && item.estimatedTotal > 0 ? `₱${item.estimatedTotal.toFixed(2)}` : 'Rate TBA';
                const courtLabel = String(item.sport).toLocaleLowerCase() === String(item.court).toLocaleLowerCase()
                    ? item.court : `${item.sport} · ${item.court}`;
                return `<li><span class="dash-book-cart-details-item"><strong>${window.escapeHtml(courtLabel)}${item.unit ? ` · ${window.escapeHtml(item.unit)}` : ''}</strong>${window.escapeHtml(formatDate(item.date))} · ${window.escapeHtml(itemSummary(item).split(' · ').slice(-1)[0])}</span><strong class="dash-book-cart-details-price">${total}</strong><button type="button" class="dash-btn-ghost dash-book-cart-details-row-remove" data-dash-book-cart-remove="${window.escapeHtml(item.key)}" aria-label="Remove ${window.escapeHtml(courtLabel)} booking"${bookingCartSaving ? ' disabled' : ''}>Remove</button></li>`;
            }).join('');
            if (bookingCartDetailsTotal) bookingCartDetailsTotal.textContent = cartTotal === null ? 'Rate TBA' : `₱${cartTotal.toFixed(2)}`;
            if (bookingCartDetailsProceed) bookingCartDetailsProceed.disabled = !bookingCart.length || bookingCartSaving;
        }
    }

    function removeBookingCartItem(key) {
        if (bookingCartSaving) return;
        const index = bookingCart.findIndex((item) => item.key === key);
        if (index < 0) return;
        bookingCart.splice(index, 1);
        const emptiedDetails = !bookingCart.length && bookingCartDetailsModal && !bookingCartDetailsModal.hidden;
        if (emptiedDetails) closeBookingCartDetails(false);
        if (!bookingCart.length) {
            editingBookingCartKey = null;
            addingBookingFromSummary = false;
            plainSummaryBackMode = false;
            bookingSummaryBackKey = null;
            bookingState.sportSlug = '';
            bookingState.court = '';
            bookingState.sport = '';
            bookingState.rate = null;
            bookingState.unit = null;
            bookingState.unitId = null;
            bookingState.selectedHours = [];
            bookingState.startHour = null;
            bookingState.endHour = null;
            if (bookAddButton) bookAddButton.textContent = 'Review booking';
            if (bookSelect) {
                bookSelect.value = '';
                bookSelect.disabled = true;
            }
            paintBookPreview(null);
            renderSportChoices();
            resetTimeSelectionAndRender();
            goToBookStep(1);
            const firstSport = bookSportGrid?.querySelector('[data-dash-book-sport]');
            if (firstSport) firstSport.focus({ preventScroll: true });
            else bookingNavButton?.focus({ preventScroll: true });
        } else {
            updateSummary();
            if (emptiedDetails) bookingNavButton?.focus({ preventScroll: true });
        }
    }

    let pendingBookingCartRemoval = null;

    function closeBookingCartRemoveConfirmation(restoreFocus = true) {
        if (!bookingRemoveConfirmation || bookingRemoveConfirmation.hidden) return;
        bookingRemoveConfirmation.hidden = true;
        const pending = pendingBookingCartRemoval;
        pendingBookingCartRemoval = null;
        if (restoreFocus) {
            const target = pending?.button;
            if (target?.isConnected && !target.disabled && target.getClientRects().length) target.focus({ preventScroll: true });
            else if (pending?.source === 'details' && !bookingCartDetailsModal?.hidden) bookingCartDetailsDialog?.focus({ preventScroll: true });
            else bookingNavButton?.focus({ preventScroll: true });
        }
    }

    function requestBookingCartItemRemoval(key, button) {
        if (bookingCartSaving || !bookingRemoveConfirmation || !bookingRemoveConfirmationDialog || pendingBookingCartRemoval) return;
        const item = bookingCart.find((entry) => entry.key === key);
        if (!item) return;
        const source = bookingCartDetailsList?.contains(button) ? 'details' : 'summary';
        const removeButtons = source === 'details'
            ? bookingCartDetailsList?.querySelectorAll('[data-dash-book-cart-remove]')
            : bookCartItemsEl?.querySelectorAll('[data-dash-book-cart-remove]');
        const rowIndex = removeButtons ? Array.from(removeButtons).indexOf(button) : 0;
        const courtLabel = String(item.sport).toLocaleLowerCase() === String(item.court).toLocaleLowerCase()
            ? item.court : `${item.sport} · ${item.court}`;
        const unit = item.unit ? ` · ${item.unit}` : '';
        const time = `${window.InigoBusinessHours.formatHourLabel(item.startHour)}–${window.InigoBusinessHours.formatHourLabel(item.endHour + 1)}`;
        bookingRemoveConfirmationDescription.textContent = `Remove ${courtLabel}${unit} on ${formatDate(item.date)} at ${time} from your booking?`;
        pendingBookingCartRemoval = { key, button, source, rowIndex };
        bookingRemoveConfirmation.hidden = false;
        bookingRemoveConfirmation.querySelector('[data-dash-book-remove-cancel]')?.focus({ preventScroll: true });
    }

    bookingRemoveConfirmation?.addEventListener('click', (event) => {
        if (event.target.closest('[data-dash-book-remove-cancel]') || event.target === bookingRemoveConfirmation) {
            closeBookingCartRemoveConfirmation();
            return;
        }
        if (!event.target.closest('[data-dash-book-remove-confirm]')) return;
        const pending = pendingBookingCartRemoval;
        closeBookingCartRemoveConfirmation(false);
        if (!pending) return;
        removeBookingCartItem(pending.key);
        if (pending.source === 'details' && !bookingCartDetailsModal?.hidden) {
            const remaining = bookingCartDetailsList?.querySelectorAll('[data-dash-book-cart-remove]') || [];
            if (remaining.length) remaining[Math.min(pending.rowIndex, remaining.length - 1)].focus({ preventScroll: true });
        } else if (pending.source === 'summary') {
            const remaining = bookCartItemsEl?.querySelectorAll('[data-dash-book-cart-remove]') || [];
            if (remaining.length) remaining[Math.min(pending.rowIndex, remaining.length - 1)].focus({ preventScroll: true });
        }
    });
    bookingRemoveConfirmation?.addEventListener('keydown', (event) => handleBookingDialogKeydown(event, bookingRemoveConfirmationDialog, closeBookingCartRemoveConfirmation));

    async function submitBookingCart() {
        if (!paymentTermsAccepted?.checked) {
            paymentTermsOpen?.focus({ preventScroll: true });
            return;
        }
        if (bookingCartSaving || !window.sb || !window.inigosyncProfile) return;
        const items = bookingCart.map((item) => ({ ...item, paymentType: bookingState.paymentType }));
        if (!items.length) return;
        if (items.some((item) => !item.listingId || !item.unitId || !Number.isFinite(item.estimatedTotal) || item.estimatedTotal <= 0)) {
            window.InigoToast?.show('This court needs a confirmed rate and lane before online checkout.', true);
            return;
        }
        for (let i = 0; i < items.length; i++) {
            if (items.slice(i + 1).some((other) => bookingCartItemsConflict(items[i], other))) {
                window.InigoToast?.show('Two items use the same physical court at overlapping times.', true);
                return;
            }
        }
        if (!window.InigoBusinessHours?.getForDate) {
            window.InigoToast?.show('Opening hours could not be checked. Refresh the page and try again.', true);
            return;
        }
        bookingCartSaving = true;
        if (bookSubmit) { bookSubmit.disabled = true; bookSubmit.textContent = 'Opening secure checkout…'; }
        renderBookingCart();
        try {
            if (!window.InigoCourtsData?.getCourts) throw new Error('Current court rates could not be checked. Refresh the page and try again.');
            const [currentCourts, settings] = await Promise.all([
                window.InigoCourtsData.getCourts({ force: true }),
                window.InigoAppSettings?.getSettings ? window.InigoAppSettings.getSettings({ force: true }) : Promise.resolve(null),
            ]);
            bookCourtsCache = currentCourts;
            const paymentRuleChanged = Boolean(settings && settings.downpaymentPct !== bookingState.downpaymentPct);
            if (settings) bookingState.downpaymentPct = settings.downpaymentPct;
            const currentCutoff = settings?.nightRateStartsAt || null;
            let ratesChanged = false;
            const rateMissing = [];
            for (const item of items) {
                const court = currentCourts.find((candidate) => String(candidate.id) === String(item.listingId));
                const unit = court && window.InigoCourtsData.resolveCourtUnits(court).units.find((candidate) => String(candidate.id) === String(item.unitId));
                if (!court || !unit) { rateMissing.push(item); continue; }
                const previous = `${item.rateDay}|${item.rateNight}|${item.rateUnit}|${item.nightRateStartsAt}|${item.estimatedTotal}`;
                applyCurrentUnitPricing(item, unit, court, currentCutoff);
                const next = `${item.rateDay}|${item.rateNight}|${item.rateUnit}|${item.nightRateStartsAt}|${item.estimatedTotal}`;
                if (previous !== next) ratesChanged = true;
                const cartIndex = bookingCart.findIndex((candidate) => candidate.key === item.key);
                if (cartIndex >= 0) bookingCart[cartIndex] = { ...item };
            }
            if (rateMissing.length) {
                window.InigoToast?.show('A selected court or unit is no longer available. Review your bookings and try again.', true);
                return;
            }
            if (ratesChanged || paymentRuleChanged || items.some((item) => !Number.isFinite(item.estimatedTotal) || item.estimatedTotal <= 0)) {
                window.InigoToast?.show('Current rates or payment settings were refreshed. Review the updated total before checkout.', true);
                updateSummary();
                return;
            }
            const rulesByDate = new Map();
            await Promise.all([...new Set(items.map((item) => item.date))].map(async (date) => {
                rulesByDate.set(date, await window.InigoBusinessHours.getForDate(date, { force: true }));
            }));
            const outsideRules = items.find((item) => !bookingRangeFitsRules(item, rulesByDate.get(item.date)));
            if (outsideRules) {
                window.InigoToast?.show(`Opening hours for ${formatDate(outsideRules.date)} have changed or the facility is closed. Review available times and try again.`, true);
                if (outsideRules.date === bookingState.date) {
                    bookingRules = rulesByDate.get(outsideRules.date);
                    resetTimeSelectionAndRender();
                    updateSummary();
                }
                return;
            }
            const occupancyByDateAndCourt = new Map();
            const occupancyQueries = [...new Map(items.map((item) => [`${item.date}|${item.court}`, item])).values()];
            await Promise.all(occupancyQueries.map(async (item) => {
                occupancyByDateAndCourt.set(`${item.date}|${item.court}`, await fetchDayOccupancy(item.court, item.date));
            }));
            if ([...occupancyByDateAndCourt.values()].some((result) => !result.ok)) {
                window.InigoToast?.show('Live availability could not be verified. Review your bookings and try again.', true);
                return;
            }
            const occupiedItem = items.find((item) => {
                const result = occupancyByDateAndCourt.get(`${item.date}|${item.court}`);
                return result.rows.some((row) => {
                    if (!sameCourtName(row.courts, item.court) || !courtUnitsOverlap(row.court_unit, item.unit)) return false;
                    return bookingWindowsOverlap(bookingTimeWindow(row), {
                        start: new Date(item.startIso), end: new Date(item.endIso),
                    });
                });
            });
            if (occupiedItem) {
                window.InigoToast?.show(`Availability changed for ${occupiedItem.court} on ${formatDate(occupiedItem.date)}. Choose another time before checkout.`, true);
                return;
            }
            const { data, error } = await window.sb.functions.invoke('paymongo-checkout', {
                body: {
                    terms_acceptance: { accepted: true, version: 'customer-booking-v1' },
                    payment_option: items[0].paymentType,
                    items: items.map((item) => ({
                        listing_id: item.listingId,
                        unit_id: item.unitId,
                        starts_at: item.startIso,
                        ends_at: item.endIso,
                        rate_quantity: item.rateQuantity,
                    })),
                },
            });
            if (error) throw new Error(await getFunctionErrorMessage(error, 'Secure checkout could not start. Please retry shortly.'));
            if (typeof data?.checkout_url !== 'string' || !data.checkout_url.startsWith('https://checkout.paymongo.com/')) {
                throw new Error(data?.message || 'Secure checkout could not start. Please retry shortly.');
            }
            window.location.assign(data.checkout_url);
        } catch (error) {
            console.error('[dashboard] checkout could not start', error);
            window.InigoToast?.show(error.message || 'Secure checkout could not start.', true);
        } finally {
            bookingCartSaving = false;
            if (bookSubmit) bookSubmit.disabled = false;
            updateSummary();
            renderBookingCart();
        }
    }

    if (bookAddButton) {
        bookAddButton.addEventListener('click', async () => {
            const pendingHours = [...bookingSelectionsByDate.values()].reduce((total, hours) => total + hours.length, 0)
                || bookingState.selectedHours.length;
            if (plainSummaryBackMode && !pendingHours && bookingCart.length) {
                // Back returned to the existing cart. Review booking takes
                // the user forward without adding or editing a cart item.
                goToBookStep(4);
                return;
            }
            const selectedByDate = new Map([...bookingSelectionsByDate.entries()].filter(([date, hours]) => bookingSelectedDates.has(date) && hours.length)
                .map(([date, hours]) => [date, [...hours]]));
            if (!selectedByDate.size && bookingState.date && bookingState.selectedHours.length) {
                selectedByDate.set(bookingState.date, [...bookingState.selectedHours]);
            }
            if (bookingCartSaving || slotGridLoading || !bookingState.court || !bookingState.unitId || !selectedByDate.size) return;
            try {
                const currentCourts = await window.InigoCourtsData.getCourts({ force: true });
                bookCourtsCache = currentCourts;
                const court = currentCourts.find((candidate) => String(candidate.name) === String(bookingState.court));
                const unitIndex = court && window.InigoCourtsData.resolveCourtUnits(court).units.findIndex((unit) => String(unit.id) === String(bookingState.unitId));
                if (!court || unitIndex < 0) throw new Error('The selected court unit is no longer available. Choose another court.');
                const settings = window.InigoAppSettings?.getSettings ? await window.InigoAppSettings.getSettings({ force: true }) : null;
                if (settings) {
                    bookingState.nightRateStartsAt = settings.nightRateStartsAt || null;
                    bookingState.downpaymentPct = settings.downpaymentPct;
                }
                paintBookPreview(court, unitIndex);
                renderCourtChoices(currentCourts.filter((candidate) => bookSportChoiceKey(candidate) === bookingState.sportSlug));
            } catch (error) {
                window.InigoToast?.show(error.message || 'Current court rates could not be checked. Please try again.', true);
                return;
            }
            await refreshTimePickers(true);
            if ([...selectedByDate.keys()].some((date) => {
                const availability = bookingAvailabilityByDate.get(date);
                return !availability?.rules?.authoritative || !availability.bookings.ok || !availability.walkins.ok;
            })) {
                window.InigoToast?.show('Hours and live availability could not be verified. Please retry before adding times.', true);
                return;
            }
            if ([...selectedByDate].some(([date, hours]) => hours.some((hour) => !(bookingSelectionsByDate.get(date) || []).includes(hour)))) {
                window.InigoToast?.show('Availability changed. Please check the times and select again.', true);
                return;
            }
            const dayRuns = bookingRunsByDate(selectedByDate);
            if ([...selectedByDate.keys()].some((date) => dayRuns.filter((item) => item.date === date).length > 1)) {
                window.InigoToast?.show('Choose one continuous time range per date before adding your bookings.', true);
                return;
            }
            if (editingBookingCartKey && (selectedByDate.size !== 1 || dayRuns.length !== 1)) {
                window.InigoToast?.show('An edited booking must use one continuous time range. Cancel and add separate ranges as new bookings.', true);
                return;
            }
            const previousDate = bookingState.date;
            const additions = dayRuns.map(({ date, run }) => {
                bookingState.date = date;
                bookingState.startHour = run.startHour;
                bookingState.endHour = run.endHourExclusive - 1;
                return selectedBookingCartItem(run.startHour, run.endHourExclusive, editingBookingCartKey);
            });
            bookingState.date = previousDate;
            const combined = [...bookingCart.filter((item) => item.key !== editingBookingCartKey), ...additions];
            for (let i = 0; i < combined.length; i += 1) {
                if (combined.slice(i + 1).some((other) => bookingCartItemsConflict(combined[i], other))) {
                    window.InigoToast?.show('Two items use the same physical court at overlapping times.', true);
                    return;
                }
            }
            if (editingBookingCartKey) {
                const index = bookingCart.findIndex((item) => item.key === editingBookingCartKey);
                if (index < 0) return;
                bookingCart[index] = additions[0];
                editingBookingCartKey = null;
                if (bookAddButton) bookAddButton.textContent = 'Review booking';
            } else bookingCart.push(...additions);
            bookingSummaryBackKey = additions[additions.length - 1]?.key || null;
            addingBookingFromSummary = false;
            plainSummaryBackMode = false;
            bookingSelectedDates.forEach((date) => bookingSelectionsByDate.set(date, []));
            bookingState.selectedHours = [];
            bookingState.startHour = null;
            bookingState.endHour = null;
            renderTimePickers();
            updateSummary();
            goToBookStep(4);
        });
    }

    function restoreBookingCartSelection(item) {
        if (!item) return false;
        const court = bookCourtsCache.find((candidate) => String(candidate.id) === String(item.listingId));
        const unit = court && window.InigoCourtsData.resolveCourtUnits(court).units
            .find((candidate) => String(candidate.id) === String(item.unitId));
        if (!court || !unit) return false;

        bookingState.sportSlug = bookSportChoiceKey(court);
        renderSportChoices();
        const sportRadio = [...(bookSportGrid?.querySelectorAll('.dash-book-sport-radio') || [])]
            .find((radio) => radio.value === bookingState.sportSlug);
        if (sportRadio) sportRadio.checked = true;
        const courts = bookCourtsCache.filter((candidate) => bookSportChoiceKey(candidate) === bookingState.sportSlug);
        bookSelect.innerHTML = '<option value="">Choose a court</option>' + courts.map((candidate) => {
            const label = candidate.name;
            return `<option value="${window.escapeHtml(candidate.name)}" data-rate="${candidate.rate !== null ? window.escapeHtml(String(candidate.rate)) : ''}" data-rate-unit="${window.escapeHtml(candidate.rateUnit || '/hr')}" data-sport="${window.escapeHtml(candidate.sportName || candidate.name)}">${window.escapeHtml(label)}</option>`;
        }).join('');
        bookSelect.disabled = false;
        renderCourtChoices(courts);
        if (!selectBookCourtUnit(court.name, unit.id)) return false;
        bookingState.date = item.date;
        if (bookDate) bookDate.value = item.date;
        // Keep the previous court and date available for navigation, but do
        // not restore cart hours: this is a plain return, not an edit draft.
        bookingState.selectedHours = [];
        bookingSelectedDates.clear();
        bookingSelectedDates.add(item.date);
        bookingSelectionsByDate.clear();
        bookingSelectionsByDate.set(item.date, []);
        bookingState.startHour = null;
        bookingState.endHour = null;
        refreshTimePickers(true);
        return true;
    }

    document.querySelectorAll('[data-dash-book-next], [data-dash-book-back]').forEach((button) => {
        button.addEventListener('click', () => {
            if (button.dataset.dashBookBack === '3' && bookingCart.length) {
                // Add another sport or court clears the transient selection.
                // Restore the most recent item's court context for navigation,
                // without entering edit mode or restoring its selected hours.
                const returnItem = bookingCart.find((item) => item.key === bookingSummaryBackKey)
                    || bookingCart[bookingCart.length - 1];
                plainSummaryBackMode = true;
                if (!bookingState.court || !bookingState.unitId) restoreBookingCartSelection(returnItem);
            }
            goToBookStep(button.dataset.dashBookNext || button.dataset.dashBookBack);
        });
    });
    if (bookCartItemsEl) {
        bookCartItemsEl.addEventListener('click', (event) => {
            const editButton = event.target.closest('[data-dash-book-cart-edit]');
            if (editButton) { editBookingCartItem(editButton.dataset.dashBookCartEdit); return; }
            const button = event.target.closest('[data-dash-book-cart-remove]');
            if (!button) return;
            requestBookingCartItemRemoval(button.dataset.dashBookCartRemove, button);
        });
    }
    bookingCartDetailsList?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-dash-book-cart-remove]');
        if (!button) return;
        requestBookingCartItemRemoval(button.dataset.dashBookCartRemove, button);
    });
    if (bookSubmit) {
        bookSubmit.addEventListener('click', () => {
            if (bookSubmit.disabled || !paymentTermsAccepted?.checked) {
                paymentTermsOpen?.focus({ preventScroll: true });
                return;
            }
            openBookingFeeConfirmation();
        });
    }
    bookingFeeContinue?.addEventListener('click', async () => {
        if (bookingFeeContinue.disabled || bookingCartSaving || !bookingFeeContinueAction) return;
        const action = bookingFeeContinueAction;
        closeBookingFeeConfirmation(false);
        if (!bookingPaymentModal?.hidden) bookingPaymentDialog?.focus({ preventScroll: true });
        else bookingNavButton?.focus({ preventScroll: true });
        await action();
    });

    // Neutral "select a court" placeholder until
    // window.InigoCourtsData.getCourts() resolves (populateBookSelect()
    // below) — same "loading" honesty as the <select>'s own "Loading
    // courts…" option.
    paintBookPreview(null);
    refreshTimePickers();
    updateSummary();

    function refreshVisibleBookingAvailability() {
        const bookingPanel = document.querySelector('[data-dash-panel="booking"]');
        if (document.visibilityState !== 'visible' || !bookingPanel?.classList.contains('is-active')
            || !bookingState.court || !bookingState.unitId || !bookingState.date) return;
        const today = todayDateInputValue();
        if (bookDate) bookDate.min = today;
        for (const date of bookingSelectedDates) {
            if (date < today) {
                bookingSelectedDates.delete(date);
                bookingSelectionsByDate.delete(date);
                bookingAvailabilityByDate.delete(date);
            }
        }
        if (bookingState.date < today) {
            bookingState.date = today;
            if (bookDate) bookDate.value = today;
        }
        if (!bookingSelectedDates.has(bookingState.date)) bookingSelectedDates.add(bookingState.date);
        if (!bookingSelectionsByDate.has(bookingState.date)) bookingSelectionsByDate.set(bookingState.date, []);
        bookingState.selectedHours = [...bookingSelectionsByDate.get(bookingState.date)];
        const firstRun = window.InigoBookingSlots.groupConsecutiveHours(bookingState.selectedHours)[0];
        bookingState.startHour = firstRun?.startHour ?? null;
        bookingState.endHour = firstRun ? firstRun.endHourExclusive - 1 : null;
        renderBookingCalendar();
        refreshTimePickers(true);
    }
    document.addEventListener('inigosync:booking-rules-updated', refreshVisibleBookingAvailability);
    document.addEventListener('visibilitychange', refreshVisibleBookingAvailability);
    window.setInterval(refreshVisibleBookingAvailability, 60000);

    // Real downpayment percentage (E2, implementation_plan.md) — read once
    // from `app_settings` via window.InigoAppSettings (includes/appSettings.js),
    // falling back to the same 50% bookingState.downpaymentPct already
    // started at if that table/row doesn't exist yet. GCash/Cash on/off
    // (the other two app_settings columns) have no UI surface on this
    // booking form — it only ever offered Downpayment vs Full Payment, never
    // a GCash/Cash method choice — so only the percentage is wired here.
    if (window.InigoAppSettings) {
        window.InigoAppSettings.getSettings().then((settings) => {
            bookingState.downpaymentPct = settings.downpaymentPct;
            bookingState.nightRateStartsAt = settings.nightRateStartsAt || null;
            if (paymentModeHint) paymentModeHint.textContent = 'Your booking will be confirmed after your online payment is verified.';
            updateSummary();
            refreshMyBookings();
            landingDraftSettingsReady = true;
            importLandingDraftCart();
        }).catch((error) => {
            console.warn('[dashboard] booking settings could not be loaded before landing draft import', error);
            landingDraftSettingsReady = true;
            importLandingDraftCart();
        });
    }

    // ------------------------------------------------------------------
    // Booking wizard court data comes from window.InigoCourtsData and is
    // rendered from its shared memoized fetch. Every interpolated field on
    // this page is escaped — a court
    // named `<img src=x onerror=alert(1)>` (staff/admin can write `court`
    // rows, see database/schema/002_content_tables.sql's RLS policies) must
    // render as literal text, not run.
    // ------------------------------------------------------------------
    function courtPhotoMarkup(unit, monogram, alt) {
        if (unit.imageUrl) {
            return `<img src="${window.escapeHtml(unit.imageUrl)}" alt="${window.escapeHtml(alt)}" loading="lazy" data-dash-book-photo>`;
        }
        return `<span class="dash-court-monogram" aria-hidden="true" data-dash-book-photo>${window.escapeHtml(monogram)}<small class="dash-court-photo-soon">Photo coming soon</small></span>`;
    }

    function sportKey(court) {
        return String(court.sportSlug || (court.sportName || court.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    }

    function isBowlingVariant(court) {
        return /^bowling-(duckpin|tenpin)$/.test(String(court.slug || '').toLowerCase());
    }

    // Bowling's two listings can share one parent sport row in Supabase, but
    // customers book Duckpin and Ten-Pin as separate products with separate
    // availability. Keep each card, filtered court list, and booking label
    // tied to its own court listing slug/name.
    function bookSportChoiceKey(court) {
        if (isBowlingVariant(court)) return String(court.slug).toLowerCase();
        if (sportKey(court) === 'bowling') {
            return String(court.name || 'bowling').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        }
        return sportKey(court);
    }

    function renderSportChoices() {
        if (!bookSportGrid) return;
        const sports = new Map();
        bookCourtsCache.forEach((court) => {
            const key = bookSportChoiceKey(court);
            if (!sports.has(key)) sports.set(key, { key, name: isBowlingVariant(court) || sportKey(court) === 'bowling' ? court.name : court.sportName || court.name, courts: [] });
            sports.get(key).courts.push(court);
        });
        bookSportGrid.innerHTML = [...sports.values()].map((sport) => {
            const coverCourt = sport.courts.find((court) => court.imageUrl || window.InigoCourtsData.resolveCourtUnits(court).units.some((unit) => unit.imageUrl)) || sport.courts[0];
            const coverUnit = window.InigoCourtsData.resolveCourtUnits(coverCourt).units.find((unit) => unit.imageUrl);
            const coverUrl = coverCourt.imageUrl || coverUnit?.imageUrl || '';
            const image = coverUrl
                ? `<img src="${window.escapeHtml(coverUrl)}" alt="" loading="lazy">`
                : `<span class="dash-court-monogram" aria-hidden="true">${window.escapeHtml(window.InigoCourtsData.monogramFor(sport.key, sport.name))}</span>`;
            const selected = bookingState.sportSlug === sport.key;
            return `<label class="dash-book-sport-card${selected ? ' is-selected' : ''}"><input class="dash-book-sport-radio" type="radio" name="dash-book-sport" value="${window.escapeHtml(sport.key)}" data-dash-book-sport="${window.escapeHtml(sport.key)}" aria-label="${window.escapeHtml(sport.name)}"${selected ? ' checked' : ''}><span class="dash-book-sport-photo">${image}</span><span class="dash-book-sport-name">${window.escapeHtml(sport.name)}</span></label>`;
        }).join('') || '<p class="dash-res-state">No courts with verified inventory are available for booking.</p>';
        const nextSportButton = document.querySelector('[data-dash-book-sport-next]');
        if (nextSportButton) nextSportButton.disabled = !bookingState.sportSlug;
    }

    function renderCourtChoices(courts) {
        if (!bookCourtGrid) return;
        const formatRate = (value, unit) => `₱${Number(value).toLocaleString('en-PH', { maximumFractionDigits: 2 })}${unit || '/hr'}`;
        const unitsFor = (court) => window.InigoCourtsData.resolveCourtUnits(court).units;
        bookCourtGrid.innerHTML = courts.flatMap((court) => unitsFor(court).map((unit, unitIndex) => {
            const selected = bookingState.court === court.name && bookingState.unitId != null
                && String(bookingState.unitId) === String(unit.id);
            const unitRate = unit.rateUnit || court.rateUnit || '/hr';
            let rate = '';
            if (typeof unit.rateDay === 'number' && Number.isFinite(unit.rateDay)
                && typeof unit.rateNight === 'number' && Number.isFinite(unit.rateNight)) {
                rate = unit.rateDay === unit.rateNight
                    ? formatRate(unit.rateDay, unitRate)
                    : `${formatRate(unit.rateDay, unitRate)} day · ${formatRate(unit.rateNight, unitRate)} night`;
            } else if (typeof unit.rateDay === 'number' && Number.isFinite(unit.rateDay)) {
                rate = formatRate(unit.rateDay, unitRate);
            } else if (typeof unit.rateNight === 'number' && Number.isFinite(unit.rateNight)) {
                rate = formatRate(unit.rateNight, unitRate);
            } else if (typeof court.rate === 'number' && Number.isFinite(court.rate)) {
                rate = formatRate(court.rate, court.rateUnit);
            }
            const photo = courtPhotoMarkup(unit, window.InigoCourtsData.monogramFor(sportKey(court), court.name), `${court.name} — ${unit.label || `Unit ${unitIndex + 1}`}`);
            const rating = Number.isFinite(court.rating) && court.rating >= 0 && court.rating <= 5
                ? `<span class="dash-book-court-rating" aria-label="Listing rating ${court.rating.toFixed(1)} out of 5"><span aria-hidden="true">★</span> ${court.rating.toFixed(1)}<small>listing rating</small></span>`
                : '';
            const available = Boolean(unit.id);
            const disabled = available ? '' : ' disabled';
            const unavailable = available ? '' : '<span class="dash-book-court-details">Online booking unavailable</span>';
            return `<label class="dash-book-court-card${selected ? ' is-selected' : ''}" data-dash-book-court-card="${window.escapeHtml(court.name)}" data-dash-book-unit-index="${unitIndex}" data-dash-book-unit-id="${window.escapeHtml(unit.id || '')}"><input class="dash-book-court-radio" type="radio" name="dash-book-court-unit" value="${window.escapeHtml(unit.id || '')}" aria-label="${window.escapeHtml(unit.label || `${court.name} ${unitIndex + 1}`)}${rate ? `, ${window.escapeHtml(rate)}` : ''}"${selected ? ' checked' : ''}${disabled}><span class="dash-book-court-photo">${photo}</span><span class="dash-book-court-body"><span class="dash-book-court-heading"><span class="dash-book-court-name">${window.escapeHtml(unit.label || `${court.name} ${unitIndex + 1}`)}</span>${rating}</span>${rate ? `<span class="dash-book-court-rate">${window.escapeHtml(rate)}</span>` : '<span class="dash-book-court-rate">Rate to be confirmed</span>'}${court.description ? `<span class="dash-book-court-details">${window.escapeHtml(court.description)}</span>` : ''}${unavailable}</span></label>`;
        })).join('') || '<p class="dash-res-state">No bookable court units are available for this sport.</p>';
    }

    function selectBookCourtUnit(courtName, unitId) {
        if (!bookSelect || !bookUnitSelect) return false;
        const court = findBookCourt(courtName);
        if (!court || unitId === '') return false;
        const units = window.InigoCourtsData.resolveCourtUnits(court).units;
        const unitIndex = units.findIndex((unit) => unit.id && String(unit.id) === String(unitId));
        if (unitIndex < 0) return false;
        bookSelect.value = court.name;
        if (!bookSelect.value) return false;
        bookSelect.dispatchEvent(new Event('change', { bubbles: true }));
        bookUnitSelect.value = String(unitIndex);
        bookUnitSelect.dispatchEvent(new Event('change', { bubbles: true }));
        return String(bookingState.unitId || '') === String(unitId);
    }

    if (bookSportGrid) bookSportGrid.addEventListener('change', (event) => {
        const radio = event.target.closest('.dash-book-sport-radio');
        if (!radio || !radio.checked) return;
        const selectedSport = radio.value;
        const restoreFocus = document.activeElement === radio;
        if (bookSelect) {
            bookSelect.value = '';
            bookingState.court = '';
            bookingState.unit = null;
            bookingState.unitId = null;
        }
        bookingState.sportSlug = radio.dataset.dashBookSport;
        renderSportChoices();
        if (restoreFocus) {
            [...bookSportGrid.querySelectorAll('.dash-book-sport-radio')]
                .find((candidate) => candidate.dataset.dashBookSport === selectedSport)
                ?.focus({ preventScroll: true });
        }
        const courts = bookCourtsCache.filter((court) => bookSportChoiceKey(court) === bookingState.sportSlug);
        if (bookSelect) {
            bookSelect.innerHTML = '<option value="">Choose a court</option>' + courts.map((court) => {
                const rateHint = window.InigoCourtsData.rateHint?.(court);
                const label = rateHint ? `${court.name} — ${rateHint}` : `${court.name} — Rate TBA`;
                const sportName = isBowlingVariant(court) ? court.name : (court.sportName || court.name);
                return `<option value="${window.escapeHtml(court.name)}" data-rate="${court.rate !== null ? window.escapeHtml(String(court.rate)) : ''}" data-rate-unit="${window.escapeHtml(court.rateUnit || '/hr')}" data-sport="${window.escapeHtml(sportName)}">${window.escapeHtml(label)}</option>`;
            }).join('');
            bookSelect.disabled = false;
            bookSelect.value = '';
            bookingState.court = '';
            bookingState.sport = '';
            paintBookPreview(null);
            renderCourtChoices(courts);
            resetTimeSelectionAndRender();
        }
    });

    bookCourtGrid?.addEventListener('change', (event) => {
        const radio = event.target.closest('.dash-book-court-radio');
        if (!radio || !radio.checked || radio.disabled) return;
        const card = radio.closest('[data-dash-book-court-card]');
        const selectedUnitId = card?.dataset.dashBookUnitId;
        const selectedCourtName = card?.dataset.dashBookCourtCard;
        const restoreFocus = document.activeElement === radio;
        if (!card || !selectBookCourtUnit(card.dataset.dashBookCourtCard, card.dataset.dashBookUnitId)) return;
        renderCourtChoices(bookCourtsCache.filter((court) => bookSportChoiceKey(court) === bookingState.sportSlug));
        if (restoreFocus) {
            const nextRadio = [...bookCourtGrid.querySelectorAll('.dash-book-court-radio')]
                .find((candidate) => candidate.value === selectedUnitId
                    && candidate.closest('[data-dash-book-court-card]')?.dataset.dashBookCourtCard === selectedCourtName);
            nextRadio?.focus({ preventScroll: true });
        }
    });

    // Replaces the "Loading courts…" placeholder <option> with one real
    // option per court, then re-derives bookingState from whichever one
    // ends up selected (the first, by default) instead of the placeholder.
    function populateBookSelect(courts) {
        if (!bookSelect) return;
        // Empty authoritative inventory means the listing is not configured
        // for safe booking yet (for example Pickleball until its renovated
        // court count and shared space are verified by an admin).
        if (courts.some((court) => Array.isArray(court.bookableUnits) || court.inventoryLoadFailed)) {
            courts = courts.filter((court) => !court.inventoryLoadFailed
                && (!Array.isArray(court.bookableUnits) || court.bookableUnits.length > 0));
        }
        // Cached for findBookCourt() (§5, D5) — the <option>s built below
        // only carry rate/rateUnit/sport, not the full normalized court
        // object (quantity/unit/unitImages) the Step 1 preview needs.
        bookCourtsCache = courts;
        bookSelect.innerHTML = '<option value="">Choose a sport first</option>';
        bookSelect.disabled = true;
        bookingState.court = '';
        bookingState.sport = '';
        bookingState.sportSlug = '';
        paintBookPreview(null);
        renderSportChoices();
        updateSummary();
        renderTimePickers();
        refreshMyBookings();
    }

    // Landing-page selections are tab-scoped drafts. Resolve every selection
    // again from current court data and live availability before it enters
    // the booking summary; the handoff itself never creates a reservation.
    async function importLandingDraftCart() {
        if (!landingDraftProfileReady || !landingDraftCourtDataReady || !landingDraftSettingsReady || landingDraftImportInFlight) return;
        let raw;
        try { raw = sessionStorage.getItem('inigosync:landing-booking-draft:v1'); } catch (_) { return; }
        if (!raw) return;
        let payload;
        try { payload = JSON.parse(raw); } catch (_) { sessionStorage.removeItem('inigosync:landing-booking-draft:v1'); return; }
        const ageMs = Date.now() - Number(payload?.createdAt);
        if (payload?.version !== 1 || !Array.isArray(payload.items) || payload.items.length !== 1
            || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 24 * 60 * 60 * 1000) {
            sessionStorage.removeItem('inigosync:landing-booking-draft:v1');
            window.InigoToast?.show('The landing-page booking draft expired or could not be read. Please select the court times again.', true);
            return;
        }

        landingDraftImportInFlight = true;
        const staged = [];
        try {
            for (const draft of payload.items) {
                if (!draft || typeof draft.listingSlug !== 'string' || typeof draft.unitId !== 'string'
                    || !/^\d{4}-\d{2}-\d{2}$/.test(String(draft.date || ''))
                    || !Array.isArray(draft.hours) || !draft.hours.length
                    || draft.hours.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23)) {
                    throw new Error('One of the draft selections is incomplete. Please select the court times again.');
                }
                if (window.InigoBookingSlots.groupConsecutiveHours(draft.hours).length !== 1) {
                    throw new Error('Choose one consecutive time range for a single court booking.');
                }
                const parsedDraftDate = new Date(`${draft.date}T00:00:00Z`);
                if (!Number.isFinite(parsedDraftDate.getTime()) || parsedDraftDate.toISOString().slice(0, 10) !== draft.date) {
                    throw new Error('A selected date is invalid. Please select the court times again.');
                }
                const court = bookCourtsCache.find((item) => item.slug === draft.listingSlug);
                if (!court || court.inventoryLoadFailed) throw new Error('A selected court is no longer available for online booking.');
                const resolved = window.InigoCourtsData.resolveCourtUnits(court);
                const unitIndex = resolved.units.findIndex((unit) => String(unit.id || '') === draft.unitId);
                if (unitIndex < 0) throw new Error('A selected court unit has changed. Please select it again.');
                if (draft.date < todayDateInputValue()) throw new Error('A selected date has passed. Please choose a new date.');

                bookingState.sportSlug = bookSportChoiceKey(court);
                renderSportChoices();
                const courtsForSport = bookCourtsCache.filter((item) => bookSportChoiceKey(item) === bookingState.sportSlug);
                bookSelect.innerHTML = '<option value="">Choose a court</option>' + courtsForSport.map((item) => {
                    const rateHint = window.InigoCourtsData.rateHint?.(item);
                    const label = rateHint ? `${item.name} — ${rateHint}` : `${item.name} — Rate TBA`;
                    const sportName = isBowlingVariant(item) ? item.name : (item.sportName || item.name);
                    return `<option value="${window.escapeHtml(item.name)}" data-rate="${item.rate !== null ? window.escapeHtml(String(item.rate)) : ''}" data-rate-unit="${window.escapeHtml(item.rateUnit || '/hr')}" data-sport="${window.escapeHtml(sportName)}">${window.escapeHtml(label)}</option>`;
                }).join('');
                if (typeof renderCourtChoices === 'function') renderCourtChoices(courtsForSport);
                bookSelect.disabled = false;
                bookSelect.value = court.name;
                if (!bookSelect.value) throw new Error('A selected court is no longer listed.');
                bookSelect.dispatchEvent(new Event('change', { bubbles: true }));
                if (bookDate) {
                    bookDate.value = draft.date;
                    bookDate.dispatchEvent(new Event('change', { bubbles: true }));
                }
                paintBookPreview(court, unitIndex);
                if (bookUnitSelect) bookUnitSelect.value = String(unitIndex);
                if (typeof renderCourtChoices === 'function') renderCourtChoices(courtsForSport);
                bookingState.selectedHours = [...new Set(draft.hours)].sort((a, b) => a - b);
                await refreshTimePickers(true);
                if (!bookingRules?.authoritative || !slotGridBookings.ok || !slotGridWalkins.ok
                    || bookingState.selectedHours.length !== new Set(draft.hours).size) {
                    throw new Error('Availability changed for a selected time. Review the available times and add your choices again.');
                }
                const runs = window.InigoBookingSlots.groupConsecutiveHours(bookingState.selectedHours);
                runs.forEach((run) => staged.push(selectedBookingCartItem(run.startHour, run.endHourExclusive)));
            }
            if (staged.length !== 1) throw new Error('Choose one court booking at a time from the landing page.');
            const combined = [...bookingCart, ...staged];
            for (let i = 0; i < combined.length; i += 1) {
                if (combined.slice(i + 1).some((other) => bookingCartItemsConflict(combined[i], other))) {
                    throw new Error('A landing-page selection overlaps another booking. Review the times and try again.');
                }
            }
            bookingCart.push(...staged);
            bookingSummaryBackKey = staged[staged.length - 1]?.key || null;
            bookingState.selectedHours = [];
            bookingState.startHour = null;
            bookingState.endHour = null;
            renderTimePickers();
            sessionStorage.removeItem('inigosync:landing-booking-draft:v1');
            updateSummary();
            renderBookingCart();
            if (typeof goToBookStep === 'function') goToBookStep(4);
            setActivePanel('booking');
            window.InigoToast?.show('Your court booking is ready. Review the rate and time before continuing to payment.');
        } catch (error) {
            try { sessionStorage.removeItem('inigosync:landing-booking-draft:v1'); } catch (_) { /* storage may be disabled */ }
            window.InigoToast?.show(error.message || 'The landing-page draft could not be imported. Please review the court times.', true);
        } finally {
            landingDraftImportInFlight = false;
        }
    }

    document.addEventListener('inigosync:profile-ready', (event) => {
        landingDraftProfileReady = event.detail?.role === 'customer';
        importLandingDraftCart();
    });

    if (window.InigoCourtsData) {
        window.InigoCourtsData.getCourts().then((courts) => {
            populateBookSelect(courts);
            renderOverviewAvailabilityCards(courts);
            landingDraftCourtDataReady = true;
            importLandingDraftCart();
        }).catch((err) => {
            console.error('[dashboard] could not load courts', err);
            showOverviewAvailabilityLoadError();
        });
    } else {
        // Should never happen — includes/courtsData.js must load before
        // this file (see the <script> order in Pages/user_dashboard.html).
        console.error('[dashboard] window.InigoCourtsData is missing — check that includes/courtsData.js loads before includes/Dashboard.js.');
        showOverviewAvailabilityLoadError();
    }

    // ------------------------------------------------------------------
    // My Bookings — real data, fetched once the signed-in profile is ready
    // (authGuard.js dispatches this after its own session+profile check).
    // ------------------------------------------------------------------
    const bookingsTableBody = document.querySelector('[data-dash-panel="bookings"] tbody');
    const myBookingsSearch = document.querySelector('[data-dash-booking-search]');
    const myBookingsStatus = document.querySelector('[data-dash-booking-status]');
    const myBookingsDate = document.querySelector('[data-dash-booking-date]');
    const myBookingsSource = document.querySelector('[data-dash-booking-source]');
    const myBookingsCount = document.querySelector('[data-dash-booking-count]');
    const upcomingReservationsList = document.querySelector('[data-dash-upcoming-list]');
    const upcomingReservationsMore = document.querySelector('[data-dash-upcoming-more]');
    const UPCOMING_RESERVATIONS_INITIAL_LIMIT = 5;
    const UPCOMING_RESERVATIONS_INCREMENT = 5;
    let upcomingReservations = [];
    let upcomingReservationsVisibleCount = UPCOMING_RESERVATIONS_INITIAL_LIMIT;

    function renderUpcomingReservations(bookings, failed = false, resetVisibleCount = true) {
        if (!upcomingReservationsList) return;
        if (failed) {
            upcomingReservations = [];
            upcomingReservationsList.innerHTML = '<p class="dash-res-state">Could not load your reservations. <button type="button" class="dash-link-btn" data-dash-upcoming-retry>Try again</button></p>';
            if (upcomingReservationsMore) upcomingReservationsMore.hidden = true;
            return;
        }

        upcomingReservations = window.InigoDashboardUpcoming.selectUpcomingReservations(bookings);
        if (resetVisibleCount) upcomingReservationsVisibleCount = UPCOMING_RESERVATIONS_INITIAL_LIMIT;

        if (!upcomingReservations.length) {
            upcomingReservationsList.innerHTML = '<p class="dash-res-state">No upcoming reservations. Book a court to get started.</p>';
            if (upcomingReservationsMore) upcomingReservationsMore.hidden = true;
            return;
        }

        const visibleBookings = upcomingReservations.slice(0, upcomingReservationsVisibleCount);
        upcomingReservationsList.innerHTML = visibleBookings.map((booking) => `
            <div class="dash-res-row">
                <div class="dash-res-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 3v18M3 12h18M6 6c3 3 3 9 0 12M18 6c-3 3-3 9 0 12" stroke="currentColor" stroke-width="1.4"/></svg>
                </div>
                <div class="dash-res-info">
                    <h4>${window.escapeHtml(booking.courts || 'Court reservation')}</h4>
                    <p>${window.escapeHtml(formatBookingDate(booking.time_date))} · ${window.escapeHtml(formatBookingTime(booking.time_date, booking.end_at))}</p>
                </div>
            </div>
        `).join('');
        if (upcomingReservationsMore) upcomingReservationsMore.hidden = upcomingReservations.length <= upcomingReservationsVisibleCount;
    }

    if (upcomingReservationsMore) {
        upcomingReservationsMore.addEventListener('click', () => {
            upcomingReservationsVisibleCount = window.InigoDashboardUpcoming.nextVisibleCount(
                upcomingReservationsVisibleCount,
                upcomingReservations.length,
                UPCOMING_RESERVATIONS_INCREMENT,
            );
            renderUpcomingReservations(upcomingReservations, false, false);
        });
    }
    if (upcomingReservationsList) {
        upcomingReservationsList.addEventListener('click', (event) => {
            if (event.target.closest('[data-dash-upcoming-retry]')) refreshMyBookings();
        });
    }

    // Same rate lookup already used by the booking form's <select> — read
    // live from its current <option data-rate> on every call rather than a
    // one-time snapshot, since those options are now populated
    // asynchronously by populateBookSelect() above (a snapshot taken here at
    // DOMContentLoaded would always find the select still empty). Only used
    // to show a known amount; no cost is persisted anywhere since no
    // payment record exists yet.
    function getCourtRate(courtName) {
        if (!bookSelect) return null;
        const opt = Array.from(bookSelect.options).find((o) => o.value === courtName);
        if (!opt || !opt.dataset.rate) return null;
        const rate = Number(opt.dataset.rate);
        return Number.isNaN(rate) ? null : rate;
    }

    // L2 fix (post-Revision-5 review) — same <option data-rate-unit> lookup
    // as getCourtRate() above (and the exact source bookingState.rateUnit
    // itself is populated from — the court <select>'s change handler around
    // updateSummary(), ~line 1012), so a receipt for court X shows the same
    // "/hr" (or whatever unit that court actually bills) the booking wizard
    // summary showed while it was being booked, instead of a hard-coded
    // "/hr" that would be wrong for a non-hourly court.
    function getCourtRateUnit(courtName) {
        if (!bookSelect) return '/hr';
        const opt = Array.from(bookSelect.options).find((o) => o.value === courtName);
        return (opt && opt.dataset.rateUnit) || '/hr';
    }

    function getBookingUnitPricing(booking) {
        const court = bookCourtsCache.find((item) => (booking.court_listing_id && String(item.id) === String(booking.court_listing_id))
            || item.name === booking.courts);
        if (!court || !window.InigoCourtsData) return { rateUnit: getCourtRateUnit(booking.courts), rateDay: null, rateNight: null };
        const units = window.InigoCourtsData.resolveCourtUnits(court).units;
        const unit = units.find((item) => booking.court_unit_inventory_id && String(item.id) === String(booking.court_unit_inventory_id));
        return {
            rateUnit: unit && (typeof unit.rateDay === 'number' || typeof unit.rateNight === 'number') ? (unit.rateUnit || court.rateUnit || '/hr') : (court.rateUnit || getCourtRateUnit(booking.courts)),
            rateDay: typeof unit?.rateDay === 'number' ? unit.rateDay : null,
            rateNight: typeof unit?.rateNight === 'number' ? unit.rateNight : null,
        };
    }

    function quoteExistingBookingTotal(booking, pricing) {
        const start = new Date(booking.time_date).getTime();
        const end = booking.end_at ? new Date(booking.end_at).getTime() : start + Math.max(1, Number(booking.duration_minutes) || 60) * 60000;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
        if (pricing.rateUnit === '/set') {
            return typeof pricing.rateDay === 'number' ? pricing.rateDay * Math.max(1, Number(booking.rate_quantity) || 1) : null;
        }
        if (pricing.rateUnit !== '/hr' || typeof pricing.rateDay !== 'number') return null;
        if (typeof pricing.rateNight !== 'number' || pricing.rateNight === pricing.rateDay) {
            return pricing.rateDay * ((end - start) / 3600000);
        }
        const match = /^(\d{2}):(\d{2})/.exec(String(bookingState.nightRateStartsAt || ''));
        if (!match) return null;
        const cutoff = Number(match[1]) * 60 + Number(match[2]);
        let total = 0;
        for (let t = start; t < end; t += 60000) {
            const local = new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
            const [hour, minute] = local.split(':').map(Number);
            total += (hour * 60 + minute >= cutoff ? pricing.rateNight : pricing.rateDay) / 60;
        }
        return Math.round(total * 100) / 100;
    }

    function formatBookingDate(iso) {
        const d = new Date(iso);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    // Part 3 (implementation_plan.md) — bookings are ranges now (database/
    // schema/012_booking_time_range.sql's end_at). `endIso` is optional and
    // falls back to a single start-time label (this function's old, entire
    // behavior) whenever it's missing/invalid — a booking made before that
    // migration, or made while it hadn't been applied yet, has no end_at,
    // and this must keep rendering something sensible for it either way.
    function formatBookingTime(iso, endIso) {
        const d = new Date(iso);
        const startLabel = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        if (!endIso) return startLabel;
        const endD = new Date(endIso);
        if (Number.isNaN(endD.getTime())) return startLabel;
        const endLabel = endD.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return `${startLabel} – ${endLabel}`;
    }

    // ------------------------------------------------------------------
    // Derived "Unattended" status (Revision 2, R4 — implementation_plan.md).
    // A booking DISPLAYS as Unattended once ALL of: it is past the
    // date-specific grace period after booking.time_date, nobody checked it in
    // (booking.checked_in_at is null/absent —
    // database/schema/004_staff_module.sql), and its stored status is still
    // 'pending' or 'confirmed' (a booking already 'completed' or 'cancelled'
    // keeps that real, later-stage status — Unattended never overrides one).
    //
    // This is NEVER written back to the database. booking.status has a CHECK
    // constraint that only accepts 'pending' | 'confirmed' | 'cancelled' |
    // 'completed' — see the big comment above the booking INSERT further up
    // this file and its own 23514 error branch. Writing 'unattended' there
    // would fail the exact same way. Nothing in this project runs a
    // scheduled job either (no cron this repo can see, and no visibility
    // into `booking`'s real triggers/RLS — database/schema/
    // 004_staff_module.sql's header note), so a WRITTEN status would need
    // server-side automation this repo cannot safely add blind. Deriving it
    // here instead means the rule is visibly enforced the moment it becomes
    // true, with zero migration risk and nothing fabricated — and it can
    // never drift out of sync between panels, since My Bookings calls this
    // SAME function rather than reading booking.status directly.
    //
    // database/schema/010_booking_unattended_status.sql (optional, NOT
    // applied — no Supabase admin access here) extends that CHECK
    // constraint so a later staff/automation feature COULD persist
    // 'unattended' for real; this function behaves identically whether or
    // not that migration has been run. Existing historical 'cancelled' rows
    // still display exactly as stored — this function only ever touches a
    // still-open pending/confirmed booking.
    // ------------------------------------------------------------------
    const bookingPolicyNotice = document.querySelector('[data-dash-booking-policy]');
    const bookingGraceMinutesByDate = new Map();
    let bookingTodayGraceRuleGeneration = 0;
    let bookingTodayGraceRuleRequest = null;
    const bookingDateForRules = (value) => {
        if (window.InigoBusinessHours?.dateInManila) return window.InigoBusinessHours.dateInManila(value);
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(new Date(value));
        const part = (type) => parts.find((item) => item.type === type)?.value;
        return `${part('year')}-${part('month')}-${part('day')}`;
    };

    async function loadTodayBookingGraceRule({ force = false } = {}) {
        if (typeof window.InigoBusinessHours?.getForDate !== 'function') return null;
        // A normal booking refresh must not overtake a forced owner-rule refresh
        // with a potentially stale cached read.
        if (!force && bookingTodayGraceRuleRequest?.force) return bookingTodayGraceRuleRequest.promise;

        const date = bookingDateForRules(new Date());
        const generation = ++bookingTodayGraceRuleGeneration;
        const request = { force, generation, promise: null };
        request.promise = Promise.resolve().then(async () => {
            try {
                const rules = await window.InigoBusinessHours.getForDate(date, { force });
                if (generation !== bookingTodayGraceRuleGeneration) return rules;
                if (rules?.authoritative && Number.isInteger(rules.graceMinutes) && rules.graceMinutes >= 0) {
                    bookingGraceMinutesByDate.set(date, rules.graceMinutes);
                    if (date === bookingDateForRules(new Date())) renderBookingPolicyNotice(rules.graceMinutes);
                } else {
                    bookingGraceMinutesByDate.delete(date);
                    if (date === bookingDateForRules(new Date())) renderBookingPolicyNotice(null);
                }
                return rules;
            } catch (error) {
                if (generation === bookingTodayGraceRuleGeneration) {
                    bookingGraceMinutesByDate.delete(date);
                    if (date === bookingDateForRules(new Date())) renderBookingPolicyNotice(null);
                    console.warn('[dashboard] booking grace rule could not be loaded', error);
                }
                return null;
            } finally {
                if (bookingTodayGraceRuleRequest === request) bookingTodayGraceRuleRequest = null;
            }
        });
        bookingTodayGraceRuleRequest = request;
        return request.promise;
    }

    async function loadBookingGraceRules(bookings, { forceToday = false } = {}) {
        if (typeof window.InigoBusinessHours?.getForDate !== 'function') return;
        const today = bookingDateForRules(new Date());
        const startOfToday = Date.now();
        const dates = new Set([today, ...(bookings || [])
            .filter((booking) => ['pending', 'confirmed'].includes(String(booking.status || '').toLowerCase())
                && !booking.checked_in_at
                && Number.isFinite(new Date(booking.time_date).getTime())
                && new Date(booking.time_date).getTime() <= startOfToday)
            .map((booking) => bookingDateForRules(booking.time_date))]);

        await Promise.all([...dates].map(async (date) => {
            if (date === today) {
                await loadTodayBookingGraceRule({ force: forceToday });
                return;
            }
            try {
                const rules = await window.InigoBusinessHours.getForDate(date);
                if (rules?.authoritative && Number.isInteger(rules.graceMinutes) && rules.graceMinutes >= 0) {
                    bookingGraceMinutesByDate.set(date, rules.graceMinutes);
                } else {
                    bookingGraceMinutesByDate.delete(date);
                }
            } catch (error) {
                bookingGraceMinutesByDate.delete(date);
                console.warn('[dashboard] booking grace rule could not be loaded', error);
            }
        }));
    }

    function renderBookingPolicyNotice(graceMinutes) {
        if (!bookingPolicyNotice) return;
        const graceDescription = Number.isInteger(graceMinutes) && graceMinutes >= 0
            ? `${graceMinutes} ${graceMinutes === 1 ? 'minute' : 'minutes'}`
            : 'the grace period set by the venue';
        bookingPolicyNotice.textContent = `You cannot cancel a booking yourself. Completed payments are non-refundable. If you have not checked in within ${graceDescription} after your start time, your booking will be cancelled as a no-show and the court will become available again.`;
    }

    function isMyBookingsPanelActive() {
        return Boolean(document.querySelector('[data-dash-panel="bookings"]')?.classList.contains('is-active'));
    }

    async function refreshBookingPolicyNotice() {
        if (!bookingPolicyNotice || !isMyBookingsPanelActive()
            || typeof window.InigoBusinessHours?.getForDate !== 'function') return;
        await loadTodayBookingGraceRule({ force: true });
    }

    document.addEventListener('inigosync:booking-rules-updated', refreshBookingPolicyNotice);
    window.addEventListener('storage', (event) => {
        if (!event.key || event.key === 'inigosync:booking-rules-updated') refreshBookingPolicyNotice();
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshBookingPolicyNotice();
    });
    window.setInterval(() => {
        if (isMyBookingsPanelActive()) refreshBookingPolicyNotice();
    }, 60_000);

    function displayStatusFor(booking) {
        const rawStatus = String(booking.status || '').toLowerCase();
        // Only a still-open booking can ever be "missed" — one that's
        // already cancelled/completed keeps that real status.
        if (rawStatus !== 'pending' && rawStatus !== 'confirmed') return rawStatus;
        // Historical bookings explicitly excluded by the server no-show
        // policy must keep their stored status.
        if (booking.no_show_policy_applies === false) return rawStatus;
        // Staff already timed this customer in — they showed up, however
        // late; not Unattended.
        if (booking.checked_in_at) return rawStatus;

        const start = new Date(booking.time_date);
        if (Number.isNaN(start.getTime())) return rawStatus; // defensive — time_date is required, never seen live

        const bookingDate = bookingDateForRules(booking.time_date);
        const graceMinutes = bookingGraceMinutesByDate.get(bookingDate);
        // Missing or fallback rules are not authoritative, so preserve the
        // server status rather than guessing a no-show threshold.
        if (!Number.isInteger(graceMinutes) || graceMinutes < 0) return rawStatus;

        const graceDeadline = start.getTime() + graceMinutes * 60000;
        return Date.now() > graceDeadline ? 'unattended' : rawStatus;
    }

    function applyMyBookingsFilters() {
        if (!bookingsTableBody) return;
        const rows = Array.from(bookingsTableBody.querySelectorAll('[data-customer-booking-row]'));
        const query = String(myBookingsSearch?.value || '').trim().toLocaleLowerCase();
        const status = String(myBookingsStatus?.value || '').toLocaleLowerCase();
        const date = String(myBookingsDate?.value || '');
        let visibleCount = 0;

        rows.forEach((row) => {
            const matches = (!query || row.textContent.toLocaleLowerCase().includes(query))
                && (!status || row.dataset.bookingStatus === status)
                && (!myBookingsSource?.value || row.dataset.bookingSource === myBookingsSource.value)
                && (!date || row.dataset.bookingDate === date);
            row.hidden = !matches;
            if (matches) visibleCount += 1;
        });

        let emptyRow = bookingsTableBody.querySelector('[data-dash-bookings-no-results]');
        if (rows.length && visibleCount === 0) {
            if (!emptyRow) {
                emptyRow = document.createElement('tr');
                emptyRow.dataset.dashBookingsNoResults = '';
                emptyRow.innerHTML = '<td colspan="7" class="dash-booking-no-results">No bookings or visits match your search and filters. Try changing or clearing them.</td>';
                bookingsTableBody.appendChild(emptyRow);
            }
            emptyRow.hidden = false;
        } else if (emptyRow) {
            emptyRow.hidden = true;
        }

        if (myBookingsCount) {
            myBookingsCount.textContent = rows.length
                ? `Showing ${visibleCount} of ${rows.length} ${rows.length === 1 ? 'activity' : 'activities'}`
                : '0 activities';
        }
    }

    [myBookingsSearch, myBookingsStatus, myBookingsDate, myBookingsSource].forEach((control) => {
        control?.addEventListener('input', applyMyBookingsFilters);
        control?.addEventListener('change', applyMyBookingsFilters);
    });

    let activeReviewBookingId = null;
    const bookingReviewModal = document.querySelector('[data-booking-review-modal]');
    let bookingFetchGeneration = 0;
    async function refreshMyBookings({ forceCurrentRule = false } = {}) {
        if (!bookingsTableBody || !window.sb || !window.inigosyncProfile) return;

        const generation = ++bookingFetchGeneration;
        let data = null;
        let error = null;
        try {
            ({ data, error } = await window.sb
                .from('booking')
                .select('*')
                .eq('customer_id', window.inigosyncProfile.id)
                .order('time_date', { ascending: false }));
        } catch (requestError) {
            error = requestError;
        }
        if (generation !== bookingFetchGeneration) return;

        if (error) {
            console.error('[dashboard] failed to load bookings', error);
            renderUpcomingReservations(null, true);
            // Booking acknowledgments depend on this account-scoped query;
            // renderReceipts still attempts to load linked walk-in records.
            renderReceipts(null, true);
            return;
        }

        await loadBookingGraceRules(data || [], { forceToday: forceCurrentRule });
        if (generation !== bookingFetchGeneration) return;

        let walkins = [];
        try {
            let offset = 0;
            let total = null;
            const limit = 50;
            do {
                const { data: result, error: walkinError } = await window.sb.rpc('customer_list_walkin_activity', {
                    p_offset: offset, p_limit: limit,
                });
                if (walkinError) throw walkinError;
                const rows = Array.isArray(result?.rows) ? result.rows : [];
                total = Number(result?.total_count) || 0;
                walkins.push(...rows);
                offset += rows.length;
                if (!rows.length || offset >= total) break;
            } while (offset < total && offset < 5000);
            if (offset < total) throw new Error('Walk-in activity paging exceeded the safe limit.');
        } catch (walkinError) {
            console.error('[dashboard] linked walk-in activity could not be loaded', walkinError);
            walkins = [];
            window.InigoToast?.show('Walk-in visits could not be loaded. Refresh and try again.', true);
        }
        if (generation !== bookingFetchGeneration) return;

        renderUpcomingReservations(data || []);
        // Notifications (§3, D6) — reuses this exact fetch rather than a
        // second query against `booking`; see renderNotifications()'s own
        // header comment near the notifications dropdown wiring above.
        renderNotifications(data || []);
        // Receipts (§7/D8, Revision 2's R5) — same reuse, no second query;
        // see renderReceipts()'s own header comment below.
        renderReceipts(data || []);

        bookingsTableBody.innerHTML = '';

        if ((!data || data.length === 0) && walkins.length === 0) {
            const row = document.createElement('tr');
            row.innerHTML = '<td colspan="7" style="text-align:center; color: var(--color-ink-faint);">No bookings or visits yet — book a court to get started.</td>';
            bookingsTableBody.appendChild(row);
            applyMyBookingsFilters();
            return;
        }

        // The safe per-customer view reveals only reviewed booking IDs.
        // Fail closed if it is unavailable: don't invite duplicate submits.
        const reviewResult = await window.sb.from('my_booking_reviews').select('booking_id');
        const reviewedBookings = new Set((reviewResult.error ? [] : reviewResult.data || []).map((review) => String(review.booking_id)));

        (data || []).forEach((booking) => {
            const savedTotal = booking.amount_total === null || booking.amount_total === undefined ? null : Number(booking.amount_total);
            const bookingPricing = getBookingUnitPricing(booking);
            const displayedTotal = Number.isFinite(savedTotal) ? savedTotal : quoteExistingBookingTotal(booking, bookingPricing);
            const amount = Number.isFinite(displayedTotal) ? `₱${displayedTotal.toFixed(2)}` : '—';
            const row = document.createElement('tr');
            // courts is DB content (free text on the booking row) — escaped
            // before touching innerHTML so this renders as literal text in
            // the customer's own session instead of running, same as the
            // staff/admin tables. Status shown is the DERIVED one
            // (displayStatusFor()) — never booking.status directly — so an
            // overdue booking reads "Unattended" only when its date-specific
            // grace rule was confirmed, without writing that value to DB.
            const displayStatus = displayStatusFor(booking);
            row.dataset.customerBookingRow = '';
            row.dataset.bookingSource = 'booking';
            row.dataset.activityTimestamp = String(new Date(booking.time_date).getTime() || 0);
            row.dataset.bookingStatus = displayStatus;
            row.dataset.bookingDate = bookingDateForRules(booking.time_date);
            const courtLabel = window.escapeHtml(booking.courts || '');
            const statusClass = window.escapeHtml(displayStatus);
            const statusLabel = window.escapeHtml(displayStatus ? displayStatus.charAt(0).toUpperCase() + displayStatus.slice(1) : '—');
            const canQuoteOnline = Number.isFinite(displayedTotal) && displayedTotal > 0;
            const canRetryOnline = !booking.payment_id && ['pending', 'confirmed'].includes(booking.status)
                && new Date(booking.time_date).getTime() > Date.now()
                && canQuoteOnline && bookingPricing.rateUnit === '/hr';
            const retryPaymentButton = canRetryOnline
                ? `<button type="button" class="dash-mini-btn" data-dash-retry-checkout="${window.escapeHtml(String(booking.booking_id))}">Pay online</button>`
                : '';
            const fullyPaid = Number(booking.amount_total) > 0 && Number(booking.amount_paid || 0) >= Number(booking.amount_total);
            const canReview = booking.status === 'completed' && fullyPaid && !reviewResult.error && !reviewedBookings.has(String(booking.booking_id));
            const reviewButton = canReview ? `<button type="button" class="dash-mini-btn" data-dash-review-booking="${window.escapeHtml(String(booking.booking_id))}">Write a review</button>` : '';
            // R3/Revision 2 — no Cancel control anywhere (see the policy
            // notice in Pages/user_dashboard.html): the real rule is no
            // cancellation and no refunds/cashback. An overdue booking shows
            // as Unattended above using its date-specific venue grace rule.
            row.innerHTML = `
                <td>Online booking</td>
                <td class="dash-cell-main">${courtLabel}</td>
                <td>${formatBookingDate(booking.time_date)}</td>
                <td>${formatBookingTime(booking.time_date, booking.end_at)}</td>
                <td>${amount}</td>
                <td><span class="dash-status ${statusClass}">${statusLabel}</span></td>
                <td>
                    <div class="dash-table-actions">
                        ${retryPaymentButton}
                        ${reviewButton}
                    </div>
                </td>
            `;
            bookingsTableBody.appendChild(row);
        });

        walkins.forEach((visit) => {
            const row = document.createElement('tr');
            const status = String(visit.display_status || visit.status || '—').toLowerCase();
            row.dataset.customerBookingRow = '';
            row.dataset.bookingSource = 'walkin';
            row.dataset.activityTimestamp = String(new Date(visit.time_date).getTime() || 0);
            row.dataset.bookingStatus = status;
            row.dataset.bookingDate = bookingDateForRules(visit.time_date);
            const court = window.escapeHtml([visit.sports, visit.courts, visit.court_unit].filter(Boolean).join(' — ') || 'Walk-in visit');
            const amount = Number.isFinite(Number(visit.amount_total)) ? `₱${Number(visit.amount_total).toFixed(2)}` : '—';
            const statusLabel = window.escapeHtml(status ? status.charAt(0).toUpperCase() + status.slice(1) : '—');
            row.innerHTML = `<td>Walk-in</td><td class="dash-cell-main">${court}</td><td>${formatBookingDate(visit.time_date)}</td><td>${formatBookingTime(visit.time_date, visit.end_at)}</td><td>${amount}</td><td><span class="dash-status ${window.escapeHtml(status)}">${statusLabel}</span></td><td><span>—</span></td>`;
            bookingsTableBody.appendChild(row);
        });

        Array.from(bookingsTableBody.querySelectorAll('[data-customer-booking-row]'))
            .sort((left, right) => Number(right.dataset.activityTimestamp) - Number(left.dataset.activityTimestamp))
            .forEach(row => bookingsTableBody.appendChild(row));

        applyMyBookingsFilters();

        // Dynamically-created [data-dash-nav] buttons don't inherit the
        // page's one-time navButtons.forEach() binding at the very top of
        // this file (that querySelectorAll ran once, before these rows
        // existed) — wired explicitly here instead, same re-wire-after-
        // render idiom this file already uses elsewhere for its own
        // dynamically rendered scopes (wireOverviewCourtList() above,
        // wireReceiptDownloads() below).
        bookingsTableBody.querySelectorAll('[data-dash-retry-checkout]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const bookingId = Number(btn.dataset.dashRetryCheckout);
                openBookingFeeConfirmation({
                    question: `Would you like to reopen online payment for booking #${bookingId}?`,
                    continueLabel: 'Retry payment securely',
                    returnFocus: btn,
                    onContinue: async () => {
                        btn.disabled = true;
                        btn.textContent = 'Opening…';
                        try {
                            const { data, error } = await window.sb.functions.invoke('paymongo-checkout', {
                                body: { booking_id: bookingId },
                            });
                            if (!error && typeof data?.checkout_url === 'string'
                                && data.checkout_url.startsWith('https://checkout.paymongo.com/')) {
                                window.location.assign(data.checkout_url);
                                return;
                            }
                            console.error('[dashboard] PayMongo retry failed', error || data);
                            const message = error
                                ? await getFunctionErrorMessage(error, 'Could not reopen online checkout. Please try again.')
                                : data?.message || 'Could not reopen online checkout. Please try again.';
                            window.InigoToast?.show(message, true);
                        } catch (error) {
                            console.error('[dashboard] PayMongo retry failed', error);
                            window.InigoToast?.show(error?.message || 'Could not reopen online checkout. Please try again.', true);
                        }
                        btn.disabled = false;
                        btn.textContent = 'Pay online';
                    },
                });
            });
        });
        bookingsTableBody.querySelectorAll('[data-dash-review-booking]').forEach((btn) => btn.addEventListener('click', () => {
            activeReviewBookingId = btn.dataset.dashReviewBooking;
            if (!bookingReviewModal) return;
            bookingReviewModal.hidden = false;
            bookingReviewModal.querySelector('[data-booking-review-comment]').value = '';
            bookingReviewModal.querySelector('[data-booking-review-rating]').value = '5';
        }));
    }

    let bookingReviewClosePending = false;
    let bookingReviewSubmitPending = false;
    function bookingReviewHasChanges() {
        return Boolean(document.querySelector('[data-booking-review-comment]')?.value.trim())
            || (document.querySelector('[data-booking-review-rating]')?.value || '5') !== '5';
    }
    async function closeBookingReviewModal(force = false) {
        if (!bookingReviewModal || bookingReviewModal.hidden) return;
        if (!force && bookingReviewHasChanges()) {
            if (bookingReviewClosePending) return;
            bookingReviewClosePending = true;
            const accepted = await confirmSettingsChange('Discard your review draft?');
            bookingReviewClosePending = false;
            if (!accepted) return;
        }
        bookingReviewModal.hidden = true;
        activeReviewBookingId = null;
    }
    document.querySelectorAll('[data-booking-review-close]').forEach((button) => button.addEventListener('click', () => closeBookingReviewModal()));
    bookingReviewModal?.addEventListener('click', event => { if (event.target === bookingReviewModal) closeBookingReviewModal(); });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && bookingReviewModal && !bookingReviewModal.hidden && !event.defaultPrevented) { event.preventDefault(); closeBookingReviewModal(); }
    });
    document.querySelector('[data-booking-review-submit]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        if (!activeReviewBookingId || !window.sb || bookingReviewSubmitPending) return;
        const rating = Number(document.querySelector('[data-booking-review-rating]')?.value);
        const comment = document.querySelector('[data-booking-review-comment]')?.value?.trim() || null;
        if (!Number.isInteger(rating) || rating < 1 || rating > 5 || (comment && comment.length > 2000)) return;
        bookingReviewSubmitPending = true;
        if (!await confirmSettingsChange('Publish this booking review?')) { bookingReviewSubmitPending = false; return; }
        button.disabled = true;
        const { error } = await window.sb.from('booking_review').insert({ booking_id: Number(activeReviewBookingId), rating, comment });
        button.disabled = false;
        bookingReviewSubmitPending = false;
        if (error) {
            console.error('[dashboard] review submit failed', error);
            window.InigoToast?.show(error.code === '23505' ? 'A review has already been submitted for this booking.' : (error.message || 'Could not publish your review.'), true);
            return;
        }
        await closeBookingReviewModal(true);
        window.InigoToast?.show('Your review is published. Thank you!');
        refreshMyBookings();
    });

    // ------------------------------------------------------------------
    // Receipts list only saved payment acknowledgments. A booking summary
    // is not proof of payment, so unpaid bookings never create receipt rows.
    // ------------------------------------------------------------------
    const receiptsGrid = document.querySelector('[data-dash-receipts]');
    const receiptSearchInput = document.querySelector('[data-dash-receipt-search]');
    const receiptDateInput = document.querySelector('[data-dash-receipt-date]');
    const receiptSourceInput = document.querySelector('[data-dash-receipt-source]');
    const receiptDialog = document.querySelector('[data-dash-receipt-dialog]');
    const receiptDialogContent = document.querySelector('[data-dash-receipt-dialog-content]');
    const receiptDialogClose = document.querySelector('[data-dash-receipt-close]');
    const receiptDownloadButton = document.querySelector('.dash-receipt-dialog [data-dash-receipt-download]');
    const RECEIPT_LOADING_HTML = '<p class="dash-notif-empty">Loading payment acknowledgments from both sources…</p>';
    let receiptRenderGeneration = 0;
    let receiptAcknowledgments = [];
    let receiptLoadErrors = [];

    if (receiptsGrid) receiptsGrid.innerHTML = RECEIPT_LOADING_HTML;

    function renderPaymentAcknowledgment(entry) {
        const acknowledgment = entry.acknowledgment;
        const safeKey = window.escapeHtml(String(entry.cardKey || acknowledgment.receipt_id || acknowledgment.receipt_number || 'payment'));
        const sourceId = entry.sourceId || acknowledgment.source_id || acknowledgment.items?.[0]?.reservation_id || '';
        const hasWalkinOrderId = entry.source === 'walkin' && Boolean(entry.sourceId || acknowledgment.source_id);
        const sourceLabel = entry.source !== 'walkin' ? 'Booking ID' : hasWalkinOrderId ? 'Walk-in order ID' : 'Walk-in visit ID';
        return window.InigoPaymentAcknowledgment.render(acknowledgment, {
            sourceLabel, sourceId, itemReferenceLabel: entry.source === 'walkin' ? 'Visit ID' : '', transactionId: acknowledgment.transaction_id,
            cardAttributes: `data-dash-receipt-card="${safeKey}"`,
        });
    }

    function receiptDateLabel(value) {
        if (!value || Number.isNaN(new Date(value).getTime())) return '—';
        return new Intl.DateTimeFormat('en-PH', {
            timeZone: 'Asia/Manila', dateStyle: 'medium',
        }).format(new Date(value));
    }

    function renderReceiptTable(entries) {
        const rows = entries.map(entry => {
            const acknowledgment = entry.acknowledgment || {};
            const key = window.escapeHtml(String(entry.cardKey || ''));
            const amount = window.InigoPaymentAcknowledgment.money(acknowledgment.total, acknowledgment.gross_minor);
            const receiptNumber = acknowledgment.receipt_number || acknowledgment.receipt_id || '—';
            return `<tr>
                <td data-label="Payment date">${window.escapeHtml(receiptDateLabel(acknowledgment.issued_at))}</td>
                <td data-label="Receipt number" class="dash-receipt-reference">${window.escapeHtml(String(receiptNumber))}</td>
                <td data-label="Amount paid" class="dash-receipt-amount">${window.escapeHtml(amount)}</td>
                <td data-label="Action"><button type="button" class="dash-btn-ghost" data-dash-receipt-view="${key}">View receipt</button></td>
            </tr>`;
        }).join('');
        return `<div class="dash-receipt-table-wrap"><table class="dash-receipt-table">
            <thead><tr><th scope="col">Payment date</th><th scope="col">Receipt number</th><th scope="col">Amount paid</th><th scope="col">Action</th></tr></thead>
            <tbody>${rows}</tbody>
        </table></div>`;
    }

    let activeReceiptOpener = null;
    function openReceipt(entry, opener) {
        if (!receiptDialog || !receiptDialogContent || !entry) return;
        activeReceiptOpener = opener;
        receiptDownloadButton?.setAttribute('data-dash-receipt-download', String(entry.cardKey || entry.acknowledgment.receipt_id || entry.acknowledgment.receipt_number || 'payment'));
        receiptDialogContent.innerHTML = renderPaymentAcknowledgment(entry);
        wireReceiptDownloads();
        if (!receiptDialog.open) receiptDialog.showModal();
        receiptDialogClose?.focus();
    }

    receiptDialogClose?.addEventListener('click', () => receiptDialog?.close());
    receiptDialog?.addEventListener('close', () => {
        receiptDialogContent.innerHTML = '';
        if (activeReceiptOpener?.isConnected) activeReceiptOpener.focus();
        activeReceiptOpener = null;
    });

    // Promisifies HTMLCanvasElement.toBlob (callback-only in every browser)
    // so downloadReceiptAsPng() below can simply await it.
    function canvasToBlobAsync(canvas) {
        return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    }

    // Rasterizes `card` (a .dash-receipt-card) to a PNG and triggers a
    // download — canvas.toBlob() + a programmatic <a download> click, which
    // (unlike canvas.toDataURL() piped straight into an <a href>) works
    // reliably on iOS Safari and Android per §7's "works seamlessly across
    // all device types". Returns true/false so the caller can toast
    // accordingly without duplicating the try/catch.
    async function downloadReceiptAsPng(card, filenameId) {
        if (!window.html2canvas) {
            window.InigoToast?.show("Download isn't available right now — please refresh and try again.", true);
            return false;
        }

        // Hides the Download button itself for the duration of the capture
        // (see .dash-receipt-card.is-capturing in Style/Dashboard.css) so
        // the button doesn't bake itself into its own screenshot.
        card.closest('.payment-ack-layout')?.classList.add('is-capturing');
        try {
            const canvas = await window.html2canvas(card, {
                backgroundColor: null,
                scale: Math.min(window.devicePixelRatio || 1, 2) || 1,
                useCORS: true,
                // html2canvas clones the WHOLE document (not just `card`) to
                // resolve inherited styles correctly, so any <iframe> on the
                // page gets walked on every single receipt download even
                // though it never appears in the output — verified locally
                // this used to turn a ~70ms capture into 1300ms+ against a
                // former cross-origin Google Maps <iframe>. That iframe is
                // gone, so this guard is currently a no-op; kept
                // rather than removed since it's harmless and protects
                // against the same slow-capture class of bug if any future
                // dashboard content ever adds an <iframe> back.
                ignoreElements: (el) => el.tagName === 'IFRAME',
            });
            const blob = await canvasToBlobAsync(canvas);
            if (!blob) throw new Error('canvas.toBlob returned no data');

            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `inigosync-payment-acknowledgment-${filenameId}.png`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            // Revoked on a short delay rather than immediately — some
            // browsers cancel an in-flight download if its object URL is
            // revoked before the download has finished reading it.
            window.setTimeout(() => URL.revokeObjectURL(url), 4000);
            return true;
        } catch (err) {
            console.error('[dashboard] receipt PNG download failed', err);
            window.InigoToast?.show('Could not generate the receipt image. Please try again.', true);
            return false;
        } finally {
            card.closest('.payment-ack-layout')?.classList.remove('is-capturing');
        }
    }

    // Re-wired after every renderReceipts() render, same re-wire-after-
    // render idiom wireOverviewCourtList() above already uses for its own
    // dynamically rendered scope.
    function wireReceiptDownloads() {
        document.querySelectorAll('.dash-receipt-dialog [data-dash-receipt-download]').forEach((btn) => {
            if (btn.dataset.dashReceiptDownloadBound === 'true') return;
            btn.dataset.dashReceiptDownloadBound = 'true';
            btn.addEventListener('click', async () => {
                const card = receiptDialogContent?.querySelector('[data-dash-receipt-card]');
                if (!card) return;
                const originalLabel = btn.textContent;
                btn.disabled = true;
                btn.textContent = 'Preparing…';
                const ok = await downloadReceiptAsPng(card, btn.dataset.dashReceiptDownload || 'receipt');
                btn.disabled = false;
                btn.textContent = originalLabel;
                if (ok) window.InigoToast?.show('Payment acknowledgment downloaded.');
            });
        });
        document.querySelectorAll('.dash-receipt-dialog [data-dash-receipt-print]').forEach((btn) => {
            if (btn.dataset.dashReceiptPrintBound === 'true') return;
            btn.dataset.dashReceiptPrintBound = 'true';
            btn.addEventListener('click', () => window.InigoPaymentAcknowledgment.print(receiptDialogContent?.querySelector('[data-dash-receipt-card]')));
        });
    }

    // Reads immutable acknowledgment snapshots for paid bookings. The
    // multi-ack RPC preserves both deposit and balance receipts; older
    // deployments fall back to the legacy RPC, which returns the latest one.
    function isMissingAcknowledgmentHistoryRpc(error) {
        const code = String(error?.code || '');
        const message = String(error?.message || '').toLowerCase();
        return code === 'PGRST202' || code === '42883'
            || (message.includes('customer_get_booking_payment_acknowledgments')
                && (message.includes('not found') || message.includes('schema cache') || message.includes('does not exist')));
    }

    function normalizeSavedAcknowledgment(historyEntry) {
        const snapshot = historyEntry?.acknowledgment && typeof historyEntry.acknowledgment === 'object'
            ? historyEntry.acknowledgment : historyEntry;
        if (!snapshot || typeof snapshot !== 'object' || !snapshot.receipt_id) return null;
        return {
            ...snapshot,
            payment_id: Number(historyEntry?.payment_id || snapshot.payment_id || 0),
            receipt_id: snapshot.receipt_id || historyEntry.receipt_id,
            receipt_number: snapshot.receipt_number || historyEntry.receipt_number,
            issued_at: snapshot.issued_at || historyEntry.issued_at,
            payment_method: snapshot.payment_method || historyEntry.method,
            transaction_id: snapshot.transaction_id || historyEntry.payment_id,
        };
    }

    async function fetchBookingAcknowledgments(booking) {
        const bookingId = Number(booking.booking_id);
        const { data, error } = await window.sb.rpc('customer_get_booking_payment_acknowledgments', { p_booking_id: bookingId });
        if (error && !isMissingAcknowledgmentHistoryRpc(error)) throw error;
        if (!error) {
            const result = Array.isArray(data) ? data[0] : data;
            const history = Array.isArray(result?.payment_history) ? result.payment_history : [];
            return history.map(normalizeSavedAcknowledgment).filter(Boolean);
        }

        const legacy = await window.sb.rpc('get_payment_acknowledgment', { p_source: 'booking', p_id: bookingId });
        if (legacy.error) throw legacy.error;
        const result = Array.isArray(legacy.data) ? legacy.data[0] : legacy.data;
        const acknowledgment = normalizeSavedAcknowledgment(result);
        return acknowledgment ? [acknowledgment] : [];
    }

    function paymentDateKey(value) {
        if (window.InigoBusinessHours?.dateInManila) {
            try { return window.InigoBusinessHours.dateInManila(value); } catch { return ''; }
        }
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(date);
        const part = type => parts.find(item => item.type === type)?.value;
        return `${part('year')}-${part('month')}-${part('day')}`;
    }

    function renderFilteredAcknowledgments() {
        if (!receiptsGrid) return;
        const query = String(receiptSearchInput?.value || '').trim().toLowerCase();
        const paymentDate = String(receiptDateInput?.value || '');
        const source = String(receiptSourceInput?.value || 'all');
        const filtered = window.InigoCustomerReceipts.filterAcknowledgments(receiptAcknowledgments, {
            source, idQuery: query, paymentDate,
        }, paymentDateKey);
        const hasEntries = filtered.length > 0;
        const table = hasEntries ? renderReceiptTable(filtered) : '';
        const message = hasEntries
            ? ''
            : query || paymentDate || source !== 'all'
                ? '<p class="dash-notif-empty">No payment acknowledgments match those filters.</p>'
                : '<p class="dash-notif-empty">No payment acknowledgments yet.</p>';
        const errors = receiptLoadErrors.length
            ? `<p class="dash-receipt-load-warning" role="status">${window.escapeHtml(receiptLoadErrors.join(' '))}</p>`
            : '';
        receiptsGrid.innerHTML = `${errors}${table}${message}`;
        receiptsGrid.querySelectorAll('[data-dash-receipt-view]').forEach(button => {
            button.addEventListener('click', () => {
                const entry = receiptAcknowledgments.find(item => String(item.cardKey || '') === button.dataset.dashReceiptView);
                openReceipt(entry, button);
            });
        });
    }

    // The RPC caps each page at 50 rows. Fetch pages serially using its
    // account-scoped total count so ID/date filters cover the whole walk-in
    // history without firing an unbounded set of requests.
    async function fetchAllWalkinAcknowledgments() {
        const pageSize = 50;
        const maxRows = 50000;
        const rows = [];
        const seen = new Set();
        let totalCount = null;
        do {
            const { data, error } = await window.sb.rpc('customer_list_walkin_acknowledgments', {
                p_offset: rows.length,
                p_limit: pageSize,
            });
            if (error) throw error;
            const result = Array.isArray(data) ? data[0] : data;
            const pageRows = Array.isArray(result?.rows) ? result.rows : [];
            if (totalCount === null) totalCount = Math.max(0, Number(result?.total_count) || 0);
            else if (Math.max(0, Number(result?.total_count) || 0) !== totalCount) throw new Error('Walk-in acknowledgment count changed during paging.');
            if (totalCount > maxRows) throw new Error('Walk-in acknowledgment history exceeds the safe search limit.');
            if (!pageRows.length && rows.length < totalCount) throw new Error('Walk-in acknowledgment paging ended before all records were returned.');
            for (const row of pageRows) {
                const key = String(row.order_id || row.receipt_id || '');
                if (!key || seen.has(key)) throw new Error('Walk-in acknowledgment paging returned a duplicate or invalid record.');
                seen.add(key);
            }
            if (rows.length + pageRows.length > totalCount) throw new Error('Walk-in acknowledgment count changed during paging.');
            rows.push(...pageRows);
        } while (rows.length < totalCount);
        return rows;
    }

    // Called with the booking rows already fetched for the customer's
    // dashboard. Only recorded payment rows are queried, then all returned
    // acknowledgment snapshots are combined with every paid walk-in page.
    async function renderReceipts(bookings, bookingsUnavailable = false) {
        if (!receiptsGrid || !window.sb || !window.inigosyncProfile) return;
        const generation = ++receiptRenderGeneration;
        const loadedAcknowledgments = [];
        const loadErrors = [];
        if (bookingsUnavailable) loadErrors.push('Online booking payment acknowledgments could not be loaded.');
        receiptsGrid.innerHTML = RECEIPT_LOADING_HTML;
        if (receiptSearchInput) receiptSearchInput.disabled = true;
        if (receiptDateInput) receiptDateInput.disabled = true;
        if (receiptSourceInput) receiptSourceInput.disabled = true;

        const paidBookings = (bookings || []).filter(booking => Number(booking.amount_paid || 0) > 0
            || booking.payment_id || booking.balance_payment_id);
        for (let offset = 0; offset < paidBookings.length; offset += 5) {
            const batch = paidBookings.slice(offset, offset + 5);
            const results = await Promise.all(batch.map(async booking => {
                try {
                    const saved = await fetchBookingAcknowledgments(booking);
                    return { booking, saved, error: null };
                } catch (error) {
                    console.error('[dashboard] saved booking acknowledgment could not be loaded', error);
                    return { booking, saved: [], error };
                }
            }));
            results.forEach(({ booking, saved, error }) => {
                const bookingId = String(booking.booking_id);
                if (error) loadErrors.push(`Booking #${bookingId} payment acknowledgments could not be loaded.`);
                saved.forEach(acknowledgment => loadedAcknowledgments.push({
                    source: 'booking',
                    sourceId: bookingId,
                    acknowledgment,
                    searchIds: [acknowledgment.receipt_number, acknowledgment.receipt_id].filter(Boolean),
                    referenceLabel: `Booking #${bookingId}`,
                    cardKey: `booking-${bookingId}-${acknowledgment.receipt_id}`,
                }));
            });
        }

        try {
            const walkinRows = await fetchAllWalkinAcknowledgments();
            walkinRows.forEach(row => {
                const snapshot = row.payload && typeof row.payload === 'object' ? row.payload : {};
                const acknowledgment = {
                    ...snapshot,
                    receipt_id: row.receipt_id || snapshot.receipt_id,
                    receipt_number: row.receipt_number || snapshot.receipt_number,
                    issued_at: row.issued_at || snapshot.issued_at,
                    transaction_id: snapshot.transaction_id || row.payment_id,
                };
                const orderId = String(row.order_id || '');
                loadedAcknowledgments.push({
                    source: 'walkin',
                    sourceId: orderId,
                    acknowledgment,
                    searchIds: [acknowledgment.receipt_number, acknowledgment.receipt_id].filter(Boolean),
                    referenceLabel: `Walk-in order #${orderId || acknowledgment.receipt_id}`,
                    cardKey: `walkin-${orderId || acknowledgment.receipt_id}`,
                });
            });
        } catch (error) {
            console.error('[dashboard] linked walk-in acknowledgments could not be loaded', error);
            loadErrors.push('Walk-in payment acknowledgments could not be loaded; displayed results include online booking payments only. Refresh and try again.');
        }

        if (generation !== receiptRenderGeneration) return;
        receiptAcknowledgments = loadedAcknowledgments;
        receiptLoadErrors = loadErrors;
        receiptAcknowledgments.sort((left, right) => new Date(right.acknowledgment.issued_at || 0) - new Date(left.acknowledgment.issued_at || 0));
        if (receiptSearchInput) receiptSearchInput.disabled = false;
        if (receiptDateInput) receiptDateInput.disabled = false;
        if (receiptSourceInput) receiptSourceInput.disabled = false;
        renderFilteredAcknowledgments();
    }

    receiptSearchInput?.addEventListener('input', renderFilteredAcknowledgments);
    receiptDateInput?.addEventListener('change', renderFilteredAcknowledgments);
    receiptSourceInput?.addEventListener('change', renderFilteredAcknowledgments);

    // ------------------------------------------------------------------
    // Profile + Settings — prefill the signed-in profile and wire the
    // account-setting editors, validated mobile flow, and password wizard.
    // ------------------------------------------------------------------

    // Shared by the Mobile number field's load-time display (below) and its
    // [data-digits-only] input/paste wiring further down (increment 13) — a
    // function declaration (hoisted), not a const arrow, so it is safe to
    // reference from renderProfile() regardless of source order; this file
    // otherwise declares everything inline at the point of use (no top-level
    // `let` a later call could run into before its declaration executes, the
    // way includes/auth.js once did), and a hoisted function keeps that same
    // guarantee for this one shared helper.
    function digitsOnly(raw) {
        return String(raw || '').replace(/[^0-9]/g, '');
    }

    // Same hoisted-function-declaration reasoning as digitsOnly above —
    // safe to call from renderProfile() regardless of source order.
    // "July 2026" (the old hardcoded value) is coincidentally this
    // function's exact output format, so a real date renders identically
    // to how the placeholder used to look.
    function formatMemberSince(iso) {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }

    // ------------------------------------------------------------------
    // Account Settings — name parts (§9, D3). profiles.first_name/
    // middle_name/last_name (database/schema/008_profile_name_parts.sql)
    // are additive columns alongside full_name, which stays the
    // compatibility field the owner/staff dashboards still read/write
    // (includes/owner_dashboard.js, includes/staff_dashboard.js) — so every
    // save here writes BOTH, and every load prefers the three columns but
    // falls back to parsing full_name when they're absent/undefined (before
    // the migration runs, or for any row that predates it).
    // ------------------------------------------------------------------

    // Inverse of composeFullName() below — first token -> first name, last
    // token -> surname, remaining tokens -> middle name. Matches the exact
    // rule implementation_plan.md's D3 specifies, so a full_name this form
    // itself composed always round-trips back to the same three boxes.
    function parseFullName(fullName) {
        const tokens = String(fullName || '').trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0) return { first: '', middle: '', last: '' };
        if (tokens.length === 1) return { first: tokens[0], middle: '', last: '' };
        return {
            first: tokens[0],
            middle: tokens.slice(1, -1).join(' '),
            last: tokens[tokens.length - 1],
        };
    }

    function getManilaToday() {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(new Date());
        const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
        return `${values.year}-${values.month}-${values.day}`;
    }

    function ageFromBirthdate(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
        const [year, month, day] = value.split('-').map(Number);
        const today = getManilaToday().split('-').map(Number);
        let age = today[0] - year;
        if (today[1] < month || (today[1] === month && today[2] < day)) age -= 1;
        return age >= 0 && age <= 125 ? age : null;
    }

    function updateBirthdateAge(value) {
        if (!birthdateAge) return;
        const age = ageFromBirthdate(value);
        birthdateAge.textContent = !value ? 'Age will be calculated from your birthdate.'
            : age === null ? 'Enter a valid birthdate that is not in the future.'
                : `Age: ${age}`;
        birthdateAge.classList.toggle('is-error', Boolean(value) && age === null);
    }

    function formatAccountBirthday(value) {
        if (!value || ageFromBirthdate(value) === null) return '—';
        const date = new Date(`${value}T00:00:00Z`);
        return date.toLocaleDateString('en-PH', { dateStyle: 'medium', timeZone: 'Asia/Manila' });
    }

    function formatAccountBirthdate(value) {
        const birthday = formatAccountBirthday(value);
        const age = ageFromBirthdate(value);
        return birthday === '—' || age === null ? '—' : `${birthday} · ${age}`;
    }

    function composeFullName(parts) {
        return [parts.first, parts.middle, parts.last].map(value => String(value || '').trim()).filter(Boolean).join(' ');
    }

    // Compose the editable name fields back into the compatibility value
    // used by the owner and staff dashboards.

    function fillNameInputs(parts) {
        const settingsPanel = document.querySelector('[data-dash-panel="settings"]');
        if (!settingsPanel) return;
        const firstInput = settingsPanel.querySelector('[data-dash-settings-firstname]');
        const middleInput = settingsPanel.querySelector('[data-dash-settings-middlename]');
        const lastInput = settingsPanel.querySelector('[data-dash-settings-lastname]');
        if (firstInput) firstInput.value = parts.first || '';
        if (middleInput) middleInput.value = parts.middle || '';
        if (lastInput) lastInput.value = parts.last || '';
    }

    // Loads first_name/middle_name/last_name in a request of their own —
    // deliberately NOT added to includes/authGuard.js's shared `profiles`
    // select, which every dashboard (customer/staff/admin) reuses as its own
    // login gate: asking THAT query for columns that don't exist yet would
    // fail the whole select with Postgres 42703 and sign every user out
    // until database/schema/008_profile_name_parts.sql is applied. Scoping
    // the request to just this panel means a schema mismatch only ever
    // affects these three boxes, same isDashboardSchemaMismatch() classifier
    // this file already uses for the Overview peek widget and feedback
    // submit — defined further below, but a hoisted function declaration
    // like every other helper on this page, so it's safe to call here.
    async function fetchProfileNameParts(profileId) {
        if (!window.sb || !profileId) return null;
        const { data, error } = await window.sb
            .from('profiles')
            .select('first_name, middle_name, last_name')
            .eq('id', profileId)
            .maybeSingle();
        if (error) {
            if (!isDashboardSchemaMismatch(error)) {
                console.error('[dashboard] failed to load profile name parts', error);
            }
            return null;
        }
        return data;
    }

    async function fetchCustomerAccountFields(profileId) {
        if (!window.sb || !profileId) return null;
        const { data, error } = await window.sb.from('customer_private_details')
            .select('birthdate, gender, civil_status, emergency_contact_name, emergency_contact_number')
            .eq('user_id', profileId).maybeSingle();
        if (error) {
            if (!isDashboardSchemaMismatch(error)) console.error('[dashboard] failed to load account details', error);
            return null;
        }
        return data;
    }

    // Fills the three boxes from full_name immediately (so they're never
    // blank while the request below is in flight), then upgrades to the
    // real columns if/when that resolves with real values — the same
    // "show something honest now, refine when the real data arrives"
    // pattern as this function's own "Member since" above. If the columns
    // don't exist yet, or exist but are still NULL (nobody has saved
    // through this form yet), the full_name-derived fill is simply left in
    // place.
    function populateSettingsNameFields(profile) {
        fillNameInputs(parseFullName(profile.full_name));

        fetchProfileNameParts(profile.id).then((parts) => {
            const hasColumnData = parts && (String(parts.first_name || '').trim() || String(parts.last_name || '').trim());
            if (!hasColumnData) return;
            fillNameInputs({
                first: parts.first_name || '',
                middle: parts.middle_name || '',
                last: parts.last_name || '',
            });
        });
    }

    const personalEditBtn = document.querySelector('[data-dash-personal-edit]');
    const personalModal = document.querySelector('[data-dash-personal-modal]');
    const personalDialog = personalModal?.querySelector('[data-dash-personal-dialog]');
    const personalSaveBtn = document.querySelector('[data-dash-personal-save]');
    const settingsFirst = document.querySelector('[data-dash-settings-firstname]');
    const settingsMiddle = document.querySelector('[data-dash-settings-middlename]');
    const settingsLast = document.querySelector('[data-dash-settings-lastname]');
    const settingsEmail = document.querySelector('[data-dash-settings-email]');
    const settingsBirthdate = document.querySelector('[data-dash-settings-birthdate]');
    const settingsGender = document.querySelector('[data-dash-settings-gender]');
    const settingsCivilStatus = document.querySelector('[data-dash-settings-civil-status]');
    const settingsEmergencyName = document.querySelector('[data-dash-settings-emergency-name]');
    const birthdateAge = document.querySelector('[data-dash-birthdate-age]');
    const emailEditBtn = document.querySelector('[data-dash-email-edit]');
    const emailProposalModal = document.querySelector('[data-dash-email-proposal-modal]');
    const emailProposalDialog = emailProposalModal?.querySelector('[data-dash-email-proposal-dialog]');
    const emailProposalInput = document.querySelector('[data-dash-email-proposal-input]');
    const emailProposalStatus = document.querySelector('[data-dash-email-proposal-status]');
    const emailProposalSaveBtn = document.querySelector('[data-dash-email-proposal-save]');
    const emailStagedStatus = document.querySelector('[data-dash-email-staged-status]');
    const emailOtpModal = document.querySelector('[data-dash-email-otp-modal]');
    const emailOtpDialog = emailOtpModal?.querySelector('[data-dash-email-otp-dialog]');
    const emailOtpTitle = document.querySelector('[data-dash-email-otp-title]');
    const emailOtpHint = document.querySelector('[data-dash-email-otp-hint]');
    const emailOtpBoxes = Array.from(document.querySelectorAll('[data-dash-email-otp-box]'));
    const emailOtpStatus = document.querySelector('[data-dash-email-otp-status]');
    const emailOtpVerifyBtn = document.querySelector('[data-dash-email-otp-verify]');
    const emailOtpResendBtn = document.querySelector('[data-dash-email-otp-resend]');
    const emailOtpTimer = document.querySelector('[data-dash-email-otp-timer]');
    let stagedEmailChange = '';
    let pendingOtpCurrentEmail = '';
    let pendingOtpEmail = '';
    let emailOtpStep = 'current';
    let emailAvailabilityRevision = 0;
    let emailAvailabilityTimer = null;
    let emailAvailabilityCache = null;
    let emailAvailabilityController = null;
    let emailOtpTimerId = null;
    let emailOtpOperationGeneration = 0;
    let savedName = null;
    let personalReturnFocus = null;

    function getEmailOtpCode() {
        return emailOtpBoxes.map(box => box.value).join('');
    }

    function clearEmailOtpCode() {
        emailOtpBoxes.forEach(box => {
            box.value = '';
            box.classList.remove('is-filled');
        });
    }

    function startEmailOtpResendCountdown(seconds = 30) {
        if (emailOtpTimerId) window.clearInterval(emailOtpTimerId);
        let remaining = seconds;
        if (emailOtpResendBtn) emailOtpResendBtn.disabled = true;
        const tick = () => {
            if (emailOtpTimer) emailOtpTimer.textContent = `Resend available in ${remaining}s`;
            if (remaining <= 0) {
                window.clearInterval(emailOtpTimerId);
                emailOtpTimerId = null;
                if (emailOtpTimer) emailOtpTimer.textContent = '';
                if (emailOtpResendBtn) emailOtpResendBtn.disabled = false;
                return;
            }
            remaining -= 1;
        };
        tick();
        emailOtpTimerId = window.setInterval(tick, 1000);
    }

    function setEmailOtpStep(step) {
        emailOtpStep = step;
        const currentStep = step === 'current';
        if (emailOtpTitle) emailOtpTitle.textContent = currentStep ? 'Verify your current email' : 'Verify your new email';
        if (emailOtpHint) {
            const address = currentStep ? pendingOtpCurrentEmail : pendingOtpEmail;
            emailOtpHint.textContent = `Enter the code sent to ${address} to approve the email change to ${pendingOtpEmail}. Your saved email remains ${window.inigosyncProfile?.email || 'unchanged'} until both codes are confirmed.`;
        }
        if (emailOtpVerifyBtn) emailOtpVerifyBtn.textContent = currentStep ? 'Verify current code' : 'Verify new code';
    }

    function openEmailOtpModal() {
        setEmailOtpStep(emailOtpStep);
        if (emailOtpStatus) {
            emailOtpStatus.textContent = '';
            emailOtpStatus.classList.remove('is-error');
        }
        emailOtpModal.hidden = false;
        personalModal.hidden = true;
        emailOtpDialog?.focus();
        clearEmailOtpCode();
        startEmailOtpResendCountdown();
        emailOtpBoxes[0]?.focus();
        if (emailStagedStatus) emailStagedStatus.textContent = `Verification codes were sent to ${pendingOtpCurrentEmail} and ${pendingOtpEmail}; saved email remains ${window.inigosyncProfile?.email || 'unchanged'}.`;
    }

    emailOtpBoxes.forEach((box, index) => {
        box.addEventListener('input', () => {
            const digits = box.value.replace(/[^0-9]/g, '');
            if (digits.length > 1) {
                clearEmailOtpCode();
                digits.slice(0, emailOtpBoxes.length).split('').forEach((digit, digitIndex) => {
                    emailOtpBoxes[digitIndex].value = digit;
                    emailOtpBoxes[digitIndex].classList.add('is-filled');
                });
                if (emailOtpStatus) {
                    emailOtpStatus.textContent = '';
                    emailOtpStatus.classList.remove('is-error');
                }
                emailOtpBoxes[Math.min(digits.length, emailOtpBoxes.length - 1)]?.focus();
                return;
            }
            box.value = digits.slice(0, 1);
            box.classList.toggle('is-filled', box.value.length === 1);
            if (emailOtpStatus) {
                emailOtpStatus.textContent = '';
                emailOtpStatus.classList.remove('is-error');
            }
            if (box.value && emailOtpBoxes[index + 1]) emailOtpBoxes[index + 1].focus();
        });
        box.addEventListener('keydown', event => {
            if (event.key === 'Backspace' && !box.value && emailOtpBoxes[index - 1]) emailOtpBoxes[index - 1].focus();
        });
        box.addEventListener('paste', event => {
            const pasted = (event.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '');
            if (!pasted) return;
            event.preventDefault();
            pasted.split('').slice(0, emailOtpBoxes.length).forEach((digit, digitIndex) => {
                emailOtpBoxes[digitIndex].value = digit;
                emailOtpBoxes[digitIndex].classList.add('is-filled');
            });
            if (emailOtpStatus) {
                emailOtpStatus.textContent = '';
                emailOtpStatus.classList.remove('is-error');
            }
            emailOtpBoxes[Math.min(pasted.length, emailOtpBoxes.length - 1)]?.focus();
        });
    });

    function setPersonalEditing(editing) {
        if (editing) {
            personalReturnFocus = document.activeElement;
            const profile = window.inigosyncProfile || {};
            fillNameInputs(parseFullName(profile.full_name));
            if (settingsEmail) settingsEmail.value = profile.email || '';
            if (settingsBirthdate) settingsBirthdate.value = profile.birthdate || '';
            if (settingsGender) setGenderSelection(profile.gender || '');
            if (settingsCivilStatus) settingsCivilStatus.value = profile.civil_status || '';
            if (settingsEmergencyName) settingsEmergencyName.value = profile.emergency_contact_name || '';
            updateBirthdateAge(settingsBirthdate?.value || '');
            savedName = [settingsFirst?.value || '', settingsMiddle?.value || '', settingsLast?.value || ''];
            personalEditBaseline = {
                full_name: profile.full_name || '', birthdate: profile.birthdate || null,
                gender: profile.gender || null, civil_status: profile.civil_status || null,
                emergency_contact_name: profile.emergency_contact_name || null,
                contact_num: profile.contact_num || '', emergency_contact_number: profile.emergency_contact_number || '',
                email: profile.email || '',
            };
            if (settingsEmail) settingsEmail.dataset.savedEmail = settingsEmail.value;
            if (personalModal) personalModal.hidden = false;
            personalDialog?.focus();
        }
    }

    let personalEditBaseline = null;
    function capturePersonalEditBaseline(profile = window.inigosyncProfile || {}) {
        personalEditBaseline = {
            full_name: profile.full_name || '', birthdate: profile.birthdate || null,
            gender: profile.gender || null, civil_status: profile.civil_status || null,
            emergency_contact_name: profile.emergency_contact_name || null,
            contact_num: profile.contact_num || '', emergency_contact_number: profile.emergency_contact_number || '',
            email: profile.email || '',
        };
    }
    function personalDraftHasChanges() {
        const profile = window.inigosyncProfile || {};
        const baseline = personalEditBaseline || profile;
        const first = settingsFirst?.value.trim() || '';
        const middle = settingsMiddle?.value.trim() || '';
        const last = settingsLast?.value.trim() || '';
        return composeFullName({ first, middle, last }) !== (baseline.full_name || '')
            || (settingsBirthdate?.value || null) !== (baseline.birthdate || null)
            || (settingsGender?.value || null) !== (baseline.gender || null)
            || (settingsCivilStatus?.value || null) !== (baseline.civil_status || null)
            || (settingsEmergencyName?.value.trim() || null) !== (baseline.emergency_contact_name || null)
            || (mobileInput?.value.trim() || '') !== (baseline.contact_num || '')
            || (emergencyMobileInput?.value.trim() || '') !== (baseline.emergency_contact_number || '')
            || (stagedEmailChange || '').toLowerCase() !== String(baseline.email || '').toLowerCase();
    }

    let personalClosePending = false;
    async function cancelPersonalEditing() {
        if (personalClosePending) return;
        if (personalDraftHasChanges()) {
            personalClosePending = true;
            const accepted = await confirmSettingsChange('Discard your unsaved personal information changes?');
            personalClosePending = false;
            if (!accepted) return;
        }
        const profile = window.inigosyncProfile || {};
        fillNameInputs(parseFullName(profile.full_name));
        if (settingsBirthdate) { settingsBirthdate.value = profile.birthdate || ''; delete settingsBirthdate.dataset.dirty; }
        if (settingsGender) { setGenderSelection(profile.gender || ''); delete settingsGender.dataset.dirty; }
        if (settingsCivilStatus) { settingsCivilStatus.value = profile.civil_status || ''; delete settingsCivilStatus.dataset.dirty; }
        if (settingsEmergencyName) { settingsEmergencyName.value = profile.emergency_contact_name || ''; delete settingsEmergencyName.dataset.dirty; }
        if (mobileInput) { mobileInput.value = profile.contact_num || ''; delete mobileInput.dataset.dirty; }
        if (emergencyMobileInput) { emergencyMobileInput.value = profile.emergency_contact_number || ''; delete emergencyMobileInput.dataset.dirty; }
        updateBirthdateAge(profile.birthdate || '');
        if (personalModal) personalModal.hidden = true;
        if (!pendingOtpEmail) stagedEmailChange = '';
        personalEditBaseline = null;
        personalReturnFocus?.focus?.();
        personalReturnFocus = null;
    }

    personalEditBtn?.addEventListener('click', () => setPersonalEditing(true));
    personalModal?.querySelectorAll('[data-dash-personal-close]').forEach(button => button.addEventListener('click', cancelPersonalEditing));
    personalModal?.addEventListener('click', event => {
        if (event.target === personalModal) cancelPersonalEditing();
    });
    personalModal?.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelPersonalEditing(); }
        if (event.key === 'Tab' && personalDialog) {
            const controls = Array.from(personalDialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)'));
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    });
    if (settingsBirthdate) {
        settingsBirthdate.max = getManilaToday();
        settingsBirthdate.addEventListener('input', () => {
            settingsBirthdate.dataset.dirty = 'true';
            updateBirthdateAge(settingsBirthdate.value);
        });
    }
    [settingsGender, settingsCivilStatus].filter(Boolean).forEach(input => input.addEventListener('change', () => { input.dataset.dirty = 'true'; }));
    [settingsEmergencyName].filter(Boolean).forEach(input => input.addEventListener('input', () => { input.dataset.dirty = 'true'; }));

    function setEmailProposalStatus(message, isError = false) {
        if (!emailProposalStatus) return;
        emailProposalStatus.textContent = message;
        emailProposalStatus.classList.toggle('is-error', isError);
    }

    async function checkProposedEmail(email, force = false) {
        const normalized = String(email || '').trim().toLowerCase();
        const revision = emailAvailabilityRevision;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
            setEmailProposalStatus('Enter a valid email address.', true);
            return false;
        }
        if (normalized === String(window.inigosyncProfile?.email || '').toLowerCase()) {
            setEmailProposalStatus('Choose an email different from your current address.', true);
            return false;
        }
        if (!force && emailAvailabilityCache?.email === normalized && emailAvailabilityCache.expires > Date.now()) {
            setEmailProposalStatus(emailAvailabilityCache.available ? 'Available' : 'Not available', !emailAvailabilityCache.available);
            if (emailProposalSaveBtn) emailProposalSaveBtn.disabled = !emailAvailabilityCache.available;
            return emailAvailabilityCache.available;
        }
        setEmailProposalStatus('Checking availability…');
        if (emailProposalSaveBtn) emailProposalSaveBtn.disabled = true;
        emailAvailabilityController?.abort();
        const controller = new AbortController();
        emailAvailabilityController = controller;
        try {
            const query = window.sb.rpc('signup_email_availability', { email_address: normalized });
            const { data, error } = typeof query.abortSignal === 'function'
                ? await query.abortSignal(controller.signal)
                : await query;
            if (revision !== emailAvailabilityRevision || emailProposalInput?.value.trim().toLowerCase() !== normalized) return false;
            if (error) throw error;
            const messages = { available: 'Available', taken: 'Not available', invalid: 'Enter a valid email address.', rate_limited: 'Too many checks. Wait one minute and try again.' };
            if (!messages[data]) throw new Error('Could not check email availability. Try again.');
            const available = data === 'available';
            emailAvailabilityCache = { email: normalized, available, expires: Date.now() + (available || data === 'taken' ? 30000 : 0) };
            setEmailProposalStatus(messages[data], !available);
            if (emailProposalSaveBtn) emailProposalSaveBtn.disabled = !available;
            return available;
        } catch (error) {
            if (!controller.signal.aborted && revision === emailAvailabilityRevision) setEmailProposalStatus(error.message || 'Could not check email availability. Try again.', true);
            return false;
        } finally {
            if (emailAvailabilityController === controller) emailAvailabilityController = null;
        }
    }

    let emailProposalBaseline = '';
    let emailProposalClosePending = false;
    async function closeEmailProposalModal(force = false) {
        if (!emailProposalModal || emailProposalModal.hidden) return;
        const hasChanges = (emailProposalInput?.value.trim().toLowerCase() || '') !== emailProposalBaseline;
        if (!force && hasChanges) {
            if (emailProposalClosePending) return;
            emailProposalClosePending = true;
            const accepted = await confirmSettingsChange('Discard this email change draft?');
            emailProposalClosePending = false;
            if (!accepted) return;
        }
        emailAvailabilityRevision += 1;
        emailAvailabilityController?.abort();
        clearTimeout(emailAvailabilityTimer);
        emailProposalModal.hidden = true;
        emailEditBtn?.focus();
    }
    emailEditBtn?.addEventListener('click', () => {
        emailAvailabilityRevision += 1;
        emailAvailabilityController?.abort();
        if (emailProposalInput) emailProposalInput.value = stagedEmailChange || '';
        emailProposalBaseline = emailProposalInput?.value.trim().toLowerCase() || '';
        setEmailProposalStatus(stagedEmailChange ? 'Check this address again before staging.' : '');
        if (emailProposalSaveBtn) emailProposalSaveBtn.disabled = true;
        emailProposalModal.hidden = false;
        emailProposalDialog?.focus();
        emailProposalInput?.focus();
    });
    emailProposalInput?.addEventListener('input', () => {
        emailAvailabilityRevision += 1;
        emailAvailabilityController?.abort();
        clearTimeout(emailAvailabilityTimer);
        emailAvailabilityCache = null;
        if (emailProposalSaveBtn) emailProposalSaveBtn.disabled = true;
        const value = emailProposalInput.value.trim().toLowerCase();
        setEmailProposalStatus(value ? 'Checking availability…' : '');
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            const revision = emailAvailabilityRevision;
            emailAvailabilityTimer = setTimeout(() => {
                if (revision === emailAvailabilityRevision) checkProposedEmail(value, true);
            }, 600);
        }
    });
    emailProposalModal?.querySelectorAll('[data-dash-email-proposal-close]').forEach(button => button.addEventListener('click', () => closeEmailProposalModal()));
    emailProposalModal?.addEventListener('click', event => { if (event.target === emailProposalModal) closeEmailProposalModal(); });
    emailProposalModal?.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeEmailProposalModal();
        } else if (event.key === 'Tab' && emailProposalDialog) {
            const controls = Array.from(emailProposalDialog.querySelectorAll('button:not(:disabled), input:not(:disabled)'));
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    });
    emailProposalSaveBtn?.addEventListener('click', async () => {
        emailAvailabilityRevision += 1;
        const email = emailProposalInput?.value.trim().toLowerCase() || '';
        if (!await checkProposedEmail(email)) return;
        stagedEmailChange = email;
        emailProposalBaseline = email;
        if (emailStagedStatus) {
            emailStagedStatus.textContent = `New email staged: ${email}. It is not saved until you confirm Save Changes and verify the code.`;
            emailStagedStatus.hidden = false;
        }
        emailProposalModal.hidden = true;
        personalModal.hidden = false;
        personalDialog?.focus();
        personalSaveBtn?.focus();
    });

    emailOtpModal?.querySelectorAll('[data-dash-email-otp-close]').forEach(button => button.addEventListener('click', () => {
        emailOtpModal.hidden = true;
        if (pendingOtpEmail && emailStagedStatus) emailStagedStatus.textContent = `Verification codes were sent to ${pendingOtpCurrentEmail} and ${pendingOtpEmail}. Your saved email is still ${window.inigosyncProfile?.email || 'unchanged'} until both are confirmed.`;
        personalModal.hidden = false;
        personalDialog?.focus();
    }));
    emailOtpModal?.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            emailOtpModal.hidden = true;
            if (pendingOtpEmail && emailStagedStatus) emailStagedStatus.textContent = `Verification codes were sent to ${pendingOtpCurrentEmail} and ${pendingOtpEmail}. Your saved email is still ${window.inigosyncProfile?.email || 'unchanged'} until both are confirmed.`;
            personalModal.hidden = false;
            personalDialog?.focus();
        } else if (event.key === 'Tab' && emailOtpDialog) {
            const controls = Array.from(emailOtpDialog.querySelectorAll('button:not(:disabled), input:not(:disabled)'));
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    });
    emailOtpVerifyBtn?.addEventListener('click', async () => {
        const code = getEmailOtpCode();
        if (!pendingOtpEmail || code.length !== emailOtpBoxes.length) {
            if (emailOtpStatus) emailOtpStatus.textContent = `Enter the 6-digit code sent to your ${emailOtpStep} email.`;
            emailOtpBoxes.find(box => !box.value)?.focus();
            return;
        }
        const confirmMessage = emailOtpStep === 'current'
            ? 'Are you sure you want to verify this current email code?'
            : 'Are you sure you want to verify and confirm this email change?';
        if (!await confirmSettingsChange(confirmMessage)) return;
        const operationGeneration = ++emailOtpOperationGeneration;
        emailOtpVerifyBtn.disabled = true;
        if (emailOtpResendBtn) emailOtpResendBtn.disabled = true;
        try {
            const stepEmail = emailOtpStep === 'current' ? pendingOtpCurrentEmail : pendingOtpEmail;
            const { error } = await window.sb.auth.verifyOtp({ email: stepEmail, token: code, type: 'email_change' });
            if (operationGeneration !== emailOtpOperationGeneration) return;
            if (error) throw error;
            if (emailOtpStep === 'current') {
                setEmailOtpStep('new');
                clearEmailOtpCode();
                if (emailOtpStatus) emailOtpStatus.textContent = `Current email confirmed. Now enter the code sent to ${pendingOtpEmail}.`;
                startEmailOtpResendCountdown();
                emailOtpBoxes[0]?.focus();
                return;
            }
            const { data: userData, error: userError } = await window.sb.auth.getUser();
            if (operationGeneration !== emailOtpOperationGeneration) return;
            if (userError) throw userError;
            const confirmedEmail = userData?.user?.email || '';
            if (!confirmedEmail || confirmedEmail.toLowerCase() !== pendingOtpEmail.toLowerCase()) {
                throw new Error('Supabase has not confirmed the requested new email yet. Your current email remains saved.');
            }
            window.inigosyncProfile.email = confirmedEmail;
            renderProfile(window.inigosyncProfile);
            stagedEmailChange = '';
            pendingOtpCurrentEmail = '';
            pendingOtpEmail = '';
            emailOtpStep = 'current';
            if (emailStagedStatus) emailStagedStatus.textContent = '';
            clearEmailOtpCode();
            if (emailOtpTimerId) window.clearInterval(emailOtpTimerId);
            emailOtpTimerId = null;
            emailOtpModal.hidden = true;
            personalModal.hidden = false;
            personalDialog?.focus();
            window.InigoToast?.show('Email address updated.');
        } catch (error) {
            if (operationGeneration === emailOtpOperationGeneration && emailOtpStatus) {
                emailOtpStatus.textContent = error.message || 'That code could not be verified. Check it and try again.';
                emailOtpStatus.classList.add('is-error');
            }
        } finally {
            if (operationGeneration === emailOtpOperationGeneration) emailOtpVerifyBtn.disabled = false;
        }
    });

    emailOtpResendBtn?.addEventListener('click', async () => {
        if (emailOtpResendBtn.disabled || !pendingOtpEmail || !window.sb?.auth?.resend) return;
        const operationGeneration = ++emailOtpOperationGeneration;
        emailOtpResendBtn.disabled = true;
        if (emailOtpVerifyBtn) emailOtpVerifyBtn.disabled = true;
        if (emailOtpStatus) {
            emailOtpStatus.textContent = 'Sending new verification codes…';
            emailOtpStatus.classList.remove('is-error');
        }
        try {
            const { error } = await window.sb.auth.resend({ type: 'email_change', email: pendingOtpEmail });
            if (operationGeneration !== emailOtpOperationGeneration) return;
            if (error) throw error;
            // Supabase resends both recipient-specific codes and resets both
            // confirmation arms, so require the current address again first.
            setEmailOtpStep('current');
            clearEmailOtpCode();
            if (emailOtpStatus) emailOtpStatus.textContent = 'New verification codes were sent to both addresses. Start again with the current email code.';
            startEmailOtpResendCountdown();
            emailOtpBoxes[0]?.focus();
        } catch (error) {
            if (operationGeneration === emailOtpOperationGeneration && emailOtpStatus) {
                emailOtpStatus.textContent = error.message || 'Could not resend the code. Please try again.';
                emailOtpStatus.classList.add('is-error');
            }
            if (operationGeneration === emailOtpOperationGeneration) emailOtpResendBtn.disabled = false;
        } finally {
            if (operationGeneration === emailOtpOperationGeneration && emailOtpVerifyBtn) emailOtpVerifyBtn.disabled = false;
        }
    });
    personalSaveBtn?.addEventListener('click', async () => {
        const profile = window.inigosyncProfile;
        const first = settingsFirst?.value.trim() || '';
        const middle = settingsMiddle?.value.trim() || '';
        const last = settingsLast?.value.trim() || '';
        if (!profile?.id || !first || !last) {
            window.InigoToast?.show('Enter your first name and surname.', true);
            (!first ? settingsFirst : settingsLast)?.focus();
            return;
        }
        const fullName = composeFullName({ first, middle, last });
        const birthdate = settingsBirthdate?.value || null;
        const gender = settingsGender?.value || null;
        if (birthdate && birthdate > getManilaToday()) {
            window.InigoToast?.show('Birthdate cannot be in the future.', true);
            settingsBirthdate.focus();
            return;
        }
        const civilStatus = settingsCivilStatus?.value || null;
        const emergencyName = settingsEmergencyName?.value.trim() || null;
        const profileChanges = { full_name: fullName, first_name: first, middle_name: middle, last_name: last };
        const privateChanges = { birthdate, gender, civil_status: civilStatus, emergency_contact_name: emergencyName };
        const changed = fullName !== profile.full_name
            || (birthdate || null) !== (profile.birthdate || null)
            || (gender || null) !== (profile.gender || null)
            || (civilStatus || null) !== (profile.civil_status || null)
            || (emergencyName || null) !== (profile.emergency_contact_name || null);
        const emailChanged = Boolean(stagedEmailChange) && stagedEmailChange.toLowerCase() !== String(profile.email || '').toLowerCase();
        if (!changed && !emailChanged) {
            if (personalDraftHasChanges()) {
                window.InigoToast?.show('Save or remove your mobile and emergency contact numbers with their separate buttons before closing.', true);
                return;
            }
            personalModal.hidden = true;
            personalEditBtn?.focus();
            return;
        }
        if (!await confirmSettingsChange('Are you sure you want to save?')) return;
        personalSaveBtn.disabled = true;
        if (changed) {
            const { error } = await window.sb.rpc('save_customer_personal_details', {
                p_full_name: profileChanges.full_name,
                p_first_name: first,
                p_middle_name: middle,
                p_last_name: last,
                p_birthdate: privateChanges.birthdate,
                p_gender: privateChanges.gender,
                p_civil_status: privateChanges.civil_status,
                p_emergency_contact_name: privateChanges.emergency_contact_name,
            });
            if (error) {
                personalSaveBtn.disabled = false;
                window.InigoToast?.show(error.message || 'Could not save your personal information.', true);
                return;
            }
            invalidateCustomerAccountFieldsFetch(profile.id);
            Object.assign(profile, profileChanges, privateChanges);
            capturePersonalEditBaseline(profile);
            [settingsBirthdate, settingsGender, settingsCivilStatus, settingsEmergencyName].filter(Boolean).forEach(input => { delete input.dataset.dirty; });
            renderProfile(profile);
        }
        savedName = [first, middle, last];
        if (emailChanged) {
            const canResumePendingChange = pendingOtpEmail.toLowerCase() === stagedEmailChange.toLowerCase()
                && pendingOtpCurrentEmail.toLowerCase() === String(profile.email || '').toLowerCase();
            if (canResumePendingChange) {
                openEmailOtpModal();
            } else {
                const { error } = await window.sb.auth.updateUser({ email: stagedEmailChange });
                if (error) {
                    personalSaveBtn.disabled = false;
                    window.InigoToast?.show(error.message || 'Your personal information was saved, but the email change could not be requested.', true);
                    return;
                }
                pendingOtpCurrentEmail = String(profile.email || '');
                pendingOtpEmail = stagedEmailChange;
                emailOtpStep = 'current';
                openEmailOtpModal();
            }
            window.InigoToast?.show('Your changes were saved. Verification codes were sent to both email addresses.');
        } else {
            const phoneDraftRemains = (mobileInput?.value.trim() || '') !== (profile.contact_num || '')
                || (emergencyMobileInput?.value.trim() || '') !== (profile.emergency_contact_number || '');
            if (!phoneDraftRemains) {
                if (personalModal) personalModal.hidden = true;
                personalEditBtn?.focus();
                personalEditBaseline = null;
            }
            window.InigoToast?.show(phoneDraftRemains
                ? 'Personal information updated. Save or remove mobile and emergency contact numbers with their separate buttons.'
                : 'Personal information updated.');
        }
        personalSaveBtn.disabled = false;
    });

    // ------------------------------------------------------------------
    // Settings confirmations use a focused, keyboard-operable dialog before
    // each account mutation. Resolve false on Escape/Cancel and restore focus.
    const confirmModal = document.querySelector('[data-dash-confirm-modal]');
    const confirmDialog = confirmModal?.querySelector('[data-dash-confirm-dialog]');
    const confirmText = document.querySelector('#dashSettingsConfirmText');
    let pendingConfirm = null;
    let confirmReturnFocus = null;

    function closeSettingsConfirm(accepted) {
        if (!confirmModal || !pendingConfirm) return;
        confirmModal.hidden = true;
        const resolve = pendingConfirm;
        pendingConfirm = null;
        resolve(accepted);
        confirmReturnFocus?.focus?.();
        confirmReturnFocus = null;
    }

    function confirmSettingsChange(message = 'Are you sure you want to change?') {
        if (!confirmModal || !confirmDialog) return Promise.resolve(false);
        if (pendingConfirm) return Promise.resolve(false);
        confirmReturnFocus = document.activeElement;
        confirmText.textContent = message;
        confirmModal.hidden = false;
        confirmDialog.querySelector('[data-dash-confirm-cancel]')?.focus();
        return new Promise(resolve => { pendingConfirm = resolve; });
    }

    confirmModal?.querySelector('[data-dash-confirm-cancel]')?.addEventListener('click', () => closeSettingsConfirm(false));
    confirmModal?.querySelector('[data-dash-confirm-accept]')?.addEventListener('click', () => closeSettingsConfirm(true));
    confirmModal?.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeSettingsConfirm(false);
            return;
        }
        if (event.key === 'Tab' && confirmDialog) {
            const controls = Array.from(confirmDialog.querySelectorAll('button:not(:disabled)'));
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    });

    // A photo remains a local draft until the user presses Save and confirms.
    // ------------------------------------------------------------------
    const AVATAR_OUTPUT_SIZE = 256;               // px, square — the final stored image
    const AVATAR_JPEG_QUALITY = 0.82;             // ~20-50KB per image at 256x256

    const avatarFileInput = document.querySelector('[data-dash-avatar-file]');
    const avatarUploadBtn = document.querySelector('[data-dash-avatar-upload-trigger]');
    const avatarRemoveBtn = document.querySelector('[data-dash-avatar-remove]');

    // Shared by the upload flow below AND Remove Photo — `avatarUrl` is
    // either a fresh data URL or null (Remove Photo writes null, exactly
    // like every other "not set" value on this profile). On success, keeps
    // window.inigosyncProfile and every .dash-avatar on the page (topbar,
    // Profile panel, this card's own live preview — all painted by the one
    // renderProfile() below) in sync via the same re-render call Personal
    // Information's own Save uses after ITS update succeeds.
    async function saveAvatarUrl(avatarUrl) {
        if (!window.sb || !window.inigosyncProfile) {
            window.InigoToast?.show('Unable to reach the server right now. Please try again shortly.', true);
            return false;
        }

        const { error } = await window.sb
            .from('profiles')
            .update({ avatar_url: avatarUrl })
            .eq('id', window.inigosyncProfile.id);

        if (error) {
            console.error('[dashboard] avatar_url update failed', error);
            window.InigoToast?.show(error.message || 'Could not save your photo. Please try again.', true);
            return false;
        }

        window.inigosyncProfile.avatar_url = avatarUrl;
        renderProfile(window.inigosyncProfile);
        return true;
    }

    // The popup's Choose Photo button forwards to the hidden native picker.
    if (avatarUploadBtn && avatarFileInput) {
        avatarUploadBtn.addEventListener('click', () => avatarFileInput.click());
    }

    if (avatarFileInput) {
        avatarFileInput.addEventListener('change', async () => {
            const file = avatarFileInput.files && avatarFileInput.files[0];
            // Reset immediately (not only on success) so picking the SAME
            // file again right after a validation error still fires a fresh
            // `change` event — a browser will not re-fire `change` for an
            // unchanged file list otherwise.
            avatarFileInput.value = '';
            if (!file) return;

            if (!file.type || !file.type.startsWith('image/')) {
                window.InigoToast?.show('Please choose an image file.', true);
                return;
            }

            const originalLabel = avatarUploadBtn ? avatarUploadBtn.textContent : '';
            if (avatarUploadBtn) {
                avatarUploadBtn.disabled = true;
                avatarUploadBtn.textContent = 'Preparing…';
            }

            try {
                const croppedBlob = await window.InigoImageTools.openCropEditor(file, {
                    aspect: 1,
                    maxW: AVATAR_OUTPUT_SIZE,
                    maxH: AVATAR_OUTPUT_SIZE,
                    quality: AVATAR_JPEG_QUALITY,
                });
                if (!croppedBlob) return;
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(new Error('Could not read the cropped photo.'));
                    reader.readAsDataURL(croppedBlob);
                });
                if (!await confirmSettingsChange()) return;
                const ok = await saveAvatarUrl(dataUrl);
                if (ok) window.InigoToast?.show('Profile photo updated.');
            } catch (err) {
                console.error('[dashboard] avatar crop failed', err);
                window.InigoToast?.show('Could not process that image. Please try a different file.', true);
            } finally {
                if (avatarUploadBtn) {
                    avatarUploadBtn.disabled = false;
                    avatarUploadBtn.textContent = originalLabel;
                }
            }
        });
    }

    avatarRemoveBtn?.addEventListener('click', async () => {
        if (!await confirmSettingsChange('Are you sure you want to remove your profile photo?')) return;
        avatarRemoveBtn.disabled = true;
        const ok = await saveAvatarUrl(null);
        avatarRemoveBtn.disabled = false;
        if (ok) window.InigoToast?.show('Profile photo removed.');
    });

    // ------------------------------------------------------------------
    // Account Settings — PH mobile-format and database availability checks.
    // A successful authenticated check creates a purpose-specific, one-use
    // proof consumed by the matching database write guard.
    // ------------------------------------------------------------------
    const mobileValidateBtn = document.querySelector('[data-dash-mobile-validate]');
    const mobileRemoveBtn = document.querySelector('[data-dash-mobile-remove]');
    const mobileStatus = document.querySelector('[data-dash-mobile-status]');
    const mobileInput = document.querySelector('[data-dash-settings-mobile]');
    const emergencyMobileInput = document.querySelector('[data-dash-settings-emergency-number]');
    const emergencySaveBtn = document.querySelector('[data-dash-emergency-save]');
    const emergencyRemoveBtn = document.querySelector('[data-dash-emergency-remove]');
    const emergencyStatus = document.querySelector('[data-dash-emergency-status]');

    function setMobileStatus(message, isError = false) {
        if (!mobileStatus) return;
        mobileStatus.textContent = message;
        mobileStatus.classList.toggle('is-error', isError);
        mobileStatus.dataset.state = isError ? 'invalid' : (/^(Valid|Saved)/.test(message) ? 'valid' : '');
    }

    function renderMobileStatus(profile) {
        const savedNumber = profile.contact_num || '';
        const parsed = savedNumber ? window.validatePhMobile?.(savedNumber) : null;
        if (mobileInput && !mobileInput.dataset.dirty) {
            mobileInput.value = parsed?.valid ? parsed.normalized : savedNumber;
        }
        if (mobileRemoveBtn) mobileRemoveBtn.hidden = !savedNumber;
        if (mobileValidateBtn) mobileValidateBtn.hidden = true;
        if (mobileStatus && !mobileInput?.dataset.dirty) {
            mobileStatus.textContent = !savedNumber ? 'Optional · format and availability check' : 'Saved number';
            mobileStatus.dataset.state = savedNumber ? 'valid' : '';
            mobileStatus.classList.remove('is-error');
        }
    }

    function formatPhoneValidationDate(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return ` on ${date.toLocaleDateString('en-PH', { dateStyle: 'medium', timeZone: 'Asia/Manila' })}`;
    }

    async function mobileFunctionErrorMessage(error) {
        const context = error?.context;
        if (context && typeof context.clone === 'function') {
            try {
                const body = await context.clone().json();
                if (body?.message) return body.message;
            } catch (_) { /* Use the SDK fallback. */ }
        }
        return error?.message || 'Phone validation is temporarily unavailable.';
    }

    function validationReasonMessage(reason) {
        if (reason === 'in_use') return 'This number is already linked to another account.';
        return 'Enter a valid Philippine mobile number.';
    }

    const phoneValidationState = new WeakMap();
    function phoneUi(input) {
        return input === mobileInput
            ? { status: mobileStatus, save: mobileValidateBtn, current: () => window.inigosyncProfile?.contact_num, field: 'contact_num' }
            : { status: emergencyStatus, save: emergencySaveBtn, current: () => window.inigosyncProfile?.emergency_contact_number, field: 'emergency_contact_number' };
    }

    function setPhoneStatus(status, message, error = false) {
        if (!status) return;
        status.textContent = message;
        status.dataset.state = error ? 'invalid'
            : /^Already saved/.test(message) ? 'warning'
                : /^(Valid|Saved|Number removed)/.test(message) ? 'valid'
                    : /^Checking/.test(message) ? 'checking' : '';
        status.classList.toggle('is-error', error);
        status.classList.toggle('is-warning', !error && status.dataset.state === 'warning');
        status.classList.toggle('is-success', !error && status.dataset.state === 'valid');
    }

    function schedulePhoneValidation(input) {
        const ui = phoneUi(input);
        const state = phoneValidationState.get(input) || { timer: null, controller: null, request: 0 };
        phoneValidationState.set(input, state);
        clearTimeout(state.timer);
        state.controller?.abort();
        const request = ++state.request;
        delete input.dataset.validatedNumber;
        if (ui.save) { ui.save.hidden = true; ui.save.disabled = true; }
        const raw = String(input.value || '').trim();
        input.dataset.phoneValidation = '';
        input.setAttribute('aria-invalid', 'false');
        if (ui.status) ui.status.dataset.state = '';
        if (!raw) {
            setPhoneStatus(ui.status, 'Optional · format check');
            return;
        }
        const check = window.validatePhMobile?.(raw);
        if (!check?.valid) {
            input.dataset.phoneValidation = 'invalid';
            input.setAttribute('aria-invalid', 'true');
            setPhoneStatus(ui.status, check?.message || 'Enter a valid Philippine mobile number.', true);
            return;
        }
        const cachedAt = Number(input.dataset.cachedValidAt || 0);
        if (input.dataset.cachedValidNumber === check.normalized && Date.now() - cachedAt < 4 * 60 * 1000) {
            input.dataset.validatedNumber = check.normalized;
            if (ui.save) { ui.save.hidden = false; ui.save.disabled = false; }
            if (ui.status) ui.status.dataset.state = 'valid';
            setPhoneStatus(ui.status, 'Valid · available');
            return;
        }
        if (!window.sb?.functions) {
            if (ui.status) ui.status.dataset.state = 'invalid';
            setPhoneStatus(ui.status, 'Check unavailable · retry', true);
            return;
        }
        if (ui.status) ui.status.dataset.state = 'checking';
        setPhoneStatus(ui.status, 'Checking…');
        state.timer = setTimeout(async () => {
            const controller = new AbortController();
            state.controller = controller;
            try {
                const { data, error } = await window.sb.functions.invoke('validate-contact-phone', {
                    body: {
                        phone: check.normalized,
                        purpose: ui.field === 'emergency_contact_number' ? 'emergency' : 'contact',
                    },
                    signal: controller.signal,
                });
                if (request !== state.request) return;
                if (error) throw new Error(await mobileFunctionErrorMessage(error));
                if (data?.valid !== true) throw new Error(validationReasonMessage(data?.reason));
                if (!/^\+639\d{9}$/.test(data.normalized || '')
                    || data.normalized !== `+63${check.normalized.slice(1)}`) {
                    throw new Error('The number could not be checked safely. Try again later.');
                }
                if (ui.field === 'emergency_contact_number' && data.available === false) {
                    input.dataset.phoneValidation = 'warning';
                    input.setAttribute('aria-invalid', 'false');
                    if (ui.status) ui.status.dataset.state = 'warning';
                    input.dataset.validatedNumber = check.normalized;
                    input.dataset.cachedValidNumber = check.normalized;
                    input.dataset.cachedValidAt = String(Date.now());
                    if (ui.save) { ui.save.hidden = false; ui.save.disabled = false; }
                    setPhoneStatus(ui.status, 'Already saved · shared allowed');
                    return;
                }
                input.dataset.phoneValidation = 'valid';
                input.setAttribute('aria-invalid', 'false');
                if (ui.status) ui.status.dataset.state = 'valid';
                input.dataset.cachedValidNumber = check.normalized;
                input.dataset.cachedValidAt = String(Date.now());
                input.dataset.validatedNumber = check.normalized;
                if (ui.save) { ui.save.hidden = false; ui.save.disabled = false; }
                setPhoneStatus(ui.status, 'Valid · available');
            } catch (error) {
                if (controller.signal.aborted || request !== state.request) return;
            input.dataset.phoneValidation = 'invalid';
            input.setAttribute('aria-invalid', 'true');
            if (ui.status) ui.status.dataset.state = 'invalid';
            setPhoneStatus(ui.status, error.message || 'Check failed · retry', true);
            }
        }, 600);
    }

    async function saveValidatedPhone(input, button) {
        const profile = window.inigosyncProfile;
        const ui = phoneUi(input);
        const check = window.validatePhMobile?.(input.value || '');
        const proofAge = Date.now() - Number(input.dataset.cachedValidAt || 0);
        if (!profile?.id || !check?.valid || input.dataset.validatedNumber !== check.normalized
            || input.dataset.cachedValidNumber !== check.normalized || proofAge >= 4 * 60 * 1000) {
            setPhoneStatus(ui.status, 'Wait for check to finish', true);
            input.focus();
            return;
        }
        if (!await confirmSettingsChange(`Are you sure you want to save this ${ui.field === 'contact_num' ? 'mobile' : 'emergency contact'} number?`)) return;
        button.disabled = true;
        try {
            const table = ui.field === 'emergency_contact_number' ? 'customer_private_details' : 'profiles';
            const key = ui.field === 'emergency_contact_number' ? 'user_id' : 'id';
            const { error } = await window.sb.from(table).update({ [ui.field]: check.normalized }).eq(key, profile.id);
            if (error) throw error;
            if (ui.field === 'contact_num') {
                profile.contact_num = check.normalized;
                profile.contact_num_validated = true;
                profile.contact_num_validated_at = new Date().toISOString();
            } else {
                invalidateCustomerAccountFieldsFetch(profile.id);
                profile.emergency_contact_number = check.normalized;
            }
            delete input.dataset.dirty;
            delete input.dataset.validatedNumber;
            delete input.dataset.cachedValidNumber;
            delete input.dataset.cachedValidAt;
            renderProfile(profile);
            if (button) button.hidden = true;
            setPhoneStatus(ui.status, 'Saved');
            window.InigoToast?.show('Validated number saved.');
        } catch (error) {
            setPhoneStatus(ui.status, error.message || 'Could not save the validated number.', true);
        } finally { button.disabled = false; }
    }

    mobileValidateBtn?.addEventListener('click', () => saveValidatedPhone(mobileInput, mobileValidateBtn));
    emergencySaveBtn?.addEventListener('click', () => saveValidatedPhone(emergencyMobileInput, emergencySaveBtn));

    async function removePhone(input, button, field, status) {
        const profile = window.inigosyncProfile;
        if (!profile?.id || !profile[field]) return;
        if (!await confirmSettingsChange(`Are you sure you want to remove the ${field === 'contact_num' ? 'mobile' : 'emergency contact'} number?`)) return;
        button.disabled = true;
        try {
            const table = field === 'emergency_contact_number' ? 'customer_private_details' : 'profiles';
            const key = field === 'emergency_contact_number' ? 'user_id' : 'id';
            const { error } = await window.sb.from(table).update({ [field]: null }).eq(key, profile.id);
            if (error) throw error;
            if (field === 'emergency_contact_number') invalidateCustomerAccountFieldsFetch(profile.id);
            profile[field] = null;
            if (field === 'contact_num') {
                profile.contact_num_validated = false;
                profile.contact_num_validated_at = null;
            }
            if (input) { input.value = ''; delete input.dataset.dirty; delete input.dataset.validatedNumber; delete input.dataset.cachedValidNumber; delete input.dataset.cachedValidAt; }
            renderProfile(profile);
            setPhoneStatus(status, 'Number removed');
            window.InigoToast?.show('Number removed.');
        } catch (error) {
            setPhoneStatus(status, error.message || 'Could not remove the number.', true);
        } finally { button.disabled = false; }
    }
    mobileRemoveBtn?.addEventListener('click', () => removePhone(mobileInput, mobileRemoveBtn, 'contact_num', mobileStatus));
    emergencyRemoveBtn?.addEventListener('click', () => removePhone(emergencyMobileInput, emergencyRemoveBtn, 'emergency_contact_number', emergencyStatus));
    [mobileInput, emergencyMobileInput].filter(Boolean).forEach(input => input.addEventListener('input', () => {
        input.dataset.dirty = 'true';
        schedulePhoneValidation(input);
    }));

    let contactValidationFetchFor = null;
    async function fetchContactValidation(profileId) {
        if (!window.sb || !profileId) return null;
        const { data, error } = await window.sb.from('profiles')
            .select('contact_num_validated, contact_num_validated_at')
            .eq('id', profileId).maybeSingle();
        if (error) {
            if (!isDashboardSchemaMismatch(error)) console.error('[dashboard] failed to load contact validation status', error);
            return null;
        }
        return data;
    }

    function populateContactValidation(profile) {
        renderMobileStatus(profile);
        if (contactValidationFetchFor === profile.id) return;
        contactValidationFetchFor = profile.id;
        fetchContactValidation(profile.id).then(data => {
            if (!data || window.inigosyncProfile?.id !== profile.id) return;
            Object.assign(profile, data);
            renderMobileStatus(profile);
        }).catch(error => console.error('[dashboard] contact validation status request failed', error));
    }

    let accountFieldsFetchFor = null;
    let accountFieldsFetchRevision = 0;

    function invalidateCustomerAccountFieldsFetch(profileId) {
        if (accountFieldsFetchFor === profileId) accountFieldsFetchRevision += 1;
    }

    function renderCustomerAccountFields(profile) {
        if (settingsBirthdate && !settingsBirthdate.dataset.dirty) settingsBirthdate.value = profile.birthdate || '';
        if (settingsGender && !settingsGender.dataset.dirty) setGenderSelection(profile.gender || '');
        if (settingsCivilStatus && !settingsCivilStatus.dataset.dirty) settingsCivilStatus.value = profile.civil_status || '';
        if (settingsEmergencyName && !settingsEmergencyName.dataset.dirty) settingsEmergencyName.value = profile.emergency_contact_name || '';
        if (emergencyMobileInput && !emergencyMobileInput.dataset.dirty) emergencyMobileInput.value = profile.emergency_contact_number || '';
        updateBirthdateAge(profile.birthdate || '');
        const birthdateDisplay = document.querySelector('[data-dash-settings-display-birthdate]');
        if (birthdateDisplay) birthdateDisplay.textContent = formatAccountBirthdate(profile.birthdate);
        const genderDisplay = document.querySelector('[data-dash-settings-display-gender]');
        if (genderDisplay) genderDisplay.textContent = profile.gender || '—';
        const civilDisplay = document.querySelector('[data-dash-settings-display-civil-status]');
        if (civilDisplay) civilDisplay.textContent = profile.civil_status || '—';
        const emergencyDisplay = document.querySelector('[data-dash-settings-display-emergency]');
        if (emergencyDisplay) emergencyDisplay.textContent = [profile.emergency_contact_name, profile.emergency_contact_number].filter(Boolean).join(' · ') || '—';
        const profileBirthday = document.querySelector('[data-dash-profile-birthday]');
        if (profileBirthday) profileBirthday.textContent = formatAccountBirthday(profile.birthdate);
        const profileAge = document.querySelector('[data-dash-profile-age]');
        if (profileAge) {
            const age = ageFromBirthdate(profile.birthdate || '');
            profileAge.textContent = age === null ? '—' : String(age);
        }
        const profileGender = document.querySelector('[data-dash-profile-gender]');
        if (profileGender) profileGender.textContent = profile.gender || '—';
        const profileCivilStatus = document.querySelector('[data-dash-profile-civil-status]');
        if (profileCivilStatus) profileCivilStatus.textContent = profile.civil_status || '—';
        const profileEmergencyName = document.querySelector('[data-dash-profile-emergency-name]');
        if (profileEmergencyName) profileEmergencyName.textContent = profile.emergency_contact_name || '—';
        const profileEmergencyNumber = document.querySelector('[data-dash-profile-emergency-number]');
        if (profileEmergencyNumber) profileEmergencyNumber.textContent = profile.emergency_contact_number || '—';
        if (emergencyRemoveBtn) emergencyRemoveBtn.hidden = !profile.emergency_contact_number;
    }

    function setGenderSelection(value) {
        if (!settingsGender) return;
        const gender = String(value || '');
        if (gender && !Array.from(settingsGender.options).some(option => option.value === gender)) {
            const option = document.createElement('option');
            option.value = gender;
            option.textContent = gender;
            settingsGender.append(option);
        }
        settingsGender.value = gender;
    }

    function populateCustomerAccountFields(profile) {
        renderCustomerAccountFields(profile);
        if (accountFieldsFetchFor === profile.id) return;
        accountFieldsFetchFor = profile.id;
        const requestRevision = ++accountFieldsFetchRevision;
        fetchCustomerAccountFields(profile.id).then(data => {
            if (!data || requestRevision !== accountFieldsFetchRevision || window.inigosyncProfile?.id !== profile.id) return;
            Object.assign(profile, data);
            renderCustomerAccountFields(profile);
        }).catch(error => console.error('[dashboard] account details request failed', error));
    }

    function renderProfile(profile) {
        const initials = (profile.full_name || profile.email || '?')
            .split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

        // R4-4 (implementation_plan.md, "Revision 4") — the ONE place that
        // paints every .dash-avatar on this page (topbar, Profile panel,
        // Account Settings' own preview above). avatar_url unset takes the
        // EXACT SAME textContent-initials path this always used — the
        // default avatar's look/behaviour is unchanged. avatar_url set
        // swaps in an <img class="dash-avatar-img"> instead (see that
        // class in Style/Dashboard.css); escapeHtml on the data URL is the
        // same "everything interpolated into innerHTML is escaped" rule
        // this file applies everywhere else, even though a data URL this
        // code itself generated never actually contains &<>"'.
        const avatarUrl = profile.avatar_url || null;
        document.querySelectorAll('.dash-avatar').forEach((el) => {
            if (avatarUrl) {
                el.innerHTML = `<img class="dash-avatar-img" src="${window.escapeHtml(avatarUrl)}" alt="Profile photo">`;
            } else {
                el.textContent = initials;
            }
        });
        // Remove Photo only makes sense once there IS a photo.
        if (avatarRemoveBtn) avatarRemoveBtn.hidden = !avatarUrl;

        document.querySelectorAll('[data-dash-profile-name]').forEach((el) => { el.textContent = profile.full_name || 'Customer'; });

        const profileCardInfo = document.querySelector('[data-dash-panel="profile"] .dash-profile-card-info h3');
        if (profileCardInfo) profileCardInfo.textContent = profile.full_name || 'Customer';
        const settingsNameDisplay = document.querySelector('[data-dash-settings-display-name]');
        if (settingsNameDisplay) settingsNameDisplay.textContent = profile.full_name || '—';
        const settingsEmailDisplay = document.querySelector('[data-dash-settings-display-email]');
        if (settingsEmailDisplay) settingsEmailDisplay.textContent = profile.email || '—';

        const metaItems = document.querySelectorAll('[data-dash-panel="profile"] .dash-profile-meta-item');
        if (metaItems[0]) metaItems[0].querySelector('span:last-child').textContent = profile.email || '—';
        const profileMetaEmail = document.querySelector('[data-dash-profile-meta-email]');
        if (profileMetaEmail) profileMetaEmail.textContent = profile.email || '—';
        if (metaItems[1]) { const phone = window.validatePhMobile?.(profile.contact_num || ''); metaItems[1].querySelector('span:last-child').textContent = phone?.valid ? phone.normalized : (profile.contact_num || '—'); }

        // Member since ([2]) — from the AUTH session's created_at, not a
        // `profiles` column. There is no schema file for `profiles` in this
        // repo and a created_at column there is unconfirmed
        // (implementation_plan.md E3/"Open questions"), but Supabase Auth
        // always provides session.user.created_at, so this has zero schema
        // risk. Async and fire-and-forget — renderProfile()'s callers never
        // await it, same as the rest of this function's side effects.
        if (metaItems[2] && window.sb) {
            window.sb.auth.getSession().then(({ data }) => {
                const createdAt = data && data.session && data.session.user ? data.session.user.created_at : null;
                const memberSince = createdAt ? formatMemberSince(createdAt) : null;
                metaItems[2].querySelector('span:last-child').textContent = memberSince || '—';
                const profileSubtitle = document.querySelector('[data-dash-panel="profile"] .dash-profile-card-info p');
                if (profileSubtitle) profileSubtitle.textContent = memberSince ? `Customer since ${memberSince}` : 'Customer';
            });
        }

        const settingsPanel = document.querySelector('[data-dash-panel="settings"]');
        if (settingsPanel) {
            const emailInput = settingsPanel.querySelector('[data-dash-settings-email]');
            const mobileInput = settingsPanel.querySelector('[data-dash-settings-mobile]');
            if (emailInput && !emailInput.dataset.editing) emailInput.value = profile.email || '';
            if (emailInput && !emailInput.dataset.editing) emailInput.dataset.savedEmail = profile.email || '';
            // Digits-only on load too, matching the field's own [data-digits-only]
            // contract (increment 13). Both write paths (signup, and this
            // panel's own mobile-verification flow above, Revision 5's D6)
            // already run contact_num through window.validatePhMobile
            // first, whose `normalized` is always the spaceless local
            // 09XXXXXXXXX form — so this is a defensive strip for any value
            // that got into the database another way, not a fix for
            // anything either write path produces today.
            if (mobileInput && !mobileInput.dataset.dirty) { const savedPhone = window.validatePhMobile?.(profile.contact_num || ''); mobileInput.value = savedPhone?.valid ? savedPhone.normalized : (profile.contact_num || ''); }
            const settingsMobileDisplay = document.querySelector('[data-dash-settings-display-mobile]');
            if (settingsMobileDisplay) {
                const savedPhone = window.validatePhMobile?.(profile.contact_num || '');
                settingsMobileDisplay.textContent = savedPhone?.valid ? savedPhone.normalized : (profile.contact_num || '—');
            }

            // First/Middle/Surname (§9, D3) — see populateSettingsNameFields()
            // above for the full_name-parsing fallback.
            populateSettingsNameFields(profile);
            populateCustomerAccountFields(profile);

            // Provider validation state is scoped to Account Settings and
            // loaded separately from authGuard's shared profile projection.
            populateContactValidation(profile);
        }
    }

    // refreshMyBookings() renders Receipts itself now (renderReceipts(),
    // R5/Revision 2 above) — no separate refreshReceipts() call needed
    // here, since it would otherwise re-fetch the same `booking` rows a
    // second time.
    document.addEventListener('inigosync:profile-ready', (e) => {
        renderProfile(e.detail);
        refreshMyBookings();
    });
    if (window.inigosyncProfile) {
        renderProfile(window.inigosyncProfile);
        refreshMyBookings();
    }

    const celebratedPaymentAttempts = new Set();
    const pendingPaymentReceipts = new Map();
    const activePaymentReceiptLoads = new Set();
    const pendingPaymentStatusChecks = new Map();
    const activePaymentStatusChecks = new Set();
    const PENDING_PAYMENT_RECEIPT_PREFIX = 'inigosync:pending-payment-receipt:';
    const PENDING_PAYMENT_STATUS_PREFIX = 'inigosync:pending-payment-status:';
    const PAYMENT_STATUS_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
    function normalizePaymentReceiptReferences(receipts) {
        if (!Array.isArray(receipts)) return [];
        const seen = new Set();
        return receipts.map(receipt => ({ booking_id: Number(receipt?.booking_id), payment_id: Number(receipt?.payment_id) }))
            .filter(receipt => Number.isSafeInteger(receipt.booking_id) && receipt.booking_id > 0
                && Number.isSafeInteger(receipt.payment_id) && receipt.payment_id > 0)
            .filter(receipt => {
                const key = `${receipt.booking_id}:${receipt.payment_id}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    }

    function persistPendingPaymentReceipt(attemptId, bookingReceipts) {
        const id = String(attemptId || '');
        const receipts = normalizePaymentReceiptReferences(bookingReceipts);
        if (!id || !receipts.length) return false;
        const pending = { attemptId: id, bookingReceipts: receipts };
        pendingPaymentReceipts.set(id, pending);
        try { window.sessionStorage?.setItem(`${PENDING_PAYMENT_RECEIPT_PREFIX}${id}`, JSON.stringify(pending)); } catch { /* Keep an in-memory retry when storage is unavailable. */ }
        return true;
    }

    function clearPendingPaymentReceipt(attemptId) {
        const id = String(attemptId || '');
        pendingPaymentReceipts.delete(id);
        try { window.sessionStorage?.removeItem(`${PENDING_PAYMENT_RECEIPT_PREFIX}${id}`); } catch { /* The receipt is already rendered in this page. */ }
    }

    function readPendingPaymentReceipts(excludeAttemptId = '') {
        const pending = new Map(pendingPaymentReceipts);
        try {
            const storage = window.sessionStorage;
            for (let index = 0; storage && index < storage.length; index += 1) {
                const key = storage.key(index);
                if (!key?.startsWith(PENDING_PAYMENT_RECEIPT_PREFIX)) continue;
                const saved = JSON.parse(storage.getItem(key) || 'null');
                if (saved?.attemptId && saved.attemptId === key.slice(PENDING_PAYMENT_RECEIPT_PREFIX.length)) {
                    pending.set(saved.attemptId, { attemptId: saved.attemptId, bookingReceipts: normalizePaymentReceiptReferences(saved.bookingReceipts) });
                }
            }
        } catch { /* The in-memory pending map remains available for this page. */ }
        return [...pending.values()].filter(item => item.attemptId !== String(excludeAttemptId || '') && item.bookingReceipts.length);
    }

    function persistPendingPaymentStatusCheck(attemptId, returnKind) {
        const id = String(attemptId || '');
        if (!id) return false;
        const pending = { attemptId: id, returnKind: returnKind === 'cancelled' ? 'cancelled' : 'success' };
        pendingPaymentStatusChecks.set(id, pending);
        try { window.sessionStorage?.setItem(`${PENDING_PAYMENT_STATUS_PREFIX}${id}`, JSON.stringify(pending)); } catch { /* Keep an in-memory retry when storage is unavailable. */ }
        return true;
    }

    function clearPendingPaymentStatusCheck(attemptId) {
        const id = String(attemptId || '');
        pendingPaymentStatusChecks.delete(id);
        try { window.sessionStorage?.removeItem(`${PENDING_PAYMENT_STATUS_PREFIX}${id}`); } catch { /* Status is already terminal or paid. */ }
    }

    function readPendingPaymentStatusChecks() {
        const pending = new Map(pendingPaymentStatusChecks);
        try {
            const storage = window.sessionStorage;
            for (let index = 0; storage && index < storage.length; index += 1) {
                const key = storage.key(index);
                if (!key?.startsWith(PENDING_PAYMENT_STATUS_PREFIX)) continue;
                const saved = JSON.parse(storage.getItem(key) || 'null');
                if (saved?.attemptId && saved.attemptId === key.slice(PENDING_PAYMENT_STATUS_PREFIX.length)) {
                    pending.set(saved.attemptId, { attemptId: saved.attemptId, returnKind: saved.returnKind === 'cancelled' ? 'cancelled' : 'success' });
                }
            }
        } catch { /* The in-memory pending map remains available for this page. */ }
        return [...pending.values()];
    }

    function schedulePaymentStatusRetry(attemptId, returnKind, retryIndex = 0) {
        const delay = PAYMENT_STATUS_RETRY_DELAYS_MS[retryIndex];
        if (!Number.isFinite(delay)) return;
        window.setTimeout(() => checkPaymentReturnStatus(attemptId, returnKind, retryIndex + 1), delay);
    }

    function claimPaymentCelebration(attemptId) {
        const key = `inigosync:payment-celebrated:${String(attemptId || '')}`;
        if (!attemptId || celebratedPaymentAttempts.has(key)) return false;
        try {
            if (window.sessionStorage?.getItem(key) === '1') return false;
            window.sessionStorage?.setItem(key, '1');
        } catch { /* Storage can be disabled; the in-memory guard still applies. */ }
        celebratedPaymentAttempts.add(key);
        return true;
    }

    function playPaymentSuccessSound() {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        try {
            const audio = new AudioContextClass();
            const now = audio.currentTime;
            audio.resume().catch(() => {});
            [659.25, 880, 1046.5].forEach((frequency, index) => {
                const oscillator = audio.createOscillator();
                const gain = audio.createGain();
                const start = now + index * 0.12;
                oscillator.type = 'sine';
                oscillator.frequency.value = frequency;
                gain.gain.setValueAtTime(0.0001, start);
                gain.gain.exponentialRampToValueAtTime(0.055, start + 0.025);
                gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);
                oscillator.connect(gain);
                gain.connect(audio.destination);
                oscillator.start(start);
                oscillator.stop(start + 0.25);
            });
            window.setTimeout(() => audio.close().catch(() => {}), 850);
        } catch { /* Autoplay restrictions or unavailable audio are non-fatal. */ }
    }

    function showPaymentConfetti() {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !receiptDialog) return;
        const canvas = document.createElement('canvas');
        canvas.className = 'dash-payment-celebration-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        receiptDialog.appendChild(canvas);
        const context = canvas.getContext('2d');
        if (!context) { canvas.remove(); return; }
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const width = receiptDialog.clientWidth;
        const height = receiptDialog.clientHeight;
        canvas.width = width * ratio;
        canvas.height = height * ratio;
        const colors = ['#e4ad43', '#55a77c', '#7ea8d8', '#e58c78', '#f3d87c'];
        const pieces = Array.from({ length: 90 }, () => ({
            x: Math.random() * width, y: -Math.random() * height * 0.55,
            vx: (Math.random() - 0.5) * 3.2, vy: 2.2 + Math.random() * 3.8,
            size: 4 + Math.random() * 5, angle: Math.random() * Math.PI,
            spin: (Math.random() - 0.5) * 0.16, color: colors[Math.floor(Math.random() * colors.length)],
        }));
        const start = performance.now();
        const draw = (time) => {
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.save();
            context.scale(ratio, ratio);
            pieces.forEach(piece => {
                piece.x += piece.vx;
                piece.y += piece.vy;
                piece.angle += piece.spin;
                context.save();
                context.translate(piece.x, piece.y);
                context.rotate(piece.angle);
                context.fillStyle = piece.color;
                context.fillRect(-piece.size / 2, -piece.size / 2, piece.size, piece.size * 0.65);
                context.restore();
            });
            context.restore();
            if (time - start < 1900) window.requestAnimationFrame(draw);
            else canvas.remove();
        };
        window.requestAnimationFrame(draw);
    }

    async function showVerifiedPaymentReceipt(attemptId, bookingReceipts) {
        const key = String(attemptId || '');
        if (!key || activePaymentReceiptLoads.has(key)) return false;
        activePaymentReceiptLoads.add(key);
        try { return await renderVerifiedPaymentReceipt(attemptId, bookingReceipts); }
        finally { activePaymentReceiptLoads.delete(key); }
    }

    async function renderVerifiedPaymentReceipt(attemptId, bookingReceipts) {
        const receipts = normalizePaymentReceiptReferences(bookingReceipts);
        if (!attemptId || !receipts.length || !window.sb || !receiptDialog || !receiptDialogContent) return false;
        // The paid webhook and its acknowledgment trigger commit together, but
        // allow a short retry window for acknowledgment replication. Keep the
        // paid references in session storage if this window is not enough.
        let entries = [];
        for (let attempt = 0; attempt < 4 && !entries.length; attempt += 1) {
            const results = await Promise.all(receipts.map(async receipt => {
                try {
                    const saved = await fetchBookingAcknowledgments({ booking_id: receipt.booking_id });
                    const acknowledgment = saved.find(item => Number(item.payment_id) === receipt.payment_id);
                    return acknowledgment ? [{
                        source: 'booking', sourceId: String(receipt.booking_id), acknowledgment,
                        searchIds: [acknowledgment.receipt_number, acknowledgment.receipt_id].filter(Boolean),
                        referenceLabel: `Booking #${receipt.booking_id}`,
                        cardKey: `booking-${receipt.booking_id}-${acknowledgment.receipt_id}`,
                    }] : [];
                } catch (error) {
                    console.error('[dashboard] verified payment receipt could not be loaded', error);
                    return [];
                }
            }));
            entries = results.flat();
            if (!entries.length && attempt < 3) await new Promise(resolve => window.setTimeout(resolve, 500));
        }
        if (!entries.length) return false;
        activeReceiptOpener = null;
        receiptDownloadButton?.setAttribute('data-dash-receipt-download', String(entries[0].cardKey || 'payment'));
        receiptDialogContent.innerHTML = entries.map(renderPaymentAcknowledgment).join('');
        wireReceiptDownloads();
        if (!receiptDialog.open) receiptDialog.showModal();
        if (!receiptDialog.open) return false;
        clearPendingPaymentReceipt(attemptId);
        receiptDialogClose?.focus({ preventScroll: true });
        if (claimPaymentCelebration(attemptId)) {
            playPaymentSuccessSound();
            showPaymentConfetti();
        }
        return true;
    }

    function resumePendingPaymentReceiptRenders() {
        readPendingPaymentReceipts().forEach(pending => {
            showVerifiedPaymentReceipt(pending.attemptId, pending.bookingReceipts);
        });
    }

    function handlePaymentReturnStatus(error, data, attemptId, returnKind, retryIndex = 0) {
        if (error || !data) {
            window.InigoToast?.show('We could not confirm checkout yet. Please check again shortly.', true);
            persistPendingPaymentStatusCheck(attemptId, returnKind);
            schedulePaymentStatusRetry(attemptId, returnKind, retryIndex);
            return;
        }
        if (data.status === 'paid') {
            window.InigoToast?.show('Payment received. Your booking is confirmed.');
            if (!persistPendingPaymentReceipt(attemptId, data.booking_receipts)) {
                // The paid status is verified, but keep checking until the
                // owner-scoped receipt references are available to render.
                persistPendingPaymentStatusCheck(attemptId, returnKind);
                schedulePaymentStatusRetry(attemptId, returnKind, retryIndex);
                refreshMyBookings();
                return;
            }
            clearPendingPaymentStatusCheck(attemptId);
            showVerifiedPaymentReceipt(attemptId, data.booking_receipts);
            refreshMyBookings();
        } else if (data.status === 'expired') {
            clearPendingPaymentStatusCheck(attemptId);
            window.InigoToast?.show('Checkout ended. The selected time is available again.', true);
            refreshMyBookings();
        } else if (String(data.status || '').toLowerCase() === 'cancelled') {
            clearPendingPaymentStatusCheck(attemptId);
            window.InigoToast?.show('Checkout was cancelled. Your selected time is available again.', true);
            refreshMyBookings();
        } else if (['failed', 'review'].includes(String(data.status || '').toLowerCase())) {
            clearPendingPaymentStatusCheck(attemptId);
            window.InigoToast?.show('Payment needs staff review. Please contact the sports center before trying again.', true);
            refreshMyBookings();
        } else if (returnKind === 'cancelled') {
            window.InigoToast?.show('Checkout cancellation is being confirmed. Your time remains held until cancellation is confirmed.', true);
            persistPendingPaymentStatusCheck(attemptId, returnKind);
            schedulePaymentStatusRetry(attemptId, returnKind, retryIndex);
        } else {
            window.InigoToast?.show('Payment is still processing. We will update your booking once the payment is verified.');
            persistPendingPaymentStatusCheck(attemptId, returnKind);
            schedulePaymentStatusRetry(attemptId, returnKind, retryIndex);
        }
    }

    async function checkPaymentReturnStatus(attemptId, returnKind, retryIndex = 0) {
        const id = String(attemptId || '');
        if (!id || activePaymentStatusChecks.has(id) || !window.sb) return;
        activePaymentStatusChecks.add(id);
        try {
            const action = retryIndex === 0 && returnKind === 'cancelled' ? 'cancel' : 'status';
            const { data, error } = await window.sb.functions.invoke('paymongo-checkout', {
                body: { action, attempt_id: id },
            });
            handlePaymentReturnStatus(error, data, id, returnKind, retryIndex);
        } catch (error) {
            handlePaymentReturnStatus(error, null, id, returnKind, retryIndex);
        } finally {
            activePaymentStatusChecks.delete(id);
        }
    }

    function resumePendingPaymentStatusChecks() {
        readPendingPaymentStatusChecks().forEach(pending => {
            checkPaymentReturnStatus(pending.attemptId, pending.returnKind);
        });
    }

    // The payment provider redirects back to the dashboard, but the redirect itself is
    // never treated as proof of payment. The signed webhook is authoritative;
    // this owner-scoped status check only tells the customer what the server
    // has recorded so far.
    const paymentReturn = new URLSearchParams(window.location.search);
    const paymentReturnKind = paymentReturn.get('paymongo');
    const paymentReturnAttempt = paymentReturn.get('attempt');
    if (paymentReturnKind && paymentReturnAttempt && window.sb) {
        window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.hash}`);
        persistPendingPaymentStatusCheck(paymentReturnAttempt, paymentReturnKind);
        checkPaymentReturnStatus(paymentReturnAttempt, paymentReturnKind);
        resumePendingPaymentReceiptRenders();
        resumePendingPaymentStatusChecks();
    } else {
        resumePendingPaymentReceiptRenders();
        resumePendingPaymentStatusChecks();
    }

    // ------------------------------------------------------------------
    // Account Settings — password visibility toggles (same pattern as
    // the auth modal) and a placeholder save handler.
    // ------------------------------------------------------------------
    document.querySelectorAll('[data-dash-toggle-password]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const input = btn.previousElementSibling;
            if (!input) return;
            const isHidden = input.type === 'password';
            input.type = isHidden ? 'text' : 'password';
            btn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
        });
    });

    // Mobile number — digits only, capped at 11 (increment 13). Identical
    // pattern to includes/auth.js's [data-digits-only] wiring for signup's
    // mobile field (see its comment there for the full reasoning): maxlength
    // alone would truncate a paste BEFORE anything can filter it, landing the
    // wrong digits, so the paste handler preempts it and strips first. Wired
    // once here at setup time rather than inside renderProfile() — that
    // function can run more than once (on 'inigosync:profile-ready' AND
    // immediately if window.inigosyncProfile already exists), and attaching
    // this twice would double-apply the paste handler's manual splice.
    document.querySelectorAll('[data-dash-panel="settings"] .dash-settings-grid .dash-input[data-digits-only]').forEach((field) => {
        const maxDigits = field.maxLength > 0 ? field.maxLength : 11;

        field.addEventListener('input', () => {
            const filtered = digitsOnly(field.value).slice(0, maxDigits);
            // Written back only when it actually differs: assigning .value
            // drops the caret to the end of the box, and every accepted
            // keystroke would otherwise pay that for nothing.
            if (filtered !== field.value) field.value = filtered;
        });

        field.addEventListener('paste', (e) => {
            const clipboard = e.clipboardData || window.clipboardData;
            // No clipboard data to read (older Safari): let the browser
            // paste and leave it to the input handler above, which still
            // filters whatever lands.
            if (!clipboard) return;
            e.preventDefault();

            const pasted = digitsOnly(clipboard.getData('text'));
            // Respects the caret and any selection, so a paste into the
            // middle of a half-typed number behaves like a normal paste.
            const start = field.selectionStart ?? field.value.length;
            const end = field.selectionEnd ?? field.value.length;
            const next = (field.value.slice(0, start) + pasted + field.value.slice(end)).slice(0, maxDigits);
            field.value = next;
            const caret = Math.min(start + pasted.length, next.length);
            field.setSelectionRange(caret, caret);

            // Assigning .value fires nothing, so a paste has to announce
            // itself with its own input event (nothing here currently
            // listens for it, unlike signup's per-field error clearing, but
            // this keeps the two implementations identical rather than
            // dropping a line signup's copy relies on).
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
    });

    // ------------------------------------------------------------------
    // Change Password — verify the current password before entering step 2,
    // then enforce the same policy as Sign Up before updating the password.
    // ------------------------------------------------------------------
    const pwStepPanels = document.querySelectorAll('[data-dash-pw-step]');
    const pwStepIndicators = document.querySelectorAll('[data-dash-pw-step-indicator]');
    const pwBackBtn = document.querySelector('[data-dash-pw-back]');
    const pwNextBtn = document.querySelector('[data-dash-pw-next]');
    const passwordSaveBtn = document.querySelector('[data-dash-settings-save="password"]');
    const pwCurrentInput = document.querySelector('[data-dash-pw-current]');
    const pwNewInput = document.querySelector('[data-dash-pw-new]');
    const pwConfirmInput = document.querySelector('[data-dash-pw-confirm]');
    const pwRules = document.querySelector('[data-dash-pw-rules]');
    let pwVerificationInProgress = false;
    let pwSaveInProgress = false;
    let pwVerificationGeneration = 0;

    function checkDashPasswordPolicy(value) {
        const password = typeof value === 'string' ? value : '';
        return {
            length: password.length >= 8 && password.length <= 15,
            upper: /[A-Z]/.test(password),
            lower: /[a-z]/.test(password),
            number: /[0-9]/.test(password),
            // Keep in sync with includes/auth.js's explicit printable-ASCII special set.
            special: /[ !"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(password),
        };
    }

    function renderDashPasswordRules() {
        const checks = checkDashPasswordPolicy(pwNewInput?.value);
        pwRules?.querySelectorAll('[data-pw-rule]').forEach((item) => {
            const met = Boolean(checks[item.dataset.pwRule]);
            item.classList.toggle('is-met', met);
            item.setAttribute('aria-label', `${item.textContent.trim()}: ${met ? 'met' : 'not met'}`);
        });
        return Object.values(checks).every(Boolean);
    }

    async function verifyDashCurrentPassword() {
        try {
            const { data: { session }, error: sessionError } = await window.sb.auth.getSession();
            if (sessionError || !session?.user?.id || !session.user.email) throw new Error('Your sign-in session could not be verified. Please sign in again.');
            const expectedUserId = session.user.id;
            const { data, error } = await window.sb.auth.signInWithPassword({ email: session.user.email, password: pwCurrentInput.value });
            if (error) {
                window.InigoToast?.show('Current password is incorrect.', true);
                return false;
            }
            if (data?.user?.id !== expectedUserId) {
                await window.sb.auth.signOut();
                throw new Error('The verified account does not match this dashboard. Please sign in again.');
            }
            return true;
        } catch (error) {
            window.InigoToast?.show(error.message || 'Could not verify your current password.', true);
            return false;
        }
    }

    let pwWizardStep = 1;

    function renderPwWizard() {
        pwStepPanels.forEach((panel) => {
            panel.classList.toggle('is-active', Number(panel.dataset.dashPwStep) === pwWizardStep);
        });
        pwStepIndicators.forEach((el) => {
            const n = Number(el.dataset.dashPwStepIndicator);
            el.classList.toggle('is-current', n === pwWizardStep);
            el.classList.toggle('is-done', n < pwWizardStep);
            el.setAttribute('aria-current', n === pwWizardStep ? 'step' : 'false');
        });

        if (pwBackBtn) pwBackBtn.hidden = pwWizardStep !== 2;
        if (passwordSaveBtn) passwordSaveBtn.hidden = pwWizardStep !== 2;
        if (pwNextBtn) {
            pwNextBtn.hidden = pwWizardStep !== 1;
            pwNextBtn.disabled = pwVerificationInProgress || !(pwCurrentInput && pwCurrentInput.value !== '');
        }
        const validPassword = renderDashPasswordRules();
        if (passwordSaveBtn) passwordSaveBtn.disabled = pwWizardStep !== 2 || !validPassword || !pwNewInput?.value || pwNewInput.value !== pwConfirmInput?.value || pwVerificationInProgress || pwSaveInProgress;
    }

    function goToPwStep(step) {
        pwWizardStep = step === 2 ? 2 : 1;
        renderPwWizard();
    }

    function invalidateDashPwVerification() {
        pwVerificationGeneration += 1;
        pwVerificationInProgress = false;
        pwSaveInProgress = false;
        if (pwNextBtn) pwNextBtn.textContent = 'Next';
    }

    [pwCurrentInput, pwNewInput, pwConfirmInput].forEach((input) => input?.addEventListener('input', () => {
        if (pwCurrentInput === input && (pwVerificationInProgress || pwSaveInProgress)) invalidateDashPwVerification();
        renderPwWizard();
    }));
    if (pwNextBtn) {
        pwNextBtn.addEventListener('click', async () => {
            if (pwNextBtn.disabled || !window.sb || !pwCurrentInput?.value) return;
            const generation = ++pwVerificationGeneration;
            pwVerificationInProgress = true;
            pwNextBtn.textContent = 'Verifying…';
            renderPwWizard();
            const verified = await verifyDashCurrentPassword();
            if (generation !== pwVerificationGeneration) return;
            pwVerificationInProgress = false;
            pwNextBtn.textContent = 'Next';
            renderPwWizard();
            if (verified) goToPwStep(2);
        });
    }
    if (pwBackBtn) {
        pwBackBtn.addEventListener('click', () => {
            invalidateDashPwVerification();
            goToPwStep(1);
        });
    }

    // Establishes the correct initial hidden/disabled state for the nav
    // buttons (matching the `disabled`/`hidden` attributes already baked
    // into the markup as a no-JS baseline) and paints the step-1 indicator.
    renderPwWizard();

    if (passwordSaveBtn) {
        passwordSaveBtn.addEventListener('click', async () => {
            if (passwordSaveBtn.disabled) return;
            if (!window.sb || !window.inigosyncProfile) return;
            const currentPassword = pwCurrentInput?.value;
            const newPassword = pwNewInput?.value;
            const confirmPassword = pwConfirmInput?.value;

            if (!currentPassword) {
                window.InigoToast?.show('Enter your current password.', true);
                goToPwStep(1);
                return;
            }
            if (!renderDashPasswordRules()) {
                window.InigoToast?.show('New password must be 8–15 characters and include an uppercase letter, a lowercase letter, a number and a special character.', true);
                return;
            }
            if (newPassword !== confirmPassword) {
                window.InigoToast?.show('Passwords do not match.', true);
                return;
            }
            pwSaveInProgress = true;
            const generation = ++pwVerificationGeneration;
            renderPwWizard();
            const confirmed = await confirmSettingsChange('Are you sure you want to update your password?');
            if (generation !== pwVerificationGeneration) {
                renderPwWizard();
                return;
            }
            if (!confirmed) {
                pwSaveInProgress = false;
                renderPwWizard();
                return;
            }

            // "Current password" used to be collected and never checked —
            // any hijacked or left-open session could silently take over
            // the account via updateUser(). Re-authenticating with it first
            // (Supabase has no separate "verify password" call) confirms
            // the person at the keyboard actually knows it before the
            // password is changed.
            const verified = await verifyDashCurrentPassword();
            if (generation !== pwVerificationGeneration) {
                renderPwWizard();
                return;
            }
            if (!verified) {
                pwSaveInProgress = false;
                renderPwWizard();
                goToPwStep(1);
                return;
            }

            try {
                const { error } = await window.sb.auth.updateUser({ password: newPassword });
                if (error) throw error;
            } catch (error) {
                window.InigoToast?.show(error.message || 'Could not update your password.', true);
                pwSaveInProgress = false;
                renderPwWizard();
                return;
            }

            [pwCurrentInput, pwNewInput, pwConfirmInput].forEach((input) => { if (input) input.value = ''; });
            pwSaveInProgress = false;
            goToPwStep(1);
            renderPwWizard();
            window.InigoToast?.show('Password updated.');
        });
    }

});
