// IñigoSync — Owner Dashboard controller
// Staff Management, Account Settings, Court Listings, the Booking Overview
// stat tiles/Booking status breakdown, Media Manager,
// and Feedbacks & Reviews all talk to the real Supabase database.
// (Booking trend chart setup lives in event/chart.js, loaded below.)
//
// Revision A1 (implementation_plan.md) brought this page up to the same
// standard as the customer dashboard: a real logo (A1), live Recent
// bookings + Booking status this month replacing two hardcoded fake cards
// (A3), Activate for disabled staff (A4), a real Media Manager against `public.event` + a
// Storage bucket (A5), an Add/Edit court modal (A6), a topbar/settings avatar that renders profiles.avatar_url
// (A8), and a Profile Photo card + editable email + a 2-step Change
// Password wizard in Account Settings (A9). See that section of
// implementation_plan.md for the full rationale; individual blocks below
// cite the specific decision letter they implement.
//
// Revision A2 (implementation_plan.md) followed up: the sidebar Log Out is
// gone (B1, dropdown keeps it), the dropdown gained a View Profile panel
// (B2), Add New Staff moved into a modal (B3), Payment Configuration was
// removed outright (B4), a responsive/consistency pass touched
// Style/owner_dashboard.css (B5), the Court modal gained a Cover + per-unit
// Photos section with a crop editor (B6, includes/imageTools.js's
// openCropEditor()), and courts are per-hour only (B7, no more Billing
// unit / "Per game").
//
// Revision A3 (implementation_plan.md) followed up again: Change Password's
// placeholders read as instructions, not fake passwords (C1); Staff
// Management/the "Active staff accounts" stat are staff-only, no more owner
// row (C2); Booking status this month drops Confirmed/Cancelled (C3);
// Recent bookings was removed (C4); and a new
// Feedbacks & Reviews tab renders a Google-Play-style ratings summary +
// sortable/filterable list over the `feedback` table (C5).

document.addEventListener('DOMContentLoaded', () => {
    function renderOwnerPageNumbers(container, currentPage, pageCount, onPageChange) {
        if (!container) return;
        const pages = pageCount <= 7
            ? Array.from({ length: pageCount }, (_, index) => index + 1)
            : [1, ...(currentPage > 3 ? ['gap'] : []),
                ...Array.from({ length: 3 }, (_, index) => currentPage - 1 + index).filter(page => page > 1 && page < pageCount),
                ...(currentPage < pageCount - 2 ? ['gap'] : []), pageCount];
        container.replaceChildren(...pages.map(page => {
            if (page === 'gap') {
                const gap = document.createElement('span');
                gap.className = 'owner-page-gap';
                gap.setAttribute('aria-hidden', 'true');
                gap.textContent = '…';
                return gap;
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'admin-btn-ghost owner-page-number';
            button.textContent = String(page);
            button.setAttribute('aria-label', `Page ${page}`);
            if (page === currentPage) {
                button.setAttribute('aria-current', 'page');
                button.disabled = true;
            } else {
                button.addEventListener('click', () => onPageChange(page));
            }
            return button;
        }));
    }

    // ------------------------------------------------------------------
    // Panel switching (sidebar + topbar/profile shortcuts)
    // ------------------------------------------------------------------
    const panels = document.querySelectorAll('[data-admin-panel]');
    const titleEl = document.querySelector('[data-admin-title]');
    const subtitleEl = document.querySelector('[data-admin-subtitle]');

    const panelMeta = {
        overview: { title: 'Booking Overview', subtitle: 'View booking trends and business activity.' },
        // Revision A2 (implementation_plan.md, decision B4) — "…and
        // configure payment settings" dropped now that Payment
        // Configuration is gone (see this file's own removal note below).
        staff: { title: 'Staff Management', subtitle: 'Manage staff accounts and roles.' },
        courts: { title: 'Court Listings', subtitle: 'Manage court listings and details.' },
        'booking-rules': { title: 'Business Hours', subtitle: 'Set opening hours and booking rules.' },
        media: { title: 'Media Manager', subtitle: 'Manage website images and slides.' },
        payments: { title: 'Payment Configuration', subtitle: 'Set deposits and payment methods.' },
        // Revision A3 (implementation_plan.md, decision C5) — new tab, after
        // Media Manager in the sidebar.
        feedback: { title: 'Feedbacks & Reviews', subtitle: 'Read customer ratings and reviews.' },
        announcement: { title: 'Announcement', subtitle: 'Publish updates for customers and staff.' },
        audit: { title: 'Audit Trail', subtitle: 'Review owner and staff activity.' },
        settings: { title: 'Account Settings', subtitle: 'Manage your account details and password.' },
        // Revision A2, decision B2 — not in .admin-nav, only reachable from
        // the profile dropdown's "View Profile"; setActivePanel() below
        // still works unmodified since it just looks this key up.
        profile: { title: 'Profile', subtitle: 'View your account information.' },
    };

    function setActivePanel(name) {
        panels.forEach((panel) => {
            panel.classList.toggle('is-active', panel.dataset.adminPanel === name);
        });

        document.querySelectorAll('[data-admin-nav]').forEach((btn) => {
            if (btn.closest('.admin-nav')) {
                const isActive = btn.dataset.adminNav === name;
                btn.classList.toggle('is-active', isActive);
                if (isActive) btn.setAttribute('aria-current', 'page');
                else btn.removeAttribute('aria-current');
            }
        });

        const meta = panelMeta[name];
        if (meta && titleEl && subtitleEl) {
            titleEl.textContent = meta.title;
            subtitleEl.textContent = meta.subtitle;
            subtitleEl.hidden = !meta.subtitle;
        }

        // Feedbacks & Reviews and Audit Trail load when their panels open.

        closeMobileSidebar();
        closeProfileMenu();
        document.dispatchEvent(new CustomEvent('inigosync:owner-panel', { detail: name }));
        if (name === 'payments') loadOwnerPaymentSettings();
        if (name === 'booking-rules') loadBookingRules();
        if (name === 'announcement') loadOwnerAnnouncements();
        if (name === 'audit') startAuditTrailUpdates();
        else stopAuditTrailUpdates();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    window.InigoOwnerUI.navigate = setActivePanel;

    document.querySelectorAll('[data-admin-nav]').forEach((btn) => {
        btn.addEventListener('click', () => setActivePanel(btn.dataset.adminNav));
    });

    // ------------------------------------------------------------------
    // Mobile sidebar toggle
    // ------------------------------------------------------------------
    const mobileToggle = document.querySelector('[data-admin-mobile-toggle]');
    const scrim = document.querySelector('[data-admin-scrim]');
    const adminShell = document.querySelector('.admin-shell');
    const adminSidebar = document.querySelector('[data-admin-sidebar]');
    const sidebarCollapse = document.querySelector('[data-admin-sidebar-collapse]');
    const mobileBreakpoint = window.matchMedia('(max-width: 860px)');

    function setDesktopSidebarCollapsed(collapsed) {
        if (!adminShell || !adminSidebar) return;
        adminShell.classList.toggle('admin-sidebar-collapsed', collapsed);
        if (sidebarCollapse) {
            const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
            sidebarCollapse.setAttribute('aria-label', label);
            sidebarCollapse.setAttribute('title', label);
            sidebarCollapse.setAttribute('aria-expanded', String(!collapsed));
        }
    }

    document.querySelectorAll('.admin-nav-link').forEach((button) => {
        const label = button.textContent.trim().replace(/\s+/g, ' ');
        if (label && !button.hasAttribute('aria-label')) button.setAttribute('aria-label', label);
        if (label) button.setAttribute('title', label);
    });

    if (sidebarCollapse) sidebarCollapse.addEventListener('click', () => {
        const collapsed = !adminShell?.classList.contains('admin-sidebar-collapsed');
        setDesktopSidebarCollapsed(collapsed);
        sidebarCollapse.focus();
    });

    function syncSidebarBreakpoint() {
        if (mobileBreakpoint.matches) setDesktopSidebarCollapsed(false);
    }
    mobileBreakpoint.addEventListener('change', syncSidebarBreakpoint);
    syncSidebarBreakpoint();

    function closeMobileSidebar() {
        document.body.classList.remove('admin-sidebar-open');
        if (mobileToggle) mobileToggle.setAttribute('aria-expanded', 'false');
    }

    if (mobileToggle) {
        mobileToggle.addEventListener('click', () => {
            const isOpen = document.body.classList.toggle('admin-sidebar-open');
            mobileToggle.setAttribute('aria-expanded', String(isOpen));
        });
    }
    if (scrim) scrim.addEventListener('click', closeMobileSidebar);

    // ------------------------------------------------------------------
    // Profile dropdown
    // ------------------------------------------------------------------
    const profile = document.querySelector('[data-admin-profile]');
    const profileTrigger = document.querySelector('[data-admin-profile-trigger]');

    function closeProfileMenu() {
        if (profile) profile.removeAttribute('data-open');
    }

    if (profileTrigger && profile) {
        profileTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            if (profile.hasAttribute('data-open')) {
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

    // ------------------------------------------------------------------
    // Live clock (topbar)
    // ------------------------------------------------------------------
    const clockEl = document.querySelector('[data-admin-clock]');
    function renderClock() {
        if (!clockEl) return;
        const now = new Date();
        const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        clockEl.textContent = `${dateStr} · ${timeStr}`;
    }
    renderClock();
    window.setInterval(renderClock, 30000);

    // True when a Supabase/PostgREST error means "this column/table doesn't
    // exist" — used to turn a raw Postgres error into an honest, specific
    // "needs a database update" message instead of a generic one or (worse)
    // a silent fake success. Same detector as staff_dashboard.js's
    // isSchemaMismatchError — duplicated rather than shared, matching how
    // every other helper in this file is self-contained (no shared module
    // beyond escape.js/courtsData.js/appSettings.js/imageTools.js).
    function isSchemaMismatchError(error) {
        if (!error) return false;
        const code = error.code || '';
        const message = String(error.message || '').toLowerCase();
        return code === 'PGRST204' || code === 'PGRST205' || code === '42703' || code === '42P01' || code === '42883'
            || message.includes('could not find') || message.includes('does not exist')
            || message.includes('schema cache');
    }

    // Revision A1 security requirement (implementation_plan.md) — only
    // allow https:// URLs or the project's own relative paths into an
    // <img src>/image_url column; rejects javascript:/data:/vbscript: etc.
    // Applied both when SAVING a court/slide image URL and when RENDERING
    // one, so a bad value already in the database (however it got there)
    // never reaches an <img src> either. The avatar pipeline's data: URLs
    // are the one deliberate exception — those are generated internally by
    // includes/imageTools.js from a local file, never taken from a URL
    // <input>, and are never run through this check.
    function isSafeImageUrl(url) {
        const value = String(url || '').trim();
        if (!value) return false;
        if (/^https:\/\//i.test(value)) return true;
        if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false; // any other explicit scheme (javascript:, data:, ...)
        if (value.startsWith('//')) return false; // protocol-relative — resolves to whatever scheme the browser likes
        return true; // a relative project path, e.g. "../database/web/basketball.jpg"
    }

    // Shared by the Court modal's photo upload (Court Listings) and Media
    // Manager's slide photos (A5/A6) — both write into the SAME public
    // `media` Storage bucket created by database/schema/015_media_bucket.sql.
    function isMediaBucketMissingError(error) {
        if (!error) return false;
        const message = String(error.message || '').toLowerCase();
        const status = error.statusCode || error.status;
        return message.includes('bucket not found') || String(status) === '404';
    }

    async function uploadToMedia(path, blob) {
        if (!window.sb) throw new Error('Unable to reach the server right now. Please try again shortly.');
        const { error } = await window.sb.storage.from('media').upload(path, blob, {
            upsert: true,
            contentType: 'image/jpeg',
        });
        if (error) {
            if (isMediaBucketMissingError(error)) {
                throw new Error("Photo storage isn't set up yet. Please contact support.");
            }
            throw new Error(error.message || 'Could not upload that image.');
        }
        const { data } = window.sb.storage.from('media').getPublicUrl(path);
        if (!data || !data.publicUrl) throw new Error('Upload succeeded, but no public URL was returned.');
        return data.publicUrl;
    }

    // Best-effort cleanup of a REPLACED/REMOVED photo's old object in the
    // `media` bucket — "best effort" because a stray orphaned object left
    // behind on failure is a harmless storage-quota nit, not something
    // worth surfacing to the admin as an error over. Silently no-ops for
    // any URL that isn't one of our own uploads (e.g. a pasted external
    // https:// URL, or a relative fallback path) — nothing to clean up.
    function removeUploadedMediaBestEffort(url) {
        if (!url || !window.sb) return;
        const marker = '/storage/v1/object/public/media/';
        const idx = url.indexOf(marker);
        if (idx === -1) return;
        const path = url.slice(idx + marker.length);
        if (!path) return;
        window.sb.storage.from('media').remove([path]).then(() => {}, () => {});
    }

    // Shared date/time formatter for Recent bookings + Notifications —
    // "Sep 14, 9:00 AM – 11:00 AM" when an end time is known, "Sep 14,
    // 9:00 AM" otherwise.
    function formatAdminDateTime(startIso, endIso) {
        const start = new Date(startIso);
        if (Number.isNaN(start.getTime())) return '—';
        const dateLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const startLabel = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        let timeLabel = startLabel;
        if (endIso) {
            const end = new Date(endIso);
            if (!Number.isNaN(end.getTime())) {
                timeLabel = `${startLabel} – ${end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
            }
        }
        return `${dateLabel}, ${timeLabel}`;
    }

    // Derived "Unattended" status — same 30-minute-grace rule
    // includes/Dashboard.js's displayStatusFor() uses (Revision 2, R4):
    // more than 30 minutes past time_date, no checked_in_at, and still
    // pending/confirmed. Duplicated rather than shared (this file has no
    // dependency on Dashboard.js and never loads it) — see
    // isSchemaMismatchError's own comment above for why every helper here
    // is self-contained.
    const ADMIN_UNATTENDED_GRACE_MINUTES = 30;
    function adminDisplayStatusFor(booking) {
        const rawStatus = String(booking.status || '').toLowerCase();
        if (rawStatus !== 'pending' && rawStatus !== 'confirmed') return rawStatus;
        if (booking.checked_in_at) return rawStatus;

        const start = new Date(booking.time_date);
        if (Number.isNaN(start.getTime())) return rawStatus;

        const graceDeadline = start.getTime() + ADMIN_UNATTENDED_GRACE_MINUTES * 60000;
        return Date.now() > graceDeadline ? 'unattended' : rawStatus;
    }

    // Shared by Recent bookings (customer_id → name) and Notifications
    // (customer_id → name) — no PostgREST embed, since a real FK from
    // booking.customer_id to profiles.id isn't confirmed in this
    // repo-invisible table (see database/schema/004_staff_module.sql's own
    // header note on `booking`).
    async function fetchProfileNamesByIds(ids) {
        const uniqueIds = Array.from(new Set((ids || []).filter(Boolean).map(String)));
        const map = new Map();
        if (!uniqueIds.length || !window.sb) return map;

        const { data, error } = await window.sb.from('profiles').select('id, full_name').in('id', uniqueIds);
        if (error) {
            console.error('[admin] failed to load customer names', error);
            return map;
        }
        (data || []).forEach((p) => map.set(String(p.id), p.full_name || 'Customer'));
        return map;
    }

    // ------------------------------------------------------------------
    // Booking Overview — 3 account/catalog stat tiles computed from the
    // same tables Staff Management, Court Listings, and staff_dashboard.js's own
    // stat tiles already read — no new tables needed (implementation_plan.md
    // E1). "—" (not "0") whenever a count is genuinely unknown — a query
    // error, window.sb missing, or the whole fetch rejecting — matching the
    // project's existing "Rate TBA"-style rule of never showing an invented
    // number.
    // ------------------------------------------------------------------
    function setAdminStat(key, value) {
        document.querySelectorAll(`[data-admin-stat="${key}"]`).forEach((el) => {
            el.textContent = String(value);
        });
    }

    const ADMIN_STAT_KEYS = ['customer-accounts', 'sports-listed', 'active-staff'];
    function setAllAdminStatsUnknown() {
        ADMIN_STAT_KEYS.forEach((key) => setAdminStat(key, '—'));
    }

    async function refreshOverviewStats() {
        // window.sb missing leaves the tiles on Pages/owner_dashboard.html's
        // own markup default, which is "—" for exactly this reason (see
        // that file's comment on the admin-stat-grid).
        if (!window.sb) return;

        let customersRes, staffRes, sports;
        try {
            [customersRes, staffRes, sports] = await Promise.all([
                window.sb.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'customer'),
                // Revision A3, decision C2 — staff ONLY now (.eq, not the old
                // .in('role', ['staff', 'admin'])): this tile shares the
                // data-admin-stat="active-staff" hook with the profile
                // panel's own "Active staff accounts" stat, and both are
                // meant to count the STAFF the owner manages, not the owner
                // counting themselves. Mirrors refreshStaffList()'s own
                // .eq('role', 'staff') below — same table, same filter,
                // same reasoning.
                //
                // "Not disabled" — NOT .eq('status', 'active'). staffStatusBadge()
                // below and the Deactivate button both treat "anything but
                // disabled" (including a NULL status, which no frontend code
                // here ever sets, and profiles' real column constraints are
                // unknown — see database/seed/001_seed_users.sql's "KNOWN
                // LIMITATION" note) as active/shown; .eq('status', 'active')
                // would only match seeded demo rows and disagree with the
                // staff table on the same screen. Plain .neq('status',
                // 'disabled') isn't enough on its own either: SQL's `<>`
                // never matches a NULL column (three-valued logic), so a
                // NULL-status row would still be silently dropped — the
                // .or() below adds it back explicitly.
                window.sb.from('profiles').select('*', { count: 'exact', head: true })
                    .eq('role', 'staff').or('status.neq.disabled,status.is.null'),
                window.InigoCourtsData ? window.InigoCourtsData.getSports() : Promise.resolve([]),
            ]);
        } catch (err) {
            // A rejected Promise.all (network failure, etc.) — as opposed to
            // an individual query resolving with a Postgres error, handled
            // below — means none of the four counts are known.
            console.error('[admin] failed to load the overview stats', err);
            setAllAdminStatsUnknown();
            return;
        }

        if (customersRes.error) console.error('[admin] failed to load the total-customer-accounts stat', customersRes.error);
        if (staffRes.error) console.error('[admin] failed to load the active-staff stat', staffRes.error);

        // getSports() falls back to a static SPORTS_FALLBACK array when the
        // real `sport` table can't be reached (includes/courtsData.js) —
        // isSportsFallback() reports that without changing getSports()'s own
        // return shape, which the court modal's sport dropdown below and
        // staff_dashboard.js's schedule tabs still expect to be a plain
        // array. A fallback count is a real number of *options*, not a real
        // count of listed sports, so it's shown as unknown too.
        const sportsIsFallback = Boolean(
            window.InigoCourtsData && window.InigoCourtsData.isSportsFallback && window.InigoCourtsData.isSportsFallback()
        );

        setAdminStat('customer-accounts', customersRes.error ? '—' : (customersRes.count || 0));
        setAdminStat('sports-listed', sportsIsFallback ? '—' : (sports || []).length);
        setAdminStat('active-staff', staffRes.error ? '—' : (staffRes.count || 0));

    }

    // The combined booking report is managed by event/chart.js.

    let ownerIncomeRange = 'month';
    let ownerIncomeRequest = 0;
    const ownerIncomeState = document.querySelector('[data-owner-income-state]');
    const ownerIncomeTotal = document.querySelector('[data-owner-income-total]');
    async function refreshOwnerIncome() {
        if (!ownerIncomeState || !window.sb || !window.inigosyncProfile?.id) return;
        const request = ++ownerIncomeRequest;
        ownerIncomeState.textContent = '';
        ownerIncomeTotal.textContent = '₱—';
        let data; let error;
        try {
            ({ data, error } = await window.sb.rpc('owner_income_period', { p_period: ownerIncomeRange }));
        } catch (err) {
            error = err;
        }
        if (request !== ownerIncomeRequest) return;
        if (error || !Array.isArray(data)) {
            console.error('[admin] failed to load owner income', error);
            ownerIncomeTotal.textContent = '₱—';
            ownerIncomeState.textContent = 'Sales total unavailable right now.';
            return;
        }
        const total = data.reduce((sum, row) => sum + (Number(row.income) || 0), 0);
        const formatter = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 2 });
        ownerIncomeTotal.textContent = formatter.format(total);
        ownerIncomeState.textContent = '';
    }
    document.querySelectorAll('[data-owner-income-range]').forEach(button => button.addEventListener('click', () => {
        const range = button.dataset.ownerIncomeRange;
        if (!['day', 'month', 'year'].includes(range)) return;
        ownerIncomeRange = range;
        document.querySelectorAll('[data-owner-income-range]').forEach(item => item.classList.toggle('is-active', item === button));
        refreshOwnerIncome();
    }));
    document.addEventListener('inigosync:profile-ready', refreshOwnerIncome);
    if (window.inigosyncProfile) refreshOwnerIncome();

    refreshOverviewStats();
    document.addEventListener('inigosync:profile-ready', refreshOverviewStats);

    // ------------------------------------------------------------------
    // Staff Management — Add New Staff modal (Revision A2, decision B3).
    // Same open/close idiom as the Court modal further down this file (S1's
    // mousedown+click backdrop-detection, Esc, focus-first-field,
    // reset-on-open) — ported rather than shared, matching how every other
    // modal-adjacent helper in this file is self-contained (see
    // isSchemaMismatchError's own comment above). The old inline
    // .admin-add-panel[data-admin-staff-form] card (shown/hidden via
    // .is-open) is gone; the "+ Add New Staff" trigger's hook was renamed
    // from data-admin-toggle-staff-form to data-admin-staff-add. The form
    // creates a pending account from only email/position; staff enter their
    // personal details during first-login setup.
    // ------------------------------------------------------------------
    const staffModal = document.querySelector('[data-admin-staff-modal]');
    const staffForm = document.querySelector('[data-admin-staff-form]');
    const staffAddBtns = document.querySelectorAll('[data-admin-staff-add]');

    function wireAdminEmergencyPhoneCheck(input, status) {
        if (!input || !status) return;
        let timer = null;
        let revision = 0;
        const paint = (state, message) => {
            status.dataset.state = state;
            status.textContent = message;
            input.dataset.phoneAvailability = state;
            input.setAttribute('aria-invalid', String(state === 'invalid' || state === 'error'));
        };
        input.addEventListener('input', () => {
            const request = ++revision;
            clearTimeout(timer);
            delete input.dataset.checkedPhone;
            const parsed = window.validatePhMobile?.(input.value.trim());
            if (!input.value.trim()) { paint('', 'Optional · shared contacts allowed'); return; }
            if (!parsed?.valid) { paint('invalid', parsed?.message || 'Enter a valid Philippine mobile number.'); return; }
            paint('checking', 'Checking…');
            timer = setTimeout(async () => {
                try {
                    const { data, error } = await window.sb.rpc('admin_phone_number_exists', {
                        p_phone_e164: `+63${parsed.normalized.slice(1)}`,
                    });
                    if (request !== revision || window.validatePhMobile?.(input.value.trim())?.normalized !== parsed.normalized) return;
                    if (error || typeof data !== 'boolean') throw error || new Error('Unexpected response');
                    input.dataset.checkedPhone = parsed.normalized;
                    paint(data ? 'warning' : 'available', data
                        ? 'Already saved · shared allowed'
                        : 'Valid · available');
                } catch (_) {
                    if (request === revision) paint('error', 'Could not check number availability. Try again.');
                }
            }, 500);
        });
    }
    wireAdminEmergencyPhoneCheck(
        document.querySelector('[data-admin-staff-edit-emergency-number]'),
        document.querySelector('[data-admin-staff-edit-emergency-status]'),
    );

    function resetStaffForm() {
        if (!staffForm) return;
        const emailInput = staffForm.querySelector('[data-admin-staff-email]');
        if (emailInput) emailInput.value = '';
        const roleSelect = staffForm.querySelector('[data-admin-staff-role]');
        if (roleSelect) roleSelect.selectedIndex = 0;
    }

    // Revision S3 — Birthdate can never be set in the future. Set once here
    // (rather than baked into the HTML's static max="…", which would
    // silently go stale) for the Edit/View staff modal further below.
    function todayDateInputValue() {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    const STAFF_MODAL_CLOSE_DELAY_MS = 250;
    let staffModalHideTimer = null;
    let staffModalIsOpen = false;
    let staffModalLastFocused = null;

    function openStaffModal() {
        if (!staffModal || !staffForm) return;
        staffModalLastFocused = document.activeElement;
        resetStaffForm();

        if (staffModalHideTimer) {
            window.clearTimeout(staffModalHideTimer);
            staffModalHideTimer = null;
        }
        staffModal.hidden = false;
        // Force a synchronous layout flush so the browser commits the
        // hidden->visible state before [data-open] flips opacity to 1 —
        // same trick the Court modal below uses.
        void staffModal.offsetWidth;
        staffModal.setAttribute('data-open', '');
        staffModalIsOpen = true;

        const firstField = staffForm.querySelector('input, select');
        if (firstField) firstField.focus();
    }

    let staffAddClosePending = false;
    function staffAddDraftHasChanges() {
        return Boolean(staffForm?.querySelector('[data-admin-staff-email]')?.value.trim())
            || Boolean(staffForm?.querySelector('[data-admin-staff-role]')?.value);
    }
    async function closeStaffModal(force = false) {
        if (!staffModalIsOpen || !staffModal) return;
        if (!force && staffAddDraftHasChanges()) {
            if (staffAddClosePending) return;
            staffAddClosePending = true;
            const accepted = await window.InigoOwnerUI?.confirm({ title: 'Discard staff invitation?', message: 'Your unsent staff invitation details will be lost.', confirmLabel: 'Discard changes', danger: true });
            staffAddClosePending = false;
            if (!accepted) return;
        }
        staffModalIsOpen = false;

        staffModal.removeAttribute('data-open');
        if (staffModalHideTimer) window.clearTimeout(staffModalHideTimer);
        staffModalHideTimer = window.setTimeout(() => {
            staffModal.hidden = true;
            staffModalHideTimer = null;
        }, STAFF_MODAL_CLOSE_DELAY_MS);

        if (staffModalLastFocused && typeof staffModalLastFocused.focus === 'function' && document.contains(staffModalLastFocused)) {
            staffModalLastFocused.focus();
        }
        staffModalLastFocused = null;
    }

    staffAddBtns.forEach((btn) => {
        btn.addEventListener('click', openStaffModal);
    });

    document.querySelectorAll('[data-admin-staff-modal-close]').forEach((btn) => {
        btn.addEventListener('click', () => closeStaffModal());
    });

    // S1 (Revision A1 fix, ported) — see the identical comment on the Court
    // modal's own backdrop listeners further down for why this needs both
    // mousedown and click on the overlay rather than a plain 'click'.
    let staffModalMouseDownOnBackdrop = false;
    if (staffModal) {
        staffModal.addEventListener('mousedown', (e) => {
            staffModalMouseDownOnBackdrop = e.target === staffModal;
        });
        staffModal.addEventListener('click', (e) => {
            if (e.target === staffModal && staffModalMouseDownOnBackdrop) closeStaffModal();
            staffModalMouseDownOnBackdrop = false;
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && staffModalIsOpen) { e.preventDefault(); closeStaffModal(); }
    });

    const staffTable = document.querySelector('[data-admin-staff-table]');
    const staffSubmitBtn = document.querySelector('[data-admin-staff-submit]');
    const staffSearch = document.querySelector('[data-admin-staff-search]');
    const staffStatusFilter = document.querySelector('[data-admin-staff-status-filter]');
    const staffPositionFilter = document.querySelector('[data-admin-staff-position-filter]');
    const staffPagination = document.querySelector('[data-admin-staff-pagination]');
    const staffCount = document.querySelector('[data-admin-staff-count]');
    const staffPagePrev = document.querySelector('[data-admin-staff-page-prev]');
    const staffPageNext = document.querySelector('[data-admin-staff-page-next]');
    const staffPageNumbers = document.querySelector('[data-admin-staff-page-numbers]');
    const STAFF_PAGE_SIZE = 10;
    let staffProfiles = [];
    let staffPage = 1;
    function humanizeStaffAction(value) {
        const fixed = {
            booking_confirmed: 'Booking confirmed', booking_declined: 'Booking declined',
            booking_timed_in: 'Customer checked in', booking_timed_out: 'Customer checked out',
            walkin_recorded: 'Walk-in booking recorded', payment_collected: 'Payment collected',
            recorded_walk_in: 'Walk-in recorded', recorded_booking: 'Booking recorded',
            checked_in: 'Customer checked in', collected_payment: 'Payment collected',
            collected_online_balance: 'Online balance collected', booking_status_changed: 'Booking status changed',
        };
        const action = String(value || 'Activity');
        return fixed[action] || action.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
    }
    if (staffSubmitBtn) {
        staffSubmitBtn.addEventListener('click', async () => {
            const emailInput = document.querySelector('[data-admin-staff-email]');
            const roleSelect = document.querySelector('[data-admin-staff-role]');
            const email = emailInput ? emailInput.value.trim() : '';
            const position = roleSelect ? roleSelect.value : '';

            if (!email) { emailInput?.focus(); return; }
            if (!['Secretary', 'Court Attendant'].includes(position)) {
                window.InigoToast?.show('Choose a valid staff position.', true);
                roleSelect?.focus(); return;
            }
            if (!emailInput.checkValidity()) { emailInput.reportValidity(); return; }

            if (!window.sb || !window.SUPABASE_URL) {
                window.InigoToast?.show('Unable to reach the server right now. Please try again shortly.', true);
                return;
            }

            const accepted = await window.InigoOwnerUI?.confirm({
                title: 'Create staff account?',
                message: `Invite ${email} as ${position}?`,
                confirmLabel: 'Create account',
            });
            if (!accepted) return;

            staffSubmitBtn.disabled = true;
            staffSubmitBtn.textContent = 'Creating account…';

            try {
                const { data: { session } } = await window.sb.auth.getSession();
                if (!session) throw new Error('Your session expired. Please log in again.');

                const res = await fetch(`${window.SUPABASE_URL}/functions/v1/invite-staff`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${session.access_token}`
                    },
                    body: JSON.stringify({ email, position })
                });

                const result = await res.json().catch(() => ({}));
                if (!res.ok) {
                    throw new Error(result.error || 'Could not create the staff account.');
                }

                refreshStaffList();
                resetStaffForm();
                closeStaffModal(true);
                recordOwnerActivity(`Staff account created for ${email}`, 'staff');
            } catch (err) {
                window.InigoToast?.show(err.message || 'Could not create the staff account. Please try again.', true);
            } finally {
                staffSubmitBtn.disabled = false;
                staffSubmitBtn.textContent = 'Create Staff Account';
            }
        });
    }

    // ------------------------------------------------------------------
    // Staff Management — read-only details and position change modal. Both
    // actions use one dialog: View shows profile details, while Change
    // position adds only the position selector and save action. Same
    // .admin-modal-overlay/.admin-modal shell + open/close idiom (Esc/
    // backdrop mousedown+click/×, focus-first-field) as the Add New Staff
    // modal above.
    // ------------------------------------------------------------------
    const staffEditModal = document.querySelector('[data-admin-staff-edit-modal]');
    const staffEditDialog = document.querySelector('[data-admin-staff-edit-dialog]');
    const STAFF_EDIT_MODAL_CLOSE_DELAY_MS = 250;
    let staffEditModalHideTimer = null;
    let staffEditModalIsOpen = false;
    let staffEditModalLastFocused = null;
    let staffEditModalProfileId = null;
    let staffEditModalProfileName = '';
    let staffEditPositionBaseline = '';
    let staffEditClosePending = false;

    function fillStaffEditForm(profile) {
        if (!staffEditDialog) return;
        const positionInput = staffEditDialog.querySelector('[data-admin-staff-edit-position]');
        if (positionInput) positionInput.value = profile.position || '';
        staffEditPositionBaseline = profile.position || '';

        const age = computeAdminStaffAge(profile.birthdate);
        const details = [
            ['name', profile.full_name],
            ['position', profile.position],
            ['mobile', profile.contact_num],
            ['address', profile.address],
            ['birthdate', profile.birthdate],
            ['gender', profile.gender],
            ['age', age === null ? '' : `${age} years old`],
            ['emergency-name', profile.emergency_contact_name],
            ['emergency-number', profile.emergency_contact_number],
        ];
        details.forEach(([key, value]) => {
            const el = staffEditDialog.querySelector(`[data-admin-staff-detail-${key}]`);
            if (el) el.textContent = value || '—';
        });

        const metaEl = staffEditDialog.querySelector('[data-admin-staff-edit-meta]');
        if (metaEl) metaEl.textContent = formatAdminStaffEditMeta(profile);
    }

    function openStaffEditModal(profile, mode) {
        if (!staffEditModal || !staffEditDialog) return;
        staffEditModalLastFocused = document.activeElement;
        staffEditModalProfileId = profile.id;
        staffEditModalProfileName = profile.full_name || 'Staff member';
        fillStaffEditForm(profile);

        const viewingDetails = mode === 'view';
        const detailsView = staffEditDialog.querySelector('[data-admin-staff-details-view]');
        const detailsEdit = staffEditDialog.querySelector('[data-admin-staff-details-edit]');
        if (detailsView) detailsView.hidden = false;
        if (detailsEdit) detailsEdit.hidden = viewingDetails;

        const titleEl = staffEditDialog.querySelector('[data-admin-staff-edit-modal-title]');
        if (titleEl) titleEl.textContent = mode === 'view' ? 'Staff Details' : 'Change Staff Position';
        const saveBtn = staffEditDialog.querySelector('[data-admin-staff-edit-submit]');
        if (saveBtn) saveBtn.hidden = mode === 'view';
        const cancelBtn = staffEditDialog.querySelector('.admin-btn-ghost[data-admin-staff-edit-modal-close]');
        if (cancelBtn) cancelBtn.textContent = 'Close';

        if (staffEditModalHideTimer) {
            window.clearTimeout(staffEditModalHideTimer);
            staffEditModalHideTimer = null;
        }
        staffEditModal.hidden = false;
        // Force a synchronous layout flush so the browser commits the
        // hidden->visible state before [data-open] flips opacity to 1 —
        // same trick the Add New Staff modal above uses.
        void staffEditModal.offsetWidth;
        staffEditModal.setAttribute('data-open', '');
        staffEditModalIsOpen = true;

        const firstField = mode === 'view' ? cancelBtn : staffEditDialog.querySelector('[data-admin-staff-edit-position]');
        if (firstField) firstField.focus();
    }

    async function closeStaffEditModal(force = false) {
        if (!staffEditModalIsOpen || !staffEditModal) return;
        const position = staffEditDialog?.querySelector('[data-admin-staff-edit-position]')?.value || '';
        if (!force && staffEditModal.querySelector('[data-admin-staff-details-edit]:not([hidden])') && position !== staffEditPositionBaseline) {
            if (staffEditClosePending) return;
            staffEditClosePending = true;
            const accepted = await window.InigoOwnerUI?.confirm({ title: 'Discard position change?', message: 'The unsaved staff position change will be lost.', confirmLabel: 'Discard changes', danger: true });
            staffEditClosePending = false;
            if (!accepted) return;
        }
        staffEditModalIsOpen = false;

        staffEditModal.removeAttribute('data-open');
        if (staffEditModalHideTimer) window.clearTimeout(staffEditModalHideTimer);
        staffEditModalHideTimer = window.setTimeout(() => {
            staffEditModal.hidden = true;
            staffEditModalHideTimer = null;
        }, STAFF_EDIT_MODAL_CLOSE_DELAY_MS);

        if (staffEditModalLastFocused && typeof staffEditModalLastFocused.focus === 'function' && document.contains(staffEditModalLastFocused)) {
            staffEditModalLastFocused.focus();
        }
        staffEditModalLastFocused = null;
        staffEditModalProfileId = null;
        staffEditModalProfileName = '';
    }

    document.querySelectorAll('[data-admin-staff-edit-modal-close]').forEach((btn) => {
        btn.addEventListener('click', closeStaffEditModal);
    });

    // S1 (Revision A1 fix, ported) — see the identical comment on the Add
    // New Staff modal's own backdrop listeners above for why this needs
    // both mousedown and click on the overlay rather than a plain 'click'.
    let staffEditModalMouseDownOnBackdrop = false;
    if (staffEditModal) {
        staffEditModal.addEventListener('mousedown', (e) => {
            staffEditModalMouseDownOnBackdrop = e.target === staffEditModal;
        });
        staffEditModal.addEventListener('click', (e) => {
            if (e.target === staffEditModal && staffEditModalMouseDownOnBackdrop) closeStaffEditModal();
            staffEditModalMouseDownOnBackdrop = false;
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && staffEditModalIsOpen) closeStaffEditModal();
    });

    const staffEditSubmitBtn = document.querySelector('[data-admin-staff-edit-submit]');
    if (staffEditSubmitBtn) {
        staffEditSubmitBtn.addEventListener('click', async () => {
            if (!window.sb || !staffEditModalProfileId || !staffEditDialog) return;
            const position = staffEditDialog.querySelector('[data-admin-staff-edit-position]')?.value || '';
            if (!['Secretary', 'Court Attendant'].includes(position)) {
                window.InigoToast?.show('Choose a valid staff position.', true);
                return;
            }
            if (position === staffEditPositionBaseline) { closeStaffEditModal(); return; }

            const staffName = staffEditModalProfileName;
            const accepted = await window.InigoOwnerUI?.confirm({
                title: 'Change staff position?',
                message: `Change ${staffName}'s position to ${position}?`,
                confirmLabel: 'Save position',
            });
            if (!accepted) return;

            staffEditSubmitBtn.disabled = true;
            const { error } = await window.sb.from('profiles')
                .update({ position })
                .eq('id', staffEditModalProfileId);
            staffEditSubmitBtn.disabled = false;

            if (error) {
                window.InigoToast?.show(error.message || 'Could not update staff position.', true);
                return;
            }

            closeStaffEditModal(true);
            refreshStaffList();
            recordOwnerActivity(`Staff position changed: ${staffName}`, 'staff');
            window.InigoToast?.show('Staff position updated.');
        });
    }
    // Revision S3 — age is always DERIVED from birthdate, never stored,
    // duplicated from includes/staff_dashboard.js's own computeStaffAge()
    // rather than shared — see isSchemaMismatchError's own comment above
    // for why every helper in this file is self-contained.
    function computeAdminStaffAge(birthdateStr) {
        if (!birthdateStr) return null;
        const dob = new Date(`${birthdateStr}T00:00:00`);
        if (Number.isNaN(dob.getTime())) return null;
        const now = new Date();
        let age = now.getFullYear() - dob.getFullYear();
        const monthDiff = now.getMonth() - dob.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) age -= 1;
        return age;
    }

    // "24 yrs · Male" under a staff row's name (renderStaffRow() below) —
    // either half missing simply drops out, never a dangling separator.
    function formatAdminStaffRowMeta(profile) {
        const age = computeAdminStaffAge(profile.birthdate);
        const parts = [];
        if (age !== null) parts.push(`${age} yrs`);
        if (profile.gender) parts.push(profile.gender);
        return parts.join(' · ');
    }

    // The Edit/View staff modal's hint line (fillStaffEditForm() above) —
    // Age (when known) + Member since + Status, none of which have their
    // own input in that form.
    function formatAdminStaffEditMeta(profile) {
        const age = computeAdminStaffAge(profile.birthdate);
        const memberSince = profile.created_at
            ? new Date(profile.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
            : '—';
        const statusLabels = { active: 'Active', disabled: 'Deactivated', pending: 'Setup pending' };
        const statusLabel = statusLabels[profile.status] || 'Active';
        const parts = [];
        if (age !== null) parts.push(`${age} yrs old`);
        parts.push(`Member since ${memberSince}`);
        parts.push(statusLabel);
        return parts.join(' · ');
    }

    // Maps profiles.status to the admin-status badge classes already styled
    // in Style/owner_dashboard.css (active/inactive/pending).
    function staffStatusBadge(status) {
        const map = {
            active: ['active', 'Active'],
            disabled: ['inactive', 'Deactivated'],
            pending: ['pending', 'Setup pending'],
        };
        const [cls, label] = map[status] || ['active', 'Active'];
        return `<span class="admin-status ${cls}">${label}</span>`;
    }

    function renderStaffRow(profile) {
        const row = document.createElement('tr');
        row.dataset.id = profile.id;
        // Revision S3 — the whole profile (address/birthdate/gender/
        // emergency contact included, whenever database/schema/
        // 018_staff_details.sql has been applied) rides along on the row
        // element itself so View/Edit (wireStaffRowActions() below) can
        // open the modal with every field already known, with no second
        // fetch — refreshStaffList() already has this same object in hand
        // from its own select('*').
        row.__staffProfile = profile;
        // full_name/email/position are set by the staff create/edit flow
        // (and, before Phase 2, an admin — but this same rendering path is
        // what a promoted/self-edited account would also
        // flow through), so they're escaped before touching innerHTML — a
        // name like `<img src=x onerror=alert(1)>` must render as literal
        // text in this admin session, not run. staffStatusBadge() only
        // returns markup built from a fixed internal map, not profile data,
        // so it's safe as-is.
        //
        // Revision A1, decision A4 — a disabled account additionally gets
        // an Activate button (mirrors the court cards' Activate/Deactivate
        // pair); an active/setup-pending account keeps just Deactivate.
        //
        // Revision S3 — data-admin-staff-name-cell moved onto an inner
        // <span> (was the whole <td>) so a second <span class="admin-staff-meta">
        // ("24 yrs · Male", Style/owner_dashboard.css) can sit under the name
        // without corrupting the name-only .textContent every confirm()
        // message below (Deactivate/Activate) reads from
        // that same hook.
        const metaLine = formatAdminStaffRowMeta(profile);
        row.innerHTML = `
            <td class="admin-cell-main">
                <span data-admin-staff-name-cell>${window.escapeHtml(profile.full_name) || '—'}</span>
                ${metaLine ? `<span class="admin-staff-meta">${window.escapeHtml(metaLine)}</span>` : ''}
            </td>
            <td data-admin-staff-email-cell>${window.escapeHtml(profile.email) || '—'}</td>
            <td data-admin-staff-position-cell>${window.escapeHtml(profile.position) || '—'}</td>
            <td data-admin-staff-status-cell>${staffStatusBadge(profile.status)}</td>
            <td>
                <div class="admin-table-actions admin-staff-action-wrap">
                    <button type="button" class="admin-btn-secondary admin-staff-actions-trigger" data-admin-staff-actions-trigger aria-haspopup="dialog" aria-expanded="false" aria-controls="adminStaffActionCard" aria-label="Actions for ${window.escapeHtml(profile.full_name || 'staff member')}">Actions <span aria-hidden="true">▾</span></button>
                    <button type="button" hidden data-admin-view-staff>View</button>
                    <button type="button" hidden data-admin-edit-staff>Change position</button>
                    ${profile.status === 'disabled'
                        ? '<button type="button" hidden data-admin-activate-staff>Activate</button>'
                        : '<button type="button" hidden data-admin-delete-staff>Deactivate</button>'}
                </div>
            </td>
        `;
        return row;
    }

    // Revision S3 — a stand-in profile object for View/Edit when a row has
    // no row.__staffProfile of its own (the static demo/fallback rows in
    // Pages/owner_dashboard.html, which predate that property — same S6
    // gap the old inline Edit already guarded against). Reads by CELL
    // POSITION (0 Name / 1 Email / 2 Position / 3 Status), not the
    // data-admin-staff-*-cell hooks, since the static rows never had those
    // either; address/birthdate/gender/emergency contact are left blank
    // rather than invented.
    function fallbackProfileFromRow(row) {
        const cells = row.cells || [];
        const nameCell = cells[0] || null;
        const nameText = nameCell
            ? (nameCell.querySelector('[data-admin-staff-name-cell]')?.textContent || nameCell.textContent || '')
            : '';
        return {
            id: row.dataset.id,
            full_name: nameText.trim(),
            email: (cells[1]?.textContent || '').trim(),
            position: (cells[2]?.textContent || '').trim(),
            status: row.querySelector('.admin-status.inactive') ? 'disabled' : 'active',
        };
    }

    // Revision A3, decision C2 — staff ONLY (.eq, not the old .in('role',
    // ['staff', 'admin'])): the owner/admin account managing this table
    // shouldn't also appear as a row inside it. Pages/owner_dashboard.html's
    // own static fallback rows dropped their "Rosalinda Driz" (owner) row to
    // match, so no owner row appears even before this fetch resolves.
    function renderStaffDirectory() {
        if (!staffTable) return;
        const tbody = staffTable.querySelector('tbody');
        const query = staffSearch?.value.trim().toLocaleLowerCase() || '';
        const selectedStatus = staffStatusFilter?.value || 'all';
        const selectedPosition = staffPositionFilter?.value || 'all';
        const filtered = staffProfiles.filter((profile) => {
            const searchable = [profile.full_name, profile.email, profile.position]
                .filter(Boolean).join(' ').toLocaleLowerCase();
            const normalizedStatus = ['active', 'pending', 'disabled'].includes(profile.status)
                ? profile.status
                : 'active';
            return (!query || searchable.includes(query))
                && (selectedStatus === 'all' || normalizedStatus === selectedStatus)
                && (selectedPosition === 'all' || (profile.position || '') === selectedPosition);
        });
        const pageCount = Math.max(1, Math.ceil(filtered.length / STAFF_PAGE_SIZE));
        staffPage = Math.min(Math.max(1, staffPage), pageCount);
        const start = (staffPage - 1) * STAFF_PAGE_SIZE;
        const visibleProfiles = filtered.slice(start, start + STAFF_PAGE_SIZE);

        tbody.innerHTML = '';
        visibleProfiles.forEach((profile) => {
            const row = renderStaffRow(profile);
            tbody.appendChild(row);
            wireStaffRowActions(row);
        });
        if (!staffProfiles.length) {
            tbody.innerHTML = '<tr><td colspan="5">No staff accounts yet.</td></tr>';
        } else if (!filtered.length) {
            tbody.innerHTML = '<tr><td colspan="5">No staff accounts match these filters.</td></tr>';
        }

        if (staffPagination) {
            staffPagination.hidden = filtered.length <= STAFF_PAGE_SIZE;
            if (staffCount) staffCount.textContent = `${filtered.length} staff`;
            if (staffPagePrev) staffPagePrev.disabled = staffPage <= 1;
            if (staffPageNext) staffPageNext.disabled = staffPage >= pageCount;
            renderOwnerPageNumbers(staffPageNumbers, staffPage, pageCount, page => { staffPage = page; renderStaffDirectory(); });
        }
    }

    function refreshStaffPositionOptions() {
        if (!staffPositionFilter) return;
        const previousValue = staffPositionFilter.value || 'all';
        const positions = ['Secretary', 'Court Attendant'];
        staffPositionFilter.innerHTML = '<option value="all">All positions</option>'
            + positions.map((position) => `<option value="${window.escapeHtml(position)}">${window.escapeHtml(position)}</option>`).join('');
        staffPositionFilter.value = positions.includes(previousValue) ? previousValue : 'all';
    }

    async function refreshStaffList() {
        if (!staffTable || !window.sb) return;
        const { data, error } = await window.sb
            .from('profiles')
            .select('*')
            .eq('role', 'staff')
            .order('created_at');

        if (error) {
            console.error('[admin] failed to load staff', error);
            staffProfiles = [];
            if (staffPagination) staffPagination.hidden = true;
            staffTable.querySelector('tbody').innerHTML = '<tr><td colspan="5">Could not load staff accounts. Please refresh the page.</td></tr>';
            return;
        }
        staffProfiles = data || [];
        refreshStaffPositionOptions();
        renderStaffDirectory();
    }

    function wireStaffRowActions(scope) {
        scope.querySelectorAll('[data-admin-staff-actions-trigger]').forEach(trigger => {
            trigger.addEventListener('click', event => {
                event.stopPropagation();
                if (staffActionCardTrigger === trigger) {
                    closeStaffActionCard();
                    return;
                }
                openStaffActionCard(trigger);
            });
        });
        // Revision S3 — View/Edit both open the same modal
        // (openStaffEditModal() above), read-only or editable. row.__staffProfile
        // (set by renderStaffRow() above) is the real profile object,
        // address/birthdate/gender/emergency contact included; the static
        // demo/fallback rows in Pages/owner_dashboard.html predate that
        // property (same S6 gap the old inline Edit already had to guard
        // against), so fallbackProfileFromRow() below rebuilds a minimal
        // stand-in from whatever the row's cells actually show.
        scope.querySelectorAll('[data-admin-view-staff]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const row = btn.closest('tr');
                if (!row) return;
                openStaffEditModal(row.__staffProfile || fallbackProfileFromRow(row), 'view');
            });
        });

        scope.querySelectorAll('[data-admin-edit-staff]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const row = btn.closest('tr');
                if (!row) return;
                openStaffEditModal(row.__staffProfile || fallbackProfileFromRow(row), 'edit');
            });
        });

        // Soft-delete: a real auth.users delete needs service-role/an edge
        // function, unavailable client-side, so this deactivates the profile
        // instead (authGuard.js already refuses disabled accounts at login).
        scope.querySelectorAll('[data-admin-delete-staff]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const row = btn.closest('tr');
                if (!row) return;
                const name = row.querySelector('[data-admin-staff-name-cell]')?.textContent;
                const accepted = await window.InigoOwnerUI?.confirm({
                    title: 'Deactivate staff account?',
                    message: `${name} will no longer be able to log in.`,
                    confirmLabel: 'Deactivate account',
                    danger: true,
                });
                if (!accepted) return;

                btn.disabled = true;
                const { error } = await window.sb.from('profiles').update({ status: 'disabled' }).eq('id', row.dataset.id);
                btn.disabled = false;

                if (error) {
                    window.InigoToast?.show(error.message || 'Could not deactivate this account.', true);
                    return;
                }
                refreshStaffList();
                recordOwnerActivity(`Staff account deactivated: ${name}`, 'staff');
            });
        });

        // Revision A1, decision A4 — Activate restores a deactivated staff
        // account, mirroring the court cards' Activate/Deactivate pair.
        scope.querySelectorAll('[data-admin-activate-staff]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const row = btn.closest('tr');
                if (!row) return;
                const name = row.querySelector('[data-admin-staff-name-cell]')?.textContent || 'this account';
                const accepted = await window.InigoOwnerUI?.confirm({
                    title: 'Activate staff account?',
                    message: `${name} will be able to log in again.`,
                    confirmLabel: 'Activate account',
                });
                if (!accepted) return;

                btn.disabled = true;
                const { error } = await window.sb.from('profiles').update({ status: 'active' }).eq('id', row.dataset.id);
                btn.disabled = false;

                if (error) {
                    window.InigoToast?.show(error.message || 'Could not activate this account.', true);
                    return;
                }
                window.InigoToast?.show(`${name} reactivated.`);
                refreshStaffList();
                recordOwnerActivity(`Staff account activated: ${name}`, 'staff');
            });
        });
    }

    const staffActionCard = document.createElement('div');
    staffActionCard.id = 'adminStaffActionCard';
    staffActionCard.className = 'admin-staff-action-card';
    staffActionCard.dataset.adminStaffActionCard = '';
    staffActionCard.setAttribute('role', 'dialog');
    staffActionCard.setAttribute('aria-label', 'Staff account actions');
    staffActionCard.hidden = true;
    staffActionCard.innerHTML = `
        <button type="button" data-admin-staff-command="view">View staff details</button>
        <button type="button" data-admin-staff-command="edit">Change position</button>
        <button type="button" data-admin-staff-command="toggle">Deactivate account</button>
    `;
    document.body.appendChild(staffActionCard);

    let staffActionCardTrigger = null;

    function positionStaffActionCard() {
        if (!staffActionCardTrigger || staffActionCard.hidden) return;
        const anchor = staffActionCardTrigger.getBoundingClientRect();
        const cardRect = staffActionCard.getBoundingClientRect();
        const margin = 8;
        const maxLeft = Math.max(margin, window.innerWidth - cardRect.width - margin);
        const left = Math.min(maxLeft, Math.max(margin, anchor.right - cardRect.width));
        const below = anchor.bottom + margin;
        const above = anchor.top - cardRect.height - margin;
        const top = below + cardRect.height <= window.innerHeight - margin
            ? below
            : Math.max(margin, above);
        staffActionCard.style.left = `${left}px`;
        staffActionCard.style.top = `${top}px`;
    }

    function closeStaffActionCard(restoreFocus = false) {
        if (!staffActionCard || staffActionCard.hidden) return;
        const previousTrigger = staffActionCardTrigger;
        staffActionCard.hidden = true;
        staffActionCardTrigger = null;
        previousTrigger?.setAttribute('aria-expanded', 'false');
        if (restoreFocus && previousTrigger && document.contains(previousTrigger)) previousTrigger.focus();
    }

    function openStaffActionCard(trigger) {
        const row = trigger.closest('tr');
        if (!row) return;
        closeStaffActionCard();
        staffActionCardTrigger = trigger;
        const toggle = staffActionCard.querySelector('[data-admin-staff-command="toggle"]');
        const isDisabled = row.querySelector('[data-admin-activate-staff]') !== null;
        if (toggle) {
            toggle.textContent = isDisabled ? 'Activate account' : 'Deactivate account';
            toggle.dataset.danger = isDisabled ? 'false' : 'true';
        }
        staffActionCard.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        positionStaffActionCard();
        staffActionCard.querySelector('button')?.focus({ preventScroll: true });
    }

    staffActionCard.addEventListener('click', event => {
        const command = event.target.closest('[data-admin-staff-command]')?.dataset.adminStaffCommand;
        if (!command || !staffActionCardTrigger) return;
        event.stopPropagation();
        const trigger = staffActionCardTrigger;
        const row = trigger.closest('tr');
        closeStaffActionCard(true);
        if (!row) return;
        const target = {
            view: '[data-admin-view-staff]',
            edit: '[data-admin-edit-staff]',
            toggle: row.querySelector('[data-admin-activate-staff]') ? '[data-admin-activate-staff]' : '[data-admin-delete-staff]',
        }[command];
        if (target) row.querySelector(target)?.click();
    });

    document.addEventListener('click', event => {
        if (!staffActionCard.hidden
            && !event.target.closest('[data-admin-staff-action-card]')
            && !event.target.closest('[data-admin-staff-actions-trigger]')) {
            closeStaffActionCard(staffActionCard.contains(document.activeElement));
        }
    });
    document.addEventListener('keydown', event => {
        if (staffActionCard.hidden) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            closeStaffActionCard(true);
        }
    });
    // Keep the floating card beside the row when the viewport changes or
    // scrolls. Close it only when its anchor has scrolled out of view.
    window.addEventListener('resize', positionStaffActionCard);
    window.addEventListener('scroll', event => {
        if (!staffActionCardTrigger || event.target === staffActionCard) return;
        const anchor = staffActionCardTrigger.getBoundingClientRect();
        const tableClip = staffActionCardTrigger.closest('.admin-table-wrap')?.getBoundingClientRect();
        const anchorVisible = anchor.bottom > 0 && anchor.top < window.innerHeight
            && anchor.right > 0 && anchor.left < window.innerWidth
            && (!tableClip || (anchor.bottom > tableClip.top && anchor.top < tableClip.bottom));
        if (!anchorVisible) {
            closeStaffActionCard(staffActionCard.contains(document.activeElement));
            return;
        }
        positionStaffActionCard();
    }, true);

    // S6 (Revision A1 fix) — Pages/owner_dashboard.html ships a few static
    // demo <tr> rows in this table as its no-JS/pre-load baseline. Every
    // row refreshStaffList() itself renders gets wired via its own
    // wireStaffRowActions(row) call above, but those static rows never did
    // — their buttons were completely inert. Wiring the whole table once
    // here (before the first refreshStaffList() swaps them out) means the
    // fallback rows behave like rendered rows for however long they're on
    // screen (including if window.sb is unset and refreshStaffList()
    // never gets to replace them at all).
    if (staffTable) wireStaffRowActions(staffTable);
    refreshStaffList();
    document.addEventListener('inigosync:profile-ready', refreshStaffList);

    if (staffSearch && staffTable) {
        staffSearch.addEventListener('input', () => {
            staffPage = 1;
            renderStaffDirectory();
        });
    }
    [staffStatusFilter, staffPositionFilter].forEach((filter) => {
        filter?.addEventListener('change', () => {
            staffPage = 1;
            renderStaffDirectory();
        });
    });
    staffPagePrev?.addEventListener('click', () => {
        if (staffPage <= 1) return;
        staffPage -= 1;
        renderStaffDirectory();
    });
    staffPageNext?.addEventListener('click', () => {
        staffPage += 1;
        renderStaffDirectory();
    });

    // ------------------------------------------------------------------
    // Payment Configuration — owner-only controls for future bookings.
    // The database's RLS protects writes; payment credentials stay server-side.
    // ------------------------------------------------------------------
    const ownerPaymentPercent = document.querySelector('[data-owner-payment-percent]');
    const ownerPaymentSave = document.querySelector('[data-owner-payment-save]');
    const ownerPaymentEdit = document.querySelector('[data-owner-payment-edit]');
    const ownerPaymentModal = document.querySelector('[data-owner-payment-modal]');
    const ownerPaymentDialog = document.querySelector('[data-owner-payment-dialog]');
    const ownerPaymentSavedPercent = document.querySelector('[data-owner-payment-saved-percent]');
    const ownerPaymentSavedMethods = document.querySelector('[data-owner-payment-saved-methods]');
    const ownerPaymentMessage = document.querySelector('[data-owner-payment-message]');
    const ownerPaymentEditorMessage = document.querySelector('[data-owner-payment-editor-message]');
    const ownerPaymentCancel = document.querySelector('[data-owner-payment-cancel]');
    const ownerPaymentInputs = Object.fromEntries(['cash', 'card', 'gcash', 'qrph'].map(method => [method,
        document.querySelector(`[data-owner-payment-method="${method}"]`)]));
    const ownerPaymentDefaults = { downpaymentPct: 50, cashEnabled: true, cardEnabled: false, gcashEnabled: true, qrphEnabled: false };
    let ownerPaymentLoadGeneration = 0;
    let ownerPaymentBaseline = null;
    let ownerPaymentBackdropStart = false;

    function setOwnerPaymentMessage(message, isError = false, target = ownerPaymentMessage) {
        if (!target) return;
        target.textContent = message || '';
        target.classList.toggle('is-error', Boolean(message) && isError);
        target.classList.toggle('is-success', Boolean(message) && !isError);
    }

    function normalizeOwnerPaymentSettings(settings) {
        return {
            downpaymentPct: Number(settings.downpaymentPct ?? 50),
            cashEnabled: settings.cashEnabled !== false,
            cardEnabled: settings.cardEnabled === true,
            gcashEnabled: settings.gcashEnabled !== false,
            qrphEnabled: settings.qrphEnabled === true,
        };
    }

    function paintOwnerPaymentSettings(settings) {
        const normalized = normalizeOwnerPaymentSettings(settings);
        if (ownerPaymentPercent) ownerPaymentPercent.value = String(normalized.downpaymentPct);
        if (ownerPaymentInputs.cash) ownerPaymentInputs.cash.checked = normalized.cashEnabled;
        if (ownerPaymentInputs.card) ownerPaymentInputs.card.checked = normalized.cardEnabled;
        if (ownerPaymentInputs.gcash) ownerPaymentInputs.gcash.checked = normalized.gcashEnabled;
        if (ownerPaymentInputs.qrph) ownerPaymentInputs.qrph.checked = normalized.qrphEnabled;
        if (ownerPaymentSavedPercent) ownerPaymentSavedPercent.textContent = `${normalized.downpaymentPct}%`;
        if (ownerPaymentSavedMethods) {
            const methods = [
                ['Cash', normalized.cashEnabled], ['Card', normalized.cardEnabled],
                ['GCash', normalized.gcashEnabled], ['QR Ph', normalized.qrphEnabled],
            ].filter(([, enabled]) => enabled).map(([name]) => name);
            ownerPaymentSavedMethods.textContent = methods.join(', ') || 'None enabled';
        }
        return normalized;
    }

    function getOwnerPaymentDraft() {
        return normalizeOwnerPaymentSettings({
            downpaymentPct: ownerPaymentPercent?.value,
            cashEnabled: ownerPaymentInputs.cash?.checked,
            cardEnabled: ownerPaymentInputs.card?.checked,
            gcashEnabled: ownerPaymentInputs.gcash?.checked,
            qrphEnabled: ownerPaymentInputs.qrph?.checked,
        });
    }

    function ownerPaymentHasChanges() {
        if (!ownerPaymentBaseline || !ownerPaymentPercent) return false;
        return JSON.stringify(getOwnerPaymentDraft()) !== JSON.stringify(ownerPaymentBaseline);
    }

    function openOwnerPaymentModal() {
        if (!ownerPaymentBaseline || ownerPaymentEdit?.disabled) return;
        paintOwnerPaymentSettings(ownerPaymentBaseline);
        setOwnerPaymentMessage('', false, ownerPaymentEditorMessage);
        window.InigoOwnerUI?.open(ownerPaymentModal);
    }

    function closeOwnerPaymentModal() {
        window.InigoOwnerUI?.close(ownerPaymentModal);
    }

    async function cancelOwnerPaymentEdit() {
        if (!ownerPaymentModal || ownerPaymentModal.hidden || ownerPaymentSave?.disabled) return;
        if (ownerPaymentHasChanges()) {
            const accepted = await window.InigoOwnerUI?.confirm({
                title: 'Discard payment settings changes?',
                message: 'Your unsaved payment settings changes will be lost.',
                confirmLabel: 'Discard changes',
                danger: true,
            });
            if (!accepted) return;
        }
        if (ownerPaymentBaseline) paintOwnerPaymentSettings(ownerPaymentBaseline);
        setOwnerPaymentMessage('', false, ownerPaymentEditorMessage);
        closeOwnerPaymentModal();
    }

    async function loadOwnerPaymentSettings() {
        if (!ownerPaymentEdit) return;
        const generation = ++ownerPaymentLoadGeneration;
        setOwnerPaymentMessage('Loading payment settings…');
        ownerPaymentEdit.disabled = true;
        if (!window.sb) {
            setOwnerPaymentMessage('Payment settings are unavailable until the server connection is ready.', true);
            return;
        }
        try {
            const { data, error } = await window.sb.from('app_settings')
                .select('downpayment_pct,cash_enabled,card_enabled,gcash_enabled,qrph_enabled')
                .eq('id', true).maybeSingle();
            if (generation !== ownerPaymentLoadGeneration) return;
            if (error) throw error;
            if (data) {
                ownerPaymentBaseline = paintOwnerPaymentSettings({
                    downpaymentPct: Number(data.downpayment_pct),
                    cashEnabled: data.cash_enabled,
                    cardEnabled: data.card_enabled,
                    gcashEnabled: data.gcash_enabled,
                    qrphEnabled: data.qrph_enabled,
                });
                setOwnerPaymentMessage('Settings loaded. Changes apply to new checkouts.');
            } else {
                ownerPaymentBaseline = paintOwnerPaymentSettings(ownerPaymentDefaults);
                setOwnerPaymentMessage('Using the default 50% deposit and enabled GCash and cash options.');
            }
            ownerPaymentEdit.disabled = false;
        } catch (error) {
            if (generation !== ownerPaymentLoadGeneration) return;
            console.error('[admin] payment settings could not be loaded', error);
            ownerPaymentBaseline = null;
            setOwnerPaymentMessage('Payment settings could not be loaded. Try refreshing the page.', true);
        }
    }

    async function saveOwnerPaymentSettings() {
        if (!ownerPaymentSave || !window.sb || ownerPaymentSave.disabled) return;
        const rawPercent = ownerPaymentPercent?.value.trim() || '';
        const percent = Number(rawPercent);
        if (!rawPercent || !Number.isFinite(percent) || percent <= 0 || percent >= 100 || !/^\d+(\.\d{1,2})?$/.test(rawPercent)) {
            setOwnerPaymentMessage('Enter a down payment greater than 0% and less than 100%, using up to two decimal places.', true, ownerPaymentEditorMessage);
            ownerPaymentPercent?.focus();
            return;
        }
        const settings = {
            downpayment_pct: percent,
            cash_enabled: Boolean(ownerPaymentInputs.cash?.checked),
            card_enabled: Boolean(ownerPaymentInputs.card?.checked),
            gcash_enabled: Boolean(ownerPaymentInputs.gcash?.checked),
            qrph_enabled: Boolean(ownerPaymentInputs.qrph?.checked),
        };
        if (!settings.card_enabled && !settings.gcash_enabled && !settings.qrph_enabled) {
            setOwnerPaymentMessage('Enable at least one online payment method (Card, GCash, or QR Ph) for customer bookings.', true, ownerPaymentEditorMessage);
            ownerPaymentInputs.card?.focus();
            return;
        }
        if (window.inigosyncProfile?.role !== 'admin') {
            setOwnerPaymentMessage('Only the owner can change payment settings.', true, ownerPaymentEditorMessage);
            return;
        }
        if (!ownerPaymentHasChanges()) { closeOwnerPaymentModal(); return; }
        const accepted = await window.InigoOwnerUI?.confirm({
            title: 'Save payment settings?',
            message: `Apply a ${percent}% down payment and the selected payment methods to new checkouts?`,
            confirmLabel: 'Save payment settings',
        });
        if (!accepted) return;
        if (ownerPaymentModal) ownerPaymentModal.inert = true;
        ownerPaymentSave.disabled = true;
        ownerPaymentSave.textContent = 'Saving…';
        setOwnerPaymentMessage('Saving payment settings…', false, ownerPaymentEditorMessage);
        try {
            const { error } = await window.sb.from('app_settings').update(settings).eq('id', true);
            if (error) throw error;
            window.InigoAppSettings?.invalidateSettings();
            await window.InigoAppSettings?.getSettings({ force: true });
            ownerPaymentBaseline = paintOwnerPaymentSettings({
                downpaymentPct: settings.downpayment_pct,
                cashEnabled: settings.cash_enabled,
                cardEnabled: settings.card_enabled,
                gcashEnabled: settings.gcash_enabled,
                qrphEnabled: settings.qrph_enabled,
            });
            setOwnerPaymentMessage('Payment settings saved. They apply to new checkouts; existing bookings keep their agreed amount.');
            setOwnerPaymentMessage('Payment settings saved.', false, ownerPaymentEditorMessage);
            closeOwnerPaymentModal();
        } catch (error) {
            console.error('[admin] payment settings save failed', error);
            setOwnerPaymentMessage(error.message || 'Payment settings could not be saved. Please try again.', true, ownerPaymentEditorMessage);
        } finally {
            if (ownerPaymentModal) ownerPaymentModal.inert = false;
            ownerPaymentSave.disabled = false;
            ownerPaymentSave.textContent = 'Save payment settings';
        }
    }

    ownerPaymentEdit?.addEventListener('click', openOwnerPaymentModal);
    ownerPaymentSave?.addEventListener('click', saveOwnerPaymentSettings);
    ownerPaymentCancel?.addEventListener('click', cancelOwnerPaymentEdit);
    ownerPaymentModal?.querySelector('[data-owner-payment-close]')?.addEventListener('click', cancelOwnerPaymentEdit);
    ownerPaymentModal?.addEventListener('pointerdown', event => { ownerPaymentBackdropStart = event.target === ownerPaymentModal; });
    ownerPaymentModal?.addEventListener('click', event => {
        if (ownerPaymentBackdropStart && event.target === ownerPaymentModal) cancelOwnerPaymentEdit();
        ownerPaymentBackdropStart = false;
    });
    ownerPaymentDialog?.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            cancelOwnerPaymentEdit();
        }
    });

    // Court and media editors live in owner-courts.js and owner-media.js.

    // Shared weekly opening hours and the no-show grace period. The server
    // owns conflict checks against existing reservations and payment holds;
    // the browser only validates the form shape before submitting.
    const bookingRulesPanel = document.querySelector('[data-admin-panel="booking-rules"]');
    const bookingRulesWeekdays = document.querySelector('[data-owner-rules-weekdays]');
    const bookingRulesEffective = document.querySelector('[data-owner-rules-effective]');
    const bookingRulesGrace = document.querySelector('[data-owner-rules-grace]');
    const bookingRulesTimezone = document.querySelector('[data-owner-rules-timezone]');
    const bookingRulesMessage = document.querySelector('[data-owner-rules-message]');
    const bookingRulesSave = document.querySelector('[data-owner-rules-save]');
    const bookingRulesEdit = document.querySelector('[data-owner-rules-edit]');
    const bookingRulesCancel = document.querySelector('[data-owner-rules-cancel]');
    const bookingRulesModal = document.querySelector('[data-owner-rules-modal]');
    const bookingRulesDialog = document.querySelector('[data-owner-rules-dialog]');
    const bookingRulesSavedEffective = document.querySelector('[data-owner-rules-saved-effective]');
    const bookingRulesSavedGrace = document.querySelector('[data-owner-rules-saved-grace]');
    const bookingRulesSavedWeek = document.querySelector('[data-owner-rules-saved-week]');
    const bookingRulesUpcoming = document.querySelector('[data-owner-rules-upcoming]');
    const bookingRulesUpcomingEffective = document.querySelector('[data-owner-rules-upcoming-effective]');
    const bookingRulesUpcomingGrace = document.querySelector('[data-owner-rules-upcoming-grace]');
    const bookingRulesUpcomingWeek = document.querySelector('[data-owner-rules-upcoming-week]');
    let bookingRulesModalLastFocused = null;
    let bookingRulesLoading = false;
    let bookingRulesEditing = false;
    let bookingRulesLoaded = false;
    let bookingRulesEditBaseline = null;

    function initializeBookingRuleTimeSelect(select) {
        if (!select || select.tagName !== 'SELECT') return;
        const options = [new Option('Select time', '')];
        for (let hour = 0; hour < 24; hour += 1) {
            const value = `${String(hour).padStart(2, '0')}:00`;
            options.push(new Option(value, value));
        }
        select.replaceChildren(...options);
    }

    function updateBookingRuleClosingOptions(row, preferredClose = null) {
        const open = row.querySelector('[data-owner-rules-open]');
        const close = row.querySelector('[data-owner-rules-close]');
        if (!open || !close) return;

        const currentClose = preferredClose ?? close.value;
        const options = [new Option('Select time', '')];
        for (let hour = 0; hour < 24; hour += 1) {
            const value = `${String(hour).padStart(2, '0')}:00`;
            if (value > open.value) options.push(new Option(value, value));
        }
        close.replaceChildren(...options);
        if (currentClose && currentClose > open.value) {
            close.value = currentClose;
        } else if (currentClose) {
            close.value = options[1]?.value || '';
        }
    }

    bookingRulesWeekdays?.querySelectorAll('[data-owner-rules-open],[data-owner-rules-close]')
        .forEach(initializeBookingRuleTimeSelect);

    function setBookingRulesMessage(message, isError = false) {
        if (!bookingRulesMessage) return;
        bookingRulesMessage.textContent = message;
        bookingRulesMessage.classList.toggle('is-error', isError);
    }

    function getBookingRulesDraft() {
        return JSON.stringify({
            effectiveFrom: bookingRulesEffective?.value || '',
            graceMinutes: bookingRulesGrace?.value || '',
            weekdays: [...(bookingRulesWeekdays?.querySelectorAll('[data-owner-rules-day]') || [])].map(row => ({
                weekday: row.dataset.ownerRulesDay,
                opensAt: row.querySelector('[data-owner-rules-open]')?.value || '',
                closesAt: row.querySelector('[data-owner-rules-close]')?.value || '',
                isClosed: row.querySelector('[data-owner-rules-closed]')?.checked === true,
            })),
        });
    }

    function renderSavedBookingWeek(rules, list) {
        if (!list) return;
        const byDay = new Map((rules.weekly_hours || []).map(item => [Number(item.weekday), item]));
        const labels = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        list.replaceChildren(...labels.map((label, index) => {
            const day = byDay.get(index + 1);
            const item = document.createElement('li');
            const dayLabel = document.createElement('strong');
            const hours = document.createElement('span');
            dayLabel.textContent = label;
            hours.textContent = !day ? 'Unavailable' : day.is_closed ? 'Closed' : `${String(day.opens_at || '').slice(0, 5)}–${String(day.closes_at || '').slice(0, 5)}`;
            item.append(dayLabel, hours);
            return item;
        }));
    }

    function renderSavedBookingRules(rules, upcoming = null) {
        if (bookingRulesSavedEffective) bookingRulesSavedEffective.textContent = String(rules.effective_from || '').slice(0, 10) || '—';
        if (bookingRulesSavedGrace) bookingRulesSavedGrace.textContent = `${Number(rules.grace_minutes) || 0} minutes`;
        renderSavedBookingWeek(rules, bookingRulesSavedWeek);
        if (bookingRulesUpcoming) bookingRulesUpcoming.hidden = !upcoming;
        if (!upcoming) return;
        if (bookingRulesUpcomingEffective) bookingRulesUpcomingEffective.textContent = String(upcoming.effective_from || '').slice(0, 10) || '—';
        if (bookingRulesUpcomingGrace) bookingRulesUpcomingGrace.textContent = String(Number(upcoming.grace_minutes) || 0);
        renderSavedBookingWeek(upcoming, bookingRulesUpcomingWeek);
    }

    function todayBookingRulesDate() {
        if (window.InigoBusinessHours?.dateInManila) return window.InigoBusinessHours.dateInManila(new Date());
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(new Date());
        const part = type => parts.find(item => item.type === type)?.value;
        return `${part('year')}-${part('month')}-${part('day')}`;
    }

    function setRuleDayClosed(row) {
        const closed = row.querySelector('[data-owner-rules-closed]')?.checked === true;
        const closedInput = row.querySelector('[data-owner-rules-closed]');
        if (closedInput) closedInput.disabled = !bookingRulesEditing;
        row.querySelectorAll('[data-owner-rules-open],[data-owner-rules-close]').forEach(input => {
            input.disabled = !bookingRulesEditing || closed;
            input.required = bookingRulesEditing && !closed;
        });
        row.classList.toggle('is-closed', closed);
    }

    function setBookingRulesEditing(editing) {
        bookingRulesEditing = editing;
        if (bookingRulesEffective) bookingRulesEffective.disabled = !editing;
        if (bookingRulesGrace) bookingRulesGrace.disabled = !editing;
        bookingRulesWeekdays?.querySelectorAll('[data-owner-rules-day]').forEach(setRuleDayClosed);
        if (bookingRulesEdit) bookingRulesEdit.hidden = editing || !bookingRulesLoaded;
        if (bookingRulesCancel) bookingRulesCancel.hidden = !editing;
        if (bookingRulesSave) bookingRulesSave.hidden = !editing;
        bookingRulesPanel?.toggleAttribute('data-editing', editing);
    }

    bookingRulesWeekdays?.querySelectorAll('[data-owner-rules-day]').forEach(row => {
        row.querySelector('[data-owner-rules-closed]')?.addEventListener('change', () => setRuleDayClosed(row));
        row.querySelector('[data-owner-rules-open]')?.addEventListener('change', () => updateBookingRuleClosingOptions(row));
    });

    async function loadBookingRules() {
        if (!bookingRulesPanel || !window.sb || bookingRulesLoading) return;
        bookingRulesLoading = true;
        setBookingRulesEditing(false);
        if (bookingRulesEdit) bookingRulesEdit.disabled = true;
        if (bookingRulesSave) bookingRulesSave.disabled = true;
        setBookingRulesMessage('Loading current booking rules…');
        try {
            const { data, error } = await window.sb.rpc('owner_get_booking_rules');
            if (error) throw error;
            const response = Array.isArray(data) ? data[0] : data;
            const rulesList = Array.isArray(response?.rules) ? response.rules : [];
            if (!rulesList.length) throw new Error('No booking rules were returned.');
            const todayManila = todayBookingRulesDate();
            const effectiveRules = rulesList.filter(item => String(item.effective_from || '') <= todayManila)
                .sort((a, b) => String(b.effective_from || '').localeCompare(String(a.effective_from || '')));
            const upcomingRules = rulesList.filter(item => String(item.effective_from || '') > todayManila)
                .sort((a, b) => String(a.effective_from || '').localeCompare(String(b.effective_from || '')));
            const rules = effectiveRules[0] || upcomingRules[0];
            if (!rules || !Array.isArray(rules.weekly_hours)) throw new Error('The booking rules response is incomplete.');
            renderSavedBookingRules(rules, effectiveRules.length ? upcomingRules[0] || null : null);
            bookingRulesEffective.min = todayManila;
            const loadedEffectiveDate = String(rules.effective_from || '').slice(0, 10);
            bookingRulesEffective.value = loadedEffectiveDate >= todayManila ? loadedEffectiveDate : todayManila;
            bookingRulesGrace.value = String(Number.isFinite(Number(rules.grace_minutes)) ? rules.grace_minutes : 30);
            if (bookingRulesTimezone) bookingRulesTimezone.textContent = `Times are shown in ${response.timezone || 'Asia/Manila'}.`;
            const byDay = new Map(rules.weekly_hours.map(item => [Number(item.weekday), item]));
            bookingRulesWeekdays?.querySelectorAll('[data-owner-rules-day]').forEach(row => {
                const day = byDay.get(Number(row.dataset.ownerRulesDay));
                const open = row.querySelector('[data-owner-rules-open]');
                const close = row.querySelector('[data-owner-rules-close]');
                const closed = row.querySelector('[data-owner-rules-closed]');
                if (!day) throw new Error('The weekly schedule is missing one or more days.');
                open.value = String(day.opens_at || '').slice(0, 5);
                updateBookingRuleClosingOptions(row, String(day.closes_at || '').slice(0, 5));
                closed.checked = day.is_closed === true;
                setRuleDayClosed(row);
            });
            bookingRulesLoaded = true;
            setBookingRulesMessage('Current rules loaded.');
        } catch (error) {
            console.error('[admin] booking rules could not be loaded', error);
            setBookingRulesMessage(error.message || 'Booking rules could not be loaded. Try again.', true);
        } finally {
            bookingRulesLoading = false;
            if (bookingRulesEdit) bookingRulesEdit.disabled = false;
            setBookingRulesEditing(false);
            if (bookingRulesSave) bookingRulesSave.disabled = false;
        }
    }

    bookingRulesEdit?.addEventListener('click', () => {
        if (!bookingRulesLoaded || bookingRulesLoading) return;
        bookingRulesModalLastFocused = document.activeElement;
        bookingRulesEditBaseline = getBookingRulesDraft();
        if (bookingRulesModal) {
            bookingRulesModal.hidden = false;
            void bookingRulesModal.offsetWidth;
            bookingRulesModal.setAttribute('data-open', '');
        }
        setBookingRulesEditing(true);
        setBookingRulesMessage('');
        bookingRulesEffective?.focus();
    });

    function closeBookingRulesModal() {
        if (!bookingRulesModal) return;
        bookingRulesModal.removeAttribute('data-open');
        bookingRulesModal.hidden = true;
        bookingRulesModalLastFocused?.focus();
    }

    bookingRulesModal?.querySelector('[data-owner-rules-modal-close]')?.addEventListener('click', () => bookingRulesCancel?.click());
    bookingRulesModal?.addEventListener('click', event => {
        if (event.target === bookingRulesModal) bookingRulesCancel?.click();
    });
    bookingRulesDialog?.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            bookingRulesCancel?.click();
            return;
        }
        if (event.key === 'Tab') {
            const focusable = [...bookingRulesDialog.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])')]
                .filter(element => element.offsetParent !== null);
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!first || !last) return;
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    });

    bookingRulesCancel?.addEventListener('click', async () => {
        if (!bookingRulesEditing || bookingRulesLoading) return;
        const hasChanges = getBookingRulesDraft() !== bookingRulesEditBaseline;
        if (hasChanges) {
            const accepted = await window.InigoOwnerUI?.confirm({
                title: 'Discard Business Hours changes?',
                message: 'Your unsaved Business Hours changes will be lost.',
                confirmLabel: 'Discard changes',
                danger: true,
            });
            if (!accepted) return;
        }
        if (bookingRulesEdit && hasChanges) bookingRulesEdit.disabled = true;
        if (bookingRulesCancel) bookingRulesCancel.disabled = true;
        setBookingRulesEditing(false);
        bookingRulesEditBaseline = null;
        if (hasChanges) {
            setBookingRulesMessage('Discarding unsaved schedule changes…');
            await loadBookingRules();
        }
        if (bookingRulesCancel) bookingRulesCancel.disabled = false;
        closeBookingRulesModal();
    });

    bookingRulesSave?.addEventListener('click', async () => {
        if (!window.sb || bookingRulesLoading) return;
        const effectiveFrom = bookingRulesEffective?.value || '';
        const graceMinutes = Number(bookingRulesGrace?.value);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) { setBookingRulesMessage('Choose the date these rules should take effect.', true); bookingRulesEffective?.focus(); return; }
        const todayManila = todayBookingRulesDate();
        if (effectiveFrom < todayManila) { setBookingRulesMessage('Choose today or a future effective date.', true); bookingRulesEffective?.focus(); return; }
        if (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 240) { setBookingRulesMessage('Enter a grace period from 0 to 240 minutes.', true); bookingRulesGrace?.focus(); return; }

        const weeklyHours = [];
        for (const row of bookingRulesWeekdays?.querySelectorAll('[data-owner-rules-day]') || []) {
            const weekday = Number(row.dataset.ownerRulesDay);
            const isClosed = row.querySelector('[data-owner-rules-closed]')?.checked === true;
            const opensAt = row.querySelector('[data-owner-rules-open]')?.value || '';
            const closesAt = row.querySelector('[data-owner-rules-close]')?.value || '';
            if (!isClosed && (!/^\d{2}:00$/.test(opensAt) || !/^\d{2}:00$/.test(closesAt))) {
                setBookingRulesMessage(`Choose whole-hour opening and closing times (:00) for ${row.querySelector('th')?.textContent || 'each open day'}.`, true);
                row.querySelector('[data-owner-rules-open]')?.focus();
                return;
            }
            if (!isClosed && opensAt >= closesAt) {
                setBookingRulesMessage(`Set a closing time after the opening time for ${row.querySelector('th')?.textContent || 'each open day'}.`, true);
                row.querySelector('[data-owner-rules-open]')?.focus();
                return;
            }
            weeklyHours.push({ weekday, opens_at: isClosed ? null : opensAt, closes_at: isClosed ? null : closesAt, is_closed: isClosed });
        }
        if (weeklyHours.length !== 7) { setBookingRulesMessage('The weekly schedule must include all seven days.', true); return; }

        if (getBookingRulesDraft() === bookingRulesEditBaseline) {
            setBookingRulesEditing(false);
            bookingRulesEditBaseline = null;
            closeBookingRulesModal();
            return;
        }

        const accepted = await window.InigoOwnerUI?.confirm({
            title: 'Save Business Hours?',
            message: `Apply these opening hours and a ${graceMinutes}-minute no-show grace period from ${effectiveFrom}?`,
            confirmLabel: 'Save Business Hours',
        });
        if (!accepted) return;

        if (bookingRulesModal) bookingRulesModal.inert = true;
        bookingRulesSave.disabled = true;
        setBookingRulesMessage('Saving rules and checking existing reservations…');
        try {
            const { error } = await window.sb.rpc('owner_save_booking_rules', {
                p_weekly_hours: weeklyHours,
                p_grace_minutes: graceMinutes,
                p_effective_from: effectiveFrom,
            });
            if (error) throw error;
            window.InigoBusinessHours?.notifyRulesUpdated?.();
            await loadBookingRules();
            setBookingRulesMessage('Business Hours saved. Shared availability will use these hours from the effective date.');
            window.InigoToast?.show('Business Hours saved.');
            setBookingRulesEditing(false);
            closeBookingRulesModal();
        } catch (error) {
            console.error('[admin] booking rules could not be saved', error);
            setBookingRulesMessage(error.message || 'Booking rules could not be saved. Check for conflicts with existing reservations.', true);
        } finally {
            if (bookingRulesModal) bookingRulesModal.inert = false;
            bookingRulesSave.disabled = false;
        }
    });

    // Announcements are server-authored and audience-scoped. A blank publish
    // time means publish now; an explicit datetime is interpreted as Manila
    // wall time before the server validates and schedules it.
    const announcementForm = document.querySelector('[data-owner-announcement-form]');
    const announcementModal = document.querySelector('[data-owner-announcement-modal]');
    const announcementDialog = announcementForm;
    const announcementList = document.querySelector('[data-owner-announcement-list]');
    const announcementMessage = document.querySelector('[data-owner-announcement-message]');
    const announcementSubmit = document.querySelector('[data-owner-announcement-submit]');
    const announcementPages = document.querySelector('[data-owner-announcement-pages]');
    const announcementPageNumbers = document.querySelector('[data-owner-announcement-page-numbers]');
    const announcementSearch = document.querySelector('[data-owner-announcement-search]');
    const announcementStatus = document.querySelector('[data-owner-announcement-status]');
    const announcementCountLabel = document.querySelector('[data-owner-announcement-count]');
    const announcementNext = document.querySelector('[data-owner-announcement-wizard-next]');
    const announcementBack = document.querySelector('[data-owner-announcement-back]');
    const announcementSteps = [...document.querySelectorAll('[data-owner-announcement-step]')];
    let announcementWizardStep = 1;
    let announcementEditBaseline = '';
    let announcementClosePending = false;
    let announcementSavePending = false;
    function getAnnouncementDraft() {
        return JSON.stringify([...(announcementForm?.querySelectorAll('input, textarea, select') || [])].map(field =>
            field.type === 'checkbox' || field.type === 'radio' ? [field.type, field.checked] : field.value));
    }
    function announcementHasChanges() { return getAnnouncementDraft() !== announcementEditBaseline; }
    let announcementEditingId = null;
    let announcementLastFocus = null;
    let announcementModalHideTimer = null;
    let announcementSaving = false;
    const ANNOUNCEMENT_PAGE_SIZE = 10;
    let announcementPage = 0;
    let announcementCount = 0;
    let announcementGeneration = 0;
    let announcementSearchTimer = null;
    const audienceLabels = { customers: 'Customers', staff: 'Staff', both: 'Customers and staff' };

    function setAnnouncementMessage(message, isError = false) {
        if (!announcementMessage) return;
        announcementMessage.textContent = message;
        announcementMessage.classList.toggle('is-error', isError);
    }

    function localManilaDateTimeToIso(value) {
        if (!value) return null;
        const date = new Date(`${value}:00+08:00`);
        return Number.isNaN(date.valueOf()) ? null : date.toISOString();
    }

    function hasAnnouncementContent() {
        const title = announcementForm?.querySelector('[data-owner-announcement-title]');
        const body = announcementForm?.querySelector('[data-owner-announcement-body]');
        return Boolean(title?.value.trim() && body?.value.trim());
    }

    function setAnnouncementWizardStep(step) {
        announcementWizardStep = Math.min(3, Math.max(1, step));
        announcementSteps.forEach(panel => {
            const isActive = Number(panel.dataset.ownerAnnouncementStep) === announcementWizardStep;
            panel.classList.toggle('is-active', isActive);
            panel.hidden = !isActive;
        });
        document.querySelectorAll('[data-owner-announcement-indicator]').forEach(indicator => {
            const index = Number(indicator.dataset.ownerAnnouncementIndicator);
            indicator.classList.toggle('is-current', index === announcementWizardStep);
            indicator.classList.toggle('is-done', index < announcementWizardStep);
            if (index === announcementWizardStep) indicator.setAttribute('aria-current', 'step');
            else indicator.removeAttribute('aria-current');
        });
        if (announcementBack) announcementBack.hidden = announcementWizardStep === 1;
        if (announcementNext) announcementNext.hidden = announcementWizardStep === 3 || (announcementWizardStep === 1 && !hasAnnouncementContent());
        if (announcementSubmit) announcementSubmit.hidden = announcementWizardStep !== 3;
    }

    announcementForm?.querySelectorAll('[data-owner-announcement-title], [data-owner-announcement-body]').forEach(field => {
        field.addEventListener('input', () => {
            if (announcementWizardStep === 1 && announcementNext) announcementNext.hidden = !hasAnnouncementContent();
        });
    });

    function openAnnouncementModal(item = null) {
        if (!announcementModal || !announcementForm) return;
        if (announcementModalHideTimer) { window.clearTimeout(announcementModalHideTimer); announcementModalHideTimer = null; }
        announcementLastFocus = document.activeElement;
        announcementForm.reset();
        announcementEditingId = item?.id || null;
        const heading = announcementForm.querySelector('[data-owner-announcement-modal-title]');
        if (heading) heading.textContent = item ? 'Edit scheduled announcement' : 'Publish a new announcement';
        if (announcementSubmit) announcementSubmit.textContent = item ? 'Save changes' : 'Publish announcement';
        const title = announcementForm.querySelector('[data-owner-announcement-title]');
        const body = announcementForm.querySelector('[data-owner-announcement-body]');
        const audience = announcementForm.querySelector('[data-owner-announcement-audience]');
        const publishTime = announcementForm.querySelector('[data-owner-announcement-publish-at]');
        if (item) {
            if (title) title.value = item.title || '';
            if (body) body.value = item.body || '';
            if (audience) audience.value = item.audience || 'both';
            if (publishTime && item.publish_at) {
                const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(item.publish_at));
                const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
                publishTime.value = `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
            }
        }
        const timeHint = announcementForm.querySelector('[data-owner-announcement-time-hint]');
        if (timeHint) timeHint.textContent = item ? 'Choose a future date and time. Manila time is used.' : 'Leave blank to publish immediately.';
        setAnnouncementWizardStep(1);
        announcementEditBaseline = getAnnouncementDraft();
        setAnnouncementMessage('');
        announcementModal.hidden = false;
        void announcementModal.offsetWidth;
        announcementModal.setAttribute('data-open', '');
        title?.focus();
    }

    async function closeAnnouncementModal(force = false) {
        if ((!force && announcementSaving) || !announcementModal || announcementModal.hidden) return;
        if (!force && announcementHasChanges()) {
            if (announcementClosePending) return;
            announcementClosePending = true;
            const accepted = await window.InigoOwnerUI?.confirm({ title: 'Discard announcement changes?', message: 'Your unsaved announcement details will be lost.', confirmLabel: 'Discard changes', danger: true });
            announcementClosePending = false;
            if (!accepted) return;
        }
        announcementModal.removeAttribute('data-open');
        if (announcementModalHideTimer) window.clearTimeout(announcementModalHideTimer);
        announcementModalHideTimer = window.setTimeout(() => { announcementModal.hidden = true; announcementModalHideTimer = null; }, 250);
        if (announcementLastFocus && document.contains(announcementLastFocus)) announcementLastFocus.focus();
        announcementLastFocus = null;
        announcementEditingId = null;
        announcementEditBaseline = '';
    }

    document.querySelector('[data-owner-announcement-new]')?.addEventListener('click', () => openAnnouncementModal());
    document.querySelectorAll('[data-owner-announcement-close]').forEach(button => button.addEventListener('click', closeAnnouncementModal));
    announcementModal?.addEventListener('mousedown', event => { if (event.target === announcementModal) announcementModal.dataset.backdropDown = 'true'; });
    announcementModal?.addEventListener('click', event => {
        if (event.target === announcementModal && announcementModal.dataset.backdropDown === 'true') closeAnnouncementModal();
        delete announcementModal.dataset.backdropDown;
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && announcementModal && !announcementModal.hidden) { event.preventDefault(); event.stopPropagation(); closeAnnouncementModal(); } });
    announcementDialog?.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return;
        const focusable = [...announcementDialog.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])')]
            .filter(element => element.getClientRects().length > 0);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && (document.activeElement === first || !announcementDialog.contains(document.activeElement))) {
            event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault(); first.focus();
        }
    });
    announcementNext?.addEventListener('click', () => {
        if (announcementWizardStep === 1) {
            const title = announcementForm.querySelector('[data-owner-announcement-title]');
            const body = announcementForm.querySelector('[data-owner-announcement-body]');
            if (!title.value.trim()) { title.setCustomValidity('Enter a title.'); title.reportValidity(); title.focus(); title.setCustomValidity(''); return; }
            if (!body.value.trim()) { body.setCustomValidity('Enter a message.'); body.reportValidity(); body.focus(); body.setCustomValidity(''); return; }
        }
        setAnnouncementWizardStep(announcementWizardStep + 1);
        announcementSteps[announcementWizardStep - 1]?.querySelector('input,select,textarea')?.focus();
    });
    announcementBack?.addEventListener('click', () => { setAnnouncementWizardStep(announcementWizardStep - 1); announcementSteps[announcementWizardStep - 1]?.querySelector('input,select,textarea')?.focus(); });

    async function loadOwnerAnnouncements() {
        if (!window.sb || !announcementList) return;
        const generation = ++announcementGeneration;
        const search = announcementSearch?.value.trim() || '';
        const status = announcementStatus?.value || '';
        announcementList.innerHTML = '<p class="admin-form-hint">Loading announcements…</p>';
        try {
            const { data, error } = await window.sb.rpc('owner_search_announcements', {
                p_offset: announcementPage * ANNOUNCEMENT_PAGE_SIZE,
                p_limit: ANNOUNCEMENT_PAGE_SIZE,
                p_search: search || null,
                p_status: status || null,
            });
            if (generation !== announcementGeneration) return;
            if (error) throw error;
            const result = Array.isArray(data) ? data[0] : data;
            if (!result || !Array.isArray(result.rows)) throw new Error('The announcements response is incomplete.');
            announcementCount = Number(result.total_count) || 0;
            const pageCount = Math.max(1, Math.ceil(announcementCount / ANNOUNCEMENT_PAGE_SIZE));
            if (announcementPage >= pageCount) {
                announcementPage = pageCount - 1;
                loadOwnerAnnouncements();
                return;
            }
            if (announcementCountLabel) {
                announcementCountLabel.textContent = announcementCount === 1 ? '1 announcement' : `${announcementCount} announcements`;
            }
            announcementList.innerHTML = result.rows.length ? result.rows.map(item => {
                const publishDate = item.publish_at ? new Date(item.publish_at) : null;
                const publishLabel = publishDate && !Number.isNaN(publishDate.valueOf()) ? formatActivityTime(publishDate.toISOString()) : 'Immediately';
                const status = String(item.status || 'published').replace(/[_-]+/g, ' ');
                const editAction = status === 'scheduled' ? `<button type="button" class="admin-btn-ghost" data-owner-announcement-edit="${window.escapeHtml(item.id)}">Edit scheduled announcement</button>` : '';
                return `<article class="owner-announcement-row" data-announcement-id="${window.escapeHtml(item.id)}"><div class="owner-announcement-row-head"><h5>${window.escapeHtml(item.title || 'Announcement')}</h5><span class="owner-announcement-status">${window.escapeHtml(status)}</span></div><p>${window.escapeHtml(item.body || '')}</p><div class="owner-announcement-row-meta"><span>${window.escapeHtml(audienceLabels[item.audience] || 'Audience')}</span><time datetime="${window.escapeHtml(item.publish_at || item.created_at || '')}">${window.escapeHtml(publishLabel)}</time>${editAction}</div></article>`;
            }).join('') : `<p class="admin-form-hint">${search || status ? 'No announcements match these filters.' : 'No announcements have been published or scheduled.'}</p>`;
            announcementList.querySelectorAll('[data-owner-announcement-edit]').forEach(button => button.addEventListener('click', () => {
                const item = result.rows.find(row => String(row.id) === button.dataset.ownerAnnouncementEdit);
                if (item && item.status === 'scheduled' && new Date(item.publish_at) > new Date()) openAnnouncementModal(item);
                else loadOwnerAnnouncements();
            }));
            if (announcementPages) announcementPages.hidden = pageCount <= 1;
            renderOwnerPageNumbers(announcementPageNumbers, announcementPage + 1, pageCount, page => { announcementPage = page - 1; loadOwnerAnnouncements(); });
            const prev = document.querySelector('[data-owner-announcement-prev]');
            const next = document.querySelector('[data-owner-announcement-next]');
            if (prev) prev.disabled = announcementPage === 0;
            if (next) next.disabled = (announcementPage + 1) * ANNOUNCEMENT_PAGE_SIZE >= announcementCount;
        } catch (error) {
            if (generation !== announcementGeneration) return;
            console.error('[admin] announcements could not be loaded', error);
            announcementList.innerHTML = '<p class="admin-form-hint">Announcements could not be loaded. Try again.</p>';
        }
    }

    function resetAnnouncementFilters() {
        announcementPage = 0;
        // Invalidate in-flight responses immediately, including during the
        // search debounce window.
        announcementGeneration += 1;
        if (announcementSearchTimer) window.clearTimeout(announcementSearchTimer);
        announcementSearchTimer = window.setTimeout(() => {
            announcementSearchTimer = null;
            loadOwnerAnnouncements();
        }, 250);
    }

    announcementSearch?.addEventListener('input', resetAnnouncementFilters);
    announcementStatus?.addEventListener('change', resetAnnouncementFilters);

    announcementForm?.addEventListener('submit', async event => {
        event.preventDefault();
        if (announcementWizardStep < 3) { announcementNext?.click(); return; }
        if (!window.sb || !announcementSubmit || announcementSavePending || announcementSaving) return;
        const title = document.querySelector('[data-owner-announcement-title]')?.value.trim() || '';
        const body = document.querySelector('[data-owner-announcement-body]')?.value.trim() || '';
        const audience = document.querySelector('[data-owner-announcement-audience]')?.value || '';
        const publishInput = document.querySelector('[data-owner-announcement-publish-at]')?.value || '';
        const publishAt = localManilaDateTimeToIso(publishInput);
        if (!title || !body || !['customers', 'staff', 'both'].includes(audience)) { setAnnouncementMessage('Enter a title, message, and valid audience.', true); return; }
        if (publishInput && !publishAt) { setAnnouncementMessage('Choose a valid publication time.', true); return; }
        if (announcementEditingId && (!publishAt || new Date(publishAt) <= new Date())) { setAnnouncementMessage('Scheduled announcements must remain set for a future time.', true); return; }
        if (!announcementHasChanges()) { await closeAnnouncementModal(); return; }
        announcementSavePending = true;
        const saveAccepted = await window.InigoOwnerUI?.confirm({
            title: announcementEditingId ? 'Save announcement changes?' : 'Publish announcement?',
            message: announcementEditingId ? 'Save these changes to the scheduled announcement?' : (publishAt ? 'Schedule this announcement for the selected time?' : 'Publish this announcement now?'),
            confirmLabel: announcementEditingId ? 'Save changes' : (publishAt ? 'Schedule announcement' : 'Publish announcement'),
        });
        announcementSavePending = false;
        if (!saveAccepted) return;
        announcementSubmit.disabled = true;
        announcementSaving = true;
        announcementForm.querySelectorAll('button, input, textarea, select').forEach(control => { control.disabled = true; });
        announcementSubmit.textContent = 'Publishing…';
        setAnnouncementMessage(announcementEditingId ? 'Saving scheduled announcement…' : (publishAt ? 'Scheduling announcement…' : 'Publishing announcement…'));
        try {
            const { error } = announcementEditingId
                ? await window.sb.rpc('owner_update_scheduled_announcement', { p_id: announcementEditingId, p_title: title, p_body: body, p_audience: audience, p_publish_at: publishAt })
                : await window.sb.rpc('owner_publish_announcement', { p_title: title, p_body: body, p_audience: audience, p_publish_at: publishAt });
            if (error) throw error;
            const wasEditing = Boolean(announcementEditingId);
            closeAnnouncementModal(true);
            announcementPage = 0;
            const successMessage = wasEditing ? 'Scheduled announcement updated.' : (publishAt ? 'Announcement scheduled.' : 'Announcement published.');
            setAnnouncementMessage(successMessage);
            window.InigoToast?.show(successMessage);
            await loadOwnerAnnouncements();
        } catch (error) {
            console.error('[admin] announcement could not be published', error);
            setAnnouncementMessage(error.message || 'The announcement could not be published. Try again.', true);
        } finally {
            announcementSaving = false;
            announcementForm.querySelectorAll('button, input, textarea, select').forEach(control => { control.disabled = false; });
            announcementSubmit.disabled = false;
            announcementSubmit.textContent = announcementEditingId ? 'Save changes' : 'Publish announcement';
        }
    });
    document.querySelector('[data-owner-announcement-prev]')?.addEventListener('click', () => { if (announcementPage > 0) { announcementPage -= 1; loadOwnerAnnouncements(); } });
    document.querySelector('[data-owner-announcement-next]')?.addEventListener('click', () => { if ((announcementPage + 1) * ANNOUNCEMENT_PAGE_SIZE < announcementCount) { announcementPage += 1; loadOwnerAnnouncements(); } });

    const auditPanel = document.querySelector('[data-admin-panel="audit"]');
    const auditRows = document.querySelector('[data-owner-audit-rows]');
    const auditStatus = document.querySelector('[data-owner-audit-status]');
    const auditSearch = document.querySelector('[data-owner-audit-search]');
    const auditDate = document.querySelector('[data-owner-audit-date]');
    const auditFrom = document.querySelector('[data-owner-audit-from]');
    const auditTo = document.querySelector('[data-owner-audit-to]');
    const auditTimePickers = ['from', 'to'].map(kind => ({
        kind,
        input: document.querySelector(`[data-owner-audit-${kind}]`),
        trigger: document.querySelector(`[data-owner-audit-time-trigger="${kind}"]`),
        popover: document.querySelector(`[data-owner-audit-time-popover="${kind}"]`),
    }));
    const auditRole = document.querySelector('[data-owner-audit-role]');
    const auditPagination = document.querySelector('[data-owner-audit-pagination]');
    const auditPrev = document.querySelector('[data-owner-audit-prev]');
    const auditNext = document.querySelector('[data-owner-audit-next]');
    const auditPageNumbers = document.querySelector('[data-owner-audit-page-numbers]');
    const AUDIT_PAGE_SIZE = 25;
    let auditPage = 0;
    let auditGeneration = 0;
    let auditSearchTimer = null;
    let auditRefreshTimer = null;
    let auditRequestsInFlight = 0;
    const AUDIT_REFRESH_INTERVAL = 15000;
    const formatActivityTime = value => new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });

    function auditManilaToday() {
        const parts = new Intl.DateTimeFormat('en', {
            timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(new Date());
        const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
        return `${values.year}-${values.month}-${values.day}`;
    }

    function updateAuditDateMax() {
        if (auditDate) auditDate.max = auditManilaToday();
    }

    function auditManilaBoundaryIso(dateValue, timeValue = '00:00', addMinute = false) {
        const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue || '');
        const timeParts = /^(\d{2}):(\d{2})$/.exec(timeValue || '');
        if (!dateParts || !timeParts) return null;
        const localValue = `${dateValue}T${timeValue}`;
        const date = new Date(`${localValue}:00+08:00`);
        const [year, month, day] = dateParts.slice(1).map(Number);
        const [hour, minute] = timeParts.slice(1).map(Number);
        const expectedTime = Date.UTC(year, month - 1, day, hour, minute) - (8 * 60 * 60 * 1000);
        if (hour > 23 || minute > 59 || Number.isNaN(date.valueOf()) || date.valueOf() !== expectedTime) return null;
        if (addMinute) date.setUTCMinutes(date.getUTCMinutes() + 1);
        return date.toISOString();
    }

    function auditTimeLabel(value) {
        if (!value) return '';
        const [hour, minute] = value.split(':').map(Number);
        return `${String(hour % 12 || 12).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
    }

    function auditTimeMinutes(value) {
        return value ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5)) : 0;
    }

    function closeAuditTimePickers(returnFocus = false) {
        auditTimePickers.forEach(({ trigger, popover }) => {
            if (!popover || popover.hidden) return;
            popover.hidden = true;
            trigger?.setAttribute('aria-expanded', 'false');
            if (returnFocus) trigger?.focus();
        });
    }

    function renderAuditTimePicker(picker) {
        const { kind, input, popover } = picker;
        if (!input || !popover) return;
        const minimum = kind === 'to' && auditFrom?.value ? auditTimeMinutes(auditFrom.value) : 0;
        let chosen = input.value ? auditTimeMinutes(input.value) : (kind === 'to' && auditFrom?.value ? minimum : 0);
        const hour24 = Math.floor(chosen / 60);
        const minute = chosen % 60;
        const hour12 = hour24 % 12 || 12;
        const period = hour24 < 12 ? 'AM' : 'PM';
        const hours = Array.from({ length: 12 }, (_, index) => index + 1).filter(hour => {
            const h24 = (hour % 12) + (period === 'PM' ? 12 : 0);
            return kind !== 'to' || h24 * 60 + 59 >= minimum;
        });
        const minutes = Array.from({ length: 60 }, (_, value) => value).filter(value => {
            const absolute = hour24 * 60 + value;
            return kind !== 'to' || absolute >= minimum;
        });
        const periods = ['AM', 'PM'].filter(candidate => kind !== 'to' || Array.from({ length: 12 }, (_, index) => index + 1).some(hour => {
            const h24 = (hour % 12) + (candidate === 'PM' ? 12 : 0);
            return h24 * 60 + 59 >= minimum;
        }));
        const column = (label, part, values, selected, text = value => String(value).padStart(2, '0')) => `<div class="owner-audit-time-column" role="group" aria-label="${label}">${values.map(value => `<button type="button" class="owner-audit-time-option" data-time-part="${part}" data-time-value="${value}" aria-pressed="${String(value) === String(selected)}" tabindex="0">${text(value)}</button>`).join('')}</div>`;
        popover.innerHTML = `<div class="owner-audit-time-columns">${column('Hour', 'hour', hours, hour12)}${column('Minute', 'minute', minutes, minute)}${column('AM or PM', 'period', periods, period, value => value)}</div><button type="button" class="owner-audit-time-clear" data-time-clear>${kind === 'from' ? 'Clear start time' : 'End of day'}</button>`;
        popover.querySelectorAll('[data-time-part]').forEach(button => button.addEventListener('click', () => {
            const part = button.dataset.timePart;
            const value = button.dataset.timeValue;
            let nextHour = hour12;
            let nextMinute = minute;
            let nextPeriod = period;
            if (part === 'hour') nextHour = Number(value);
            if (part === 'minute') nextMinute = Number(value);
            if (part === 'period') nextPeriod = value;
            let nextHour24 = (nextHour % 12) + (nextPeriod === 'PM' ? 12 : 0);
            let absolute = nextHour24 * 60 + nextMinute;
            if (kind === 'to' && absolute < minimum) {
                absolute = minimum;
                nextHour24 = Math.floor(absolute / 60);
                nextMinute = absolute % 60;
                nextHour = nextHour24 % 12 || 12;
                nextPeriod = nextHour24 < 12 ? 'AM' : 'PM';
            }
            input.value = `${String(nextHour24).padStart(2, '0')}:${String(nextMinute).padStart(2, '0')}`;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            renderAuditTimePicker(picker);
            popover.querySelector(`[data-time-part="${part}"][data-time-value="${value}"]`)?.focus();
        }));
        popover.querySelector('[data-time-clear]')?.addEventListener('click', () => {
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            closeAuditTimePickers(true);
        });
        popover.querySelectorAll('.owner-audit-time-column').forEach(col => col.addEventListener('keydown', event => {
            if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
            const options = [...col.querySelectorAll('button')];
            const current = options.indexOf(document.activeElement);
            const offset = event.key === 'ArrowDown' ? 1 : -1;
            options[(current + offset + options.length) % options.length]?.focus();
            event.preventDefault();
        }));
    }

    function updateAuditToConstraints() {
        const selectedDate = auditDate?.value || '';
        const hasValidDate = Boolean(auditManilaBoundaryIso(selectedDate));
        auditTimePickers.forEach(picker => {
            if (picker.input) picker.input.disabled = !hasValidDate;
            if (picker.trigger) {
                picker.trigger.disabled = !hasValidDate;
                picker.trigger.textContent = picker.input?.value ? auditTimeLabel(picker.input.value) : (picker.kind === 'to' ? 'End of day' : 'Select time');
            }
            renderAuditTimePicker(picker);
        });
        if (!hasValidDate) closeAuditTimePickers();
    }

    auditTimePickers.forEach(picker => {
        picker.trigger?.addEventListener('click', () => {
            const opening = picker.popover?.hidden;
            closeAuditTimePickers();
            if (!opening || !picker.popover) return;
            renderAuditTimePicker(picker);
            picker.popover.hidden = false;
            picker.trigger.setAttribute('aria-expanded', 'true');
            picker.popover.style.left = '0px';
            const bounds = picker.popover.getBoundingClientRect();
            picker.popover.style.left = `${Math.min(0, window.innerWidth - bounds.right - 8)}px`;
            picker.popover.classList.toggle('is-above', bounds.bottom > window.innerHeight && bounds.top - bounds.height > 8);
            picker.popover.querySelector('[aria-pressed="true"]')?.focus();
        });
        picker.trigger?.addEventListener('keydown', event => {
            if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                picker.trigger.click();
            }
        });
    });
    document.addEventListener('pointerdown', event => {
        if (!event.target.closest('.owner-audit-time-picker')) closeAuditTimePickers();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && auditTimePickers.some(picker => picker.popover && !picker.popover.hidden)) closeAuditTimePickers(true);
    });

    function auditDateRangeBounds() {
        updateAuditDateMax();
        const selectedDate = auditDate?.value || '';
        const from = auditFrom?.value || '';
        const to = auditTo?.value || '';
        if (!selectedDate) return from || to ? null : { from: null, to: null };
        if (selectedDate > auditManilaToday()) return null;
        if (!auditManilaBoundaryIso(selectedDate)) return null;
        if ((from && !auditManilaBoundaryIso(selectedDate, from)) || (to && !auditManilaBoundaryIso(selectedDate, to))) return null;
        if (from && to && to < from) return null;
        const nextDate = new Date(`${selectedDate}T00:00:00Z`);
        nextDate.setUTCDate(nextDate.getUTCDate() + 1);
        const nextDateValue = nextDate.toISOString().slice(0, 10);
        const fromIso = auditManilaBoundaryIso(selectedDate, from || '00:00');
        const toIso = to
            ? auditManilaBoundaryIso(selectedDate, to, true)
            : auditManilaBoundaryIso(nextDateValue);
        if (!toIso) return null;
        return { from: fromIso, to: toIso };
    }

    function auditRoleLabel(value) {
        return ({ admin: 'Owner', staff: 'Staff', customer: 'Customer', system: 'System' })[value] || 'System';
    }

    function auditSummary(item) {
        const action = String(item.action || '').toLowerCase();
        const details = item.details && typeof item.details === 'object' && !Array.isArray(item.details) ? item.details : {};
        const detailText = value => value === null || value === undefined || typeof value === 'object' ? '' : String(value).trim();
        const customer = detailText(details.customer);
        const court = detailText(details.court || details.unit);
        const method = detailText(details.method);
        const context = [customer, court].filter(Boolean).join(' · ');
        const eventSummaries = {
            sign_in: 'Signed in to IñigoSync',
            sign_out: 'Signed out of IñigoSync',
            time_in: 'Customer arrived', checked_in: 'Customer arrived', booking_timed_in: 'Customer arrived', booking_checked_in: 'Customer arrived',
            time_out: 'Customer exited', checked_out: 'Customer exited', booking_timed_out: 'Customer exited', booking_checked_out: 'Customer exited',
            walkin_timed_out: 'Walk-in customer checked out',
            unattended: 'Booking marked unattended', marked_unattended: 'Booking marked unattended',
            recorded_booking: 'Booking recorded', booking_created: 'Booking recorded', booking_confirmed: 'Booking confirmed',
            recorded_walk_in: 'Walk-in booking recorded', walkin_recorded: 'Walk-in booking recorded', walkin_created: 'Walk-in booking recorded',
            collected_payment: 'Payment collected', payment_collected: 'Payment collected', payment_recorded: 'Payment recorded',
            booking_declined: 'Booking declined', booking_status_changed: 'Booking status changed',
        };
        const event = eventSummaries[action] || humanizeStaffAction(item.action);

        if (action === 'sign_in' || action === 'sign_out') return event;
        const description = detailText(details.description);
        if (description) return description;
        const extra = [context, method ? `via ${method}` : ''].filter(Boolean).join(' · ');
        const summary = detailText(item.summary);
        const usefulSummary = summary && summary.toLowerCase() !== event.toLowerCase() && summary.toLowerCase() !== String(item.action || '').toLowerCase()
            ? summary : '';
        return [event, extra || description || usefulSummary].filter(Boolean).join(': ');
    }

    function renderAuditTrailRows(rows) {
        if (!auditRows) return;
        auditRows.innerHTML = rows.length ? rows.map(item => {
            const amount = item.amount !== null && item.amount !== undefined && Number.isFinite(Number(item.amount))
                ? `₱${Number(item.amount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
            const cellValue = value => {
                const text = String(value ?? '—');
                const escaped = window.escapeHtml(text);
                return `<span class="owner-audit-cell-value" title="${escaped}">${escaped}</span>`;
            };
            const eventId = String(item.event_id || '—');
            const eventLabel = humanizeStaffAction(item.action);
            const actorName = item.actor_name || 'Deleted account';
            const role = auditRoleLabel(item.actor_role);
            const timeLabel = formatActivityTime(item.created_at);
            const summary = auditSummary(item);
            return `<tr>
                <td><code class="owner-audit-cell-value" title="${window.escapeHtml(eventId)}">${window.escapeHtml(eventId)}</code></td>
                <td><time datetime="${window.escapeHtml(item.created_at || '')}" class="owner-audit-cell-value" title="${window.escapeHtml(timeLabel)}">${window.escapeHtml(timeLabel)}</time></td>
                <td>${cellValue(eventLabel)}</td>
                <td>${cellValue(role)}</td>
                <td>${cellValue(actorName)}</td>
                <td>${cellValue(amount)}</td>
                <td><span class="owner-audit-summary" title="${window.escapeHtml(summary)}">${window.escapeHtml(summary)}</span></td>
            </tr>`;
        }).join('') : '<tr><td colspan="7">No events match these filters.</td></tr>';
    }

    async function loadAuditTrail({ silent = false } = {}) {
        if (!window.sb || !auditRows) return;
        const generation = ++auditGeneration;
        const dateBounds = auditDateRangeBounds();
        if (!dateBounds) {
            auditRows.setAttribute('aria-busy', 'false');
            auditPagination?.setAttribute('aria-busy', 'false');
            if (auditStatus) auditStatus.textContent = 'Choose a valid time range on the selected date.';
            if (auditRows) auditRows.innerHTML = '<tr><td colspan="7">Choose a valid date and time range.</td></tr>';
            return;
        }
        auditRequestsInFlight += 1;
        if (!silent) {
            auditRows.setAttribute('aria-busy', 'true');
            if (auditStatus) auditStatus.textContent = 'Loading audit trail…';
            auditPagination?.setAttribute('aria-busy', 'true');
        }
        try {
            const { data, error } = await window.sb.rpc('owner_audit_trail', {
                p_search: auditSearch?.value.trim() || '',
                p_from: dateBounds.from,
                p_to: dateBounds.to,
                p_actor_role: auditRole?.value || 'all',
                p_offset: auditPage * AUDIT_PAGE_SIZE,
                p_limit: AUDIT_PAGE_SIZE,
            });
            if (generation !== auditGeneration) return;
            if (error) throw error;
            const rows = Array.isArray(data?.rows) ? data.rows : [];
            const total = Math.max(0, Number(data?.total_count) || 0);
            renderAuditTrailRows(rows);
            const pageCount = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
            if (auditStatus) auditStatus.textContent = `${total.toLocaleString()} ${total === 1 ? 'event' : 'events'} recorded`;
            if (auditPagination) auditPagination.hidden = total <= AUDIT_PAGE_SIZE;
            if (auditPrev) auditPrev.disabled = auditPage <= 0;
            if (auditNext) auditNext.disabled = auditPage + 1 >= pageCount;
            renderOwnerPageNumbers(auditPageNumbers, auditPage + 1, pageCount, page => { auditPage = page - 1; loadAuditTrail(); });
        } catch (error) {
            if (generation !== auditGeneration) return;
            console.error('[admin] audit trail could not be loaded', error);
            if (!silent) {
                if (auditStatus) auditStatus.textContent = 'Audit trail could not be loaded. Please try again later.';
                if (auditRows) auditRows.innerHTML = '<tr><td colspan="7">Audit trail could not be loaded.</td></tr>';
            }
        } finally {
            auditRequestsInFlight = Math.max(0, auditRequestsInFlight - 1);
            if (!silent && generation === auditGeneration) {
                auditRows.setAttribute('aria-busy', 'false');
                auditPagination?.setAttribute('aria-busy', 'false');
            }
        }
    }

    function isAuditPanelVisible() {
        return auditPanel?.classList.contains('is-active') && document.visibilityState === 'visible';
    }

    function stopAuditTrailUpdates() {
        if (auditRefreshTimer !== null) {
            window.clearInterval(auditRefreshTimer);
            auditRefreshTimer = null;
        }
        // Discard any response that returns after the owner leaves the panel.
        auditGeneration += 1;
    }

    function startAuditTrailUpdates() {
        if (!isAuditPanelVisible()) {
            stopAuditTrailUpdates();
            return;
        }
        if (auditRefreshTimer === null) {
            auditRefreshTimer = window.setInterval(() => {
                updateAuditDateMax();
                if (isAuditPanelVisible() && auditRequestsInFlight === 0) loadAuditTrail({ silent: true });
            }, AUDIT_REFRESH_INTERVAL);
        }
        updateAuditDateMax();
        loadAuditTrail();
    }

    document.addEventListener('visibilitychange', () => {
        if (isAuditPanelVisible()) startAuditTrailUpdates();
        else stopAuditTrailUpdates();
    });

    const resetAuditPage = () => { auditPage = 0; loadAuditTrail(); };
    auditSearch?.addEventListener('input', () => {
        auditPage = 0;
        window.clearTimeout(auditSearchTimer);
        auditSearchTimer = window.setTimeout(loadAuditTrail, 250);
    });
    updateAuditDateMax();
    updateAuditToConstraints();
    auditDate?.addEventListener('change', () => {
        if (auditFrom) auditFrom.value = '';
        if (auditTo) auditTo.value = '';
        updateAuditToConstraints();
        resetAuditPage();
    });
    auditFrom?.addEventListener('input', () => {
        if (auditTo) auditTo.value = '';
        updateAuditToConstraints();
    });
    auditFrom?.addEventListener('change', () => { updateAuditToConstraints(); resetAuditPage(); });
    auditTo?.addEventListener('change', resetAuditPage);
    auditRole?.addEventListener('change', resetAuditPage);
    auditPrev?.addEventListener('click', () => { if (auditPage > 0) { auditPage -= 1; loadAuditTrail(); } });
    auditNext?.addEventListener('click', () => { auditPage += 1; loadAuditTrail(); });
    async function recordOwnerActivity(title, targetSection, detail = '') {
        if (!window.sb || !window.inigosyncProfile?.id) return;
        const { error } = await window.sb.from('owner_activity').insert({
            owner_id: window.inigosyncProfile.id, title, target_section: targetSection,
            detail: detail || ({staff: 'A staff account was updated in Staff Management.', settings: 'The owner updated their account settings.'}[targetSection] || title),
        });
        if (error) console.error('[admin] activity save failed', error);
    }
    window.InigoOwnerUI.recordActivity = recordOwnerActivity;
    // Account Settings — password visibility toggles
    // ------------------------------------------------------------------
    document.querySelectorAll('[data-admin-toggle-password]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const input = btn.previousElementSibling;
            if (!input) return;
            const isHidden = input.type === 'password';
            input.type = isHidden ? 'text' : 'password';
            btn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
        });
    });

    // ------------------------------------------------------------------
    // Account Settings — avatar upload/remove (Revision A1, decision A9).
    // The owner chooses a square crop before the resulting JPEG data URL is
    // written to profiles.avatar_url.
    // ------------------------------------------------------------------
    const AVATAR_OUTPUT_SIZE = 256;
    const AVATAR_JPEG_QUALITY = 0.82;

    const adminAvatarFileInput = document.querySelector('[data-admin-avatar-file]');
    const adminAvatarUploadBtn = document.querySelector('[data-admin-avatar-upload-trigger]');
    const adminAvatarRemoveBtn = document.querySelector('[data-admin-avatar-remove]');

    document.querySelector('[data-admin-profile-edit]')?.addEventListener('click', () => {
        ownerProfileEditBaseline = { ...(window.inigosyncProfile || {}) };
        paintOwnerDetails(window.inigosyncProfile || {});
        const modal = document.querySelector('[data-admin-settings-profile-modal]');
        window.InigoOwnerUI.open(modal);
        refreshLinkedGoogleEmails();
    });
    let ownerProfileClosePending = false;
    let ownerProfileEditBaseline = null;
    function ownerProfileDraftHasChanges() {
        const profile = window.inigosyncProfile || {};
        const baseline = ownerProfileEditBaseline || profile;
        const name = document.querySelector('[data-admin-settings-name]')?.value.trim() || '';
        const mobile = document.querySelector('[data-admin-settings-mobile]')?.value.trim() || '';
        const mobileCheck = mobile ? window.validatePhMobile?.(mobile) : null;
        const normalizedMobile = mobile ? (mobileCheck?.valid ? mobileCheck.normalized : mobile) : '';
        return name !== (baseline.full_name || '')
            || normalizedMobile !== (baseline.contact_num || '')
            || (document.querySelector('[data-admin-settings-address]')?.value.trim() || '') !== (baseline.address || '')
            || (document.querySelector('[data-admin-settings-birthdate]')?.value || null) !== (baseline.birthdate || null)
            || (document.querySelector('[data-admin-settings-gender]')?.value || '') !== (baseline.gender || '')
            || (document.querySelector('[data-admin-settings-civil-status]')?.value || null) !== (baseline.civil_status || null);
    }
    function refreshOwnerProfileAfterAsyncLoad(profile) {
        const modal = document.querySelector('[data-admin-settings-profile-modal]');
        const isEditing = Boolean(modal && !modal.hidden && ownerProfileEditBaseline);
        if (!isEditing) {
            paintOwnerDetails(profile);
            renderAdminProfile(profile);
            return;
        }

        const baseline = ownerProfileEditBaseline;
        const normalizePhone = value => {
            const raw = String(value || '').trim();
            if (!raw) return '';
            const checked = window.validatePhMobile?.(raw);
            return checked?.valid ? checked.normalized : raw;
        };
        const fields = [
            ['[data-admin-settings-name]', baseline.full_name || '', profile.full_name || '', value => String(value || '').trim()],
            ['[data-admin-settings-mobile]', baseline.contact_num || '', profile.contact_num || '', normalizePhone],
            ['[data-admin-settings-address]', baseline.address || '', profile.address || '', value => String(value || '').trim()],
            ['[data-admin-settings-birthdate]', baseline.birthdate || '', profile.birthdate || '', value => String(value || '')],
            ['[data-admin-settings-gender]', baseline.gender || '', profile.gender || '', value => String(value || '')],
            ['[data-admin-settings-civil-status]', baseline.civil_status || '', profile.civil_status || '', value => String(value || '')],
        ];
        fields.forEach(([selector, before, saved, normalize]) => {
            const field = document.querySelector(selector);
            if (field && normalize(field.value) === normalize(before)) field.value = saved;
        });
        ownerProfileEditBaseline = { ...profile };
        paintOwnerDetails(profile, true);
        renderAdminProfile(profile, true);
    }
    async function cancelOwnerProfileEditing(button) {
        if (ownerProfileClosePending) return;
        const modal = button?.closest('.admin-modal-overlay') || document.querySelector('[data-admin-settings-profile-modal]');
        if (ownerProfileDraftHasChanges()) {
            ownerProfileClosePending = true;
            const accepted = await window.InigoOwnerUI?.confirm({ title: 'Discard profile changes?', message: 'Your unsaved profile changes will be lost.', confirmLabel: 'Discard changes', danger: true });
            ownerProfileClosePending = false;
            if (!accepted) return;
        }
        window.InigoOwnerUI.close(modal);
        ownerProfileEditBaseline = null;
    }
    document.querySelectorAll('[data-admin-settings-cancel="profile"]').forEach((button) => {
        button.addEventListener('click', () => cancelOwnerProfileEditing(button));
    });

    const accountModals = [document.querySelector('[data-admin-settings-profile-modal]')].filter(Boolean);
    accountModals.forEach(modal => {
        let backdropStart = false;
        modal.addEventListener('pointerdown', event => { backdropStart = event.target === modal; });
        modal.addEventListener('click', event => { if (backdropStart && event.target === modal) modal.querySelector('[data-admin-settings-cancel="profile"]')?.click(); backdropStart = false; });
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') accountModals.find(modal => !modal.hidden)?.querySelector('[data-admin-settings-cancel="profile"]')?.click();
    });

    async function saveAdminAvatarUrl(avatarUrl) {
        if (!window.sb || !window.inigosyncProfile) {
            window.InigoToast?.show('Unable to reach the server right now. Please try again shortly.', true);
            return false;
        }
        const { error } = await window.sb.from('profiles').update({ avatar_url: avatarUrl }).eq('id', window.inigosyncProfile.id);
        if (error) {
            console.error('[admin] avatar_url update failed', error);
            window.InigoToast?.show(error.message || 'Could not save your photo. Please try again.', true);
            return false;
        }
        window.inigosyncProfile.avatar_url = avatarUrl;
        renderAdminProfile(window.inigosyncProfile);
        recordOwnerActivity(avatarUrl ? 'Owner profile photo updated' : 'Owner profile photo removed', 'settings');
        return true;
    }

    if (adminAvatarUploadBtn && adminAvatarFileInput) {
        adminAvatarUploadBtn.addEventListener('click', () => adminAvatarFileInput.click());
    }

    if (adminAvatarFileInput) {
        adminAvatarFileInput.addEventListener('change', async () => {
            const file = adminAvatarFileInput.files && adminAvatarFileInput.files[0];
            adminAvatarFileInput.value = '';
            if (!file) return;

            if (!file.type || !file.type.startsWith('image/')) {
                window.InigoToast?.show('Please choose an image file.', true);
                return;
            }
            if (!window.InigoImageTools) return;

            const originalLabel = adminAvatarUploadBtn.textContent;
            adminAvatarUploadBtn.disabled = true;
            adminAvatarUploadBtn.textContent = 'Preparing…';

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
                    reader.onerror = () => reject(new Error('Could not finish processing the cropped photo.'));
                    reader.readAsDataURL(croppedBlob);
                });
                const accepted = await window.InigoOwnerUI?.confirm({
                    title: 'Save profile photo?',
                    message: 'Save this cropped photo as your owner profile photo?',
                    confirmLabel: 'Save photo',
                });
                if (!accepted) return;
                if (await saveAdminAvatarUrl(dataUrl)) window.InigoToast?.show('Profile photo updated.');
            } catch (err) {
                console.error('[admin] avatar crop failed', err);
                window.InigoToast?.show('Could not process that image. Please try a different file.', true);
            } finally {
                adminAvatarUploadBtn.disabled = false;
                adminAvatarUploadBtn.textContent = originalLabel;
            }
        });
    }

    adminAvatarRemoveBtn?.addEventListener('click', async () => {
        if (adminAvatarRemoveBtn.disabled) return;
        adminAvatarRemoveBtn.disabled = true;
        const accepted = await window.InigoOwnerUI?.confirm({
            title: 'Remove profile photo?',
            message: 'Remove your current owner profile photo?',
            confirmLabel: 'Remove photo',
            danger: true,
        });
        if (!accepted) { adminAvatarRemoveBtn.disabled = false; return; }
        const ok = await saveAdminAvatarUrl(null);
        adminAvatarRemoveBtn.disabled = false;
        if (ok) window.InigoToast?.show('Profile photo removed.');
    });

    // Owner Profile — prefill from the real signed-in profile. Revision A1,
    // decision A8 — the ONE place that paints every .admin-avatar (topbar,
    // Settings' profile card, Settings' own upload preview): an <img> when
    // avatar_url is set, initials otherwise (unchanged default look/
    // behaviour). Decision A9 — Personal Information's name/email inputs
    // are addressed by their own data-admin-settings-* hooks now, rather
    // than positional NodeList indexing (fragile after the old "Username"
    // placeholder field was removed).
    // S2 (Revision A1 fix) — small "pending confirmation" hint painted next
    // to the email field, created once here (lazily, on first call) rather
    // than in Pages/owner_dashboard.html — this fix pass is scoped to this
    // file. Reuses the already-styled .admin-form-hint class instead of a
    // new one this pass has no matching CSS change for.
    // `options.skipEmailRepaint` — S2 (Revision A1 fix). A successful
    // sb.auth.updateUser({ email }) does NOT change window.inigosyncProfile
    // (see the Personal Information save handler below — profiles.email
    // only follows a CONFIRMED change), so the default repaint below used
    // to immediately overwrite whatever the admin just typed back to the
    // old address, as if the save had silently failed. The one call right
    // after that specific save passes skipEmailRepaint: true to leave the
    // typed value in place and show the pending-confirmation hint instead;
    // every other call site (initial load, Cancel, a real profile change)
    // omits it, so those still correctly repaint/revert the field.
    function renderAdminProfile(profile, preserveEditorDraft = false) {
        const initials = (profile.full_name || profile.email || '?')
            .split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

        const avatarUrl = profile.avatar_url || null;
        document.querySelectorAll('.admin-avatar').forEach((el) => {
            if (avatarUrl) {
                el.innerHTML = `<img class="admin-avatar-img" src="${window.escapeHtml(avatarUrl)}" alt="Profile photo">`;
            } else {
                el.textContent = initials;
            }
        });
        if (adminAvatarRemoveBtn) adminAvatarRemoveBtn.hidden = !avatarUrl;

        document.querySelectorAll('[data-admin-profile-name]').forEach((el) => { el.textContent = profile.full_name || 'Owner'; });

        const cardInfo = document.querySelector('[data-admin-panel="settings"] .admin-profile-card-info h3');
        if (cardInfo) cardInfo.textContent = profile.full_name || 'Owner';

        const nameInput = document.querySelector('[data-admin-settings-name]');
        const emailInput = document.querySelector('[data-admin-settings-email]');
        if (nameInput && !preserveEditorDraft) nameInput.value = profile.full_name || '';
        if (emailInput) emailInput.textContent = profile.email || '—';
        const fullNameEl = document.querySelector('[data-admin-profile-full-name]');
        if (fullNameEl) fullNameEl.textContent = profile.full_name || '—';

        // Revision A2, decision B2 — the Profile panel's Email/Mobile
        // definition-list rows. authGuard.js's own profiles select already
        // includes contact_num (unlike created_at — see
        // loadAdminProfileMemberSince() below for that one), so no extra
        // fetch is needed for either of these two.
        const profileEmailEl = document.querySelector('[data-admin-profile-email]');
        if (profileEmailEl) profileEmailEl.textContent = profile.email || '—';
        const profileMobileEl = document.querySelector('[data-admin-profile-mobile]');
        if (profileMobileEl) profileMobileEl.textContent = profile.contact_num || '—';
        const birthdateEl = document.querySelector('[data-admin-profile-birthdate]');
        if (birthdateEl) birthdateEl.textContent = profile.birthdate || '—';
    }

    function paintOwnerDetails(profile, preserveEditorDraft = false) {
        const savedMobile = window.validatePhMobile?.(profile.contact_num || '');
        const fields = [
            ['[data-admin-settings-mobile]', savedMobile?.valid ? savedMobile.normalized : (profile.contact_num || '')],
            ['[data-admin-settings-address]', profile.address || ''],
            ['[data-admin-settings-birthdate]', profile.birthdate || ''],
            ['[data-admin-settings-gender]', profile.gender || ''],
            ['[data-admin-settings-civil-status]', profile.civil_status || ''],
        ];
        if (!preserveEditorDraft) fields.forEach(([selector, value]) => {
            const field = document.querySelector(selector);
            if (field) field.value = value;
        });
        const values = [
            ['[data-admin-profile-address]', profile.address || '—'],
            ['[data-admin-profile-age]', computeAdminStaffAge(profile.birthdate) === null ? '—' : `${computeAdminStaffAge(profile.birthdate)} years old`],
            ['[data-admin-profile-gender]', profile.gender || '—'],
            ['[data-admin-profile-civil-status]', profile.civil_status || '—'],
            ['[data-admin-profile-birthdate]', profile.birthdate || '—'],
        ];
        values.forEach(([selector, value]) => {
            const target = document.querySelector(selector);
            if (target) target.textContent = value;
        });
        if (ownerMobileMessage && !preserveEditorDraft) {
            ownerMobileMessage.textContent = !profile.contact_num ? 'Optional · format and availability check' : 'Saved number';
            ownerMobileMessage.classList.remove('is-error');
            ownerMobileMessage.dataset.state = profile.contact_num ? 'available' : '';
        }
    }

    function formatOwnerPhoneValidationDate(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return ` on ${date.toLocaleDateString('en-PH', { dateStyle: 'medium', timeZone: 'Asia/Manila' })}`;
    }

    document.addEventListener('inigosync:profile-ready', (e) => renderAdminProfile(e.detail));
    if (window.inigosyncProfile) renderAdminProfile(window.inigosyncProfile);

    // ------------------------------------------------------------------
    // Profile panel — "Member since" (Revision A2, decision B2).
    // authGuard.js selects a fixed column list from `profiles` that does
    // NOT include created_at (see its own header comment), so this is a
    // small, separate, tolerate-failure fetch — same "—" not-loaded-yet
    // convention as every other placeholder on this page, never a fake
    // date.
    // ------------------------------------------------------------------
    function formatAdminMemberSince(createdAt) {
        const d = new Date(createdAt);
        if (!createdAt || Number.isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }

    let ownerDetailsLoaded = false;
    async function loadAdminProfileMemberSince() {
        const el = document.querySelector('[data-admin-profile-member-since]');
        if (!el || !window.sb || !window.inigosyncProfile) return;
        const { data, error } = await window.sb
            .from('profiles')
            .select('created_at, contact_num, contact_num_validated, contact_num_validated_at, address, birthdate, gender')
            .eq('id', window.inigosyncProfile.id)
            .single();
        el.textContent = (!error && data) ? formatAdminMemberSince(data.created_at) : '—';
        if (!error && data) {
            Object.assign(window.inigosyncProfile, data);
            refreshOwnerProfileAfterAsyncLoad(window.inigosyncProfile);
        } else {
            return;
        }
        const { data: privateDetails, error: privateError } = await window.sb
            .from('owner_private_details')
            .select('civil_status')
            .eq('user_id', window.inigosyncProfile.id)
            .maybeSingle();
        if (privateError) {
            console.error('[admin] could not load owner private details', privateError);
            window.InigoToast?.show('Could not load your civil status. Try reloading the page.', true);
            return;
        }
        window.inigosyncProfile.civil_status = privateDetails?.civil_status || '';
        ownerDetailsLoaded = true;
        refreshOwnerProfileAfterAsyncLoad(window.inigosyncProfile);
    }

    document.addEventListener('inigosync:profile-ready', loadAdminProfileMemberSince);
    if (window.inigosyncProfile) loadAdminProfileMemberSince();

    // ------------------------------------------------------------------
    // Account Settings — Personal Information save (Revision A1, decision
    // A9). Full name saves straight to profiles.full_name, unchanged. Email
    // is NEW: sb.auth.updateUser({ email }) sends a confirmation link to
    // the new address — profiles.email is deliberately NOT written here;
    // it only follows once Supabase actually confirms the change (see the
    // onAuthStateChange/session-sync block below), so the app never shows
    // an email as "saved" before it truly is.
    // ------------------------------------------------------------------
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const OWNER_CIVIL_STATUSES = new Set(['Single', 'Married', 'Separated', 'Widowed', 'Prefer not to say']);

    const adminProfileSaveBtn = document.querySelector('[data-admin-settings-save="profile"]');
    const ownerMobileMessage = document.querySelector('[data-admin-mobile-message]');
    const ownerMobileInput = document.querySelector('[data-admin-settings-mobile]');
    let ownerMobileCheckTimer = null;
    let ownerMobileRequestId = 0;
    let ownerMobileCheckedNumber = '';
    let ownerMobileCheckPassed = false;
    let ownerMobileCheckedAt = 0;
    const OWNER_PHONE_PROOF_MAX_AGE_MS = 4 * 60 * 1000;
    const ownerMobileRecentChecks = new Map();
    let ownerProfileSaveConfirmPending = false;

    function setOwnerMobileMessage(message, isError = false) {
        if (!ownerMobileMessage) return;
        ownerMobileMessage.textContent = message;
        ownerMobileMessage.classList.toggle('is-error', isError);
        ownerMobileMessage.dataset.state = isError ? 'invalid' : ownerMobileCheckPassed ? 'available' : (/^Checking/.test(message) ? 'checking' : '');
    }

    async function ownerPhoneFunctionError(error) {
        const context = error?.context;
        if (context && typeof context.clone === 'function') {
            try {
                const body = await context.clone().json();
                if (body?.message) return body.message;
            } catch (_) { /* Use the SDK fallback. */ }
        }
        return error?.message || 'Phone validation is temporarily unavailable.';
    }

    function ownerPhoneFailureMessage(reason) {
        return reason === 'in_use' ? 'This number is already linked to another account.'
            : 'Enter a valid Philippine mobile number.';
    }

    function ownerMobileInputMatches(normalized) {
        const current = window.validatePhMobile?.(ownerMobileInput?.value || '');
        return current?.valid === true && current.normalized === normalized;
    }

    async function checkOwnerMobile(normalized, requestId) {
        if (!window.sb || !window.inigosyncProfile) return;
        setOwnerMobileMessage('Checking…');
        try {
            const { data, error } = await window.sb.functions.invoke('validate-contact-phone', { body: { phone: normalized } });
            if (requestId !== ownerMobileRequestId || !ownerMobileInputMatches(normalized)) return;
            if (error) throw new Error(await ownerPhoneFunctionError(error));
            if (data?.valid !== true) {
                throw new Error(ownerPhoneFailureMessage(data?.reason));
            }
            if (!/^\+639\d{9}$/.test(data.normalized || '')
                || data.normalized !== `+63${normalized.slice(1)}`) {
                throw new Error('The number could not be checked safely. Try again later.');
            }
            ownerMobileCheckedNumber = normalized;
            ownerMobileCheckPassed = true;
            ownerMobileCheckedAt = Date.now();
            ownerMobileRecentChecks.set(normalized, ownerMobileCheckedAt);
            ownerMobileInput.dataset.phoneAvailability = 'available';
            ownerMobileInput.setAttribute('aria-invalid', 'false');
            setOwnerMobileMessage('Valid · available');
        } catch (error) {
            if (requestId !== ownerMobileRequestId || !ownerMobileInputMatches(normalized)) return;
            ownerMobileCheckPassed = false;
            ownerMobileInput.dataset.phoneAvailability = 'invalid';
            ownerMobileInput.setAttribute('aria-invalid', 'true');
            console.error('[admin] contact number validation failed', error);
            setOwnerMobileMessage(error.message || 'Could not validate the number. Try again.', true);
        }
    }

    ownerMobileInput?.addEventListener('input', () => {
        clearTimeout(ownerMobileCheckTimer);
        const requestId = ++ownerMobileRequestId;
        ownerMobileCheckedNumber = '';
        ownerMobileCheckPassed = false;
        ownerMobileCheckedAt = 0;
        ownerMobileInput.dataset.phoneAvailability = '';
        ownerMobileInput.setAttribute('aria-invalid', 'false');
        const raw = ownerMobileInput.value.trim();
        if (!raw) {
            setOwnerMobileMessage('Optional · format and availability check');
            return;
        }
        const localCheck = window.validatePhMobile?.(raw);
        if (!localCheck?.valid) {
            ownerMobileInput.dataset.phoneAvailability = 'invalid';
            ownerMobileInput.setAttribute('aria-invalid', 'true');
            setOwnerMobileMessage('Invalid format', true);
            return;
        }
        const recentCheckAt = ownerMobileRecentChecks.get(localCheck.normalized) || 0;
        if (recentCheckAt && Date.now() - recentCheckAt < 30000) {
            ownerMobileCheckedNumber = localCheck.normalized;
            ownerMobileCheckPassed = true;
            ownerMobileCheckedAt = recentCheckAt;
            ownerMobileInput.dataset.phoneAvailability = 'available';
            ownerMobileInput.setAttribute('aria-invalid', 'false');
            setOwnerMobileMessage('Valid · available');
            return;
        }
        setOwnerMobileMessage('Checking…');
        ownerMobileCheckTimer = setTimeout(() => checkOwnerMobile(localCheck.normalized, requestId), 700);
    });

    if (adminProfileSaveBtn) {
        adminProfileSaveBtn.addEventListener('click', async () => {
            if (!window.sb || !window.inigosyncProfile) return;

            const nameInput = document.querySelector('[data-admin-settings-name]');
            const mobileInput = document.querySelector('[data-admin-settings-mobile]');
            const addressInput = document.querySelector('[data-admin-settings-address]');
            const birthdateInput = document.querySelector('[data-admin-settings-birthdate]');
            const genderInput = document.querySelector('[data-admin-settings-gender]');
            const civilStatusInput = document.querySelector('[data-admin-settings-civil-status]');
            const newName = nameInput ? nameInput.value.trim() : '';
            const mobileRaw = mobileInput ? mobileInput.value.trim() : '';
            const address = addressInput ? addressInput.value.trim() : '';
            const birthdate = birthdateInput?.value || null;
            const gender = genderInput?.value || '';
            const civilStatus = civilStatusInput?.value || null;

            if (civilStatus && !OWNER_CIVIL_STATUSES.has(civilStatus)) {
                window.InigoToast?.show('Choose a valid civil status.', true);
                civilStatusInput?.focus();
                return;
            }

            if (!ownerDetailsLoaded) {
                window.InigoToast?.show('Account details are still loading. Please try again.', true);
                return;
            }
            const mobileCheck = mobileRaw && window.validatePhMobile
                ? window.validatePhMobile(mobileRaw)
                : { valid: !mobileRaw, normalized: '' };
            const currentMobile = window.inigosyncProfile.contact_num || '';
            const requestedMobile = mobileRaw ? (mobileCheck.valid ? mobileCheck.normalized : mobileRaw) : '';
            const currentMobileCheck = currentMobile ? window.validatePhMobile?.(currentMobile) : null;
            const mobileNeedsValidation = Boolean(requestedMobile)
                && (!mobileCheck.valid || !currentMobileCheck?.valid || requestedMobile !== currentMobileCheck.normalized);
            const mobileReadyToSave = mobileNeedsValidation && ownerMobileCheckPassed
                && ownerMobileCheckedNumber === requestedMobile
                && Date.now() - ownerMobileCheckedAt < OWNER_PHONE_PROOF_MAX_AGE_MS;
            const mobileNeedsRemoval = !requestedMobile && Boolean(currentMobile);
            if (birthdate && birthdate > todayDateInputValue()) {
                window.InigoToast?.show('Date of birth cannot be in the future.', true);
                birthdateInput?.focus();
                return;
            }

            if (!newName) {
                window.InigoToast?.show('Enter your full name.', true);
                nameInput?.focus();
                return;
            }
            if (mobileNeedsValidation && ownerMobileCheckPassed && ownerMobileCheckedNumber === requestedMobile && !mobileReadyToSave) {
                ownerMobileCheckPassed = false;
                setOwnerMobileMessage('The status check expired. Checking the number again…');
                checkOwnerMobile(requestedMobile, ++ownerMobileRequestId);
            }
            if (mobileNeedsValidation && !mobileReadyToSave) {
                if (mobileCheck.valid && ownerMobileInput?.dataset.phoneAvailability !== 'invalid') {
                    setOwnerMobileMessage('Wait for the automatic number check to finish before saving.', true);
                }
                ownerMobileInput?.focus();
                return;
            }
            const nameChanged = newName !== (window.inigosyncProfile.full_name || '');
            const detailsChanged = mobileNeedsRemoval || mobileReadyToSave
                || address !== (window.inigosyncProfile.address || '')
                || birthdate !== (window.inigosyncProfile.birthdate || null)
                || gender !== (window.inigosyncProfile.gender || '')
                || civilStatus !== (window.inigosyncProfile.civil_status || null);
            if (!nameChanged && !detailsChanged) {
                window.InigoOwnerUI?.close(document.querySelector('[data-admin-settings-profile-modal]'));
                return;
            }

            if (ownerProfileSaveConfirmPending) return;
            ownerProfileSaveConfirmPending = true;
            const saveAccepted = await window.InigoOwnerUI?.confirm({
                title: 'Save profile changes?',
                message: 'Save these changes to your owner profile?',
                confirmLabel: 'Save changes',
            });
            ownerProfileSaveConfirmPending = false;
            if (!saveAccepted) return;

            const profileModal = document.querySelector('[data-admin-settings-profile-modal]');
            if (profileModal) profileModal.inert = true;
            adminProfileSaveBtn.disabled = true;
            const civilStatusNeedsSave = civilStatus !== (window.inigosyncProfile.civil_status || null);
            const profileDetailsChanged = mobileNeedsRemoval || mobileReadyToSave
                || address !== (window.inigosyncProfile.address || '')
                || birthdate !== (window.inigosyncProfile.birthdate || null)
                || gender !== (window.inigosyncProfile.gender || '');
            const ownerProfileFieldsChanged = nameChanged || profileDetailsChanged;
            let profileWriteSucceeded = false;
            let civilStatusWriteSucceeded = false;
            try {
                if (nameChanged || detailsChanged) {
                    const profilePatch = { full_name: newName, address, birthdate, gender };
                    if (mobileNeedsRemoval) profilePatch.contact_num = null;
                    if (mobileReadyToSave) profilePatch.contact_num = `+63${requestedMobile.slice(1)}`;
                    if (nameChanged || profileDetailsChanged) {
                        const { error } = await window.sb.from('profiles').update(profilePatch).eq('id', window.inigosyncProfile.id);
                        if (error) throw error;
                        profileWriteSucceeded = true;
                        Object.assign(window.inigosyncProfile, { full_name: newName, address, birthdate, gender });
                        if (mobileNeedsRemoval) {
                            window.inigosyncProfile.contact_num = null;
                            window.inigosyncProfile.contact_num_validated = false;
                            window.inigosyncProfile.contact_num_validated_at = null;
                        }
                        if (mobileReadyToSave) {
                            window.inigosyncProfile.contact_num = `+63${requestedMobile.slice(1)}`;
                            window.inigosyncProfile.contact_num_validated = true;
                            window.inigosyncProfile.contact_num_validated_at = new Date().toISOString();
                        }
                    }
                    if (civilStatusNeedsSave) {
                        const { error } = await window.sb.from('owner_private_details').upsert({
                            user_id: window.inigosyncProfile.id,
                            civil_status: civilStatus,
                        }, { onConflict: 'user_id' });
                        if (error) throw error;
                        civilStatusWriteSucceeded = true;
                        window.inigosyncProfile.civil_status = civilStatus || '';
                    }
                }

                renderAdminProfile(window.inigosyncProfile);
                paintOwnerDetails(window.inigosyncProfile);
                if (nameChanged || detailsChanged) recordOwnerActivity('Owner profile updated', 'settings');
                window.InigoToast?.show('Profile updated.');
                window.InigoOwnerUI.close(document.querySelector('[data-admin-settings-profile-modal]'));
                ownerProfileEditBaseline = null;
            } catch (err) {
                if (profileWriteSucceeded || civilStatusWriteSucceeded) {
                    renderAdminProfile(window.inigosyncProfile);
                    paintOwnerDetails(window.inigosyncProfile);
                    if (civilStatusNeedsSave && !civilStatusWriteSucceeded && civilStatusInput) {
                        civilStatusInput.value = civilStatus || '';
                    }
                    recordOwnerActivity('Owner profile updated', 'settings');
                }
                if (profileWriteSucceeded && civilStatusNeedsSave && !civilStatusWriteSucceeded) {
                    window.InigoToast?.show('Your other profile changes were saved, but civil status could not be updated. Please retry.', true);
                } else if (civilStatusWriteSucceeded && !profileWriteSucceeded && ownerProfileFieldsChanged) {
                    window.InigoToast?.show('Your civil status was saved, but the other profile changes could not be updated. Please retry.', true);
                } else {
                    window.InigoToast?.show(err.message || 'Could not save your changes.', true);
                }
            } finally {
                if (profileModal) profileModal.inert = false;
                adminProfileSaveBtn.disabled = false;
            }
        });
    }

    // ------------------------------------------------------------------
    async function refreshLinkedGoogleEmails() {
        const root = document.querySelector('[data-admin-linked-google-emails]');
        if (!root || !window.sb || !window.inigosyncProfile) return;
        const { data, error } = await window.sb.auth.getUser();
        if (error || !data?.user) {
            root.textContent = 'Could not load linked Google accounts.';
            return;
        }
        const emails = (data.user.identities || [])
            .filter((identity) => identity.provider === 'google')
            .map((identity) => identity.identity_data?.email)
            .filter(Boolean);
        root.innerHTML = emails.length
            ? emails.map((email) => `<div class="admin-google-account"><span class="admin-google-account-check" aria-hidden="true">✓</span><span class="admin-google-account-email">${window.escapeHtml(email)}</span><span class="admin-google-account-badge">Linked</span></div>`).join('')
            : '<p class="admin-google-accounts-empty">No Google account linked yet.</p>';
    }

    document.querySelector('[data-admin-link-google]')?.addEventListener('click', async (event) => {
        if (!window.sb || !window.inigosyncProfile) return;
        const button = event.currentTarget;
        button.disabled = true;
        const { error } = await window.sb.auth.linkIdentity({
            provider: 'google',
            options: { redirectTo: new URL('owner_dashboard.html', window.location.href).href },
        });
        if (error) {
            button.disabled = false;
            window.InigoToast?.show(error.message || 'Could not start Google account verification.', true);
        }
    });
    document.addEventListener('inigosync:profile-ready', refreshLinkedGoogleEmails);
    if (window.inigosyncProfile) refreshLinkedGoogleEmails();

    // Email confirmation → profiles.email sync (Revision A1, decision A9).
    // profiles.email only ever follows the AUTH session's confirmed email,
    // never the other way around. Checked two ways so this is correct
    // regardless of load-order races between this file and
    // includes/authGuard.js's own async profile fetch:
    //   1. On every 'inigosync:profile-ready' (i.e. once window.inigosyncProfile
    //      is guaranteed set) — re-reads the CURRENT session and syncs if
    //      it's already ahead of profiles.email (covers "on load", including
    //      a confirmation clicked in a previous visit).
    //   2. Live, via onAuthStateChange — covers a confirmation link clicked
    //      DURING this session (Supabase's auth client broadcasts session
    //      changes across tabs in the same browser).
    // ------------------------------------------------------------------
    function syncConfirmedAdminEmail(sessionEmail) {
        if (!sessionEmail || !window.sb || !window.inigosyncProfile) return;
        if (sessionEmail === window.inigosyncProfile.email) return;

        window.sb.from('profiles').update({ email: sessionEmail }).eq('id', window.inigosyncProfile.id).then(({ error }) => {
            if (error) {
                console.error('[admin] failed to sync confirmed email to profiles', error);
                return;
            }
            window.inigosyncProfile.email = sessionEmail;
            renderAdminProfile(window.inigosyncProfile);
        });
    }

    document.addEventListener('inigosync:profile-ready', () => {
        window.sb?.auth.getSession().then(({ data }) => syncConfirmedAdminEmail(data?.session?.user?.email));
    });

    if (window.sb) {
        window.sb.auth.onAuthStateChange((event, session) => {
            if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'USER_UPDATED') {
                syncConfirmedAdminEmail(session?.user?.email);
            }
        });
    }

    // ------------------------------------------------------------------
    // Change Password — 2-step wizard (Revision A1, decision A9), ported
    // from the customer dashboard's own (includes/Dashboard.js) under
    // data-admin-pw-* names. Step 1 collects only the current password
    // (Next disabled until non-empty); Step 2 collects the new password
    // twice, with a minimum length + match check this file adds on top of
    // the customer version (Supabase's own server-side minimum still
    // applies regardless). Re-verifies the current password via
    // signInWithPassword() before calling updateUser() — unchanged
    // reasoning from the single-form version this replaces.
    // ------------------------------------------------------------------
    const ADMIN_PW_MIN_LENGTH = 8;
    const ADMIN_PW_MAX_LENGTH = 15;
    const pwStepPanels = document.querySelectorAll('[data-admin-pw-step]');
    const pwStepIndicators = document.querySelectorAll('[data-admin-pw-step-indicator]');
    const pwCancelBtn = document.querySelector('[data-admin-settings-cancel="password"]');
    const pwBackBtn = document.querySelector('[data-admin-pw-back]');
    const pwNextBtn = document.querySelector('[data-admin-pw-next]');
    const adminPasswordSaveBtn = document.querySelector('[data-admin-settings-save="password"]');
    const pwCurrentInput = document.querySelector('[data-admin-pw-current]');
    const pwNewInput = document.querySelector('[data-admin-pw-new]');
    const pwConfirmInput = document.querySelector('[data-admin-pw-confirm]');
    const pwRules = document.querySelector('[data-admin-pw-rules]');
    let adminPwVerificationInProgress = false;
    let adminPwSaveInProgress = false;
    let adminPwVerificationGeneration = 0;

    function checkAdminPasswordPolicy(value) {
        const password = typeof value === 'string' ? value : '';
        return {
            length: password.length >= ADMIN_PW_MIN_LENGTH && password.length <= ADMIN_PW_MAX_LENGTH,
            upper: /[A-Z]/.test(password),
            lower: /[a-z]/.test(password),
            number: /[0-9]/.test(password),
            special: /[ !"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(password),
        };
    }

    function renderAdminPasswordRules() {
        const checks = checkAdminPasswordPolicy(pwNewInput?.value);
        pwRules?.querySelectorAll('[data-pw-rule]').forEach((item) => {
            const met = Boolean(checks[item.dataset.pwRule]);
            item.classList.toggle('is-met', met);
            item.setAttribute('aria-label', `${item.textContent.trim()}: ${met ? 'met' : 'not met'}`);
        });
        return Object.values(checks).every(Boolean);
    }

    async function verifyAdminCurrentPassword() {
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

    let adminPwWizardStep = 1;

    function renderAdminPwWizard() {
        pwStepPanels.forEach((panel) => {
            panel.classList.toggle('is-active', Number(panel.dataset.adminPwStep) === adminPwWizardStep);
        });
        pwStepIndicators.forEach((el) => {
            const n = Number(el.dataset.adminPwStepIndicator);
            el.classList.toggle('is-current', n === adminPwWizardStep);
            el.classList.toggle('is-done', n < adminPwWizardStep);
            el.setAttribute('aria-current', n === adminPwWizardStep ? 'step' : 'false');
        });

        if (pwCancelBtn) pwCancelBtn.hidden = adminPwWizardStep !== 2;
        if (pwBackBtn) pwBackBtn.hidden = adminPwWizardStep !== 2;
        if (adminPasswordSaveBtn) adminPasswordSaveBtn.hidden = adminPwWizardStep !== 2;
        if (pwNextBtn) {
            pwNextBtn.hidden = adminPwWizardStep !== 1;
            pwNextBtn.disabled = adminPwVerificationInProgress || !(pwCurrentInput && pwCurrentInput.value !== '');
        }
        const validPassword = renderAdminPasswordRules();
        if (adminPasswordSaveBtn) adminPasswordSaveBtn.disabled = adminPwWizardStep !== 2 || !validPassword || !pwNewInput?.value || pwNewInput.value !== pwConfirmInput?.value || adminPwVerificationInProgress || adminPwSaveInProgress;
    }

    function goToAdminPwStep(step) {
        adminPwWizardStep = step === 2 ? 2 : 1;
        renderAdminPwWizard();
    }

    function resetAdminPwWizard() {
        invalidateAdminPwVerification();
        [pwCurrentInput, pwNewInput, pwConfirmInput].forEach((input) => { if (input) input.value = ''; });
        goToAdminPwStep(1);
    }

    function invalidateAdminPwVerification() {
        adminPwVerificationGeneration += 1;
        adminPwVerificationInProgress = false;
        adminPwSaveInProgress = false;
        if (pwNextBtn) pwNextBtn.textContent = 'Next';
    }

    [pwCurrentInput, pwNewInput, pwConfirmInput].forEach((input) => input?.addEventListener('input', () => {
        if (pwCurrentInput === input && (adminPwVerificationInProgress || adminPwSaveInProgress)) invalidateAdminPwVerification();
        renderAdminPwWizard();
    }));
    if (pwNextBtn) {
        pwNextBtn.addEventListener('click', async () => {
            if (pwNextBtn.disabled || !window.sb || !pwCurrentInput?.value) return;
            const generation = ++adminPwVerificationGeneration;
            adminPwVerificationInProgress = true;
            pwNextBtn.textContent = 'Verifying…';
            renderAdminPwWizard();
            const verified = await verifyAdminCurrentPassword();
            if (generation !== adminPwVerificationGeneration) return;
            adminPwVerificationInProgress = false;
            pwNextBtn.textContent = 'Next';
            renderAdminPwWizard();
            if (verified) goToAdminPwStep(2);
        });
    }
    if (pwBackBtn) pwBackBtn.addEventListener('click', () => {
        invalidateAdminPwVerification();
        goToAdminPwStep(1);
    });

    // Establishes the correct initial hidden/disabled state for the nav
    // buttons (matching the `disabled`/`hidden` attributes already baked
    // into the markup as a no-JS baseline) and paints the step-1 indicator.
    renderAdminPwWizard();

    if (adminPasswordSaveBtn) {
        let adminPwSaveConfirmPending = false;
        adminPasswordSaveBtn.addEventListener('click', async () => {
            if (adminPasswordSaveBtn.disabled || adminPwSaveConfirmPending || adminPwSaveInProgress) return;
            if (!window.sb || !window.inigosyncProfile) return;
            const currentPassword = pwCurrentInput?.value;
            const newPassword = pwNewInput?.value;
            const confirmPassword = pwConfirmInput?.value;

            if (!currentPassword) {
                window.InigoToast?.show('Enter your current password.', true);
                goToAdminPwStep(1);
                return;
            }
            if (!renderAdminPasswordRules()) {
                window.InigoToast?.show('New password must be 8–15 characters and include an uppercase letter, a lowercase letter, a number and a special character.', true);
                return;
            }
            if (newPassword !== confirmPassword) {
                window.InigoToast?.show('Passwords do not match.', true);
                return;
            }

            const draftAtConfirmation = { currentPassword, newPassword, confirmPassword };
            adminPwSaveConfirmPending = true;
            const saveAccepted = await window.InigoOwnerUI?.confirm({
                title: 'Save new password?',
                message: 'Update your owner account password now?',
                confirmLabel: 'Save password',
            });
            adminPwSaveConfirmPending = false;
            if (!saveAccepted) return;
            if (pwCurrentInput?.value !== draftAtConfirmation.currentPassword
                || pwNewInput?.value !== draftAtConfirmation.newPassword
                || pwConfirmInput?.value !== draftAtConfirmation.confirmPassword) {
                window.InigoToast?.show('Your password draft changed while confirmation was open. Review it and confirm again before saving.', true);
                return;
            }

            adminPwSaveInProgress = true;
            const generation = ++adminPwVerificationGeneration;
            renderAdminPwWizard();

            // S3 (Revision A1 fix) — re-verify against the AUTH session's
            // OWN current email first, falling back to profiles.email only
            // if no session email is available. profiles.email can lag a
            // just-confirmed email change (see syncConfirmedAdminEmail
            // above, and S2's own note on this same lag) or simply be
            // stale from before this session loaded; signInWithPassword()
            // against a stale address would fail with "Current password is
            // incorrect" even when the password typed is exactly right.
            const verified = await verifyAdminCurrentPassword();
            if (generation !== adminPwVerificationGeneration) {
                renderAdminPwWizard();
                return;
            }
            if (!verified) {
                adminPwSaveInProgress = false;
                renderAdminPwWizard();
                goToAdminPwStep(1);
                return;
            }
            if (pwCurrentInput?.value !== draftAtConfirmation.currentPassword
                || pwNewInput?.value !== draftAtConfirmation.newPassword
                || pwConfirmInput?.value !== draftAtConfirmation.confirmPassword) {
                window.InigoToast?.show('Your password draft changed while it was being verified. Review it and save again.', true);
                adminPwSaveInProgress = false;
                renderAdminPwWizard();
                return;
            }

            try {
                const { error } = await window.sb.auth.updateUser({ password: newPassword });
                if (error) throw error;
            } catch (error) {
                window.InigoToast?.show(error.message || 'Could not update your password.', true);
                adminPwSaveInProgress = false;
                renderAdminPwWizard();
                return;
            }

            resetAdminPwWizard();
            adminPwSaveInProgress = false;
            renderAdminPwWizard();
            window.InigoToast?.show('Password updated.');
            recordOwnerActivity('Owner password updated', 'settings');
        });
    }

    // ------------------------------------------------------------------
    // Account Settings — Cancel buttons. Profile discards in-progress edits
    // back to the last-saved values; Password's step-2 Cancel resets the
    // wizard to step 1 and clears every field.
    // ------------------------------------------------------------------
    let adminPasswordCancelPending = false;
    document.querySelectorAll('[data-admin-settings-cancel]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const mode = btn.dataset.adminSettingsCancel;
            if (mode === 'password') {
                const hasDraft = Boolean(pwCurrentInput?.value || pwNewInput?.value || pwConfirmInput?.value);
                if (hasDraft) {
                    if (adminPasswordCancelPending) return;
                    adminPasswordCancelPending = true;
                    const accepted = await window.InigoOwnerUI?.confirm({ title: 'Discard password change?', message: 'Your unsaved password change will be lost.', confirmLabel: 'Discard changes', danger: true });
                    adminPasswordCancelPending = false;
                    if (!accepted) return;
                }
                resetAdminPwWizard();
            }
        });
    });

    // Owners choose exactly three written public booking reviews for the
    // landing page. The database RPC validates and saves the ordered set.
    const reviewList = document.querySelector('[data-admin-review-list]');
    const reviewPager = document.querySelector('[data-admin-review-pagination]');
    const reviewCount = document.querySelector('[data-featured-review-count]');
    const reviewMessage = document.querySelector('[data-featured-review-message]');
    const reviewModalCount = document.querySelector('[data-featured-review-modal-count]');
    const reviewModalMessage = document.querySelector('[data-featured-review-modal-message]');
    const reviewSave = document.querySelector('[data-featured-review-save]');
    const reviewOpen = document.querySelector('[data-featured-review-open]');
    const reviewModal = document.querySelector('[data-featured-review-modal]');
    const reviewSlots = document.querySelector('[data-featured-review-slots]');
    const ownerReviewBrowser = document.querySelector('[data-owner-review-list]');
    const ownerReviewBrowserPager = document.querySelector('[data-owner-review-pagination]');
    let reviewRatingFilter = 'all';
    let reviewPage = 0;
    let reviewRequest = 0;
    let ownerReviewBrowserFilter = 'all';
    let ownerReviewBrowserPage = 0;
    let ownerReviewBrowserRequest = 0;
    let ownerReviewBrowserLoading = false;
    let ownerReviewBrowserLoaded = false;
    let featuredSelectionRequest = 0;
    let savedFeaturedReviewIds = [];
    let draftFeaturedReviewIds = [];
    const featuredReviewDetails = new Map();
    let featuredSelectionLoaded = false;
    let savingFeaturedReviews = false;
    let closingFeaturedModal = false;
    const REVIEW_PAGE_SIZE = 10;
    const featuredSelectionChanged = () => savedFeaturedReviewIds.length !== draftFeaturedReviewIds.length || savedFeaturedReviewIds.some((id, index) => id !== draftFeaturedReviewIds[index]);
    const selectedFeaturedReviewIds = () => reviewModal && !reviewModal.hidden ? draftFeaturedReviewIds : savedFeaturedReviewIds;
    async function loadOwnerReviewBrowser(force = false) {
        if (!ownerReviewBrowser || !window.sb) return;
        if ((!force && ownerReviewBrowserLoading) || (!force && ownerReviewBrowserLoaded)) return;
        const request = ++ownerReviewBrowserRequest;
        ownerReviewBrowserLoading = true;
        ownerReviewBrowser.setAttribute('aria-busy', 'true');
        let query = window.sb.from('public_booking_reviews').select('id,rating,comment,created_at', { count: 'exact' })
            .order('created_at', { ascending: false }).range(ownerReviewBrowserPage * REVIEW_PAGE_SIZE, (ownerReviewBrowserPage + 1) * REVIEW_PAGE_SIZE - 1);
        if (ownerReviewBrowserFilter !== 'all') query = query.eq('rating', Number(ownerReviewBrowserFilter));
        try {
            const { data, count, error } = await query;
            if (request !== ownerReviewBrowserRequest) return;
            ownerReviewBrowser.setAttribute('aria-busy', 'false');
            if (error) {
                ownerReviewBrowser.innerHTML = '<p class="admin-form-hint">Reviews could not be loaded. Check your owner access and try again.</p>';
                console.error('[admin] public review browser query failed', error);
                return;
            }
            const rows = data || [];
            ownerReviewBrowser.innerHTML = rows.length ? rows.map((review) => {
                featuredReviewDetails.set(review.id, review);
                const rating = Math.max(0, Math.min(5, Number(review.rating) || 0));
                const comment = typeof review.comment === 'string' && review.comment.trim()
                    ? `<p>${window.escapeHtml(review.comment)}</p>`
                    : '<p class="owner-review-no-comment">No written comment</p>';
                const date = review.created_at ? new Date(review.created_at) : null;
                const dateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : 'Date unavailable';
                const datetime = review.created_at ? ` datetime="${window.escapeHtml(review.created_at)}"` : '';
                return `<article class="admin-review-item owner-review-browser-item"><div class="admin-review-item-head"><strong>Verified customer</strong><span aria-label="${rating} out of 5 stars">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</span></div>${comment}<time${datetime}>${window.escapeHtml(dateText)}</time></article>`;
            }).join('') : '<p class="admin-form-hint">No customer reviews match this filter yet.</p>';
            const pages = Math.max(1, Math.ceil((count || 0) / REVIEW_PAGE_SIZE));
            if (ownerReviewBrowserPager) ownerReviewBrowserPager.hidden = (count || 0) <= REVIEW_PAGE_SIZE;
            const prev = document.querySelector('[data-owner-review-prev]');
            const next = document.querySelector('[data-owner-review-next]');
            const pageNumbers = document.querySelector('[data-owner-review-page-numbers]');
            if (prev) prev.disabled = ownerReviewBrowserPage <= 0;
            if (next) next.disabled = ownerReviewBrowserPage + 1 >= pages;
            renderOwnerPageNumbers(pageNumbers, ownerReviewBrowserPage + 1, pages, page => { ownerReviewBrowserPage = page - 1; loadOwnerReviewBrowser(true); });
            ownerReviewBrowserLoaded = true;
        } catch (error) {
            if (request !== ownerReviewBrowserRequest) return;
            ownerReviewBrowser.setAttribute('aria-busy', 'false');
            ownerReviewBrowser.innerHTML = '<p class="admin-form-hint">Reviews could not be loaded. Check your owner access and try again.</p>';
            console.error('[admin] public review browser query failed', error);
        } finally {
            if (request === ownerReviewBrowserRequest) ownerReviewBrowserLoading = false;
        }
    }
    function renderFeaturedReviewSlots() {
        if (!reviewSlots) return;
        reviewSlots.setAttribute('aria-busy', String(!featuredSelectionLoaded));
        reviewSlots.innerHTML = Array.from({ length: 3 }, (_, index) => {
            const id = savedFeaturedReviewIds[index];
            const review = id ? featuredReviewDetails.get(id) : null;
            return `<article class="owner-featured-review-slot${id ? ' is-filled' : ''}"><span class="owner-featured-review-slot-number">${index + 1}</span>${review ? `<div><div class="owner-featured-review-slot-rating" aria-label="${Number(review.rating)} out of 5 stars">${'★'.repeat(Number(review.rating))}${'☆'.repeat(5 - Number(review.rating))}</div><p>“${window.escapeHtml(review.comment)}”</p><time datetime="${window.escapeHtml(review.created_at)}">${window.escapeHtml(new Date(review.created_at).toLocaleDateString())}</time></div>` : `<p>${id ? 'Loading saved review…' : 'Your next featured story goes here'}</p>`}</article>`;
        }).join('');
    }
    async function loadOwnerReviews() {
        if (!reviewList || !window.sb) return;
        const request = ++reviewRequest;
        reviewList.setAttribute('aria-busy', 'true');
        let query = window.sb.from('public_booking_reviews').select('id,rating,comment,created_at', { count: 'exact' })
            .not('comment', 'is', null).neq('comment', '')
            .order('created_at', { ascending: false }).range(reviewPage * REVIEW_PAGE_SIZE, (reviewPage + 1) * REVIEW_PAGE_SIZE - 1);
        if (reviewRatingFilter !== 'all') query = query.eq('rating', Number(reviewRatingFilter));
        const { data, count, error } = await query;
        if (request !== reviewRequest) return;
        reviewList.setAttribute('aria-busy', 'false');
        if (error) {
            reviewList.innerHTML = '<p class="admin-form-hint">Reviews could not be loaded. Check your owner access and try again.</p>';
            console.error('[admin] owner reviews query failed', error);
            return;
        }
        const total = count || 0;
        const eligibleReviews = (data || []).filter((review) => typeof review.comment === 'string' && review.comment.trim().length > 0);
        reviewList.innerHTML = eligibleReviews.length ? eligibleReviews.map((review) => {
            featuredReviewDetails.set(review.id, review);
            const featuredReviewIds = selectedFeaturedReviewIds();
            const selectedIndex = featuredReviewIds.indexOf(review.id);
            const checked = selectedIndex >= 0;
            const selectionOrder = checked ? `<span class="owner-featured-review-order" aria-label="Featured review ${selectedIndex + 1}">${selectedIndex + 1}</span>` : '';
            const disabled = (!checked && featuredReviewIds.length >= 3) || savingFeaturedReviews || !featuredSelectionLoaded;
            return `<label class="admin-review-item owner-featured-review-item${checked ? ' is-selected' : ''}"><input type="checkbox" data-featured-review-id="${window.escapeHtml(review.id)}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''} aria-label="${checked ? 'Remove' : 'Add'} this ${Number(review.rating)} star review${selectionOrder ? `; selected ${selectedIndex + 1} of 3` : ''}"><span class="owner-featured-review-content"><span class="admin-review-item-head"><strong>Verified customer</strong><span aria-label="${Number(review.rating)} out of 5 stars">${'★'.repeat(Number(review.rating))}${'☆'.repeat(5 - Number(review.rating))}</span></span><span class="owner-featured-review-comment">${window.escapeHtml(review.comment)}</span><time datetime="${window.escapeHtml(review.created_at)}">${window.escapeHtml(new Date(review.created_at).toLocaleDateString())}</time></span>${selectionOrder}</label>`;
        }).join('') : '<p class="admin-form-hint">No eligible reviews with written comments are available yet.</p>';
        reviewList.querySelectorAll('[data-featured-review-id]').forEach((checkbox) => checkbox.addEventListener('change', () => {
            const id = checkbox.dataset.featuredReviewId;
            if (checkbox.checked && draftFeaturedReviewIds.length < 3 && !draftFeaturedReviewIds.includes(id)) draftFeaturedReviewIds.push(id);
            else if (!checkbox.checked) draftFeaturedReviewIds = draftFeaturedReviewIds.filter((selectedId) => selectedId !== id);
            setFeaturedReviewStatus();
            loadOwnerReviews();
        }));
        const pages = Math.max(1, Math.ceil(total / REVIEW_PAGE_SIZE));
        if (reviewPager) reviewPager.hidden = total <= REVIEW_PAGE_SIZE;
        const prev = document.querySelector('[data-admin-review-prev]');
        const next = document.querySelector('[data-admin-review-next]');
        const pageNumbers = document.querySelector('[data-admin-review-page-numbers]');
        if (prev) prev.disabled = reviewPage <= 0;
        if (next) next.disabled = reviewPage + 1 >= pages;
        renderOwnerPageNumbers(pageNumbers, reviewPage + 1, pages, page => { reviewPage = page - 1; loadOwnerReviews(); });
    }
    function setFeaturedReviewStatus(message = '', isError = false) {
        if (reviewCount) {
            reviewCount.textContent = `${savedFeaturedReviewIds.length} of 3 selected`;
        }
        if (reviewModalCount) reviewModalCount.textContent = `${draftFeaturedReviewIds.length} of 3 selected`;
        if (reviewSave) reviewSave.disabled = draftFeaturedReviewIds.length !== 3 || !featuredSelectionChanged() || savingFeaturedReviews || !featuredSelectionLoaded;
        if (reviewOpen) reviewOpen.disabled = !featuredSelectionLoaded || savingFeaturedReviews;
        for (const target of [reviewMessage, reviewModalMessage]) {
            if (!target) continue;
            target.textContent = message;
            target.classList.toggle('is-error', Boolean(message) && isError);
            target.classList.toggle('is-success', Boolean(message) && !isError);
        }
        if (!reviewModal || reviewModal.hidden) renderFeaturedReviewSlots();
    }
    async function loadFeaturedReviewSelection() {
        if (!window.sb) return;
        const request = ++featuredSelectionRequest;
        try {
            const { data, error } = await window.sb.from('owner_featured_review_selection').select('review_ids').eq('singleton', true).maybeSingle();
            if (request !== featuredSelectionRequest) return;
            if (error) throw error;
            savedFeaturedReviewIds = Array.isArray(data?.review_ids) ? data.review_ids.filter((id) => typeof id === 'string').slice(0, 3) : [];
            draftFeaturedReviewIds = [...savedFeaturedReviewIds];
            featuredSelectionLoaded = true;
            setFeaturedReviewStatus();
            if (savedFeaturedReviewIds.length) {
                const { data: details, error: detailsError } = await window.sb.from('public_booking_reviews').select('id,rating,comment,created_at').in('id', savedFeaturedReviewIds);
                if (request !== featuredSelectionRequest) return;
                if (detailsError) throw detailsError;
                (details || []).forEach(review => featuredReviewDetails.set(review.id, review));
                renderFeaturedReviewSlots();
            }
            await loadOwnerReviews();
        } catch (error) {
            if (request !== featuredSelectionRequest) return;
            featuredSelectionLoaded = false;
            setFeaturedReviewStatus('The featured selection could not be loaded. Please refresh and try again.', true);
            console.error('[admin] featured review selection query failed', error);
        }
    }
    async function closeFeaturedReviewModal(discard = false) {
        if (!reviewModal || reviewModal.hidden || closingFeaturedModal || savingFeaturedReviews) return;
        if (featuredSelectionChanged()) {
            closingFeaturedModal = true;
            const accepted = await window.InigoOwnerUI?.confirm({
                title: 'Discard review changes?',
                message: 'Your saved featured reviews will stay as they are.',
                confirmLabel: 'Discard changes', danger: true,
            });
            closingFeaturedModal = false;
            if (!accepted) return;
        }
        if (discard || featuredSelectionChanged()) draftFeaturedReviewIds = [...savedFeaturedReviewIds];
        setFeaturedReviewStatus();
        window.InigoOwnerUI?.close(reviewModal);
    }
    reviewOpen?.addEventListener('click', () => {
        if (!featuredSelectionLoaded || savingFeaturedReviews) return;
        draftFeaturedReviewIds = [...savedFeaturedReviewIds];
        reviewRatingFilter = 'all'; reviewPage = 0;
        document.querySelectorAll('[data-admin-review-rating]').forEach((item, index) => { item.classList.toggle('is-active', index === 0); item.setAttribute('aria-pressed', String(index === 0)); });
        setFeaturedReviewStatus();
        window.InigoOwnerUI?.open(reviewModal);
        loadOwnerReviews();
    });
    document.querySelector('[data-featured-review-cancel]')?.addEventListener('click', () => closeFeaturedReviewModal(true));
    document.querySelector('[data-featured-review-close]')?.addEventListener('click', () => closeFeaturedReviewModal());
    reviewModal?.addEventListener('click', event => { if (event.target === reviewModal) closeFeaturedReviewModal(); });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && reviewModal && !reviewModal.hidden && !document.querySelector('.owner-confirm-overlay:not([hidden])')) {
            event.preventDefault(); event.stopPropagation(); closeFeaturedReviewModal();
        }
    });
    reviewSave?.addEventListener('click', async () => {
        if (draftFeaturedReviewIds.length !== 3 || !featuredSelectionChanged() || savingFeaturedReviews || !window.sb) return;
        const accepted = await window.InigoOwnerUI?.confirm({
            title: 'Save featured reviews?',
            message: 'This will update the three reviews shown on your landing page.',
            confirmLabel: 'Save reviews',
        });
        if (!accepted) return;
        const idsToSave = [...draftFeaturedReviewIds];
        savingFeaturedReviews = true;
        if (reviewModal) reviewModal.inert = true;
        setFeaturedReviewStatus('Saving featured reviews…');
        try {
            const { error } = await window.sb.rpc('owner_save_featured_booking_reviews', { p_review_ids: idsToSave });
            if (error) throw error;
            savedFeaturedReviewIds = idsToSave;
            draftFeaturedReviewIds = [...idsToSave];
            window.InigoOwnerUI?.close(reviewModal);
            setFeaturedReviewStatus('Featured reviews saved.');
        } catch (error) {
            setFeaturedReviewStatus(error?.message || 'Featured reviews could not be saved. Try again.', true);
            console.error('[admin] featured review save failed', error);
        } finally {
            if (reviewModal) reviewModal.inert = false;
            const finalMessage = reviewMessage?.textContent || '';
            const finalIsError = reviewMessage?.classList.contains('is-error') || false;
            savingFeaturedReviews = false;
            setFeaturedReviewStatus(finalMessage, finalIsError);
            await loadOwnerReviews();
        }
    });
    document.querySelectorAll('[data-admin-review-rating]').forEach((button) => button.addEventListener('click', () => {
        reviewRatingFilter = button.dataset.adminReviewRating || 'all'; reviewPage = 0;
        document.querySelectorAll('[data-admin-review-rating]').forEach((item) => { item.classList.toggle('is-active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
        loadOwnerReviews();
    }));
    document.querySelector('[data-admin-review-prev]')?.addEventListener('click', () => { if (reviewPage > 0) { reviewPage -= 1; loadOwnerReviews(); } });
    document.querySelector('[data-admin-review-next]')?.addEventListener('click', () => { reviewPage += 1; loadOwnerReviews(); });
    document.querySelectorAll('[data-owner-review-rating]').forEach((button) => button.addEventListener('click', () => {
        ownerReviewBrowserFilter = button.dataset.ownerReviewRating || 'all'; ownerReviewBrowserPage = 0;
        document.querySelectorAll('[data-owner-review-rating]').forEach((item) => { item.classList.toggle('is-active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
        loadOwnerReviewBrowser(true);
    }));
    document.querySelector('[data-owner-review-prev]')?.addEventListener('click', () => { if (ownerReviewBrowserPage > 0) { ownerReviewBrowserPage -= 1; loadOwnerReviewBrowser(true); } });
    document.querySelector('[data-owner-review-next]')?.addEventListener('click', () => { ownerReviewBrowserPage += 1; loadOwnerReviewBrowser(true); });
    document.addEventListener('inigosync:owner-panel', event => { if (event.detail === 'feedback') { loadFeaturedReviewSelection(); ownerReviewBrowserPage = 0; loadOwnerReviewBrowser(true); } });
    document.addEventListener('inigosync:profile-ready', () => { loadFeaturedReviewSelection(); loadOwnerReviewBrowser(); });
    if (window.inigosyncProfile) { loadFeaturedReviewSelection(); loadOwnerReviewBrowser(); }
});
