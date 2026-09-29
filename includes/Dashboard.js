// IñigoSync — Customer Dashboard controller
// Handles: sidebar/topbar panel switching, mobile sidebar toggle, profile
// dropdown, the notifications dropdown, the feedback modal, the Overview
// panel's sport-grouped, sport-sorted court cards (marketing/showcase only —
// each with a per-unit combo box + swappable photo, plus the read-only
// real-time slot-peek widget from PR #1), the 3-step Book a Court wizard
// (with its dynamic court preview image), time-slot and payment-option
// selection with a live summary recalculation, My Bookings (no
// cancellation), the Receipts panel's per-booking cards + PNG download,
// Account Settings' name-part fields, and the 2-step Change Password
// wizard.
//
// This file implements Phase 1 (§1 nav, §2 feedback, §3 notifications, §4
// dashboard courts — implementation_plan.md decisions D1/D2/D6/D7), Phase 2
// (§5 booking wizard, §6 my-bookings chip removal, §7 receipts, §9 account
// settings — decisions D3/D4/D5/D8) of the redesign in
// InigoSync_Dashboard_Feedback_v6.md, AND "Revision 2" (implementation_plan.md,
// decisions R1-R6 — post-feedback-v6 corrections):
//   R1 — the Overview Courts section is re-scoped to marketing/showcase
//        only: no "Book Now" button, no click-to-book hand-off from peek
//        slots. Peek slots stays as a READ-ONLY availability display (the
//        user explicitly praised it) — see renderOverviewSlotPill() and the
//        Overview Courts widget's header comment further below.
//   R2 — the courts sort <select> defaults to grouping-by-sport
//        (overviewSortMode), with "Available first"/"Price: Low to High"
//        retained as alternatives that sort *within* each sport group.
//   R3 — My Bookings drops cancellation entirely (no Cancel control
//        anywhere) in favor of the real no-cancellation/no-refund/
//        30-minute-"Unattended" policy stated in
//        Pages/user_dashboard.html's two policy notices.
//   R4 — "Unattended" is DERIVED for display only, never written to the
//        database — see displayStatusFor() further below for the full
//        reasoning (booking.status's CHECK constraint, the 23514 error
//        branch on the booking INSERT below, and why this can't safely be
//        persisted from this repo).
//   R5 — Receipts renders one real card per booking (every booking, not
//        just ones with a payment_id) instead of a hardcoded empty state —
//        see renderReceipts() further below.
//
// Booking (including its court dropdown), the Overview panel's court
// widget, My Bookings, Receipts, Profile, and Settings talk to the real
// Supabase database — Booking's court options and the Overview widget's
// cards both read the same `court`/`sport` tables via window.InigoCourtsData
// (includes/courtsData.js; see docs/QA_AUDIT_REPORT.md P0#8). The
// per-unit combo box + photo swap on each Overview court card AND the
// Booking wizard's Step 1 preview are both built from
// window.InigoCourtsData.resolveCourtUnits(), ported from
// includes/landingPage.js into includes/courtsData.js (implementation_plan.md
// D2) so that file stays untouched. Notifications are derived from the
// customer's own `booking` rows (no `notification` table — D6). Feedback
// writes to the new `feedback` table (database/schema/009_feedback.sql),
// failing honestly with a toast if that migration hasn't been applied yet.
// Receipts (Revision 2, R5) render one card per booking, reusing
// refreshMyBookings()'s own fetch rather than a second query — rate/amount
// shows "Rate TBA" whenever a unit's price is genuinely unknown. Account Settings' three
// name boxes read/write profiles.first_name/middle_name/last_name
// (database/schema/008_profile_name_parts.sql) while keeping full_name — the
// column the owner/staff dashboards still read — in sync (D3). Everything
// else here (panel switching, hero carousel) is UI-only, same as before.

document.addEventListener('DOMContentLoaded', () => {
    const panels = document.querySelectorAll('[data-dash-panel]');
    const navButtons = document.querySelectorAll('[data-dash-nav]');
    const titleEl = document.querySelector('[data-dash-title]');
    const subtitleEl = document.querySelector('[data-dash-subtitle]');
    // D8/D9 (implementation_plan.md "Revision 5") — the slim dashboard-only
    // footer; see setActivePanel() below for the visibility rule and the
    // "Footer" section further down for its Operating-hours text fill.
    const dashFooter = document.querySelector('[data-dash-footer]');

    const panelMeta = {
        overview: { title: 'Dashboard', subtitle: "Welcome back, here's what's happening with your bookings." },
        // 'courts' removed (§1/D1) — the standalone Courts panel is gone;
        // its content now lives inside 'overview' (§4/D2), which already has
        // its own entry above.
        booking: { title: 'Book a Court', subtitle: 'Follow the 3 simple steps below to reserve your schedule.' },
        bookings: { title: 'My Bookings', subtitle: "Track the status of every reservation you've made." },
        receipts: { title: 'Booking summaries', subtitle: '' },
        profile: { title: 'My Profile', subtitle: 'Your personal details and booking history at a glance.' },
        settings: { title: 'Account Settings', subtitle: 'Update your personal details and manage your password.' },
    };

    function setActivePanel(name) {
        panels.forEach((panel) => {
            panel.classList.toggle('is-active', panel.dataset.dashPanel === name);
        });

        // Every navigation into the Booking panel (sidebar link, hero "Book
        // this slot", the Overview card's quick action, etc.) starts the
        // §5/D5 wizard fresh at Step 1 — a guided flow that silently resumed
        // wherever a PREVIOUS visit left off would be confusing, not guided.
        // Revision 2's R1 (implementation_plan.md) removed the two hand-offs
        // that used to need a different landing step (the Overview court
        // cards' "Book Now" button, and peek slots' click-to-book jump to
        // Step 3): the Overview Courts section is marketing/showcase only
        // now, so nothing outside this wizard pre-fills a court/date/time
        // anymore — every entry point always starts here, at Step 1.
        if (name === 'booking') goToBookStep(1);

        document.querySelectorAll('[data-dash-nav]').forEach((btn) => {
            // Only sidebar links get the highlighted state (topbar/profile
            // menu shortcuts to the same panel shouldn't visually toggle).
            if (btn.closest('.dash-nav')) {
                btn.classList.toggle('is-active', btn.dataset.dashNav === name);
            }
        });

        const meta = panelMeta[name];
        if (meta && titleEl && subtitleEl) {
            titleEl.textContent = meta.title;
            subtitleEl.textContent = meta.subtitle;
        }

        // D8 (implementation_plan.md, "Revision 5") — the slim dashboard
        // footer (D9) is visible ONLY on the Overview tab; every other
        // panel hides it entirely, including a notification's own deep
        // link into Receipts (setActivePanel('receipts'), wired near the
        // notifications dropdown above) — it is never left showing on a
        // tab it wasn't designed for.
        if (dashFooter) dashFooter.hidden = name !== 'overview';

        closeMobileSidebar();
        closeProfileMenu();
        closeNotifMenu();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    navButtons.forEach((btn) => {
        btn.addEventListener('click', () => setActivePanel(btn.dataset.dashNav));
    });

    // ------------------------------------------------------------------
    // Mobile sidebar toggle
    // ------------------------------------------------------------------
    const mobileToggle = document.querySelector('[data-dash-mobile-toggle]');
    const scrim = document.querySelector('[data-dash-scrim]');

    function closeMobileSidebar() {
        document.body.classList.remove('dash-sidebar-open');
    }

    if (mobileToggle) {
        mobileToggle.addEventListener('click', () => {
            document.body.classList.toggle('dash-sidebar-open');
        });
    }
    if (scrim) {
        scrim.addEventListener('click', closeMobileSidebar);
    }

    // ------------------------------------------------------------------
    // Footer: opening hours vary by date and come from the same server rules
    // used by booking availability. Avoid presenting the fallback defaults
    // as a daily schedule here.
    // ------------------------------------------------------------------
    const dashFooterHoursEl = document.querySelector('[data-dash-footer-hours]');
    if (dashFooterHoursEl) dashFooterHoursEl.textContent = 'Hours vary by day. Check the selected date before booking.';

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
    // same dot/auto-advance/pause-on-hover behaviour either way.
    // ------------------------------------------------------------------
    const heroEl = document.querySelector('[data-dash-hero]');

    if (heroEl) {
        const heroContainer = heroEl.querySelector('.dash-hero-container');
        const heroDotsContainer = heroEl.querySelector('.dash-hero-dots');
        const heroPrefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        let heroIndex = 0;
        let heroTimer = null;

        // Re-queried on every call rather than captured once at parse time —
        // renderHeroSlidesFromEvents() below may have just replaced
        // heroContainer/heroDotsContainer's entire innerHTML with real data,
        // and this is only ever wired up ONCE regardless of which content
        // (static fallback or fetched) ends up in the DOM (see
        // loadHeroSlides() at the bottom of this block), so there's no risk
        // of double-registering the hover/focus listeners below.
        function wireHeroCarousel() {
            const heroSlides = heroEl.querySelectorAll('[data-dash-hero-slide]');
            const heroDots = heroEl.querySelectorAll('[data-dash-hero-dot]');
            if (heroSlides.length === 0) return;

            function updateHeroSlide(newIndex, skipTimer = false) {
                if (newIndex >= heroSlides.length) newIndex = 0;
                if (newIndex < 0) newIndex = heroSlides.length - 1;

                heroSlides.forEach((s) => s.classList.remove('is-active'));
                heroDots.forEach((d) => {
                    d.classList.remove('is-active');
                    d.setAttribute('aria-current', 'false');
                });

                heroSlides[newIndex].classList.add('is-active');
                heroDots[newIndex].classList.add('is-active');
                heroDots[newIndex].setAttribute('aria-current', 'true');

                heroIndex = newIndex;

                if (!skipTimer) {
                    clearHeroAutoplay();
                    startHeroAutoplay();
                }
            }

            function startHeroAutoplay() {
                if (heroPrefersReducedMotion) return;
                heroTimer = setInterval(() => {
                    updateHeroSlide(heroIndex + 1, true);
                }, 5000);
            }

            function clearHeroAutoplay() {
                if (heroTimer) {
                    clearInterval(heroTimer);
                    heroTimer = null;
                }
            }

            heroDots.forEach((dot, index) => {
                dot.addEventListener('click', () => updateHeroSlide(index));
            });

            heroEl.addEventListener('mouseenter', clearHeroAutoplay);
            heroEl.addEventListener('mouseleave', startHeroAutoplay);
            heroEl.addEventListener('focusin', clearHeroAutoplay);
            heroEl.addEventListener('focusout', () => {
                setTimeout(() => {
                    if (!heroEl.contains(document.activeElement)) startHeroAutoplay();
                }, 0);
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
            if (!heroContainer || !heroDotsContainer) return;

            heroContainer.innerHTML = events.map((ev, i) => {
                const activeClass = i === 0 ? ' is-active' : '';
                const title = window.escapeHtml(ev.title || '');
                const tag = window.escapeHtml(ev.tag || 'Featured');
                const meta = window.escapeHtml(ev.meta || '');
                const media = (ev.image_url && isSafeHeroImageUrl(ev.image_url))
                    ? `<img src="${window.escapeHtml(ev.image_url)}" alt="${title}" class="dash-hero-image" loading="${i === 0 ? 'eager' : 'lazy'}">`
                    : `<div class="dash-hero-image" aria-hidden="true" style="background: linear-gradient(135deg, var(--color-bg-elevated), var(--color-bg-card));"></div>`;
                return `
                    <article class="dash-hero-slide${activeClass}" data-dash-hero-slide="${i}">
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

            heroDotsContainer.innerHTML = events.map((_, i) => {
                const activeClass = i === 0 ? ' is-active' : '';
                return `<button type="button" class="dash-hero-dot${activeClass}" data-dash-hero-dot="${i}" aria-label="Slide ${i + 1}" aria-current="${i === 0 ? 'true' : 'false'}"></button>`;
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
            } else {
                profile.setAttribute('data-open', '');
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
    const notifSearch = document.querySelector('[data-dash-notif-search]');
    const notifUnread = document.querySelector('[data-dash-notif-unread]');
    const notifPagination = document.querySelector('[data-dash-notif-pagination]');
    const notifPageLabel = document.querySelector('[data-dash-notif-page]');
    const NOTIF_LIMIT = 10;
    let notifPage = 0;
    let notifTotalCount = 0;
    let notifSearchTimer = null;
    let notifGeneration = 0;

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
        notifList.innerHTML = '<p class="dash-notif-empty">Loading notifications…</p>';
        try {
            const { data, error } = await window.sb.rpc('customer_list_notifications', {
                p_search: notifSearch?.value.trim() || '',
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
            const persistentHtml = persistentItems.map(item => `<button type="button" class="dash-notif-item dash-notif-persistent${item.read_at ? ' is-read' : ' is-unread'}" data-dash-notif-key="${window.escapeHtml(item.key)}" data-dash-notif-href="${window.escapeHtml(item.href)}"><span class="dash-notif-dot ${window.escapeHtml(item.category.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))}" aria-hidden="true"></span><span class="dash-notif-item-body"><strong>${window.escapeHtml(item.title)}</strong><span>${window.escapeHtml(item.body)}</span><small>${window.escapeHtml(item.category)} · ${window.escapeHtml(notificationTime(item.created_at))} · ${item.read_at ? 'Read' : 'Unread'}</small></span></button>`).join('');
            notifList.innerHTML = persistentHtml || '<p class="dash-notif-empty">No notifications match your search.</p>';
            const unreadCount = Number(result.unread_count) || 0;
            if (notifUnread) notifUnread.textContent = unreadCount ? `${unreadCount} unread` : '';
            if (notifDot) notifDot.hidden = unreadCount === 0;
            if (notifPagination) notifPagination.hidden = notifTotalCount <= NOTIF_LIMIT;
            if (notifPageLabel) notifPageLabel.textContent = `Page ${notifPage + 1} of ${Math.max(1, Math.ceil(notifTotalCount / NOTIF_LIMIT))}`;
            const prev = document.querySelector('[data-dash-notif-prev]');
            const next = document.querySelector('[data-dash-notif-next]');
            if (prev) prev.disabled = notifPage === 0;
            if (next) next.disabled = (notifPage + 1) * NOTIF_LIMIT >= notifTotalCount;
        } catch (error) {
            if (generation !== notifGeneration) return;
            console.error('[dashboard] notifications could not be loaded', error);
            notifList.innerHTML = '<p class="dash-notif-empty">Notifications could not be loaded. Try again.</p>';
            if (notifDot) notifDot.hidden = true;
        }
    }

    notifSearch?.addEventListener('input', () => {
        if (notifSearchTimer) window.clearTimeout(notifSearchTimer);
        notifPage = 0;
        notifSearchTimer = window.setTimeout(loadCustomerNotifications, 250);
    });
    document.querySelector('[data-dash-notif-prev]')?.addEventListener('click', () => { if (notifPage > 0) { notifPage -= 1; loadCustomerNotifications(); } });
    document.querySelector('[data-dash-notif-next]')?.addEventListener('click', () => { if ((notifPage + 1) * NOTIF_LIMIT < notifTotalCount) { notifPage += 1; loadCustomerNotifications(); } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadCustomerNotifications(); });
    document.addEventListener('inigosync:profile-ready', loadCustomerNotifications);
    window.setInterval(() => { if (!document.hidden) loadCustomerNotifications(); }, 60000);

    if (notifList) {
        notifList.addEventListener('click', (e) => {
            const persistent = e.target.closest('[data-dash-notif-key]');
            if (persistent) {
                const key = persistent.dataset.dashNotifKey;
                persistent.disabled = true;
                window.sb.rpc('mark_notification_read', { p_key: key }).then(({ data, error }) => {
                    if (error || data === false) throw error || new Error('Notification could not be marked read.');
                    const href = persistent.dataset.dashNotifHref || '';
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
                    persistent.disabled = false;
                    console.error('[dashboard] notification read state could not be saved', error);
                    window.InigoToast?.show('Could not mark notification as read.', true);
                });
                return;
            }
        });
    }

    // ------------------------------------------------------------------
    // Theme toggle — includes/theme.js manages the data-theme attribute
    // and persistence; this just wires the topbar button to it and keeps
    // the sun/moon icon in sync.
    // ------------------------------------------------------------------
    const themeToggleBtn = document.querySelector('[data-theme-toggle]');
    function syncThemeToggleUI(theme) {
        if (!themeToggleBtn) return;
        const isLight = theme === 'light';
        themeToggleBtn.setAttribute('aria-pressed', String(isLight));
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
    // migration's own header comment. bookingState.time (a single "8:00 AM"
    // string) is gone, replaced by bookingState.startHour/endHour (24-hour
    // integers) and bookingState.unit (the Step 1 preview's resolved
    // Court/Lane/Table label, D3 — persisted now instead of thrown away).
    // Revision 5, D3 further replaced the clickable button grid itself with
    // a From/To <select> pair — see that section's own header comment
    // further below for the full reasoning.
    // ------------------------------------------------------------------
    if (!window.InigoBusinessHours) {
        // Should never happen — includes/businessHours.js must load before
        // this file (see the <script> order in Pages/user_dashboard.html).
        console.error('[dashboard] window.InigoBusinessHours is missing — check that includes/businessHours.js loads before includes/Dashboard.js.');
    }

    const bookSelect = document.querySelector('[data-dash-book-select]');
    const bookDate = document.querySelector('[data-dash-book-date]');
    // Revision 5, D3 (implementation_plan.md) — the old clickable slot grid
    // is gone; Step 2 is now a From/To time-range picker whose OPTIONS are
    // rendered into these two (initially empty) <select>s by
    // renderTimePickers() below, one <option> per still-free bookable hour,
    // re-filled on every repaint (same idiom this file's
    // wireOverviewCourtList() already uses for its own dynamically rendered
    // scope further below). bookOpenWindowsEl is the "Open on this date: …"
    // status line underneath both selects.
    const bookFromSelect = document.querySelector('[data-dash-book-from]');
    const bookToSelect = document.querySelector('[data-dash-book-to]');
    const bookOpenWindowsEl = document.querySelector('[data-dash-book-open-windows]');
    const paymentOptions = document.querySelectorAll('[data-dash-payment-option]');
    const paymentModeOptions = document.querySelectorAll('[data-dash-pay-mode-option]');
    const paymentModeRadios = document.querySelectorAll('[data-dash-pay-mode]');
    const paymentModeHint = document.querySelector('[data-dash-pay-mode-hint]');
    const onlineModeLabel = document.querySelector('[data-dash-online-mode-label]');
    const bookSubmit = document.querySelector('[data-dash-book-submit]');
    const bookAddButton = document.querySelector('[data-dash-book-add]');
    const bookCartPanel = document.querySelector('[data-dash-book-cart]');
    const bookCartItemsEl = document.querySelector('[data-dash-book-cart-items]');
    const bookCartCountEl = document.querySelector('[data-dash-book-cart-count]');
    const bookCartSubmit = document.querySelector('[data-dash-book-cart-submit]');

    // Defaults the date input to TODAY and floors it there (Part 3 — this
    // input used to carry a hardcoded value="2026-07-14" with no `min`,
    // silently allowing a past date to be "booked"). Computed from local
    // Y/M/D, not toISOString().slice(0,10) — that reads UTC, which for a PH
    // user (UTC+8) rolls over to the WRONG calendar date for roughly the
    // first 8 hours of every local day. Must run before bookingState below
    // reads bookDate.value as its own initial date.
    function todayDateInputValue() {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    if (bookDate) {
        const todayStr = todayDateInputValue();
        bookDate.min = todayStr;
        if (!bookDate.value || bookDate.value < todayStr) bookDate.value = todayStr;
    }

    const summaryCourt = document.querySelector('[data-dash-summary-court]');
    const summaryDate = document.querySelector('[data-dash-summary-date]');
    const summaryTime = document.querySelector('[data-dash-summary-time]');
    const summaryRate = document.querySelector('[data-dash-summary-rate]');
    const summaryPayment = document.querySelector('[data-dash-summary-payment]');
    const summaryTotal = document.querySelector('[data-dash-summary-total]');
    const rateQuantityWrap = document.querySelector('[data-dash-rate-quantity-wrap]');
    const rateQuantityInput = document.querySelector('[data-dash-rate-quantity]');

    // Wizard chrome (§5, D5) — step panels, the step indicator, and the
    // Back/Next nav row. See renderBookWizard()/goToBookStep() below for the
    // state machine; kept as plain DOM lookups here, same shape as every
    // other *Select/*Date/etc. const on this page.
    const bookStepPanels = document.querySelectorAll('[data-dash-book-step]');
    const bookStepIndicators = document.querySelectorAll('[data-dash-book-step-indicator]');
    const bookBackBtn = document.querySelector('[data-dash-book-back]');
    const bookNextBtn = document.querySelector('[data-dash-book-next]');
    const BOOK_STEP_COUNT = bookStepPanels.length || 3;

    // Step 1's dynamic court preview (§5 "Dynamic Court Preview", D5) — the
    // same img-vs-"Photo coming soon" placeholder mechanism the Overview
    // panel's court cards use (courtPhotoMarkup()/resolveCourtUnits(),
    // §4/D2), reused here rather than reimplemented. See paintBookPreview()
    // below.
    const bookPreviewMedia = document.querySelector('[data-dash-book-preview-media]');
    const bookUnitWrap = document.querySelector('[data-dash-book-unit-wrap]');
    const bookUnitLabel = document.querySelector('[data-dash-book-unit-label]');
    const bookUnitSelect = document.querySelector('[data-dash-book-unit-select]');

    // court/rate start empty/null — the real <select> options (and their
    // data-rate) only exist once window.InigoCourtsData.getCourts() resolves
    // below (populateBookSelect). Every court's rate is NULL in the live DB
    // today (the owner hasn't confirmed prices yet — see
    // database/seed/002_seed_content.sql), so "unknown rate" has to be a
    // first-class state here, not an assumed 300. `sport` is the selected
    // court's REAL related sport (e.g. "Bowling" for the "Bowling —
    // Duckpin" court, not a copy of the court name) — booking.sports is
    // NOT NULL, so this must never still be empty by the time a booking is
    // submitted; see the insert below. `unit` is the Step 1 preview's
    // currently resolved Court/Lane/Table label (window.InigoCourtsData
    // .resolveCourtUnits(), kept in sync by paintBookPreview() below) — used
    // to be preview-only (the chosen unit never left the DOM); Part 3/D3
    // persists it, since availability/overlap is checked PER UNIT, not per
    // sport (booking two different Basketball courts must not conflict with
    // each other). `startHour`/`endHour` (24-hour integers, or null before
    // anything is picked) replace the old single `time` string — set by the
    // From/To <select>s' own change handlers below (Revision 5, D3).
    let bookingState = {
        court: '',
        sport: '',
        rate: null,
        rateUnit: '/hr',
        rateDay: null,
        rateNight: null,
        rateQuantity: 1,
        nightRateStartsAt: null,
        date: bookDate ? bookDate.value : '',
        unit: null,
        unitId: null,
        startHour: null,
        endHour: null,
        paymentType: 'downpayment',
        paymentMode: 'online',
        gcashEnabled: true,
        // Overwritten once window.InigoAppSettings.getSettings() resolves
        // below — 50 is the same fallback that module itself uses when
        // `app_settings` doesn't exist yet, so this default is never
        // visibly wrong, just possibly stale for a moment on first load.
        downpaymentPct: window.InigoAppSettings ? window.InigoAppSettings.DEFAULT_SETTINGS.downpaymentPct : 50,
    };
    const bookingCart = [];
    let bookingCartSeq = 0;
    let bookingCartSaving = false;

    const downpaymentDesc = document.querySelector('[data-dash-payment-desc="downpayment"]');

    // ------------------------------------------------------------------
    // Step 1 dynamic court preview (§5, D5) — bookCourtsCache holds the same
    // normalized court objects populateBookSelect() below receives from
    // window.InigoCourtsData.getCourts() (quantity/unit/unitImages included,
    // unlike the <select>'s own <option data-*> attributes, which only carry
    // rate/rateUnit/sport), so a court can be looked up by name whenever the
    // preview needs to repaint. bookSelectedUnitIndex resets to 0 every time
    // the COURT changes (a new court's units always start at its first one);
    // there's only ever one active preview on this panel, unlike the
    // Overview cards' per-court overviewSelectedUnitIndex map.
    // ------------------------------------------------------------------
    let bookCourtsCache = [];
    let bookSelectedUnitIndex = 0;

    function findBookCourt(name) {
        return bookCourtsCache.find((c) => c.name === name) || null;
    }

    // Repaints the preview image + unit combo box for `court` (or a neutral
    // "select a court" placeholder when none is known yet — e.g. before
    // window.InigoCourtsData.getCourts() resolves). Reuses
    // courtPhotoMarkup()/window.InigoCourtsData.resolveCourtUnits() exactly
    // as renderOverviewCourtCard() does further below (§4/D2) rather than a
    // second implementation — see that function's own header comment for
    // why "no photo yet" always renders the honest "Photo coming soon"
    // placeholder instead of a broken <img> or an invented URL. Also the
    // ONE place that keeps bookingState.unit in sync (Part 3/D3) — every
    // caller below (bookSelect's court change, the unit <select>'s own
    // change, and populateBookSelect()'s initial paint) always goes through
    // here, so Step 2's per-unit availability check can never see a stale
    // unit.
    function paintBookPreview(court, unitIndexOverride) {
        if (!bookPreviewMedia) return;

        if (!court) {
            bookPreviewMedia.innerHTML = '<span class="dash-court-monogram" aria-hidden="true">?<small class="dash-court-photo-soon">Select a court to preview it</small></span>';
            if (bookUnitWrap) bookUnitWrap.hidden = true;
            if (bookUnitSelect) bookUnitSelect.innerHTML = '';
            bookingState.unit = null;
            bookingState.unitId = null;
            return;
        }

        const resolved = window.InigoCourtsData
            ? window.InigoCourtsData.resolveCourtUnits(court)
            : { pickerLabel: '', units: [{ label: null, imageUrl: court.imageUrl }] };
        const units = resolved.units.length ? resolved.units : [{ label: null, imageUrl: court.imageUrl }];
        const hasChoice = units.length > 1;

        const index = Math.min(Math.max(0, unitIndexOverride !== undefined ? unitIndexOverride : bookSelectedUnitIndex), units.length - 1);
        bookSelectedUnitIndex = index;
        const unit = units[index];
        // Null only in the rare "quantity 0, no unit_images" fallback (see
        // window.InigoCourtsData.resolveCourtUnits()) — a real data gap, not
        // an error; fetchDayOccupancy()/the insert below both treat a null
        // unit as "nothing to disambiguate", same as a legacy pre-Part-3
        // booking.
        bookingState.unit = unit.label;
        bookingState.unitId = unit.id || null;
        bookingState.rateDay = unit.rateDay ?? null;
        bookingState.rateNight = unit.rateNight ?? null;
        bookingState.rateUnit = (typeof unit.rateDay === 'number' || typeof unit.rateNight === 'number') ? (unit.rateUnit || court.rateUnit || '/hr') : (court.rateUnit || '/hr');
        bookingState.rate = unit.rate ?? court.rate ?? null;

        const monogram = window.InigoCourtsData ? window.InigoCourtsData.monogramFor(court.sportSlug, court.name) : '?';
        const alt = unit.label ? `${court.name} — ${unit.label}` : court.name;
        bookPreviewMedia.innerHTML = courtPhotoMarkup(unit, monogram, alt);

        // Same broken-photo-URL fallback as paintOverviewCourtMedia() below
        // — a typo'd unit_images URL degrades to the placeholder instead of
        // a broken-image icon.
        const img = bookPreviewMedia.querySelector('img[data-overview-court-photo]');
        if (img) {
            img.addEventListener('error', () => {
                img.remove();
                bookPreviewMedia.insertAdjacentHTML('afterbegin', courtPhotoMarkup({ imageUrl: null }, monogram, alt));
            }, { once: true });
        }

        if (bookUnitWrap) bookUnitWrap.hidden = !hasChoice;
        if (bookUnitLabel) bookUnitLabel.textContent = resolved.pickerLabel || 'Choose a unit';
        if (bookUnitSelect) {
            bookUnitSelect.innerHTML = units.map((u, i) => `<option value="${i}"${i === index ? ' selected' : ''}>${window.escapeHtml(u.label || `${court.name} ${i + 1}`)}</option>`).join('');
        }
    }

    // Looks up bookingState.court's full record and repaints the preview
    // from scratch (unit reset to its first one) — the one call site every
    // "the selected court just changed" path below uses, so the preview can
    // never fall out of sync with bookingState.
    function syncBookPreviewFromState() {
        bookSelectedUnitIndex = 0;
        paintBookPreview(findBookCourt(bookingState.court), 0);
    }

    if (bookUnitSelect) {
        bookUnitSelect.addEventListener('change', () => {
            const court = findBookCourt(bookingState.court);
            if (!court) return;
            // Unit choice used to be preview-only — it repainted the photo
            // and nothing else. Part 3/D3 makes it meaningful: a different
            // unit can have entirely different availability, so any
            // in-progress Step 2 selection is cleared and the From/To
            // pickers re-fetched for the newly chosen unit
            // (resetTimeSelectionAndRender(), defined with the rest of the
            // time-picker machinery below — hoisted, safe to call from
            // here).
            paintBookPreview(court, Number(bookUnitSelect.value) || 0);
            resetTimeSelectionAndRender();
            updateSummary();
        });
    }
    if (rateQuantityInput) rateQuantityInput.addEventListener('input', () => {
        const n = Math.max(1, Math.min(100, Number.parseInt(rateQuantityInput.value, 10) || 1));
        bookingState.rateQuantity = n;
        rateQuantityInput.value = String(n);
        if (bookingState.rateUnit === '/set' && bookingState.startHour !== null) {
            bookingState.endHour = bookingState.startHour + n - 1;
            if (Array.from({ length: n }, (_, i) => bookingState.startHour + i).some((hour) =>
                slotHourStatus(hour) !== 'available')) {
                bookingState.endHour = null;
            }
            renderTimePickers();
        }
        updateSummary();
    });

    // ------------------------------------------------------------------
    // Wizard step machine (§5, D5) — one step visible at a time, a step
    // indicator, and Back/Next with Next gated on that step's required
    // field ("step 1 needs a court, step 2 needs a date+slot" per the spec).
    // Step 3 has no Next of its own — its own "Request Booking" button
    // (bookSubmit, wired further below) is the wizard's final action.
    // ------------------------------------------------------------------
    let bookWizardStep = 1;

    function bookStepIsReady(step) {
        if (step === 1) return Boolean(bookingState.court);
        // Revision 5, D3 (implementation_plan.md) — both From AND To must
        // now be chosen, even for a 1-hour booking (From = 8:00 AM, To =
        // 9:00 AM). The old "a single clicked hour is already a complete
        // 1-hour booking" rule is gone along with the clickable slot grid
        // it belonged to — there is nothing to click any more, only two
        // explicit <select>s (see renderTimePickers() below), and Next
        // stays disabled until both hold a real value.
        if (step === 2) return Boolean(bookingState.date) && bookingState.startHour !== null && bookingState.endHour !== null;
        return true;
    }

    function renderBookWizard() {
        bookStepPanels.forEach((panel) => {
            panel.classList.toggle('is-active', Number(panel.dataset.dashBookStep) === bookWizardStep);
        });
        bookStepIndicators.forEach((el) => {
            const n = Number(el.dataset.dashBookStepIndicator);
            el.classList.toggle('is-current', n === bookWizardStep);
            el.classList.toggle('is-done', n < bookWizardStep);
            el.setAttribute('aria-current', n === bookWizardStep ? 'step' : 'false');
        });

        if (bookBackBtn) bookBackBtn.hidden = bookWizardStep === 1;
        if (bookNextBtn) {
            bookNextBtn.hidden = bookWizardStep === BOOK_STEP_COUNT;
            bookNextBtn.disabled = !bookStepIsReady(bookWizardStep);
        }
    }

    function goToBookStep(step) {
        bookWizardStep = Math.min(Math.max(1, step), BOOK_STEP_COUNT);
        renderBookWizard();
        updateSummary();
        if (bookAddButton) bookAddButton.hidden = bookWizardStep !== BOOK_STEP_COUNT || !bookStepIsReady(2) || bookingCart.length >= 7;
    }

    if (bookNextBtn) {
        bookNextBtn.addEventListener('click', () => {
            if (bookNextBtn.disabled) return;
            goToBookStep(bookWizardStep + 1);
        });
    }
    if (bookBackBtn) {
        bookBackBtn.addEventListener('click', () => goToBookStep(bookWizardStep - 1));
    }

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

    // Number of whole hours in the currently chosen From/To range, or 0
    // before From is even chosen. Falls back to treating startHour as its
    // own 1-hour end whenever endHour is still null — that fallback is only
    // ever observed INSIDE Step 2's own transient state (e.g. From is
    // chosen but To isn't yet), since bookStepIsReady() (Revision 5, D3)
    // keeps the wizard from reaching Step 3's summary until BOTH From and
    // To hold a real value.
    function bookingHoursSelected() {
        if (bookingState.startHour === null) return 0;
        const effectiveEnd = bookingState.endHour !== null ? bookingState.endHour : bookingState.startHour;
        return effectiveEnd - bookingState.startHour + 1;
    }

    // "8:00 AM – 12:00 PM · 4 hrs" (Part 3) — replaces the old single-slot
    // label (bookingState.time). Null before any hour is picked, same
    // "nothing selected yet" signal the old bookingState.time === null used
    // to give summaryTime's own fallback text below.
    function bookingTimeRangeLabel() {
        const hours = bookingHoursSelected();
        if (hours === 0) return null;
        const effectiveEnd = bookingState.endHour !== null ? bookingState.endHour : bookingState.startHour;
        const fmt = window.InigoBusinessHours.formatHourLabel;
        // effectiveEnd+1 is deliberate — a booking whose last clicked hour
        // is 11 (11 AM-12 PM) ENDS at 12, per this feature's "clicking 8
        // then 11 books 8:00-12:00" rule (implementation_plan.md).
        return `${fmt(bookingState.startHour)} – ${fmt(effectiveEnd + 1)} · ${hours} hr${hours === 1 ? '' : 's'}`;
    }

    function updateSummary() {
        const isFull = bookingState.paymentType === 'full';
        const pct = bookingState.downpaymentPct;
        const hours = bookingHoursSelected();
        // Part 3 — total now scales with hours selected (it used to always
        // be `rate × (pct or 1)`, i.e. hardcoded to exactly 1 hour, because
        // only one slot was ever selectable). Still null whenever the rate
        // itself is unknown (every court today — see hasKnownRate() above)
        // so this never invents a peso figure.
        const baseAmount = bookingState.rateUnit === '/set'
            ? (typeof bookingState.rateDay === 'number' ? bookingState.rateDay * bookingState.rateQuantity : null)
            : bookingHourlyAmount(hours);
        const amount = baseAmount !== null ? baseAmount * (isFull ? 1 : pct / 100) : null;

        if (summaryCourt) summaryCourt.textContent = bookingState.court || '—';
        if (rateQuantityWrap) rateQuantityWrap.hidden = bookingState.rateUnit !== '/set';
        if (summaryDate) summaryDate.textContent = formatDate(bookingState.date);
        if (summaryTime) summaryTime.textContent = bookingTimeRangeLabel() || '— Select a time —';
        if (summaryRate) summaryRate.textContent = bookingState.rateUnit === '/set' && typeof bookingState.rateDay === 'number'
            ? `₱${bookingState.rateDay}/set × ${bookingState.rateQuantity}`
            : (hasKnownRate() ? (typeof bookingState.rateDay === 'number' && typeof bookingState.rateNight === 'number' && bookingState.rateDay !== bookingState.rateNight
                ? `₱${bookingState.rateDay} day / ₱${bookingState.rateNight} night per hr` : `₱${bookingState.rateDay ?? bookingState.rate}${bookingState.rateUnit}`) : 'Rate TBA');
        if (summaryPayment) summaryPayment.textContent = isFull ? 'Full payment preference' : `Downpayment preference (${pct}%)`;
        if (summaryTotal) summaryTotal.textContent = amount !== null ? `₱${amount.toFixed(2)}` : '—';
        // Downpayment option's own description line ("Pay N% now, balance
        // on-site.") — kept in sync with the same real downpayment_pct
        // rather than left at its hardcoded "50%" (implementation_plan.md
        // E2, the same duplicated-hardcoded-50% defect Payment
        // Configuration was built to fix).
        if (downpaymentDesc) downpaymentDesc.textContent = `Pay ${pct}% securely now; pay the remaining balance at check-in.`;

        if (bookSubmit) {
            // Revision 5, D3 — both From AND To required (not just
            // startHour), matching bookStepIsReady()'s own step-2 gate
            // above; Step 3 is unreachable without both already set, so
            // this is defensive belt-and-suspenders rather than a normally
            // reachable branch.
            const ready = bookingState.startHour !== null && bookingState.endHour !== null
                && Boolean(bookingState.court) && Boolean(bookingState.unitId)
                && Number.isFinite(baseAmount) && baseAmount > 0;
            bookSubmit.disabled = !ready;
            bookSubmit.textContent = ready
                ? (bookingCart.length ? `Pay for ${bookingCart.length + 1} bookings` : 'Continue to secure checkout')
                : 'Select a time range to continue';
        }
        const onlineCharge = baseAmount === null ? null : baseAmount * (isFull ? 1 : pct / 100);
        const onlineAllowed = hasKnownRate() && ['/hr', '/set'].includes(bookingState.rateUnit) && onlineCharge !== null && onlineCharge > 0;
        paymentModeRadios.forEach((radio) => {
            if (radio.dataset.dashPayMode !== 'online') return;
            radio.disabled = !onlineAllowed;
        });
        if (paymentModeHint && !onlineAllowed) {
            paymentModeHint.textContent = 'Online checkout is unavailable until this court or lane has a confirmed rate.';
        }

        // Re-gates the wizard's Next button and refreshes the step
        // indicator every time ANY piece of bookingState changes (court,
        // date, or time) — updateSummary() already runs after every one of
        // those changes below, so this is the single hook the whole wizard
        // needs (§5, D5). renderBookWizard() only re-applies whichever step
        // is already current; it never changes which step is showing.
        renderBookWizard();
    }

    if (bookSelect) {
        bookSelect.addEventListener('change', () => {
            const opt = bookSelect.selectedOptions[0];
            bookingState.court = bookSelect.value;
            bookingState.sport = (opt && opt.dataset.sport) || bookingState.court;
            bookingState.rate = (opt && opt.dataset.rate) ? Number(opt.dataset.rate) : null;
            bookingState.rateUnit = (opt && opt.dataset.rateUnit) || '/hr';
            syncBookPreviewFromState();
            // A different court almost always means different availability
            // (and paintBookPreview() above just reset bookingState.unit
            // too) — any in-progress Step 2 selection is stale, so it's
            // cleared and the From/To pickers re-fetched for the new court.
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
            if (bookDate.value < todayStr) {
                bookDate.value = todayStr;
                window.InigoToast?.show("You can't book a date in the past — showing today instead.", true);
            }
            bookingState.date = bookDate.value;
            resetTimeSelectionAndRender();
            updateSummary();
        });
    }

    paymentOptions.forEach((option) => {
        option.addEventListener('click', () => {
            paymentOptions.forEach((o) => o.classList.remove('is-selected'));
            option.classList.add('is-selected');
            const radio = option.querySelector('input[type="radio"]');
            if (radio) {
                radio.checked = true;
                bookingState.paymentType = radio.dataset.dashPayment;
            }
            updateSummary();
        });
    });

    paymentModeRadios.forEach((radio) => {
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            if (radio.dataset.dashPayMode === 'online' && (!hasKnownRate() || !['/hr', '/set'].includes(bookingState.rateUnit))) {
                radio.checked = false;
                window.InigoToast?.show('Online checkout requires a confirmed court rate.', true);
                return;
            }
            bookingState.paymentMode = 'online';
            paymentModeOptions.forEach((option) => option.classList.toggle('is-selected', option.contains(radio)));
            updateSummary();
        });
    });

    // ------------------------------------------------------------------
    // Step 2 — From/To time-range picker (Revision 5, D3 —
    // implementation_plan.md). Replaces Part 3's clickable slot-grid model
    // (bookingState.startHour/endHour set by clicking hour buttons —
    // onSlotClick()/extendSelectionTo()/paintSlotGrid(), all three deleted)
    // after the user's explicit correction: "there should be no slots to
    // click." Two plain <select>s do the same job now — From (bookFromSelect)
    // and To (bookToSelect) — with their OPTIONS shrunk to whatever is
    // actually free, so every value either one can hold is already
    // guaranteed bookable; see renderTimePickers() further below.
    // bookingState.startHour/endHour (24-hour integers, or null before both
    // are chosen) are UNCHANGED in shape and meaning — bookingHoursSelected(),
    // bookingTimeRangeLabel(), updateSummary(), and the insert payload
    // further below all keep working exactly as before.
    //
    // Bookable hours come from booking_rules_for_date() through
    // window.InigoBusinessHours.getForDate(); the selected day's exact
    // opening window drives both this picker and the Overview peek below.
    //
    // Availability comes from court_occupancy(), the database's
    // privacy-limited view over the shared reservation ledger. It includes
    // active online and walk-in reservations overlapping the selected day.
    // Named units only block the same normalized unit; a missing/blank unit
    // blocks every unit because its physical location cannot be narrowed.
    //
    // Reuses this file's own overlap primitives — overviewBookingWindow()/
    // overviewWindowsOverlap()/overviewSlotWindow() further below in the
    // Overview Courts section — instead of a third copy of the same
    // `a.start < b.end && b.start < a.end` math. Despite their "overview"
    // names (kept as-is; see isOverviewSchemaMismatch()'s own "despite its
    // name" comment further below for why this file doesn't rename a
    // widely-used helper just because a second, unrelated feature now
    // shares it), all three are plain, date-agnostic functions — calling
    // them from here is safe: they're `function` DECLARATIONS in this same
    // outer scope, hoisted, so it doesn't matter that they're defined later
    // in this file than this section.
    //
    // Online and walk-in rows are fetched in one RPC snapshot, then split
    // for the shared hour checks below. This keeps both channels and every
    // unit selector aligned with the overview availability display.
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

    async function fetchDayOccupancy(courtName, dateStr) {
        if (!window.sb || !courtName || !dateStr) return { ok: false, rows: [] };

        const dayStart = new Date(`${dateStr}T00:00:00`);
        const dayEnd = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1);
        let res;
        try {
            res = await window.sb.rpc('court_occupancy', {
                from_at: dayStart.toISOString(), to_at: dayEnd.toISOString(),
            });
        } catch (error) {
            console.error('[dashboard] failed to load occupancy for the time pickers', error);
            return { ok: false, rows: [] };
        }

        if (res.error) {
            console.error('[dashboard] failed to load occupancy for the time pickers', res.error);
            return { ok: false, rows: [] };
        }
        return { ok: true, rows: (res.data || []).filter((row) => sameCourtName(row.courts, courtName)) };
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

    // True when `hour` (on the currently selected date) has already
    // started — the customer's local "now", not the server's, since this
    // is purely a client-side UX guard (the DB doesn't know or care what a
    // browser's clock reads).
    function isSlotHourPast(hour) {
        const start = new Date(`${bookingState.date}T00:00:00`);
        start.setHours(hour, 0, 0, 0);
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
        const slot = overviewSlotWindow(hour, dateBase);
        const currentUnit = bookingState.unit || '';
        const bookingMatch = slotGridBookings.rows.some((row) => {
            if (!courtUnitsOverlap(row.court_unit, currentUnit)) return false;
            return overviewWindowsOverlap(overviewBookingWindow(row), slot);
        });
        if (bookingMatch) return true;

        if (!slotGridWalkins.ok) return false;
        return slotGridWalkins.rows.some((row) => {
            return courtUnitsOverlap(row.court_unit, currentUnit)
                && overviewWindowsOverlap(overviewBookingWindow(row), slot);
        });
    }

    function slotHourStatus(hour) {
        if (!bookingHoursRange().includes(hour)) return 'closed';
        if (isSlotHourPast(hour)) return 'past';
        if (isSlotHourBooked(hour)) return 'booked';
        return 'available';
    }

    // Runs of consecutive free (available, non-past) hours for the
    // currently selected court/unit/date (Revision 5, D3 —
    // implementation_plan.md) — e.g. with 10-11 AM booked, this returns
    // [{ startHour: 8, endHourExclusive: 10 }, { startHour: 11,
    // endHourExclusive: 20 }]. The single source both renderTimePickers()
    // below (Step 2's From/To options + its "Open on this date" status
    // line) and the Overview strip's per-hour pills read availability from
    // (via the same slotHourStatus()/isSlotHourBooked() this function
    // calls) — so the two views can never disagree about what's free for a
    // given court/unit/date (D4). hoursRange() always returns a plain
    // ascending, step-1 sequence, so a run only needs to remember where it
    // started; it closes the moment a non-free hour interrupts it, or at
    // CLOSE_HOUR if it reaches the end of the day still open.
    function computeFreeWindows() {
        const hours = bookingHoursRange();
        if (!hours.length) return [];
        const windows = [];
        let runStart = null;

        hours.forEach((hour) => {
            if (slotHourStatus(hour) === 'available') {
                if (runStart === null) runStart = hour;
            } else if (runStart !== null) {
                windows.push({ startHour: runStart, endHourExclusive: hour });
                runStart = null;
            }
        });
        if (runStart !== null) {
            windows.push({ startHour: runStart, endHourExclusive: hours[hours.length - 1] + 1 });
        }
        return windows;
    }

    // Fills [data-dash-book-from]/[data-dash-book-to] from
    // computeFreeWindows() above and writes the "Open on this date" status
    // line (Revision 5, D3). Both selects get an explicit, UNSELECTED
    // placeholder <option> — bookStepIsReady() keeps Next disabled until the
    // customer actively picks both, the same "nothing chosen yet" state a
    // fresh page load starts in.
    //
    // From lists every free hour across every window, labelled with its
    // OWN start time (formatHourLabel — "8:00 AM"). To only makes sense
    // once From is picked: it lists every hour from From+1 through the end
    // of the free run that CONTAINS From, labelled with the END time each
    // option represents (so picking 8:00 AM inside a run that's open
    // through 8 PM offers "9:00 AM" … "8:00 PM") — an option's value V
    // means "book through V:00", stored as bookingState.endHour = V-1 to
    // keep the existing inclusive-hour convention bookingHoursSelected()/
    // bookingTimeRangeLabel()/the insert payload above already rely on.
    // This is the direct replacement for Part 3's paintSlotGrid() — same
    // "pure re-render from whatever was last fetched into slotGridBookings"
    // role, just painting two <select>s instead of a button grid.
    function renderTimePickers() {
        if (!bookFromSelect || !bookToSelect || !window.InigoBusinessHours) return;

        if (!bookingState.court || !bookingState.date) {
            bookFromSelect.innerHTML = '<option value="">Select a court first</option>';
            bookToSelect.innerHTML = '<option value="">Select a court first</option>';
            bookFromSelect.disabled = true;
            bookToSelect.disabled = true;
            if (bookOpenWindowsEl) bookOpenWindowsEl.textContent = 'Select a court first.';
            return;
        }

        if (!bookingRules) {
            bookFromSelect.innerHTML = '<option value="">Checking opening hours…</option>';
            bookToSelect.innerHTML = '<option value="">Checking opening hours…</option>';
            bookFromSelect.disabled = true;
            bookToSelect.disabled = true;
            if (bookOpenWindowsEl) bookOpenWindowsEl.textContent = 'Checking opening hours…';
            return;
        }

        if (!bookingRules.authoritative) {
            bookFromSelect.innerHTML = '<option value="">Opening hours unavailable</option>';
            bookToSelect.innerHTML = '<option value="">Opening hours unavailable</option>';
            bookFromSelect.disabled = true;
            bookToSelect.disabled = true;
            bookingState.startHour = null;
            bookingState.endHour = null;
            if (bookOpenWindowsEl) bookOpenWindowsEl.textContent = 'Could not check opening hours. Refresh the page and try again.';
            return;
        }

        if (bookingRules.isClosed) {
            bookFromSelect.innerHTML = '<option value="">Closed</option>';
            bookToSelect.innerHTML = '<option value="">Closed</option>';
            bookFromSelect.disabled = true;
            bookToSelect.disabled = true;
            bookingState.startHour = null;
            bookingState.endHour = null;
            if (bookOpenWindowsEl) bookOpenWindowsEl.textContent = 'This facility is closed on the selected date.';
            return;
        }

        // M2 fix — either fetch failing means occupancy can't be trusted
        // (a walk-in fetch failure is just as unsafe to render around as a
        // booking fetch failure), same fail-safe reasoning
        // refreshOverviewCourtWidget()'s overviewDataOk uses.
        if (!slotGridBookings.ok || !slotGridWalkins.ok) {
            bookFromSelect.innerHTML = '<option value="">Unavailable</option>';
            bookToSelect.innerHTML = '<option value="">Unavailable</option>';
            bookFromSelect.disabled = true;
            bookToSelect.disabled = true;
            if (bookOpenWindowsEl) bookOpenWindowsEl.textContent = 'Could not check live availability right now — please try a different date, or refresh the page.';
            return;
        }

        const fmt = window.InigoBusinessHours.formatHourLabel;
        const windows = computeFreeWindows();

        if (windows.length === 0) {
            bookFromSelect.innerHTML = '<option value="">No times available</option>';
            bookToSelect.innerHTML = '<option value="">No times available</option>';
            bookFromSelect.disabled = true;
            bookToSelect.disabled = true;
            bookingState.startHour = null;
            bookingState.endHour = null;
            if (bookOpenWindowsEl) {
                // L3 fix (post-Revision-5 review) — windows.length === 0
                // means every hour of the day is either 'booked' or 'past'
                // (an 'available' hour would have produced a window above).
                // On a future date every one of those must be 'booked', so
                // "Fully booked" is always accurate there. On TODAY,
                // though, an evening visit could find every hour simply
                // elapsed with nothing ever booked — "Fully booked" would
                // be misleading in that case, so this only says it when at
                // least one hour is genuinely 'booked'; otherwise the day
                // just ran out.
                const isToday = bookingState.date === todayDateInputValue();
                const noneBooked = bookingHoursRange().every((h) => slotHourStatus(h) !== 'booked');
                bookOpenWindowsEl.textContent = (isToday && noneBooked)
                    ? 'No more times available today.'
                    : 'Fully booked on this date.';
            }
            return;
        }

        // From — every free hour, across every window, in order.
        const freeHours = [];
        windows.forEach((w) => {
            for (let h = w.startHour; h < w.endHourExclusive; h++) {
                if (bookingState.rateUnit !== '/set' || h + bookingState.rateQuantity <= w.endHourExclusive) freeHours.push(h);
            }
        });
        if (bookingState.startHour !== null && !freeHours.includes(bookingState.startHour)) {
            // Defensive only — From's OWN change handler below already
            // clears endHour whenever From itself changes, and every
            // court/unit/date change goes through resetTimeSelectionAndRender()
            // (which nulls both directly), so this should never actually
            // trigger; kept in case a future caller repaints without
            // resetting first.
            bookingState.startHour = null;
            bookingState.endHour = null;
        }

        bookFromSelect.disabled = false;
        const fromPlaceholder = `<option value=""${bookingState.startHour === null ? ' selected' : ''} disabled>Select a start time</option>`;
        const fromOptions = freeHours.map((h) => `<option value="${h}"${h === bookingState.startHour ? ' selected' : ''}>${window.escapeHtml(fmt(h))}</option>`).join('');
        bookFromSelect.innerHTML = fromPlaceholder + fromOptions;

        // To — only the hours from From+1 through the end of the run that
        // contains From, so a range can never be chosen that spans a
        // booked/past hour (the same rule Part 3's extendSelectionTo() used
        // to enforce for the old clickable grid).
        if (bookingState.startHour === null) {
            bookToSelect.innerHTML = '<option value="" selected disabled>Select a start time first</option>';
            bookToSelect.disabled = true;
        } else {
            const run = windows.find((w) => bookingState.startHour >= w.startHour && bookingState.startHour < w.endHourExclusive);
            const runEndExclusive = run ? run.endHourExclusive : bookingState.startHour + 1;

            const toPlaceholder = `<option value=""${bookingState.endHour === null ? ' selected' : ''} disabled>Select an end time</option>`;
            const toOptions = [];
            const firstEnd = bookingState.rateUnit === '/set' ? bookingState.startHour + bookingState.rateQuantity : bookingState.startHour + 1;
            for (let endExclusive = firstEnd; endExclusive <= runEndExclusive; endExclusive++) {
                if (bookingState.rateUnit === '/set' && endExclusive !== firstEnd) break;
                const endHourValue = endExclusive - 1; // stored using the existing inclusive-hour convention
                toOptions.push(`<option value="${endHourValue}"${endHourValue === bookingState.endHour ? ' selected' : ''}>${window.escapeHtml(fmt(endExclusive))}</option>`);
            }
            bookToSelect.innerHTML = toPlaceholder + toOptions.join('');
            bookToSelect.disabled = bookingState.rateUnit === '/set';
        }

        if (bookOpenWindowsEl) {
            const windowLabels = windows.map((w) => `${fmt(w.startHour)} – ${fmt(w.endHourExclusive)}`).join(', ');
            bookOpenWindowsEl.textContent = `Open on this date: ${windowLabels}`;
        }
    }

    if (bookFromSelect) {
        bookFromSelect.addEventListener('change', () => {
            const value = bookFromSelect.value;
            bookingState.startHour = value === '' ? null : Number(value);
            // Changing From always clears To (Revision 5, D3) — the free
            // run containing the new From hour may not even include the
            // previously chosen End, so re-deriving To from scratch (via
            // renderTimePickers() below) is simpler and safer than trying
            // to carry a possibly-invalid End forward.
            bookingState.endHour = null;
            if (bookingState.rateUnit === '/set' && bookingState.startHour !== null) {
                const end = bookingState.startHour + bookingState.rateQuantity - 1;
                if (Array.from({ length: bookingState.rateQuantity }, (_, i) => bookingState.startHour + i)
                    .every((hour) => slotHourStatus(hour) === 'available')) {
                    bookingState.endHour = end;
                }
            }
            renderTimePickers();
            updateSummary();
        });
    }

    if (bookToSelect) {
        bookToSelect.addEventListener('change', () => {
            const value = bookToSelect.value;
            bookingState.endHour = value === '' ? null : Number(value);
            updateSummary();
        });
    }

    // Re-fetches availability for the currently selected court + date, then
    // repaints the From/To pickers from the result. Called whenever court,
    // unit, or date changes (implementation_plan.md) — a unit-only change
    // re-fetches too, even though fetchDayOccupancy() isn't itself
    // unit-filtered (filtering happens client-side in isSlotHourBooked()
    // above); the extra round trip is cheap and keeps this one function the
    // single "availability might have changed" entry point. Renamed from
    // Part 3's renderSlotGrid() (Revision 5, D3) now that there's no grid
    // left to paint — repaints via renderTimePickers() above instead of the
    // deleted paintSlotGrid().
    async function refreshTimePickers(forceRules = false) {
        if (!bookFromSelect || !bookToSelect) return;
        const mySeq = ++slotGridRequestSeq;

        if (!bookingState.court || !bookingState.date) {
            renderTimePickers();
            return;
        }

        bookFromSelect.innerHTML = '<option value="">Checking availability…</option>';
        bookToSelect.innerHTML = '<option value="">Checking availability…</option>';
        bookFromSelect.disabled = true;
        bookToSelect.disabled = true;
        if (bookOpenWindowsEl) bookOpenWindowsEl.textContent = 'Checking availability…';

        if (!window.InigoBusinessHours?.getForDate) {
            slotGridBookings = { ok: false, rows: [] };
            slotGridWalkins = { ok: false, rows: [] };
            bookingRules = null;
            renderTimePickers();
            return;
        }

        // M2 fix — fetched together (Promise.all) so a walk-in fetched a
        // request apart from its booking counterpart can't itself become a
        // second, separately-racing source of staleness.
        const [result, rules] = await Promise.all([
            fetchDayOccupancy(bookingState.court, bookingState.date),
            window.InigoBusinessHours.getForDate(bookingState.date, { force: forceRules }),
        ]);
        // A newer refresh started while this one was in flight — that newer
        // call already owns the pickers, so this stale response is dropped
        // instead of flashing outdated availability.
        if (mySeq !== slotGridRequestSeq) return;
        bookingRules = rules;
        slotGridBookings = { ok: result.ok, rows: result.rows.filter((row) => row.source === 'online') };
        // Maintenance shares the same occupancy snapshot and blocks selection
        // exactly like either reservation channel.
        slotGridWalkins = { ok: result.ok, rows: result.rows.filter((row) => ['walkin', 'maintenance', 'checkout_hold'].includes(row.source)) };
        renderTimePickers();
    }

    // Clears any in-progress Step 2 selection and re-renders the From/To
    // pickers — shared by every "the court/unit/date might have just
    // changed" handler above and below, so none of them has to repeat both
    // steps. Renamed from Part 3's resetSlotSelectionAndRender() (Revision
    // 5, D3) now that there's no grid selection left to reset, only
    // bookingState.startHour/endHour.
    function resetTimeSelectionAndRender() {
        bookingState.startHour = null;
        bookingState.endHour = null;
        refreshTimePickers();
    }

    function selectedBookingCartItem() {
        const court = findBookCourt(bookingState.court);
        const units = court && window.InigoCourtsData ? window.InigoCourtsData.resolveCourtUnits(court).units : [];
        const selectedUnit = units.find((unit) => bookingState.unitId && String(unit.id) === String(bookingState.unitId));
        const endHour = bookingState.endHour;
        const hours = endHour - bookingState.startHour + 1;
        const startIso = new Date(`${bookingState.date}T${String(bookingState.startHour).padStart(2, '0')}:00:00`).toISOString();
        const endIso = new Date(`${bookingState.date}T${String(endHour + 1).padStart(2, '0')}:00:00`).toISOString();
        const total = bookingState.rateUnit === '/set'
            ? (typeof bookingState.rateDay === 'number' ? bookingState.rateDay * bookingState.rateQuantity : null)
            : bookingHourlyAmount(hours);
        return {
            key: `item-${++bookingCartSeq}`,
            court: bookingState.court,
            sport: bookingState.sport || bookingState.court,
            listingId: (court || {}).id || null,
            unit: bookingState.unit || null,
            unitId: bookingState.unitId || null,
            resourceIds: selectedUnit?.resourceIds || [],
            date: bookingState.date,
            startHour: bookingState.startHour,
            endHour,
            startIso,
            endIso,
            hours,
            rateUnit: bookingState.rateUnit,
            rateQuantity: bookingState.rateUnit === '/set' ? bookingState.rateQuantity : 1,
            paymentType: bookingState.paymentType,
            paymentMode: bookingState.paymentMode,
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

    function renderBookingCart() {
        if (!bookCartPanel || !bookCartItemsEl) return;
        bookCartPanel.hidden = bookingCart.length === 0;
        if (bookCartCountEl) bookCartCountEl.textContent = `${bookingCart.length} item${bookingCart.length === 1 ? '' : 's'}`;
        if (bookCartSubmit) bookCartSubmit.disabled = bookingCartSaving || bookingCart.length === 0;
        if (onlineModeLabel) onlineModeLabel.textContent = 'Pay online now';
        if (paymentModeHint) paymentModeHint.textContent = 'Pay for the whole cart in one secure PayMongo checkout.';
        bookCartItemsEl.innerHTML = bookingCart.map((item) => {
            const unit = item.unit ? ` · ${item.unit}` : '';
            const time = `${window.InigoBusinessHours.formatHourLabel(item.startHour)} – ${window.InigoBusinessHours.formatHourLabel(item.endHour + 1)}`;
            const estimate = Number.isFinite(item.estimatedTotal) ? ` · ₱${item.estimatedTotal.toFixed(2)}` : ' · Rate TBA';
            const payType = item.paymentType === 'full' ? 'Full payment' : 'Deposit';
            return `<li><span><strong>${window.escapeHtml(item.court + unit)}</strong><br>${window.escapeHtml(formatDate(item.date))} · ${window.escapeHtml(time)}${estimate}<br>${window.escapeHtml(payType)}</span><button type="button" class="dash-btn-ghost" data-dash-book-cart-remove="${window.escapeHtml(item.key)}" aria-label="Remove booking item"${bookingCartSaving ? ' disabled' : ''}>Remove</button></li>`;
        }).join('');
    }

    function resetCurrentBookingDraft() {
        bookingState.startHour = null;
        bookingState.endHour = null;
        bookingState.date = todayDateInputValue();
        bookingState.rateQuantity = 1;
        bookingState.paymentType = 'downpayment';
        bookingState.paymentMode = 'online';
        if (bookDate) bookDate.value = bookingState.date;
        if (rateQuantityInput) rateQuantityInput.value = '1';
        document.querySelector('[data-dash-payment="downpayment"]')?.click();
        const onlineRadio = document.querySelector('[data-dash-pay-mode="online"]');
        if (onlineRadio) onlineRadio.checked = true;
        refreshTimePickers();
        updateSummary();
        goToBookStep(1);
    }

    async function submitBookingCart(includeCurrent) {
        if (bookingCartSaving || !window.sb || !window.inigosyncProfile) return;
        const current = includeCurrent ? selectedBookingCartItem() : null;
        const items = [...bookingCart, ...(current ? [current] : [])];
        if (!items.length) return;
        if (items.some((item) => !item.listingId || !item.unitId || !Number.isFinite(item.estimatedTotal) || item.estimatedTotal <= 0)) {
            window.InigoToast?.show('This court needs a confirmed rate and lane before online checkout.', true);
            return;
        }
        if (items.some((item) => item.paymentType !== items[0].paymentType)) {
            window.InigoToast?.show('Choose the same payment option for every item in this checkout.', true);
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
        bookingCartSaving = true;
        if (bookSubmit) { bookSubmit.disabled = true; bookSubmit.textContent = 'Opening secure checkout…'; }
        renderBookingCart();
        try {
            const { data, error } = await window.sb.functions.invoke('paymongo-checkout', {
                body: {
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
            if (error || typeof data?.checkout_url !== 'string' || !data.checkout_url.startsWith('https://checkout.paymongo.com/')) {
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
        bookAddButton.addEventListener('click', () => {
            if (bookingCartSaving || bookingCart.length >= 7) return;
            const item = selectedBookingCartItem();
            if (bookingCart.some((saved) => bookingCartItemsConflict(item, saved))) {
                window.InigoToast?.show('Two items in your list use the same physical court at overlapping times. Change one date or time first.', true);
                return;
            }
            bookingCart.push(item);
            renderBookingCart();
            resetCurrentBookingDraft();
            window.InigoToast?.show('Booking added. Choose another court or pay for the cart above.');
        });
    }
    if (bookCartItemsEl) {
        bookCartItemsEl.addEventListener('click', (event) => {
            if (bookingCartSaving) return;
            const button = event.target.closest('[data-dash-book-cart-remove]');
            if (!button) return;
            const index = bookingCart.findIndex((item) => item.key === button.dataset.dashBookCartRemove);
            if (index >= 0) bookingCart.splice(index, 1);
            renderBookingCart();
            updateSummary();
            if (bookAddButton) bookAddButton.hidden = bookingCart.length >= 7;
        });
    }
    if (bookCartSubmit) bookCartSubmit.addEventListener('click', () => submitBookingCart(false));

    if (bookSubmit) {
        bookSubmit.addEventListener('click', async () => {
            if (bookSubmit.disabled) return;
            if (!bookingState.date || bookingState.startHour === null || bookingState.endHour === null) {
                window.InigoToast?.show('Please select a date and time range.', true);
                return;
            }
            await submitBookingCart(true);
        });
    }

    // Neutral "select a court" placeholder until
    // window.InigoCourtsData.getCourts() resolves (populateBookSelect()
    // below) — same "loading" honesty as the <select>'s own "Loading
    // courts…" option.
    paintBookPreview(null);
    refreshTimePickers();
    updateSummary();

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
            bookingState.gcashEnabled = settings.gcashEnabled;
            bookingState.nightRateStartsAt = settings.nightRateStartsAt || null;
            if (paymentModeHint) paymentModeHint.textContent = settings.gcashEnabled && settings.cardEnabled
                ? 'Pay securely with GCash or card on PayMongo.'
                : settings.gcashEnabled ? 'Pay securely with GCash on PayMongo.' : 'Pay securely by card on PayMongo.';
            updateSummary();
            refreshMyBookings();
        });
    }

    // ------------------------------------------------------------------
    // Court data — the Overview Courts cards (further below, §4/D2) and the
    // Booking Management court <select> are rendered from the SAME fetch
    // (window.InigoCourtsData.getCourts(), memoized), so the two can never
    // disagree about which courts exist or what they cost. courtTags() is
    // shared by both this file's populateBookSelect() (indirectly, via the
    // rate it reads) and the Overview cards' own renderOverviewCourtCard()
    // below. Every interpolated field on this page is escaped — a court
    // named `<img src=x onerror=alert(1)>` (staff/admin can write `court`
    // rows, see database/schema/002_content_tables.sql's RLS policies) must
    // render as literal text, not run.
    // ------------------------------------------------------------------
    function courtTags(court) {
        const tags = [];
        if (court.sportName) tags.push(court.sportName);
        tags.push(`${court.quantity} ${court.unit}`);
        String(court.description || '').split('·').forEach((part) => {
            const trimmed = part.trim();
            if (trimmed) tags.push(trimmed);
        });
        return tags;
    }

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
        bookSelect.innerHTML = courts.map((court) => {
            const rateAttr = court.rate !== null ? window.escapeHtml(String(court.rate)) : '';
            const rateHint = window.InigoCourtsData.rateHint?.(court);
            const label = rateHint
                ? `${court.name} — ${rateHint}`
                : `${court.name} — Rate TBA`;
            // data-sport carries the court's REAL related sport (e.g.
            // "Bowling" for the "Bowling — Duckpin" court, not a copy of
            // the court name) through to bookingState/the insert in the
            // bookSubmit handler below — same idea as data-rate /
            // data-rate-unit. booking.sports is NOT NULL, so this falls
            // back to the court's own name only if a court somehow has no
            // linked sport row; it is never left empty.
            const sportAttr = window.escapeHtml(court.sportName || court.name);
            return `<option value="${window.escapeHtml(court.name)}" data-rate="${rateAttr}" data-rate-unit="${window.escapeHtml(court.rateUnit)}" data-sport="${sportAttr}">${window.escapeHtml(label)}</option>`;
        }).join('');

        const firstOpt = bookSelect.selectedOptions[0];
        bookingState.court = bookSelect.value;
        bookingState.sport = (firstOpt && firstOpt.dataset.sport) || bookingState.court;
        bookingState.rate = (firstOpt && firstOpt.dataset.rate) ? Number(firstOpt.dataset.rate) : null;
        bookingState.rateUnit = (firstOpt && firstOpt.dataset.rateUnit) || '/hr';
        syncBookPreviewFromState();
        // First time bookingState.court/unit become real (courts load
        // asynchronously) — renders Step 2's From/To pickers for real
        // instead of the "Select a court first." placeholder
        // refreshTimePickers() showed at setup time above.
        refreshTimePickers();
        updateSummary();
        refreshMyBookings();
    }

    if (window.InigoCourtsData) {
        window.InigoCourtsData.getCourts().then((courts) => {
            populateBookSelect(courts);
        }).catch((err) => {
            console.error('[dashboard] could not load courts', err);
        });
    } else {
        // Should never happen — includes/courtsData.js must load before
        // this file (see the <script> order in Pages/user_dashboard.html).
        console.error('[dashboard] window.InigoCourtsData is missing — check that includes/courtsData.js loads before includes/Dashboard.js.');
    }

    // ------------------------------------------------------------------
    // Overview — Courts widget (replaces the old, fully-static "Calendar"
    // and "Live availability" cards). MARKETING/SHOWCASE ONLY as of
    // Revision 2's R1 (implementation_plan.md) — booking has its own
    // designated panel (Book a Court); this widget only shows the courts
    // off. Lists the real courts (window.InigoCourtsData, the same source
    // as Booking above) grouped by sport (§4's "visual segregation" — a
    // heading per sport, that sport's court card(s) beneath it), grouping
    // that stays on regardless of sort mode. The sort <select> defaults to
    // ordering those sport groups alphabetically (R2); "Available first"
    // and "Price: Low to High" remain selectable alternatives that instead
    // order courts *within* each group — see sortOverviewCourts() above.
    // The widget also lets the customer "peek" a court's real hourly
    // open/booked slots for TODAY, read-only, without leaving the Overview
    // tab. The open/booked computation reuses the exact overlap algorithm
    // the Staff dashboard's Court Schedule already proved
    // (includes/staff_dashboard.js's bookingWindow/windowsOverlap/
    // todayRange), adapted to hourly granularity (matching this page's own
    // Booking-panel slot labels) instead of that file's 2-hour columns.
    // Peek slots used to hand off a click into the Booking panel
    // (jumpToBookingFromPeekSlot()) — R1 removed that entirely: an open
    // slot pill is now purely informational (renderOverviewSlotPill()
    // above), not a control.
    //
    // §4/D2 additionally gives each card a per-unit combo box
    // (window.InigoCourtsData.resolveCourtUnits()) whose selection swaps the
    // card's displayed photo — see renderOverviewCourtCard(),
    // paintOverviewCourtMedia() and the [data-overview-unit-select] wiring
    // in wireOverviewCourtList() below. This REPLACES the old standalone
    // Courts dash-panel (deleted) and the compact avail-row list PR #1 put
    // here; the peek-slot DISPLAY mechanism itself (toggle, hourly pills)
    // is preserved from PR #1 — the user explicitly praised it — only its
    // container changed (a one-line row to this richer card) and, per R1,
    // its former click-to-book hand-off is gone.
    //
    // RLS risk (implementation_plan.md's Context/"Open questions" —
    // documented, pre-existing, not introduced here): `booking` and
    // `walk_in_booking`'s row-level security policies predate this repo's
    // schema tracking and are not visible to it (see
    // database/schema/004_staff_module.sql's header note), so it is
    // unconfirmed whether the `customer` role can read every row of either
    // table or only its own. This widget therefore (a) selects only the
    // minimal columns needed to compute open/booked — never a customer's
    // name/contact, unlike the staff version's `profiles` join — and (b)
    // fails safe: if either query errors, every court's peek shows an
    // honest "unavailable" note instead of ever claiming a slot is open
    // when that couldn't be verified. Court rows themselves (name/rate/
    // status dot) still render either way, since those come from
    // window.InigoCourtsData independently of the booking queries below.
    // ------------------------------------------------------------------
    const overviewCourtList = document.querySelector('[data-dash-overview-court-list]');
    const overviewSortSelect = document.querySelector('[data-dash-overview-sort]');

    // Overview slot pills use the same server-returned date rules as the
    // Booking pickers, so closed days and shorter/longer opening windows
    // stay aligned across both customer views.
    function overviewSlotHours() {
        return hoursRangeForRules(overviewRules);
    }
    // Kept equal to database/schema/004_staff_module.sql's
    // booking.duration_minutes DEFAULT, same reasoning as
    // includes/staff_dashboard.js's own DEFAULT_DURATION_MINUTES.
    const OVERVIEW_DEFAULT_DURATION_MINUTES = 60;

    // Revision 5, D5 (implementation_plan.md) — which calendar day this
    // widget's peek strips reflect. Defaults to today, min-clamped to
    // today, same todayDateInputValue() the Booking wizard's own bookDate
    // uses (defined with that section above — a hoisted function, safe to
    // call from here). overviewDate is tracked as its own piece of state
    // (not read from overviewDateInput.value on demand) for the same reason
    // bookingState.date is: every helper below reads ONE value instead of
    // re-querying the DOM, and it degrades honestly to today even if this
    // <input> is ever missing from the markup.
    const overviewDateInput = document.querySelector('[data-dash-overview-date]');
    if (overviewDateInput) {
        const todayStr = todayDateInputValue();
        overviewDateInput.min = todayStr;
        if (!overviewDateInput.value || overviewDateInput.value < todayStr) overviewDateInput.value = todayStr;
    }
    let overviewDate = overviewDateInput ? overviewDateInput.value : todayDateInputValue();

    // Default sort mode (Revision 2, R2 — implementation_plan.md): groups
    // the per-sport headings alphabetically, matching the sort <select>'s
    // own default option (Pages/user_dashboard.html, value="sport",
    // selected). "Available first" and "Price: Low to High" remain
    // selectable alternatives that instead sort courts *within* each sport
    // group — grouping by sport (groupOverviewCourtsBySport() below) stays
    // always-on no matter which mode is chosen, so the two concerns compose
    // instead of conflicting. (Phase 1 had dropped this option, reasoning
    // that always-on grouping made it a no-op duplicate of the default
    // order; the user later asked for it back explicitly, overruling that
    // call — see implementation_plan.md's Context section.)
    let overviewSortMode = 'sport';
    let overviewCourts = [];
    let overviewBookings = [];
    let overviewWalkins = [];
    let overviewDataOk = true;
    let overviewDateBase = null;
    let overviewRules = null;
    // M3 fix (post-Revision-5 review) — same stale-response race guard as
    // Step 2's slotGridRequestSeq above: refreshOverviewCourtWidget() is
    // re-entrant (date change, unit change, the profile-ready event, and
    // the initial call can all overlap), and network responses are not
    // guaranteed to resolve in the order their requests were sent. Bumped
    // at the top of every call; a response only gets to write state/paint
    // if its own snapshot still matches the latest value when it resolves.
    let overviewRequestSeq = 0;
    // Court ids (always compared as strings — see courtId below) currently
    // expanded — a Set so re-rendering after a sort change or a toggle
    // click preserves whichever peeks were already open instead of
    // collapsing everything.
    const overviewExpandedCourts = new Set();
    // Court id -> selected unit <select> index (§4/D2). Same reasoning as
    // overviewExpandedCourts above: renderOverviewCourtList() re-renders
    // every card from scratch on any peek toggle or sort change, so without
    // this a customer's "Court 5" pick on one card would silently reset to
    // "Court 1" the moment they toggled Peek slots on a DIFFERENT card.
    const overviewSelectedUnitIndex = new Map();

    // "Today" in the browser's local timezone — same 2-line pattern as
    // includes/staff_dashboard.js's todayRange(). Used directly only as
    // overviewSelectedDayRange()'s defensive fallback below now (Revision 5,
    // D5 moved this widget's OWN day off "always today" — see that
    // function), but kept as its own named helper since that fallback still
    // needs exactly this "local midnight, +24h" math.
    function todayRange() {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
        return { start, end };
    }

    // Revision 5, D5 (implementation_plan.md) — the [start, end) range for
    // whatever date is currently in overviewDate, replacing this widget's
    // old hardcoded todayRange() call (below, in refreshOverviewCourtWidget()).
    // Falls back to todayRange() itself if overviewDate is ever unparsable
    // (e.g. the <input> is missing from the markup and the fallback
    // assignment above somehow still produced something invalid) — the
    // same "degrade to today, never to nothing" honesty this widget's other
    // fallbacks already use.
    function overviewSelectedDayRange() {
        const start = new Date(`${overviewDate}T00:00:00`);
        if (Number.isNaN(start.getTime())) return todayRange();
        return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) };
    }

    // True when overviewDate IS today — the only case where any hour can
    // read as "past" (D5). A future date never has past hours by
    // definition; renderOverviewPeekContent() below checks this before ever
    // calling isOverviewHourPast().
    function overviewDateIsToday() {
        return overviewDate === todayDateInputValue();
    }

    // `dateBase` defaults to overviewDateBase (this widget's own currently
    // selected date, kept in sync by refreshOverviewCourtWidget() below) —
    // Step 2's From/To pickers (isSlotHourBooked() above) reuse this SAME
    // function for an arbitrary customer-picked date by passing one
    // explicitly, instead of a second near-identical implementation. Despite
    // the "overview" name (kept as-is — see isOverviewSchemaMismatch()'s own
    // "despite its name" comment below for why this file doesn't rename a
    // helper just because a second feature now shares it), this has always
    // been a plain, date-agnostic window builder.
    function overviewSlotWindow(hour, dateBase) {
        const start = new Date(dateBase || overviewDateBase);
        start.setHours(hour, 0, 0, 0);
        return { start, end: new Date(start.getTime() + 60 * 60 * 1000) };
    }

    // True when `hour` on overviewDateBase has already started — mirrors
    // Step 2's own isSlotHourPast() above, just against this widget's
    // selected date instead of bookingState.date (D5, Revision 5).
    function isOverviewHourPast(hour) {
        const start = new Date(overviewDateBase);
        start.setHours(hour, 0, 0, 0);
        return start.getTime() < Date.now();
    }

    // Same shape as includes/staff_dashboard.js's bookingWindow() — a
    // missing/invalid duration_minutes falls back to
    // OVERVIEW_DEFAULT_DURATION_MINUTES, never a fabricated guess. Prefers
    // the real end_at (database/schema/012_booking_time_range.sql, Part 3)
    // when the caller's query selected it — both Step 2's fetchDayOccupancy()
    // and this widget's own fetchOverviewOccupancy() below now do (D4,
    // Revision 5), so this branch engages for both.
    function overviewBookingWindow(row) {
        const start = new Date(row.time_date);
        if (row.end_at) {
            const end = new Date(row.end_at);
            if (!Number.isNaN(end.getTime())) return { start, end };
        }
        const minutesRaw = Number(row.duration_minutes);
        const minutes = Number.isFinite(minutesRaw) && minutesRaw > 0 ? minutesRaw : OVERVIEW_DEFAULT_DURATION_MINUTES;
        return { start, end: new Date(start.getTime() + minutes * 60000) };
    }

    function overviewWindowsOverlap(a, b) {
        return a.start < b.end && b.start < a.end;
    }

    // A court+unit's hour is occupied if a `pending`/`confirmed` booking
    // sharing that SAME unit, OR a walk-in, overlaps that hour's [start,
    // start+1h) window (Revision 5, D4 — implementation_plan.md). `unitLabel`
    // is the card's CURRENTLY SELECTED unit (renderOverviewCourtCard()
    // below) — matched against a row's court_unit the exact same way Step
    // 2's isSlotHourBooked() matches bookingState.unit: null/'' on either
    // side both mean "no unit distinction", so a legacy pre-012 row (or a
    // single-unit court) still behaves as a sport-wide block, and the two
    // views (this peek strip, Step 2's own pickers) can never disagree
    // about a given court+unit+hour.
    //
    // M2 fix (post-Revision-5 review) — this used to treat "anything not
    // cancelled" (including `completed`) as occupying, while Step 2's
    // fetchDayOccupancy() only ever fetches `pending`/`confirmed` rows in the
    // first place (its `.in('status', [...])` filter). A `completed`
    // booking from earlier the same day therefore still blocked THIS
    // widget's pill while Step 2 had already stopped counting it — the two
    // views could disagree about the exact same hour. Matching Step 2's
    // allow-list (rather than a deny-list) makes them structurally
    // incapable of disagreeing on status again, per D4's own guarantee.
    function isOverviewCourtHourOccupied(court, hour, unitLabel) {
        const slot = overviewSlotWindow(hour);
        const currentUnit = unitLabel || '';

        const bookingMatch = overviewBookings.some((b) => {
            const status = String(b.status || '').toLowerCase();
            if (status !== 'pending' && status !== 'confirmed') return false;
            if (!sameCourtName(b.courts, court.name)) return false;
            if (!courtUnitsOverlap(b.court_unit, currentUnit)) return false;
            return overviewWindowsOverlap(overviewBookingWindow(b), slot);
        });
        if (bookingMatch) return true;

        // Occupancy rows retain a walk-in unit when available. Missing
        // unit labels remain wildcards because the physical unit is unknown.
        return overviewWalkins.some((w) => {
            if (!sameCourtName(w.courts, court.name)) return false;
            if (!courtUnitsOverlap(w.court_unit, currentUnit)) return false;
            return overviewWindowsOverlap(overviewBookingWindow(w), slot);
        });
    }

    // True when a Supabase/PostgREST error means "this column/table doesn't
    // exist" — same check includes/staff_dashboard.js's own
    // isSchemaMismatchError() uses. Duplicated locally (this project ships
    // plain <script> files with no shared module system — see
    // includes/courtsData.js's own header note on why todayRange()-style
    // helpers are copied per file rather than imported).
    function isOverviewSchemaMismatch(error) {
        if (!error) return false;
        const code = error.code || '';
        const message = String(error.message || '').toLowerCase();
        return code === 'PGRST204' || code === 'PGRST205' || code === '42703' || code === '42P01'
            || message.includes('could not find') || message.includes('does not exist')
            || message.includes('schema cache');
    }

    // Revision 5, D4 (implementation_plan.md) — court_unit/end_at only
    // exist once database/schema/012_booking_time_range.sql has been
    // applied. If it hasn't, this first attempt fails with a schema-mismatch
    // error and retries with only the columns that predate that migration —
    // same idiom (and the exact same three columns dropped) as Step 2's own
    // fetchDayOccupancy() above, so the two never disagree about which
    // columns they can/can't rely on. Without court_unit, occupancy still
    // degrades to a sport-wide (not per-unit) block, same "approximate
    // availability instead of nothing" fallback fetchDayOccupancy() uses.
    async function fetchOverviewOccupancy(start, end) {
        try {
            return await window.sb.rpc('court_occupancy', {
                from_at: start.toISOString(), to_at: end.toISOString(),
            });
        } catch (error) {
            return { data: null, error };
        }
    }

    function sortOverviewCourts(courts, mode) {
        const copy = courts.slice(); // never mutate window.InigoCourtsData's memoized array
        if (mode === 'available') {
            copy.sort((a, b) => {
                const aAvail = String(a.status || '').toLowerCase() === 'available';
                const bAvail = String(b.status || '').toLowerCase() === 'available';
                if (aAvail !== bAvail) return aAvail ? -1 : 1;
                return (a.sportName || '').localeCompare(b.sportName || '') || (a.name || '').localeCompare(b.name || '');
            });
        } else if (mode === 'price') {
            copy.sort((a, b) => {
                const aNull = a.rate === null || a.rate === undefined;
                const bNull = b.rate === null || b.rate === undefined;
                if (aNull && bNull) return (a.name || '').localeCompare(b.name || '');
                if (aNull !== bNull) return aNull ? 1 : -1; // unknown rate always sorts last, never treated as 0
                return a.rate - b.rate;
            });
        } else {
            // 'sport' — the DEFAULT mode as of Revision 2's R2 (see
            // overviewSortMode's declaration above); also the safe fallback
            // for any unrecognized mode value. Grouping by sport
            // (groupOverviewCourtsBySport() below) is always-on regardless
            // of mode, so this sort only decides GROUP order; 'available'/
            // 'price' above remain selectable alternatives that instead
            // order courts *within* each group. Courts within the same
            // sport are secondarily ordered by name (e.g. "Bowling —
            // Duckpin" before "Bowling — Ten-Pin").
            copy.sort((a, b) => (a.sportName || '').localeCompare(b.sportName || '') || (a.name || '').localeCompare(b.name || ''));
        }
        return copy;
    }

    // Groups an already-sorted court list into { sportName, courts }
    // buckets, one per real sportSlug, preserving each group's first-seen
    // order in `courts` (so the "available"/"price" sort modes still
    // determine which SPORT heading appears first, not just which card
    // does) — §4's "visual segregation": a heading per sport, that sport's
    // card(s) beneath it, never one flat grid.
    function groupOverviewCourtsBySport(courts) {
        const order = [];
        const groups = new Map();
        courts.forEach((court) => {
            const key = court.sportSlug || court.sportName || court.name;
            if (!groups.has(key)) {
                groups.set(key, { sportName: court.sportName || court.name || 'Other', courts: [] });
                order.push(key);
            }
            groups.get(key).courts.push(court);
        });
        return order.map((key) => groups.get(key));
    }

    // Revision 2, R1 (implementation_plan.md) — these pills are a READ-ONLY
    // availability display only now: the Overview Courts section is
    // marketing/showcase, and booking has its own designated panel (the
    // Book a Court wizard's own Step-1 court picker, unaffected by this
    // change). Both open and booked pills render as plain, non-interactive
    // <span>s — not <button>s — since there is nothing left to click, and a
    // <button> would wrongly suggest there is; Style/Dashboard.css also
    // neutralizes the shared .dash-slot class's pointer cursor/hover
    // affordance specifically inside .dash-overview-peek-strip, so these
    // don't visually invite a click they no longer respond to (the Booking
    // panel's own From/To <select>s in Step 2 are unaffected — this is
    // scoped to the peek strip only). Every interpolated value is escaped,
    // same as renderOverviewCourtCard() below — court/sport names are
    // admin-authored content that can contain HTML.
    //
    // Revision 5, D2/D4/D5 (implementation_plan.md) — the label is now a
    // SHORT range ("8–9 AM", formatHourRangeLabelShort()) instead of a
    // single start time, `unitLabel` scopes occupancy to the card's
    // CURRENTLY SELECTED unit (isOverviewCourtHourOccupied() above), and
    // `isPast` (true only when overviewDate is today AND the hour has
    // already started) adds the same .is-past treatment Step 2's pickers
    // give an elapsed hour.
    function renderOverviewSlotPill(court, hour, unitLabel, isPast) {
        const label = window.InigoBusinessHours.formatHourRangeLabelShort(hour);
        const occupied = isOverviewCourtHourOccupied(court, hour, unitLabel);
        const classes = ['dash-slot', 'dash-slot-mini'];
        if (occupied) classes.push('is-unavailable');
        if (isPast) classes.push('is-past');
        return `<span class="${classes.join(' ')}">${window.escapeHtml(label)}</span>`;
    }

    function renderOverviewPeekContent(court, unitLabel) {
        if (!overviewRules) {
            return '<p style="color: var(--color-ink-faint); font-size: 0.78rem; margin: 0; padding: 4px 0;">Opening hours are unavailable right now.</p>';
        }
        if (overviewRules.isClosed) {
            return '<p style="color: var(--color-ink-faint); font-size: 0.78rem; margin: 0; padding: 4px 0;">Closed on this date.</p>';
        }
        const hours = overviewSlotHours();
        if (!hours.length) {
            return '<p style="color: var(--color-ink-faint); font-size: 0.78rem; margin: 0; padding: 4px 0;">No bookable hours are configured for this date.</p>';
        }
        if (!overviewDataOk) {
            return '<p style="color: var(--color-ink-faint); font-size: 0.78rem; margin: 0; padding: 4px 0;">Live slot status unavailable right now.</p>';
        }
        const isToday = overviewDateIsToday();
        return hours.map((hour) => {
            const isPast = isToday && isOverviewHourPast(hour);
            return renderOverviewSlotPill(court, hour, unitLabel, isPast);
        }).join('');
    }

    // One unit's photo (or the honest placeholder) as an HTML string — the
    // ONE place that decides img-vs-placeholder for an Overview court card,
    // used both by renderOverviewCourtCard()'s initial markup and by
    // paintOverviewCourtMedia()'s later DOM patch on unit-select change, so
    // the two can never render a unit's photo differently. Mirrors
    // includes/landingPage.js's renderMediaSlot()/paintMedia() shape (court
    // viewer), adapted to this file's existing .dash-court-media/
    // .dash-court-monogram markup instead of that file's .media-slot.
    function courtPhotoMarkup(unit, monogram, alt) {
        if (unit.imageUrl) {
            return `<img src="${window.escapeHtml(unit.imageUrl)}" alt="${window.escapeHtml(alt)}" loading="lazy" data-overview-court-photo>`;
        }
        // Honest placeholder — the monogram square this dashboard already
        // used (renderCourtCard, now folded into this function), PLUS an
        // explicit "Photo coming soon" caption matching
        // includes/landingPage.js's court viewer wording, so the empty
        // state reads the same everywhere a customer sees it. Never a
        // broken-image icon, never an invented URL.
        return `<span class="dash-court-monogram" aria-hidden="true" data-overview-court-photo>${window.escapeHtml(monogram)}<small class="dash-court-photo-soon">Photo coming soon</small></span>`;
    }

    // Swaps the photo/monogram inside one card's .dash-court-media in place
    // — called on [data-overview-unit-select] `change` (see
    // wireOverviewCourtList() below). Leaves the status badge (a sibling
    // element, appended after the photo) untouched. A unit photo that fails
    // to load (a typo'd unit_images URL, hand-entered by the owner) falls
    // back to the same placeholder rather than a broken-image icon — same
    // idea as includes/landingPage.js's court viewer paintMedia().
    function paintOverviewCourtMedia(mediaEl, court, unit) {
        if (!mediaEl) return;
        const monogram = window.InigoCourtsData ? window.InigoCourtsData.monogramFor(court.sportSlug, court.name) : '?';
        const alt = unit.label ? `${court.name} — ${unit.label}` : court.name;

        const existingPhoto = mediaEl.querySelector('[data-overview-court-photo]');
        if (existingPhoto) existingPhoto.remove();
        mediaEl.insertAdjacentHTML('afterbegin', courtPhotoMarkup(unit, monogram, alt));

        const img = mediaEl.querySelector('img[data-overview-court-photo]');
        if (img) {
            img.addEventListener('error', () => {
                img.remove();
                mediaEl.insertAdjacentHTML('afterbegin', courtPhotoMarkup({ imageUrl: null }, monogram, alt));
                console.warn('[dashboard] court photo failed to load for "%s" — showing the placeholder instead.', alt);
            }, { once: true });
        }
    }

    // One sport-grouped Courts card — marketing/showcase only as of
    // Revision 2's R1 (implementation_plan.md). Combines what the old,
    // deleted standalone Courts panel's renderCourtCard() drew (photo,
    // status badge, name, rating, rate, tags) with the per-unit combo box
    // (window.InigoCourtsData.resolveCourtUnits(), §4's "Combo Box
    // Integration"/"Imagery") and the read-only peek-slots toggle + strip
    // PR #1 shipped (§4's "Pixlot Integration", kept per R1 but with its
    // click-to-book hand-off removed — see renderOverviewSlotPill() above).
    // There is no "Book Now" button here any more (R1) — booking is
    // entirely the Book a Court panel's job now; this card only shows off
    // the court.
    function renderOverviewCourtCard(court) {
        const isAvailable = String(court.status || '').toLowerCase() === 'available';
        const statusClass = isAvailable ? 'confirmed' : 'cancelled';
        const courtId = String(court.id);
        const courtIdAttr = window.escapeHtml(courtId);
        const isExpanded = overviewExpandedCourts.has(courtId);

        // Unit resolution (§4/D2) — see window.InigoCourtsData.resolveCourtUnits()
        // in includes/courtsData.js for the 2 fallback cases (unit_images,
        // then derive Court/Lane/Table N from quantity+unit). Always at
        // least one unit; a lone unit means no combo box (nothing to
        // choose between).
        const resolved = window.InigoCourtsData
            ? window.InigoCourtsData.resolveCourtUnits(court)
            : { pickerLabel: '', units: [{ label: null, imageUrl: court.imageUrl }] };
        const units = resolved.units.length ? resolved.units : [{ label: null, imageUrl: court.imageUrl }];
        const hasUnitChoice = units.length > 1;
        const savedIndex = overviewSelectedUnitIndex.has(courtId) ? overviewSelectedUnitIndex.get(courtId) : 0;
        const selectedIndex = Math.min(Math.max(0, savedIndex), units.length - 1);
        const selectedUnit = units[selectedIndex];

        const monogram = window.InigoCourtsData ? window.InigoCourtsData.monogramFor(court.sportSlug, court.name) : '?';
        const initialAlt = selectedUnit.label ? `${court.name} — ${selectedUnit.label}` : court.name;
        const media = courtPhotoMarkup(selectedUnit, monogram, initialAlt);

        // Prefer the lowest server-configured unit rate when the listing has
        // per-court schedules; the selected unit and time still determine the
        // actual quote in the booking summary.
        const rateHint = window.InigoCourtsData.rateHint?.(court);
        const rateHtml = rateHint
            ? `<span>${window.escapeHtml(rateHint)}</span>`
            : '<span>Rate TBA</span>';
        // Rating: `court.rating` only exists once the owner runs
        // database/schema/003_court_rating.sql, and only renders when a
        // court actually has one — no invented ratings.
        const ratingHtml = (court.rating !== null && court.rating !== undefined)
            ? `<div class="dash-court-rating">
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.9L22 9.6l-5.4 4.9L18 22l-6-3.6L6 22l1.4-7.5L2 9.6l7.1-.7z"/></svg>
                    ${window.escapeHtml(court.rating.toFixed(1))}<span>/ 5</span>
               </div>`
            : '';
        const tagsHtml = courtTags(court).map((t) => `<span>${window.escapeHtml(t)}</span>`).join('');

        const unitPickerHtml = hasUnitChoice ? `
            <div class="dash-form-group dash-court-unit-picker">
                <span class="dash-form-label">${window.escapeHtml(resolved.pickerLabel || 'Choose a unit')}</span>
                <select class="dash-select" data-overview-unit-select data-overview-court-id="${courtIdAttr}">
                    ${units.map((u, i) => `<option value="${i}"${i === selectedIndex ? ' selected' : ''}>${window.escapeHtml(u.label || `${court.name} ${i + 1}`)}</option>`).join('')}
                </select>
            </div>
        ` : '';

        return `
            <article class="dash-court-card">
                <div class="dash-court-media" data-overview-court-media>
                    ${media}
                    <span class="dash-status ${statusClass}">${window.escapeHtml(court.status || 'Unavailable')}</span>
                </div>
                <div class="dash-court-body">
                    <h3>${window.escapeHtml(court.name)}</h3>
                    ${ratingHtml}
                    <div class="dash-court-rate">${rateHtml}</div>
                    <div class="dash-court-tags">${tagsHtml}</div>
                    ${unitPickerHtml}
                    <div class="dash-court-peek">
                        <button type="button" class="dash-mini-btn" data-overview-peek-toggle data-overview-court-id="${courtIdAttr}" aria-expanded="${isExpanded ? 'true' : 'false'}">${isExpanded ? 'Hide availability' : 'Show availability'}</button>
                    </div>
                    <!-- data-overview-peek-strip (Revision 5, D4) lets the
                         unit <select>'s own change handler
                         (wireOverviewCourtList() below) find and repaint
                         JUST this card's strip in place when the selected
                         unit changes availability, without a full
                         renderOverviewCourtList() re-render that would
                         disturb every OTHER card's expanded/scroll state. -->
                    <div class="dash-overview-peek-strip${isExpanded ? ' is-active' : ''}" data-overview-peek-strip data-overview-court-id="${courtIdAttr}">${isExpanded ? renderOverviewPeekContent(court, selectedUnit.label) : ''}</div>
                </div>
            </article>
        `;
    }

    // Re-wired after every renderOverviewCourtList() call, same
    // re-wire-after-render idiom wireReceiptDownloads() below also uses for
    // its own dynamically-rendered scope. [data-overview-peek-toggle]
    // wiring is unchanged from PR #1 (§4's "Pixlot Integration") — it only
    // shows/hides the read-only strip, nothing else. There is no
    // [data-overview-peek-slot] click wiring any more: Revision 2's R1
    // (implementation_plan.md) removed the peek-slot click-to-book hand-off
    // (jumpToBookingFromPeekSlot(), deleted) — renderOverviewSlotPill()
    // above now renders plain, non-interactive <span>s with nothing to wire
    // a click to. [data-overview-unit-select] is unchanged (§4/D2 — the
    // per-unit combo box's image swap).
    function wireOverviewCourtList() {
        if (!overviewCourtList) return;

        overviewCourtList.querySelectorAll('[data-overview-peek-toggle]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const courtId = btn.dataset.overviewCourtId;
                if (!courtId) return;
                if (overviewExpandedCourts.has(courtId)) {
                    overviewExpandedCourts.delete(courtId);
                } else {
                    overviewExpandedCourts.add(courtId);
                }
                renderOverviewCourtList();
            });
        });

        // Combo box selection swaps that card's photo in place (§4
        // "Imagery") — does NOT re-render the list, so it neither disturbs
        // any other card's peek strip nor loses its own; the chosen index
        // is stashed in overviewSelectedUnitIndex so it also survives the
        // NEXT full re-render (a peek toggle or sort change elsewhere).
        overviewCourtList.querySelectorAll('[data-overview-unit-select]').forEach((select) => {
            select.addEventListener('change', () => {
                const courtId = select.dataset.overviewCourtId;
                const court = overviewCourts.find((c) => String(c.id) === courtId);
                if (!court || !window.InigoCourtsData) return;

                const resolved = window.InigoCourtsData.resolveCourtUnits(court);
                const units = resolved.units.length ? resolved.units : [{ label: null, imageUrl: court.imageUrl }];
                const index = Math.min(Math.max(0, Number(select.value) || 0), units.length - 1);
                overviewSelectedUnitIndex.set(courtId, index);

                const card = select.closest('.dash-court-card');
                const mediaEl = card ? card.querySelector('[data-overview-court-media]') : null;
                paintOverviewCourtMedia(mediaEl, court, units[index]);

                // Revision 5, D4 (implementation_plan.md) — occupancy is now
                // PER SELECTED UNIT, so a unit change can flip which hours
                // this card's peek strip shows as booked/open. Patched in
                // place rather than a full renderOverviewCourtList()
                // re-render, so no OTHER card's expanded state or scroll
                // position is disturbed; a COLLAPSED strip needs no repaint
                // here at all — renderOverviewCourtCard() already reads the
                // just-updated overviewSelectedUnitIndex the next time this
                // card is expanded.
                const strip = card ? card.querySelector('[data-overview-peek-strip]') : null;
                if (strip && strip.classList.contains('is-active')) {
                    strip.innerHTML = renderOverviewPeekContent(court, units[index].label);
                }
            });
        });
    }

    // Sort-select changes only re-render (sorting already-fetched data), not
    // re-fetch — implementation_plan.md's explicit instruction, since
    // nothing about the underlying court/booking data changes with sort
    // order. Grouped by sport (§4's "visual segregation") AFTER sorting, so
    // the chosen sort mode still decides which sport heading comes first —
    // see groupOverviewCourtsBySport() above.
    function renderOverviewCourtList() {
        if (!overviewCourtList) return;
        if (!overviewCourts.length) {
            overviewCourtList.innerHTML = '<p style="color: var(--color-ink-faint); padding: 8px 4px;">No courts available right now.</p>';
            return;
        }
        const sorted = sortOverviewCourts(overviewCourts, overviewSortMode);
        const groups = groupOverviewCourtsBySport(sorted);
        overviewCourtList.innerHTML = groups.map((group) => `
            <div class="dash-court-group">
                <h4 class="dash-court-group-title">${window.escapeHtml(group.sportName)}</h4>
                <div class="dash-court-grid">${group.courts.map(renderOverviewCourtCard).join('')}</div>
            </div>
        `).join('');
        wireOverviewCourtList();
    }

    if (overviewSortSelect) {
        overviewSortSelect.addEventListener('change', () => {
            overviewSortMode = overviewSortSelect.value;
            renderOverviewCourtList();
        });
    }

    // Revision 5, D5 (implementation_plan.md) — changing the date DOES
    // re-fetch (unlike the sort <select> above): a different day's bookings
    // and walk-ins are genuinely different data, not just a different
    // ordering of what's already in memory. Same past-date clamp idiom as
    // the Booking wizard's own bookDate change handler above.
    if (overviewDateInput) {
        overviewDateInput.addEventListener('change', () => {
            const todayStr = todayDateInputValue();
            if (overviewDateInput.value < todayStr) {
                overviewDateInput.value = todayStr;
                window.InigoToast?.show("You can't check availability for a past date — showing today instead.", true);
            }
            overviewDate = overviewDateInput.value;
            refreshOverviewCourtWidget();
        });
    }

    async function refreshOverviewCourtWidget(forceRules = false) {
        if (!overviewCourtList || !window.InigoCourtsData) return;

        // M3 fix (post-Revision-5 review) — see overviewRequestSeq's own
        // declaration above for why this exists.
        const mySeq = ++overviewRequestSeq;

        // Revision 5, D5 — was always todayRange(); now the customer-picked
        // overviewDate, defaulting to today (overviewSelectedDayRange()
        // above).
        const { start, end } = overviewSelectedDayRange();

        const courtsPromise = window.InigoCourtsData.getCourts();
        const occupancyPromise = window.sb
            ? fetchOverviewOccupancy(start, end)
            : Promise.resolve({ data: null, error: new Error('Supabase client unavailable') });
        const rulesPromise = window.InigoBusinessHours?.getForDate
            ? window.InigoBusinessHours.getForDate(overviewDate, { force: forceRules })
            : Promise.resolve(null);

        const [courts, occupancyRes, rules] = await Promise.all([courtsPromise, occupancyPromise, rulesPromise]);

        // M3 fix — a slower, now-superseded call (e.g. the date was changed
        // again before this one resolved) must not overwrite state a newer,
        // already-resolved call already painted. Every write below (state
        // AND the render call) moves after this guard so a stale response
        // touches nothing.
        if (mySeq !== overviewRequestSeq) return;

        overviewDateBase = start;
        overviewCourts = courts || [];
        overviewRules = rules;

        if (occupancyRes.error) console.error('[dashboard] failed to load court occupancy for the court peek', occupancyRes.error);

        // Fail-safe, not fabrication (see this block's header comment on the
        // RLS risk): if EITHER query errors, every court's peek renders the
        // honest "unavailable" note instead of pills. Court rows themselves
        // still render regardless, since overviewCourts came from
        // window.InigoCourtsData independently of these two queries.
        overviewDataOk = !occupancyRes.error && rules?.authoritative === true;
        const occupancyRows = overviewDataOk ? (occupancyRes.data || []) : [];
        overviewBookings = occupancyRows.filter((row) => row.source === 'online');
        overviewWalkins = occupancyRows.filter((row) => ['walkin', 'maintenance', 'checkout_hold'].includes(row.source));

        renderOverviewCourtList();
    }

    refreshOverviewCourtWidget();
    document.addEventListener('inigosync:profile-ready', () => {
        refreshOverviewCourtWidget(true);
        refreshTimePickers(true);
    });

    // ------------------------------------------------------------------
    // My Bookings — real data, fetched once the signed-in profile is ready
    // (authGuard.js dispatches this after its own session+profile check).
    // ------------------------------------------------------------------
    const bookingsTableBody = document.querySelector('[data-dash-panel="bookings"] tbody');

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
    // A booking DISPLAYS as Unattended once ALL of: it is more than 30
    // minutes past its start time (booking.time_date), nobody checked it in
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
    // never drift out of sync between panels, since both My Bookings
    // (refreshMyBookings() below) and Receipts (normalizeReceipt() further
    // below) call this SAME function rather than reading booking.status
    // directly.
    //
    // database/schema/010_booking_unattended_status.sql (optional, NOT
    // applied — no Supabase admin access here) extends that CHECK
    // constraint so a later staff/automation feature COULD persist
    // 'unattended' for real; this function behaves identically whether or
    // not that migration has been run. Existing historical 'cancelled' rows
    // still display exactly as stored — this function only ever touches a
    // still-open pending/confirmed booking.
    // ------------------------------------------------------------------
    const UNATTENDED_GRACE_MINUTES = 30;

    function displayStatusFor(booking) {
        const rawStatus = String(booking.status || '').toLowerCase();
        // Only a still-open booking can ever be "missed" — one that's
        // already cancelled/completed keeps that real status.
        if (rawStatus !== 'pending' && rawStatus !== 'confirmed') return rawStatus;
        // Staff already timed this customer in — they showed up, however
        // late; not Unattended.
        if (booking.checked_in_at) return rawStatus;

        const start = new Date(booking.time_date);
        if (Number.isNaN(start.getTime())) return rawStatus; // defensive — time_date is required, never seen live

        const graceDeadline = start.getTime() + UNATTENDED_GRACE_MINUTES * 60000;
        return Date.now() > graceDeadline ? 'unattended' : rawStatus;
    }

    // Profile panel's Total bookings / Completed / Cancelled tiles
    // ([3]/[4]/[5] of .dash-profile-meta-item — Member since is [2],
    // handled separately in renderProfile() via the auth session).
    // Computed from the exact same booking rows refreshMyBookings() already
    // fetches for the My Bookings table below, rather than a second query.
    // booking.status is CHECK-constrained to pending/confirmed/cancelled/
    // completed (confirmed live against the database), so those are the
    // only values ever seen here.
    function renderProfileBookingStats(bookings) {
        const metaItems = document.querySelectorAll('[data-dash-panel="profile"] .dash-profile-meta-item');
        const total = bookings.length;
        const completed = bookings.filter((b) => b.status === 'completed').length;
        const cancelled = bookings.filter((b) => b.status === 'cancelled').length;
        if (metaItems[3]) metaItems[3].querySelector('span:last-child').textContent = String(total);
        if (metaItems[4]) metaItems[4].querySelector('span:last-child').textContent = String(completed);
        if (metaItems[5]) metaItems[5].querySelector('span:last-child').textContent = String(cancelled);
    }

    let activeReviewBookingId = null;
    const bookingReviewModal = document.querySelector('[data-booking-review-modal]');
    async function refreshMyBookings() {
        if (!bookingsTableBody || !window.sb || !window.inigosyncProfile) return;

        const { data, error } = await window.sb
            .from('booking')
            .select('*')
            .eq('customer_id', window.inigosyncProfile.id)
            .order('time_date', { ascending: false });

        if (error) {
            console.error('[dashboard] failed to load bookings', error);
            // Receipts (R5, Revision 2) reuses this exact fetch rather than
            // a second query — see renderReceipts()'s own header comment
            // below — so a failure here means Receipts can't render either.
            // Same fail-safe-not-fabrication convention this file already
            // uses elsewhere (e.g. the Overview peek widget): show the
            // honest empty state, never a stale or fabricated list.
            if (receiptsGrid) receiptsGrid.innerHTML = RECEIPT_EMPTY_HTML;
            loadWalkinAcknowledgments();
            return;
        }

        renderProfileBookingStats(data || []);
        // Notifications (§3, D6) — reuses this exact fetch rather than a
        // second query against `booking`; see renderNotifications()'s own
        // header comment near the notifications dropdown wiring above.
        renderNotifications(data || []);
        // Receipts (§7/D8, Revision 2's R5) — same reuse, no second query;
        // see renderReceipts()'s own header comment below.
        renderReceipts(data || []);

        bookingsTableBody.innerHTML = '';

        if (!data || data.length === 0) {
            const row = document.createElement('tr');
            row.innerHTML = '<td colspan="6" style="text-align:center; color: var(--color-ink-faint);">No bookings yet — book a court to see it here.</td>';
            bookingsTableBody.appendChild(row);
            return;
        }

        // The safe per-customer view reveals only reviewed booking IDs.
        // Fail closed if it is unavailable: don't invite duplicate submits.
        const reviewResult = await window.sb.from('my_booking_reviews').select('booking_id');
        const reviewedBookings = new Set((reviewResult.error ? [] : reviewResult.data || []).map((review) => String(review.booking_id)));

        data.forEach((booking) => {
            const savedTotal = booking.amount_total === null || booking.amount_total === undefined ? null : Number(booking.amount_total);
            const bookingPricing = getBookingUnitPricing(booking);
            const displayedTotal = Number.isFinite(savedTotal) ? savedTotal : quoteExistingBookingTotal(booking, bookingPricing);
            const amount = Number.isFinite(displayedTotal) ? `₱${displayedTotal.toFixed(2)}` : '—';
            const row = document.createElement('tr');
            // courts is DB content (free text on the booking row) — escaped
            // before touching innerHTML so this renders as literal text in
            // the customer's own session instead of running, same as the
            // staff/admin tables. Status shown is the DERIVED one
            // (displayStatusFor(), R4/Revision 2) — never booking.status
            // directly — so a booking more than 30 minutes past its start
            // with no check-in reads "Unattended" here without ever writing
            // that value to the database.
            const displayStatus = displayStatusFor(booking);
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
            // notices in Pages/user_dashboard.html): the real rule is no
            // cancellation, no refunds/cashback, and 30+ minutes late
            // automatically shows as Unattended above. This cell used to
            // hold ONLY a conditional Cancel button (nothing for
            // completed/cancelled rows) — a Receipt shortcut takes its
            // place instead of leaving the Actions column permanently
            // blank, matching what the static demo rows above it already
            // show in this same column.
            row.innerHTML = `
                <td class="dash-cell-main">${courtLabel}</td>
                <td>${formatBookingDate(booking.time_date)}</td>
                <td>${formatBookingTime(booking.time_date, booking.end_at)}</td>
                <td>${amount}</td>
                <td><span class="dash-status ${statusClass}">${statusLabel}</span></td>
                <td>
                    <div class="dash-table-actions">
                        ${retryPaymentButton}
                        ${reviewButton}
                        <button type="button" class="dash-mini-btn" data-dash-nav="receipts">Details</button>
                    </div>
                </td>
            `;
            bookingsTableBody.appendChild(row);
        });

        // Dynamically-created [data-dash-nav] buttons don't inherit the
        // page's one-time navButtons.forEach() binding at the very top of
        // this file (that querySelectorAll ran once, before these rows
        // existed) — wired explicitly here instead, same re-wire-after-
        // render idiom this file already uses elsewhere for its own
        // dynamically rendered scopes (wireOverviewCourtList() above,
        // wireReceiptDownloads() below).
        bookingsTableBody.querySelectorAll('[data-dash-nav="receipts"]').forEach((btn) => {
            btn.addEventListener('click', () => setActivePanel('receipts'));
        });
        bookingsTableBody.querySelectorAll('[data-dash-retry-checkout]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = 'Opening…';
                const { data, error } = await window.sb.functions.invoke('paymongo-checkout', {
                    body: { booking_id: Number(btn.dataset.dashRetryCheckout) },
                });
                if (!error && typeof data?.checkout_url === 'string'
                    && data.checkout_url.startsWith('https://checkout.paymongo.com/')) {
                    window.location.assign(data.checkout_url);
                    return;
                }
                console.error('[dashboard] PayMongo retry failed', error || data);
                window.InigoToast?.show(data?.message || 'Could not reopen online checkout. Please try again.', true);
                btn.disabled = false;
                btn.textContent = 'Pay online';
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

    document.querySelectorAll('[data-booking-review-close]').forEach((button) => button.addEventListener('click', () => { if (bookingReviewModal) bookingReviewModal.hidden = true; activeReviewBookingId = null; }));
    document.querySelector('[data-booking-review-submit]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        if (!activeReviewBookingId || !window.sb) return;
        const rating = Number(document.querySelector('[data-booking-review-rating]')?.value);
        const comment = document.querySelector('[data-booking-review-comment]')?.value?.trim() || null;
        if (!Number.isInteger(rating) || rating < 1 || rating > 5 || (comment && comment.length > 2000)) return;
        button.disabled = true;
        const { error } = await window.sb.from('booking_review').insert({ booking_id: Number(activeReviewBookingId), rating, comment });
        button.disabled = false;
        if (error) {
            console.error('[dashboard] review submit failed', error);
            window.InigoToast?.show(error.code === '23505' ? 'A review has already been submitted for this booking.' : (error.message || 'Could not publish your review.'), true);
            return;
        }
        bookingReviewModal.hidden = true;
        activeReviewBookingId = null;
        window.InigoToast?.show('Your review is published. Thank you!');
        refreshMyBookings();
    });

    // ------------------------------------------------------------------
    // Receipts (Revision 2, R5 — implementation_plan.md). Renders one
    // .dash-receipt-card per booking from the customer's own real `booking`
    // rows — EVERY booking, not just ones that carry a payment_id (the old
    // Phase 2 behavior, §7/D8, under which this panel could only ever show
    // its hardcoded "No receipts yet" state, since nothing in this project
    // sets payment_id yet — no PayMongo/e-wallet integration). The ask for
    // this revision is explicit: every booking made should show a receipt
    // here. renderReceipts() below is called from refreshMyBookings() with
    // the SAME data that fetch already retrieved — no second query against
    // `booking` (R5's explicit instruction).
    //
    // Amount is shown only where genuinely known: getCourtRate() returns
    // null for every court today (court.rate is NULL in the live DB — see
    // database/seed/002_seed_content.sql), so a card honestly reads
    // "Rate TBA" rather than inventing a peso figure — same convention the
    // booking wizard's own summary and My Bookings' Amount column already
    // use. There is also no `payment` table anywhere in this project, so a
    // receipt card has no payment method/reference to show.
    //
    // Status shown is the DERIVED one (displayStatusFor(), R4 above) — never
    // booking.status directly — so a receipt for a booking more than 30
    // minutes past its start with no check-in reads "Unattended" here too,
    // exactly matching what My Bookings shows for that same booking; the two
    // panels can never disagree, since both call the one shared function.
    //
    // Each card's Download button rasterizes THAT card (not the whole page)
    // to a PNG via html2canvas (CDN <script> in Pages/user_dashboard.html)
    // and canvas.toBlob() + a programmatic <a download> click — the one
    // path that also works on iOS Safari and Android, unlike an <a href>
    // pointed at a data: URL for a large image. This mechanism is unchanged
    // from Phase 2 — only the empty-forever data source above it changed.
    // ------------------------------------------------------------------
    const receiptsGrid = document.querySelector('[data-dash-booking-receipts]');
    const walkinReceiptsGrid = document.querySelector('[data-dash-walkin-receipts]');
    const walkinReceiptPages = document.querySelector('[data-dash-walkin-receipt-pages]');
    const walkinReceiptPageLabel = document.querySelector('[data-dash-walkin-receipts-page]');
    const RECEIPT_EMPTY_HTML = '<p class="dash-notif-empty">No booking payment acknowledgments yet.</p>';
    let receiptRenderGeneration = 0;
    let walkinReceiptPage = 0;
    let walkinReceiptCount = 0;
    const WALKIN_RECEIPT_PAGE_SIZE = 8;

    if (receiptsGrid) receiptsGrid.innerHTML = '<p class="dash-notif-empty">Loading confirmed booking payments…</p>';

    // booking row -> the small, honest subset of fields a receipt card can
    // actually show today: nothing here is invented. `sport` is
    // booking.sports (the court's REAL related sport, e.g. "Bowling" for a
    // "Bowling — Duckpin" booking — see the big booking-insert comment
    // further up this file), `rate` comes from the same getCourtRate()
    // lookup (with the same "Rate TBA" honesty) My Bookings already uses
    // above, `hours` from receiptHours() below, and `status` is the DERIVED
    // display status (R4), not the raw stored one.
    function normalizeReceipt(booking) {
        const pricing = getBookingUnitPricing(booking);
        return {
            id: booking.booking_id,
            court: booking.courts || 'Booking',
            sport: booking.sports || '',
            when: booking.time_date,
            // Part 3 — booking.end_at (database/schema/
            // 012_booking_time_range.sql); undefined for a booking made
            // before that migration, which formatBookingTime()/
            // receiptHours() below both already handle by falling back to a
            // single start-time label / duration_minutes respectively.
            until: booking.end_at,
            status: displayStatusFor(booking),
            rate: getCourtRate(booking.courts),
            total: booking.amount_total === null || booking.amount_total === undefined ? null : Number(booking.amount_total),
            rateDay: pricing.rateDay,
            rateNight: pricing.rateNight,
            rateQuantity: Number(booking.rate_quantity) || 1,
            // L2 fix — carried alongside `rate` so renderReceiptCard() below
            // never has to assume "/hr".
            rateUnit: pricing.rateUnit,
            hours: receiptHours(booking),
        };
    }

    // Whole hours between a booking's start and end (Revision 5, D7 —
    // implementation_plan.md), for the redesigned receipt's itemised
    // "Rate/hr × hours" line. Every booking this app writes is whole-hour
    // by construction (Part 3's Step 2 From/To pickers), so Math.round()
    // here is just floating-point insurance, not real rounding.
    //
    // L1 fix (post-Revision-5 review) — a booking made before database/
    // schema/012_booking_time_range.sql added end_at has no end_at, but it
    // DOES still have its original duration_minutes column (Part 3 stopped
    // writing new values there, it never dropped the column or backfilled
    // it away) — a real recorded duration, not a guess. Falling straight to
    // an assumed 1 hour ignored that real value whenever it wasn't exactly
    // 60. Takes the whole `booking` row (not just two ISO strings) so it can
    // reach duration_minutes; 60 is only the last-resort default when THAT
    // is also missing. This is still a display-only computation — it never
    // invents a rate or amount that isn't already known; "Rate TBA" still
    // applies independently.
    function receiptHours(booking) {
        const endIso = booking.end_at;
        if (endIso) {
            const start = new Date(booking.time_date);
            const end = new Date(endIso);
            if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
                const hours = Math.round((end.getTime() - start.getTime()) / 3600000);
                if (hours > 0) return hours;
            }
        }
        return Math.max(1, Math.round((Number(booking.duration_minutes) || 60) / 60));
    }

    function acknowledgmentAmount(value) {
        if (value === null || value === undefined || value === '') return '—';
        const amount = Number(value);
        return Number.isFinite(amount) ? `₱${amount.toFixed(2)}` : '—';
    }

    function acknowledgmentMoney(major, minor) {
        if (major !== null && major !== undefined && major !== '') return acknowledgmentAmount(major);
        if (minor !== null && minor !== undefined && minor !== '') return acknowledgmentAmount(Number(minor) / 100);
        return '—';
    }

    function renderPaymentAcknowledgment(acknowledgment, cardKey) {
        const items = Array.isArray(acknowledgment.items) ? acknowledgment.items : [];
        const safeKey = window.escapeHtml(String(cardKey || acknowledgment.receipt_id || acknowledgment.receipt_number || 'payment'));
        const receiptNo = window.escapeHtml(String(acknowledgment.receipt_number || acknowledgment.receipt_id || 'Payment acknowledgment'));
        const paymentStatus = String(acknowledgment.payment_status || 'confirmed').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const statusLabel = window.escapeHtml(String(acknowledgment.payment_status || 'Confirmed').replace(/[_-]+/g, ' '));
        const itemRows = items.length ? items.map(item => {
            const place = [item.sport, item.court, item.unit].filter(Boolean).map(value => window.escapeHtml(String(value))).join(' · ') || 'Court access';
            const when = `${window.escapeHtml(formatBookingDate(item.starts_at))} · ${window.escapeHtml(formatBookingTime(item.starts_at, item.ends_at))}`;
            return `<div class="dash-ack-item"><strong>${place}</strong><span>${when}</span><span class="dash-ack-item-amount">${window.escapeHtml(acknowledgmentMoney(item.subtotal, item.subtotal_minor))}</span></div>`;
        }).join('') : '<p class="dash-receipt-thanks">Saved item details are unavailable.</p>';
        const method = String(acknowledgment.payment_method || '—').replace(/[_-]+/g, ' ');
        const issuedAt = acknowledgment.issued_at ? notificationTime(acknowledgment.issued_at) : '—';
        const disclaimer = acknowledgment.disclaimer || 'Payment acknowledgment and entry pass — not a BIR invoice or official receipt.';
        return `<article class="dash-receipt-card dash-payment-ack-card" data-dash-receipt-card="${safeKey}">
            <div class="dash-receipt-brand"><span class="dash-receipt-brand-name">IñigoSync</span><span class="dash-receipt-brand-tag">Payment acknowledgment and entry pass</span></div>
            <p class="dash-receipt-no">Acknowledgment #${receiptNo}</p>
            <div class="dash-receipt-divider"></div>
            <div class="dash-receipt-top"><h4>${window.escapeHtml(String(acknowledgment.customer_name || 'Customer'))}</h4><span class="dash-status ${window.escapeHtml(paymentStatus)}">${statusLabel}</span></div>
            <div class="dash-receipt-meta"><div class="dash-summary-row"><span>Mobile</span><strong>${window.escapeHtml(String(acknowledgment.mobile || '—'))}</strong></div><div class="dash-summary-row"><span>Issued</span><strong>${window.escapeHtml(issuedAt)}</strong></div><div class="dash-summary-row"><span>Payment method</span><strong>${window.escapeHtml(method)}</strong></div></div>
            <div class="dash-receipt-divider"></div>
            <div class="dash-ack-items">${itemRows}</div>
            <div class="dash-receipt-divider"></div>
            <div class="dash-receipt-meta"><div class="dash-summary-row"><span>Subtotal</span><strong>${window.escapeHtml(acknowledgmentMoney(acknowledgment.subtotal, acknowledgment.subtotal_minor))}</strong></div><div class="dash-summary-row"><span>Processing fee</span><strong>${window.escapeHtml(acknowledgmentMoney(acknowledgment.fee, acknowledgment.fee_minor))}</strong></div></div>
            <div class="dash-receipt-total"><span>Total paid</span><span>${window.escapeHtml(acknowledgmentMoney(acknowledgment.total, acknowledgment.gross_minor))}</span></div>
            <div class="dash-receipt-divider"></div>
            <p class="dash-receipt-thanks">${window.escapeHtml(disclaimer)}</p>
            <div class="dash-receipt-actions"><button type="button" class="dash-btn-primary" data-dash-receipt-download="${safeKey}">Download acknowledgment</button></div>
        </article>`;
    }

    function renderAcknowledgmentUnavailable(id) {
        const safeId = window.escapeHtml(String(id));
        return `<article class="dash-receipt-card" data-dash-receipt-card="${safeId}"><h3>Booking #${safeId}</h3><p class="dash-receipt-thanks">A payment is recorded, but its saved acknowledgment could not be loaded. Refresh and try again.</p></article>`;
    }

    // Store-receipt/ticket redesign (Revision 5, D7 — implementation_plan.md):
    // brand header, monospace receipt number, dashed "perforation" dividers,
    // an itemised Rate/hr × hours line (or the existing "Rate TBA" honesty
    // convention whenever the rate itself is unknown — every court today),
    // and a prominent TOTAL row. EXACTLY the same underlying fields as
    // before this redesign (court, receipt #, status, sport, date, time,
    // amount) — nothing new is shown, only how it's laid out. Kept
    // deliberately simple/non-exotic (flexbox, solid backgrounds, plain
    // dashed borders, no gradients/backdrop-filter/transforms/external
    // images) so html2canvas — which does not reliably support every modern
    // CSS feature — captures it correctly and completely, matching the
    // on-screen card exactly (the user's explicit priority for this
    // redesign); see downloadReceiptAsPng() below. No logo image for the
    // same reason: a wordmark rendered as plain text can never fail to load
    // or render differently between the screen and the captured PNG the way
    // an <img> could.
    function renderReceiptCard(receipt) {
        const hasRate = receipt.rate !== null;
        const hasSavedTotal = Number.isFinite(receipt.total);
        const hasSetEstimate = receipt.rateUnit === '/set' && typeof receipt.rateDay === 'number';
        const hasRateEstimate = (hasRate && receipt.rateUnit === '/hr') || hasSetEstimate;
        const amount = hasSavedTotal ? receipt.total : hasSetEstimate
            ? receipt.rateDay * receipt.rateQuantity : hasRateEstimate ? receipt.rate * receipt.hours : null;
        const rateLineLabel = hasSavedTotal
            ? 'Saved reservation total'
            : hasRateEstimate
                ? (receipt.rateUnit === '/set' && typeof receipt.rateDay === 'number' ? `₱${receipt.rateDay.toFixed(2)}/set × ${receipt.rateQuantity} set${receipt.rateQuantity === 1 ? '' : 's'}`
                    : (hasRate ? `₱${receipt.rate.toFixed(2)}/hr × ${receipt.hours} hr${receipt.hours === 1 ? '' : 's'}` : 'Saved reservation total'))
            : hasRate ? `₱${receipt.rate.toFixed(2)}/game`
            : 'Amount';
        const rateLineAmount = hasSavedTotal || hasRateEstimate ? `₱${amount.toFixed(2)}` : hasRate ? 'Games not recorded' : 'Rate TBA';
        const totalAmount = hasSavedTotal || hasRateEstimate ? `₱${amount.toFixed(2)}` : '—';
        const statusClass = window.escapeHtml(receipt.status);
        const statusLabel = window.escapeHtml(receipt.status ? receipt.status.charAt(0).toUpperCase() + receipt.status.slice(1) : '—');
        const idAttr = window.escapeHtml(String(receipt.id));
        // R4-3 (implementation_plan.md, "Revision 4") — carries the same
        // booking_id a notification's data-dash-notif-booking carries (see
        // renderNotificationItem() above), so a notification click can find
        // THIS exact card via document.querySelectorAll('[data-dash-receipt-card]')
        // + a dataset match. wireReceiptDownloads()'s own
        // closest('[data-dash-receipt-card]') below is a presence selector
        // (matches regardless of the attribute's value), so giving it a real
        // value here doesn't affect that at all.
        return `
            <div class="dash-receipt-card" data-dash-receipt-card="${idAttr}">
                <div class="dash-receipt-brand">
                    <span class="dash-receipt-brand-name">IñigoSync</span>
                    <span class="dash-receipt-brand-tag">Booking summary · Not proof of payment</span>
                </div>
                <p class="dash-receipt-no">Booking #${idAttr}</p>

                <div class="dash-receipt-divider"></div>

                <div class="dash-receipt-top">
                    <h4>${window.escapeHtml(receipt.court)}</h4>
                    <span class="dash-status ${statusClass}">${statusLabel}</span>
                </div>

                <div class="dash-receipt-meta">
                    <div class="dash-summary-row"><span>Sport</span><strong>${window.escapeHtml(receipt.sport || '—')}</strong></div>
                    <div class="dash-summary-row"><span>Date</span><strong>${window.escapeHtml(formatBookingDate(receipt.when))}</strong></div>
                    <div class="dash-summary-row"><span>Time</span><strong>${window.escapeHtml(formatBookingTime(receipt.when, receipt.until))}</strong></div>
                </div>

                <div class="dash-receipt-divider"></div>

                <div class="dash-receipt-meta">
                    <div class="dash-summary-row"><span>${window.escapeHtml(rateLineLabel)}</span><strong>${window.escapeHtml(rateLineAmount)}</strong></div>
                </div>

                <div class="dash-receipt-total">
                    <span>Estimated total</span>
                    <span>${window.escapeHtml(totalAmount)}</span>
                </div>

                <div class="dash-receipt-divider"></div>

                <p class="dash-receipt-thanks">Payment is not confirmed by this summary.</p>

                <div class="dash-receipt-actions">
                    <button type="button" class="dash-btn-primary" data-dash-receipt-download="${idAttr}">Download as PNG</button>
                </div>
            </div>
        `;
    }

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
        card.classList.add('is-capturing');
        try {
            const canvas = await window.html2canvas(card, {
                backgroundColor: null,
                scale: Math.min(window.devicePixelRatio || 1, 2) || 1,
                useCORS: true,
                // html2canvas clones the WHOLE document (not just `card`) to
                // resolve inherited styles correctly, so any <iframe> on the
                // page gets walked on every single receipt download even
                // though it never appears in the output — verified locally
                // this used to turn a ~70ms capture into 1300ms+ against the
                // footer's old cross-origin Google Maps <iframe>. That
                // <iframe> is gone as of Revision 5, D9 (implementation_plan.md
                // — the dashboard footer now links out to Maps instead of
                // embedding it), so this guard is currently a no-op; kept
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
            link.download = `inigosync-booking-${filenameId}.png`;
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
            card.classList.remove('is-capturing');
        }
    }

    // Re-wired after every renderReceipts() render, same re-wire-after-
    // render idiom wireOverviewCourtList() above already uses for its own
    // dynamically rendered scope.
    function wireReceiptDownloads() {
        document.querySelectorAll('.dash-receipt-grid [data-dash-receipt-download]').forEach((btn) => {
            if (btn.dataset.dashReceiptDownloadBound === 'true') return;
            btn.dataset.dashReceiptDownloadBound = 'true';
            btn.addEventListener('click', async () => {
                const card = btn.closest('[data-dash-receipt-card]');
                if (!card) return;
                const originalLabel = btn.textContent;
                btn.disabled = true;
                btn.textContent = 'Preparing…';
                const ok = await downloadReceiptAsPng(card, btn.dataset.dashReceiptDownload || 'receipt');
                btn.disabled = false;
                btn.textContent = originalLabel;
                if (ok) window.InigoToast?.show('Booking summary downloaded.');
            });
        });
    }

    // Renders every booking's receipt card at once — called from
    // refreshMyBookings() with the data it already fetched (R5's explicit
    // "no redundant query" instruction), not a fetcher of its own. Genuinely
    // empty only when the customer has zero bookings at all; a fetch error
    // is handled by the caller (refreshMyBookings() falls back to
    // RECEIPT_EMPTY_HTML itself when its shared query fails, same fail-safe
    // convention Phase 2's refreshReceipts() used to use on its own error
    // branch).
    async function renderReceipts(bookings) {
        if (!receiptsGrid) return;
        const generation = ++receiptRenderGeneration;

        if (!bookings || bookings.length === 0) {
            receiptsGrid.innerHTML = RECEIPT_EMPTY_HTML;
            await loadWalkinAcknowledgments();
            return;
        }

        receiptsGrid.innerHTML = '<p class="dash-notif-empty">Loading saved payment acknowledgments…</p>';
        const paidBookings = bookings.filter(booking => Number(booking.amount_paid || 0) > 0);
        const acknowledgments = new Map();
        const failedAcknowledgments = new Set();
        for (let offset = 0; offset < paidBookings.length; offset += 5) {
            const batch = paidBookings.slice(offset, offset + 5);
            const results = await Promise.all(batch.map(async booking => {
                const id = String(booking.booking_id);
                try {
                    const { data, error } = await window.sb.rpc('get_payment_acknowledgment', { p_source: 'booking', p_id: Number(booking.booking_id) });
                    if (error) throw error;
                    const acknowledgment = Array.isArray(data) ? data[0] : data;
                    if (!acknowledgment || !acknowledgment.receipt_id) throw new Error('No saved acknowledgment was returned.');
                    return [id, acknowledgment, null];
                } catch (error) {
                    console.error('[dashboard] saved booking acknowledgment could not be loaded', error);
                    return [id, null, error];
                }
            }));
            results.forEach(([id, acknowledgment, error]) => {
                if (acknowledgment) acknowledgments.set(id, acknowledgment);
                else if (error) failedAcknowledgments.add(id);
            });
        }
        if (generation !== receiptRenderGeneration) return;
        receiptsGrid.innerHTML = bookings.map(booking => {
            const id = String(booking.booking_id);
            const acknowledgment = acknowledgments.get(id);
            if (acknowledgment) return renderPaymentAcknowledgment(acknowledgment, id);
            if (failedAcknowledgments.has(id)) return renderAcknowledgmentUnavailable(id);
            return renderReceiptCard(normalizeReceipt(booking));
        }).join('');
        wireReceiptDownloads();
        await loadWalkinAcknowledgments();
    }

    async function loadWalkinAcknowledgments() {
        if (!walkinReceiptsGrid || !window.sb || !window.inigosyncProfile) return;
        walkinReceiptsGrid.innerHTML = '<p class="dash-notif-empty">Loading linked walk-in visits…</p>';
        try {
            const { data, error } = await window.sb.rpc('customer_list_walkin_acknowledgments', {
                p_offset: walkinReceiptPage * WALKIN_RECEIPT_PAGE_SIZE,
                p_limit: WALKIN_RECEIPT_PAGE_SIZE,
            });
            if (error) throw error;
            const result = Array.isArray(data) ? data[0] : data;
            const rows = Array.isArray(result?.rows) ? result.rows : [];
            walkinReceiptCount = Number(result?.total_count) || 0;
            if (!rows.length) {
                walkinReceiptsGrid.innerHTML = '<p class="dash-notif-empty">No linked walk-in visits with payment acknowledgments yet.</p>';
            } else {
                walkinReceiptsGrid.innerHTML = rows.map(row => {
                    const snapshot = row.payload && typeof row.payload === 'object' ? row.payload : {};
                    const acknowledgment = {
                        ...snapshot,
                        receipt_id: row.receipt_id || snapshot.receipt_id,
                        receipt_number: row.receipt_number || snapshot.receipt_number,
                        issued_at: row.issued_at || snapshot.issued_at,
                    };
                    return renderPaymentAcknowledgment(acknowledgment, `walkin-${row.order_id || row.receipt_id}`);
                }).join('');
            }
            if (walkinReceiptPages) walkinReceiptPages.hidden = walkinReceiptCount <= WALKIN_RECEIPT_PAGE_SIZE;
            if (walkinReceiptPageLabel) walkinReceiptPageLabel.textContent = `Page ${walkinReceiptPage + 1} of ${Math.max(1, Math.ceil(walkinReceiptCount / WALKIN_RECEIPT_PAGE_SIZE))}`;
            const prev = document.querySelector('[data-dash-walkin-receipts-prev]');
            const next = document.querySelector('[data-dash-walkin-receipts-next]');
            if (prev) prev.disabled = walkinReceiptPage === 0;
            if (next) next.disabled = (walkinReceiptPage + 1) * WALKIN_RECEIPT_PAGE_SIZE >= walkinReceiptCount;
            wireReceiptDownloads();
        } catch (error) {
            console.error('[dashboard] linked walk-in acknowledgments could not be loaded', error);
            walkinReceiptsGrid.innerHTML = '<p class="dash-notif-empty">Linked walk-in acknowledgments could not be loaded. Try again.</p>';
        }
    }

    document.querySelector('[data-dash-walkin-receipts-prev]')?.addEventListener('click', () => {
        if (walkinReceiptPage > 0) { walkinReceiptPage -= 1; loadWalkinAcknowledgments(); }
    });
    document.querySelector('[data-dash-walkin-receipts-next]')?.addEventListener('click', () => {
        if ((walkinReceiptPage + 1) * WALKIN_RECEIPT_PAGE_SIZE < walkinReceiptCount) { walkinReceiptPage += 1; loadWalkinAcknowledgments(); }
    });

    // ------------------------------------------------------------------
    // Profile + Settings — prefill from the real signed-in profile, and
    // wire Change Password's save button (data-dash-settings-save="password")
    // to a real Supabase call. Personal Information no longer has a save
    // button of its own as of Revision 5 (implementation_plan.md) — names/
    // email are read-only, and the mobile number's only write path is the
    // provider-validated contact flow, not this save-button family.
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

    // composeFullName() (the inverse of parseFullName() above — "First
    // Middle Last" -> one string) used to live here, used only by the
    // Personal Information card's Save handler. Revision 5 (implementation_plan.md)
    // made the name fields read-only and removed that handler entirely (see
    // its own removal note further below, near where it used to be wired),
    // which left this as unused dead code — removed alongside it rather
    // than left behind for nothing to call.

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
    // affects these three boxes, same isOverviewSchemaMismatch() classifier
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
            if (!isOverviewSchemaMismatch(error)) {
                console.error('[dashboard] failed to load profile name parts', error);
            }
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

    // ------------------------------------------------------------------
    // Account Settings — Profile Photo (R4-4, implementation_plan.md
    // "Revision 4"). profiles.avatar_url already existed and was already
    // selected by includes/authGuard.js's login-gate query — nothing on any
    // dashboard read or wrote it until now. No Supabase Storage bucket
    // exists anywhere in this project (see the two notes in
    // Pages/owner_dashboard.html) and provisioning one is out of this
    // repo's tracked scope, so the picked photo never leaves the browser as
    // a file upload: it is downscaled through a <canvas> into a small,
    // fixed-size (256x256, center-cropped) JPEG data URL and written
    // straight into that existing text column via the SAME self-
    // update().eq('id', window.inigosyncProfile.id) path Personal
    // Information's Save uses below. Unlike that save, avatar_url is
    // already confirmed to exist (authGuard.js selects it today, live), so
    // there is no schema-mismatch column-fallback retry needed here — a
    // failure here is a real error, not a "hasn't been migrated yet" one.
    // ------------------------------------------------------------------
    const AVATAR_MAX_RAW_BYTES = 5 * 1024 * 1024; // 5 MB raw file ceiling, checked before downscaling
    const AVATAR_OUTPUT_SIZE = 256;               // px, square — the final stored image
    const AVATAR_JPEG_QUALITY = 0.82;             // ~20-50KB per image at 256x256

    const avatarFileInput = document.querySelector('[data-dash-avatar-file]');
    const avatarUploadBtn = document.querySelector('[data-dash-avatar-upload-trigger]');
    const avatarRemoveBtn = document.querySelector('[data-dash-avatar-remove]');

    // Revision A1 (implementation_plan.md, decision A9) — the actual
    // center-crop/downscale/encode algorithm moved to the shared
    // includes/imageTools.js (window.InigoImageTools.downscaleImageToDataUrl),
    // which the owner dashboard's own Account Settings avatar upload now
    // uses too, so there is exactly one implementation instead of two
    // copies drifting apart. This is a THIN WRAPPER ONLY — same name, same
    // signature, same AVATAR_OUTPUT_SIZE/AVATAR_JPEG_QUALITY constants
    // passed through — so every caller below and the behaviour a customer
    // sees are byte-identical to before this file existed.
    function downscaleImageToAvatarDataUrl(file) {
        return window.InigoImageTools.downscaleImageToDataUrl(file, {
            size: AVATAR_OUTPUT_SIZE,
            quality: AVATAR_JPEG_QUALITY,
        });
    }

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

    // "Upload Photo" is a styled button, not the (unstyleable) native file
    // input itself — clicking it just forwards to the real, hidden picker,
    // same indirection Pages/user_dashboard.html's own comment on that
    // input describes.
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
            if (file.size > AVATAR_MAX_RAW_BYTES) {
                window.InigoToast?.show('That image is too large — please choose one under 5 MB.', true);
                return;
            }

            const originalLabel = avatarUploadBtn ? avatarUploadBtn.textContent : '';
            if (avatarUploadBtn) {
                avatarUploadBtn.disabled = true;
                avatarUploadBtn.textContent = 'Uploading…';
            }

            try {
                const dataUrl = await downscaleImageToAvatarDataUrl(file);
                const ok = await saveAvatarUrl(dataUrl);
                if (ok) window.InigoToast?.show('Profile photo updated.');
            } catch (err) {
                console.error('[dashboard] avatar downscale failed', err);
                window.InigoToast?.show('Could not process that image. Please try a different file.', true);
            } finally {
                if (avatarUploadBtn) {
                    avatarUploadBtn.disabled = false;
                    avatarUploadBtn.textContent = originalLabel;
                }
            }
        });
    }

    if (avatarRemoveBtn) {
        avatarRemoveBtn.addEventListener('click', async () => {
            avatarRemoveBtn.disabled = true;
            const ok = await saveAvatarUrl(null);
            avatarRemoveBtn.disabled = false;
            if (ok) window.InigoToast?.show('Profile photo removed.');
        });
    }

    // ------------------------------------------------------------------
    // Account Settings — contact number format/type validation.
    // Validation is provider-backed by an authenticated Edge Function; it
    // does not establish ownership. A successful response creates a one-use
    // proof consumed by the database trigger when contact_num is updated.
    // ------------------------------------------------------------------
    const mobileValidateBtn = document.querySelector('[data-dash-mobile-validate]');
    const mobileRemoveBtn = document.querySelector('[data-dash-mobile-remove]');
    const mobileStatus = document.querySelector('[data-dash-mobile-status]');

    function setMobileStatus(message, isError = false) {
        if (!mobileStatus) return;
        mobileStatus.textContent = message;
        mobileStatus.classList.toggle('is-error', isError);
    }

    function renderMobileStatus(profile) {
        const mobileInput = document.querySelector('[data-dash-settings-mobile]');
        const savedNumber = profile.contact_num || '';
        const parsed = savedNumber ? window.validatePhMobile?.(savedNumber) : null;
        if (mobileInput && !mobileInput.dataset.dirty) {
            mobileInput.value = parsed?.valid ? parsed.normalized : savedNumber;
        }
        if (mobileRemoveBtn) mobileRemoveBtn.hidden = !savedNumber;
        if (mobileStatus && !mobileInput?.dataset.dirty) {
            mobileStatus.textContent = !savedNumber
                ? 'A contact number is optional. We check Philippine format, mobile type, and active status, not ownership.'
                : profile.contact_num_validated
                    ? `Validated as an active Philippine mobile number${formatPhoneValidationDate(profile.contact_num_validated_at)}. This does not confirm ownership or guarantee reachability.`
                    : 'This saved number has not been validated for format, mobile type, and active status.';
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
        if (reason === 'not_mobile') return 'Enter a Philippine mobile number.';
        if (reason === 'inactive') return 'The provider reports that this number is not active.';
        if (reason === 'status_unknown') return 'The provider could not confirm the number status. Try again later.';
        return 'Enter a valid Philippine mobile number.';
    }

    mobileValidateBtn?.addEventListener('click', async () => {
        const mobileInput = document.querySelector('[data-dash-settings-mobile]');
        const profile = window.inigosyncProfile;
        if (!window.sb?.functions || !profile || !mobileInput) {
            setMobileStatus('Phone validation is unavailable. Please try again later.', true);
            return;
        }
        const check = window.validatePhMobile?.(mobileInput.value || '');
        if (!check?.valid) {
            setMobileStatus(check?.message || 'Enter a valid Philippine mobile number.', true);
            mobileInput.focus();
            return;
        }
        const current = window.validatePhMobile?.(profile.contact_num || '');
        if (current?.valid && current.normalized === check.normalized) {
            setMobileStatus(profile.contact_num_validated
                ? 'This number is already validated; no provider lookup was used.'
                : 'This saved number is unchanged; no provider lookup was used.');
            mobileInput.dataset.dirty = '';
            return;
        }

        mobileValidateBtn.disabled = true;
        mobileValidateBtn.textContent = 'Validating…';
        setMobileStatus('Checking Philippine format, mobile type, and active status…');
        try {
            const { data, error } = await window.sb.functions.invoke('validate-contact-phone', {
                body: { phone: check.normalized },
            });
            if (error) throw new Error(await mobileFunctionErrorMessage(error));
            if (data?.valid !== true) throw new Error(validationReasonMessage(data?.reason));
            if (data.phone_type !== 'mobile' || !/^\+639\d{9}$/.test(data.normalized || '')
                || data.normalized !== `+63${check.normalized.slice(1)}`) {
                throw new Error('The provider returned an unsupported validation result. Try again later.');
            }

            const { error: saveError } = await window.sb.from('profiles')
                .update({ contact_num: data.normalized }).eq('id', profile.id);
            if (saveError) throw saveError;
            profile.contact_num = data.normalized;
            profile.contact_num_validated = true;
            profile.contact_num_validated_at = new Date().toISOString();
            delete mobileInput.dataset.dirty;
            renderProfile(profile);
            setMobileStatus('Validated as an active Philippine mobile number. This does not confirm ownership or guarantee reachability.');
            window.InigoToast?.show('Contact number validated and saved.');
        } catch (error) {
            console.error('[dashboard] contact number validation failed', error);
            setMobileStatus(error.message || 'Could not validate the number. Try again.', true);
        } finally {
            mobileValidateBtn.disabled = false;
            mobileValidateBtn.textContent = 'Validate & save';
        }
    });

    mobileRemoveBtn?.addEventListener('click', async () => {
        const profile = window.inigosyncProfile;
        if (!window.sb || !profile?.id || !profile.contact_num) return;
        if (!window.confirm('Remove the contact number from your account?')) return;
        mobileRemoveBtn.disabled = true;
        try {
            const { error } = await window.sb.from('profiles').update({ contact_num: null }).eq('id', profile.id);
            if (error) throw error;
            profile.contact_num = null;
            profile.contact_num_validated = false;
            profile.contact_num_validated_at = null;
            const mobileInput = document.querySelector('[data-dash-settings-mobile]');
            if (mobileInput) {
                mobileInput.value = '';
                delete mobileInput.dataset.dirty;
            }
            renderProfile(profile);
            setMobileStatus('Contact number removed. You can add one later.');
            window.InigoToast?.show('Contact number removed.');
        } catch (error) {
            console.error('[dashboard] contact number removal failed', error);
            setMobileStatus(error.message || 'Could not remove the contact number.', true);
        } finally {
            mobileRemoveBtn.disabled = false;
        }
    });

    document.querySelector('[data-dash-settings-mobile]')?.addEventListener('input', event => {
        const input = event.currentTarget;
        input.dataset.dirty = 'true';
        const current = window.validatePhMobile?.(window.inigosyncProfile?.contact_num || '');
        const typed = window.validatePhMobile?.(input.value || '');
        if (current?.valid && typed?.valid && current.normalized === typed.normalized) {
            delete input.dataset.dirty;
            renderMobileStatus(window.inigosyncProfile);
        } else {
            if (mobileRemoveBtn) mobileRemoveBtn.hidden = !window.inigosyncProfile?.contact_num;
            setMobileStatus('Use Validate & save to check and save this number.');
        }
    });

    let contactValidationFetchFor = null;
    async function fetchContactValidation(profileId) {
        if (!window.sb || !profileId) return null;
        const { data, error } = await window.sb.from('profiles')
            .select('contact_num_validated, contact_num_validated_at')
            .eq('id', profileId).maybeSingle();
        if (error) {
            if (!isOverviewSchemaMismatch(error)) console.error('[dashboard] failed to load contact validation status', error);
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

        const metaItems = document.querySelectorAll('[data-dash-panel="profile"] .dash-profile-meta-item');
        if (metaItems[0]) metaItems[0].querySelector('span:last-child').textContent = profile.email || '—';
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
                metaItems[2].querySelector('span:last-child').textContent = createdAt ? formatMemberSince(createdAt) : '—';
            });
        }

        const settingsPanel = document.querySelector('[data-dash-panel="settings"]');
        if (settingsPanel) {
            const emailInput = settingsPanel.querySelector('[data-dash-settings-email]');
            const mobileInput = settingsPanel.querySelector('[data-dash-settings-mobile]');
            if (emailInput) emailInput.value = profile.email || '';
            // Digits-only on load too, matching the field's own [data-digits-only]
            // contract (increment 13). Both write paths (signup, and this
            // panel's own mobile-verification flow above, Revision 5's D6)
            // already run contact_num through window.validatePhMobile
            // first, whose `normalized` is always the spaceless local
            // 09XXXXXXXXX form — so this is a defensive strip for any value
            // that got into the database another way, not a fix for
            // anything either write path produces today.
            if (mobileInput && !mobileInput.dataset.dirty) { const savedPhone = window.validatePhMobile?.(profile.contact_num || ''); mobileInput.value = savedPhone?.valid ? savedPhone.normalized : (profile.contact_num || ''); }

            // First/Middle/Surname (§9, D3) — see populateSettingsNameFields()
            // above for the full_name-parsing fallback.
            populateSettingsNameFields(profile);

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

    // PayMongo redirects back to the dashboard, but the redirect itself is
    // never treated as proof of payment. The signed webhook is authoritative;
    // this owner-scoped status check only tells the customer what the server
    // has recorded so far.
    const paymentReturn = new URLSearchParams(window.location.search);
    const paymentReturnKind = paymentReturn.get('paymongo');
    const paymentReturnAttempt = paymentReturn.get('attempt');
    if (paymentReturnKind && paymentReturnAttempt && window.sb) {
        window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.hash}`);
        window.sb.functions.invoke('paymongo-checkout', {
            body: { action: paymentReturnKind === 'cancelled' ? 'cancel' : 'status', attempt_id: paymentReturnAttempt },
        }).then(({ data, error }) => {
            if (error || !data) {
                window.InigoToast?.show('We could not confirm checkout yet. Please check again shortly.', true);
                return;
            }
            if (data.status === 'paid') window.InigoToast?.show('Payment received. Your booking is confirmed.');
            else if (data.status === 'expired') window.InigoToast?.show('Checkout ended. The selected time is available again.', true);
            else if (paymentReturnKind === 'cancelled') window.InigoToast?.show('Checkout cancellation is being confirmed. Your time remains held until PayMongo closes it.', true);
            else window.InigoToast?.show('Payment is still processing. We will update your booking when PayMongo confirms it.');
            refreshMyBookings();
        }).catch(() => window.InigoToast?.show('We could not confirm checkout yet. Please check again shortly.', true));
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

    // Revision 5 (implementation_plan.md) — the Personal Information card's
    // "Save Changes"/"Cancel" pair and the profile-save handler that used to
    // live here are GONE, not merely disabled: names and email are
    // read-only now (Pages/user_dashboard.html no longer renders either
    // button), and the mobile number's only write path is the validated
    // contact-number flow above, which saves only after the authenticated
    // provider check succeeds. There is nothing
    // left on this card for a Save button to do, so removing the handler
    // outright — rather than leaving it attached to a button that no longer
    // exists — is the "no dead listeners" cleanup this revision calls for.
    // composeFullName()/parseFullName() above stay: parseFullName() still
    // feeds populateSettingsNameFields()'s full_name-parsing fallback for
    // the (now read-only) name fields; only composeFullName() (the inverse,
    // used solely by this deleted save path) would have become dead code,
    // so it is removed alongside this handler.

    // ------------------------------------------------------------------
    // Change Password — 2-step wizard (§9, D4). Step 1 collects only the
    // current password, with Next disabled until it's non-empty; Step 2
    // collects the new password + confirmation, with Go Back / Save
    // Password. This block only re-stages the PRESENTATION — the actual
    // save handler below still re-verifies the current password via
    // sb.auth.signInWithPassword() before calling updateUser(), unchanged.
    // ------------------------------------------------------------------
    const pwStepPanels = document.querySelectorAll('[data-dash-pw-step]');
    const pwStepIndicators = document.querySelectorAll('[data-dash-pw-step-indicator]');
    const pwBackBtn = document.querySelector('[data-dash-pw-back]');
    const pwNextBtn = document.querySelector('[data-dash-pw-next]');
    const passwordSaveBtn = document.querySelector('[data-dash-settings-save="password"]');
    const pwCurrentInput = document.querySelector('[data-dash-pw-current]');
    const pwNewInput = document.querySelector('[data-dash-pw-new]');
    const pwConfirmInput = document.querySelector('[data-dash-pw-confirm]');

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
            pwNextBtn.disabled = !(pwCurrentInput && pwCurrentInput.value !== '');
        }
    }

    function goToPwStep(step) {
        pwWizardStep = step === 2 ? 2 : 1;
        renderPwWizard();
    }

    if (pwCurrentInput) {
        pwCurrentInput.addEventListener('input', renderPwWizard);
    }
    if (pwNextBtn) {
        pwNextBtn.addEventListener('click', () => {
            if (pwNextBtn.disabled) return;
            goToPwStep(2);
        });
    }
    if (pwBackBtn) {
        pwBackBtn.addEventListener('click', () => goToPwStep(1));
    }

    // Establishes the correct initial hidden/disabled state for the nav
    // buttons (matching the `disabled`/`hidden` attributes already baked
    // into the markup as a no-JS baseline) and paints the step-1 indicator.
    renderPwWizard();

    if (passwordSaveBtn) {
        passwordSaveBtn.addEventListener('click', async () => {
            if (!window.sb || !window.inigosyncProfile) return;
            const currentPassword = pwCurrentInput?.value;
            const newPassword = pwNewInput?.value;
            const confirmPassword = pwConfirmInput?.value;

            if (!currentPassword) {
                window.InigoToast?.show('Enter your current password.', true);
                goToPwStep(1);
                return;
            }
            if (!newPassword) {
                window.InigoToast?.show('Enter a new password.', true);
                return;
            }
            if (newPassword !== confirmPassword) {
                window.InigoToast?.show('Passwords do not match.', true);
                return;
            }

            passwordSaveBtn.disabled = true;

            // "Current password" used to be collected and never checked —
            // any hijacked or left-open session could silently take over
            // the account via updateUser(). Re-authenticating with it first
            // (Supabase has no separate "verify password" call) confirms
            // the person at the keyboard actually knows it before the
            // password is changed.
            const { error: verifyError } = await window.sb.auth.signInWithPassword({
                email: window.inigosyncProfile.email,
                password: currentPassword,
            });

            if (verifyError) {
                passwordSaveBtn.disabled = false;
                window.InigoToast?.show('Current password is incorrect.', true);
                goToPwStep(1);
                return;
            }

            const { error } = await window.sb.auth.updateUser({ password: newPassword });
            passwordSaveBtn.disabled = false;

            if (error) {
                window.InigoToast?.show(error.message || 'Could not update your password.', true);
                return;
            }

            [pwCurrentInput, pwNewInput, pwConfirmInput].forEach((input) => { if (input) input.value = ''; });
            goToPwStep(1);
            window.InigoToast?.show('Password updated.');
        });
    }

    // Account Settings — Personal Information's Cancel button (and the
    // [data-dash-settings-cancel] handler that used to discard in-progress
    // edits back to the last-saved values) is gone as of Revision 5
    // (implementation_plan.md): the name fields are read-only now, so there
    // is nothing left to "cancel" back to. Pages/user_dashboard.html no
    // longer renders this button at all — removed here too, rather than
    // wiring a click handler to a selector that will only ever match zero
    // elements.
});
