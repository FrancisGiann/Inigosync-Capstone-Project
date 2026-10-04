// IñigoSync — Owner Dashboard controller
// Staff Management, Account Settings, Court Listings, the Booking Overview
// stat tiles/Website performance/Booking status breakdown, Media Manager,
// and Feedbacks & Reviews all talk to the real Supabase database.
// (Booking trend chart setup lives in event/chart.js, loaded below.)
//
// Revision A1 (implementation_plan.md) brought this page up to the same
// standard as the customer dashboard: a real logo (A1), live Recent
// bookings + Booking status this month replacing two hardcoded fake cards
// (A3), an instant default-password Reset Password RPC + Activate for
// disabled staff (A4), a real Media Manager against `public.event` + a
// Storage bucket (A5), an Add/Edit court modal (A6), a real notifications
// dropdown (A7), a topbar/settings avatar that renders profiles.avatar_url
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
// Recent bookings was replaced by a Website performance card with three
// grouped, client-measurable checks (C4, refreshWebsitePerformance()); and a new
// Feedbacks & Reviews tab renders a Google-Play-style ratings summary +
// sortable/filterable list over the `feedback` table (C5).

// Revision A3, decision C4 — "Errors this session" counter for the Website
// performance card. Registered here, at the very top of this file (before
// the DOMContentLoaded listener below, and before every other <script> this
// file could theoretically outlive), so an error thrown at any point during
// this page's lifetime — including before DOMContentLoaded fires — is
// counted the first time refreshWebsitePerformance() reads
// inigosyncSessionErrorCount. Never reset for the life of this tab: "this
// session" means "since this page was loaded", not "since the last check".
let inigosyncSessionErrorCount = 0;
window.addEventListener('error', () => { inigosyncSessionErrorCount += 1; });
window.addEventListener('unhandledrejection', () => { inigosyncSessionErrorCount += 1; });

function worstAdminPerfStatus(rows) {
    const rank = { good: 0, warn: 1, problem: 2 };
    let worst = null;
    rows.forEach(row => {
        if (!row || row.status === 'neutral' || !(row.status in rank)) return;
        worst = worst === null ? rank[row.status] : Math.max(worst, rank[row.status]);
    });
    return worst === null ? 'good' : worst === 0 ? 'good' : worst === 1 ? 'warn' : 'problem';
}

function buildAdminPerfGroups({ storage, pageLoad, serverResponse, errorCount, connection }) {
    const pageParts = [
        pageLoad.status === 'neutral' ? 'Page load unavailable' : `Page load ${pageLoad.value}`,
        serverResponse.status === 'neutral' ? 'Service response unavailable' : `Service response ${serverResponse.value}`,
    ];
    const pageUnavailable = pageLoad.status === 'neutral' || serverResponse.status === 'neutral';
    const pageStatus = pageUnavailable ? 'neutral' : worstAdminPerfStatus([pageLoad, serverResponse]);
    const problemsStatus = worstAdminPerfStatus([{
        status: errorCount === 0 ? 'good' : errorCount < 5 ? 'warn' : 'problem',
    }, connection]);
    return [
        storage,
        {
            label: 'Page speed',
            value: pageUnavailable ? 'Unavailable' : `${pageLoad.value} · ${serverResponse.value}`,
            details: pageParts.join(' · '), status: pageStatus,
            pillText: pageUnavailable ? 'Unavailable' : pageStatus === 'good' ? 'Good' : pageStatus === 'warn' ? 'Slow' : 'Problem',
        },
        {
            label: 'Problems / errors', value: `${errorCount} · ${connection.value}`,
            details: `${errorCount === 0 ? 'No browser errors recorded this visit' : `${errorCount} browser error${errorCount === 1 ? '' : 's'} recorded this visit`} · Internet ${connection.value.toLowerCase()}`,
            status: problemsStatus,
            pillText: errorCount > 0 ? (errorCount < 5 ? 'Review' : 'Problem') : connection.status === 'problem' ? 'Check connection' : 'Clear',
        },
    ];
}

function routeOwnerActivityOpen(target, openNotification) {
    const button = target.closest('[data-owner-activity-open]');
    const row = button?.closest('[data-owner-activity-id]');
    if (!row) return false;
    openNotification(row.dataset.ownerActivityId);
    return true;
}

document.addEventListener('DOMContentLoaded', () => {
    // ------------------------------------------------------------------
    // Panel switching (sidebar + topbar/profile shortcuts)
    // ------------------------------------------------------------------
    const panels = document.querySelectorAll('[data-admin-panel]');
    const titleEl = document.querySelector('[data-admin-title]');
    const subtitleEl = document.querySelector('[data-admin-subtitle]');

    const panelMeta = {
        overview: { title: 'Booking Overview', subtitle: 'Reservation trends, staff activity, and business performance at a glance.' },
        // Revision A2 (implementation_plan.md, decision B4) — "…and
        // configure payment settings" dropped now that Payment
        // Configuration is gone (see this file's own removal note below).
        staff: { title: 'Staff Management', subtitle: 'Add, update, or remove staff accounts.' },
        courts: { title: 'Court Listings', subtitle: 'Add new courts, update details, or activate/deactivate existing ones.' },
        'booking-rules': { title: 'Working Time Schedule', subtitle: 'Set shared opening hours and the no-show grace period.' },
        media: { title: 'Media Manager', subtitle: "Whatever you upload here shows up on the website's home featured slideshow — both the landing page and the customer dashboard." },
        payments: { title: 'Payment Configuration', subtitle: 'Set the deposit amount and payment methods for new bookings.' },
        // Revision A3 (implementation_plan.md, decision C5) — new tab, after
        // Media Manager in the sidebar.
        feedback: { title: 'Feedbacks & Reviews', subtitle: '' },
        announcement: { title: 'Announcement', subtitle: '' },
        audit: { title: 'Audit Trail', subtitle: '' },
        settings: { title: 'Account Settings', subtitle: '' },
        // Revision A2, decision B2 — not in .admin-nav, only reachable from
        // the profile dropdown's "View Profile"; setActivePanel() below
        // still works unmodified since it just looks this key up.
        profile: { title: 'Profile', subtitle: '' },
    };

    function setActivePanel(name) {
        panels.forEach((panel) => {
            panel.classList.toggle('is-active', panel.dataset.adminPanel === name);
        });

        document.querySelectorAll('[data-admin-nav]').forEach((btn) => {
            if (btn.closest('.admin-nav')) {
                btn.classList.toggle('is-active', btn.dataset.adminNav === name);
            }
        });

        const meta = panelMeta[name];
        if (meta && titleEl && subtitleEl) {
            titleEl.textContent = meta.title;
            subtitleEl.textContent = '';
            subtitleEl.hidden = true;
        }

        // Feedbacks & Reviews and Audit Trail load when their panels open.

        closeMobileSidebar();
        closeProfileMenu();
        closeAdminNotifMenu();
        document.dispatchEvent(new CustomEvent('inigosync:owner-panel', { detail: name }));
        if (name === 'payments') { loadOwnerPaymentSettings(); refreshPayMongoHealth(); }
        if (name === 'booking-rules') loadBookingRules();
        if (name === 'announcement') loadOwnerAnnouncements();
        if (name === 'audit') loadAuditTrail();
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
            // closeAdminNotifMenu is a hoisted function declaration defined
            // further down this file (Notifications section) — safe to call
            // from here regardless of source order, same reasoning
            // includes/Dashboard.js documents for its own closeNotifMenu.
            closeAdminNotifMenu();
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

    function monthRange(date = new Date()) {
        const start = new Date(date.getFullYear(), date.getMonth(), 1);
        const end = new Date(date.getFullYear(), date.getMonth() + 1, 1);
        return { start, end };
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

        // Revision A1, decision A3 — the Booking status breakdown refreshes
        // alongside the account/catalog stat tiles, from this SAME entry point (also
        // triggered on 'inigosync:profile-ready' below), rather than a
        // second listener elsewhere. Revision A3, decision C4 — the old
        // Recent bookings table (which used to also refresh from here) is
        // gone; Website performance replaced it and runs on its own
        // schedule — see refreshWebsitePerformance()'s own comment for why
        // it isn't wired to this same entry point.
        refreshStatusBreakdown();
    }

    // ------------------------------------------------------------------
    // Overview — Booking status this month (Revision A1, decision A3).
    // Replaces the old hardcoded "Staff on shift" card: real counts,
    // rendered as the SAME label + count + proportional-bar rows
    // (.admin-progress-*) the old fake card used.
    //
    // Checkout attempts are never bookings in this flow. The chart shows
    // only reservation statuses, so pending/unpaid rows are omitted.
    const ADMIN_STATUS_LABELS = { booked: 'Booked', completed: 'Completed', no_show: 'No-show' };
    let statusRange = 'month';

    function statusDateRange(range) {
        const now = new Date();
        if (range === 'week') {
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
            return { start, end: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) };
        }
        if (range === 'year') {
            return { start: new Date(now.getFullYear(), 0, 1), end: new Date(now.getFullYear() + 1, 0, 1) };
        }
        return monthRange(now);
    }

    document.querySelectorAll('[data-admin-status-range]').forEach((button) => {
        button.addEventListener('click', () => {
            statusRange = button.dataset.adminStatusRange;
            document.querySelectorAll('[data-admin-status-range]').forEach((item) => {
                item.classList.toggle('is-active', item === button);
            });
            refreshStatusBreakdown();
        });
    });

    async function refreshStatusBreakdown() {
        const listRoot = document.querySelector('[data-admin-status-breakdown]');
        if (!listRoot || !window.sb) return;

        const { start, end } = statusDateRange(statusRange);

        const { data: rows, error } = await window.sb.rpc('admin_booking_overview', { p_from_at: start.toISOString(), p_to_at: end.toISOString() });
        if (error) { listRoot.innerHTML = '<p class="admin-form-hint">Could not load booking status.</p>'; return; }
        const counts = { booked: 0, completed: 0, no_show: 0 };
        (rows || []).forEach(row => {
            const key = row.auto_cancelled_at || ['no_show', 'unattended'].includes(row.status) ? 'no_show'
                : row.status === 'completed' ? 'completed'
                : row.status === 'confirmed' && Number(row.amount_paid) > 0 ? 'booked'
                : null;
            if (key) counts[key]++;
        });

        const maxCount = Math.max(1, ...Object.values(counts));

        listRoot.innerHTML = Object.keys(ADMIN_STATUS_LABELS).map((key) => {
            const count = counts[key];
            const pct = Math.round((count / maxCount) * 100);
            return `
                <div class="admin-progress-item">
                    <div class="admin-progress-row">
                        <span>${ADMIN_STATUS_LABELS[key]}</span>
                        <span class="admin-progress-count">${count} booking${count === 1 ? '' : 's'}</span>
                    </div>
                    <div class="admin-progress-track"><div class="admin-progress-fill" style="width: ${pct}%;"></div></div>
                </div>
            `;
        }).join('');
    }

    // ------------------------------------------------------------------
    // Overview — Website performance (Revision A3, implementation_plan.md,
    // decision C4). Replaces the old Recent bookings card with 3 grouped,
    // client-measurable health checks. Every check either returns a REAL
    // measured value or, if it genuinely can't run right now, an explicit
    // "—" value with a neutral "Unavailable" pill and a tooltip reason
    // (adminPerfUnavailableRow) — never a fabricated number. Each check
    // function is written to never reject (its own try/catch always
    // resolves to a row), so Promise.all below can't itself fail.
    // ------------------------------------------------------------------

    // Safety cap on checkAdminPerfMediaStorage()'s recursive descent into
    // Storage "folders" (list() entries with no `metadata`) — a media
    // library this deeply nested is not expected, and this bounds how many
    // list() round trips a single Run check can ever make.
    const ADMIN_PERF_MAX_STORAGE_FOLDERS = 20;
    const ADMIN_PERF_REFRESH_MS = 5 * 60 * 1000;

    function adminPerfUnavailableRow(label, reason) {
        return { label, value: '—', status: 'neutral', pillText: 'Unavailable', title: reason || 'This check could not run.' };
    }

    // Decimal byte units match the 1 GB reference used by the percentage.
    function formatAdminPerfBytes(bytes) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = Math.max(0, Number(bytes) || 0);
        let unitIndex = 0;
        while (value >= 1000 && unitIndex < units.length - 1) {
            value /= 1000;
            unitIndex += 1;
        }
        const rounded = (unitIndex === 0 || value >= 100) ? Math.round(value) : Math.round(value * 10) / 10;
        return `${rounded} ${units[unitIndex]}`;
    }

    // (1) Website loading — Navigation Timing. loadEventEnd (and its domComplete
    // fallback) both read 0/undefined until the browser's own 'load' event
    // has actually finished dispatching, so this can legitimately be
    // "not ready yet" for a little while after DOMContentLoaded — handled
    // as an honest Unavailable row rather than a fabricated/negative
    // duration (see refreshWebsitePerformance's own initial-run comment
    // below for how the FIRST run avoids this case entirely).
    function getAdminPerfPageLoadMs() {
        const [nav] = performance.getEntriesByType('navigation');
        if (!nav) return null;
        const raw = nav.loadEventEnd > 0 ? (nav.loadEventEnd - nav.startTime) : (nav.domComplete > 0 ? (nav.domComplete - nav.startTime) : null);
        return (typeof raw === 'number' && raw > 0) ? raw : null;
    }

    function checkAdminPerfPageLoad() {
        const LABEL = 'Page loading time';
        const ms = getAdminPerfPageLoadMs();
        if (ms === null) return adminPerfUnavailableRow(LABEL, 'The page is still finishing loading — try Run check again in a moment.');
        const status = ms < 2500 ? 'good' : ms < 5000 ? 'warn' : 'problem';
        const pillText = status === 'good' ? 'Good' : status === 'warn' ? 'Slow' : 'Problem';
        return { label: LABEL, value: `${(ms / 1000).toFixed(1)} s`, status, pillText };
    }

    // (2) Photo and media space — recursive, best-effort walk of the `media`
    // bucket. list() entries with a `metadata` object are files (summed by
    // metadata.size); entries with no `metadata` are "folders" and are
    // descended into, up to ADMIN_PERF_MAX_STORAGE_FOLDERS list() calls
    // total. Reuses isMediaBucketMissingError() (defined above, shared with
    // uploadToMedia()) so a not-yet-provisioned bucket reads as "Not set up"
    // rather than an error.
    async function checkAdminPerfMediaStorage() {
        const LABEL = 'Storage';
        if (!window.sb) return adminPerfUnavailableRow(LABEL, 'Not connected to the server yet.');

        let totalBytes = 0;
        let foldersVisited = 0;
        let bucketMissing = false;
        let hardError = null;

        async function walk(prefix) {
            if (hardError || bucketMissing) return;
            if (foldersVisited >= ADMIN_PERF_MAX_STORAGE_FOLDERS) {
                hardError = new Error('The photo library is too large for this check.');
                return;
            }
            foldersVisited += 1;
            const { data, error } = await window.sb.storage.from('media').list(prefix, { limit: 1000 });
            if (error) {
                if (isMediaBucketMissingError(error)) bucketMissing = true;
                else hardError = error;
                return;
            }
            if ((data || []).length === 1000) {
                hardError = new Error('The photo library is too large for this check.');
                return;
            }
            for (const entry of (data || [])) {
                if (hardError || bucketMissing) return;
                if (entry.metadata && typeof entry.metadata.size === 'number') {
                    if (!Number.isFinite(entry.metadata.size) || entry.metadata.size < 0) {
                        hardError = new Error('Storage returned an invalid photo size.');
                        return;
                    }
                    totalBytes += entry.metadata.size;
                } else if (!entry.metadata) {
                    await walk(prefix ? `${prefix}/${entry.name}` : entry.name);
                }
            }
        }

        try {
            await walk('');
        } catch (err) {
            hardError = err;
        }

        if (bucketMissing) {
            return { label: LABEL, value: 'Not set up', status: 'neutral', pillText: 'Unavailable', title: 'Photo storage has not been configured.' };
        }
        if (hardError) {
            return adminPerfUnavailableRow(LABEL, hardError.message || 'Could not read Storage.');
        }

        const referenceBytes = 1_000_000_000;
        const usagePct = (totalBytes / referenceBytes) * 100;
        const status = usagePct < 25 ? 'good'
            : usagePct < 50 ? 'neutral'
                : usagePct < 70 ? 'warn'
                    : 'problem';
        const pillText = usagePct < 25 ? 'Low use'
            : usagePct < 50 ? 'Moderate'
                : usagePct < 70 ? 'High use'
                    : 'Very high';

        return {
            label: LABEL,
            value: `${formatAdminPerfBytes(totalBytes)} of 1 GB reference · ${usagePct.toFixed(1)}%`,
            status,
            pillText,
            storageUsage: true,
            barPct: Math.min(100, Math.max(0, usagePct)),
            barValueText: `${usagePct.toFixed(1)}% of the 1 GB reference`,
        };
    }

    // Measure a lightweight authenticated request to the service so the
    // owner sees a simple server response time rather than database internals.
    async function checkAdminPerfServerResponse() {
        const LABEL = 'Server response';
        if (!window.sb) return adminPerfUnavailableRow(LABEL, 'Not connected to the server yet.');
        try {
            const startedAt = performance.now();
            const { error } = await window.sb.from('profiles').select('id', { head: true }).limit(1);
            if (error) return adminPerfUnavailableRow(LABEL, error.message || 'Could not contact the service.');
            const ms = Math.max(0, Math.round(performance.now() - startedAt));
            const status = ms < 500 ? 'good' : ms < 1500 ? 'warn' : 'problem';
            const pillText = status === 'good' ? 'Fast' : status === 'warn' ? 'Taking longer' : 'Slow';
            return { label: LABEL, value: `${ms} ms`, status, pillText };
        } catch (err) {
            return adminPerfUnavailableRow(LABEL, (err && err.message) || 'Could not reach the database.');
        }
    }

    // (4) Website issues this visit — show the count without technical detail.
    // inigosyncSessionErrorCount is a module-level
    // counter incremented by the window 'error'/'unhandledrejection'
    // listeners registered at the very top of this file (before this
    // DOMContentLoaded block even runs), so it also counts anything thrown
    // during this file's own startup.
    function checkAdminPerfSessionErrors() {
        const count = inigosyncSessionErrorCount;
        const status = count === 0 ? 'good' : count < 5 ? 'warn' : 'problem';
        const pillText = status === 'good' ? 'Good' : status === 'warn' ? 'Warn' : 'Problem';
        return { label: 'Website issues this visit', value: String(count), status, pillText };
    }

    // (5) Internet connection — keep the owner-facing state simple.
    function checkAdminPerfConnection() {
        const online = navigator.onLine;
        const value = online ? 'Connected' : 'Not connected';
        return { label: 'Internet connection', value, status: online ? 'good' : 'problem', pillText: online ? 'Good' : 'Check connection' };
    }

    const ADMIN_PERF_OVERALL_LABELS = { good: 'Good', warn: 'Slow', problem: 'Problem' };

    // A 'neutral' row (media storage's "Not set up",
    // or any check's own "Unavailable") never counts toward it: a bucket
    // the owner hasn't provisioned yet, or a check that simply couldn't run
    // this time, isn't a website PERFORMANCE problem, so neither should
    // drag the overall badge down. If every row is neutral (practically
    // unreachable — Connection/Errors this session/Page load are almost
    // always computable), default to Good rather than alarming the owner
    // over nothing measured.
    function adminPerfPillHtml(row, extraClass) {
        const status = row.status || 'neutral';
        const text = row.pillText || 'Info';
        const cls = `admin-perf-pill${extraClass ? ` ${extraClass}` : ''} admin-perf-pill-${window.escapeHtml(status)}`;
        return `<span class="${cls}">${window.escapeHtml(text)}</span>`;
    }

    // Legend swatch — same "which of the 4 statuses" branch the chart slice
    // colors below use, just as a tiny CSS-colored dot (.admin-perf-dot-*,
    // Style/owner_dashboard.css) instead of a canvas fill.
    function adminPerfDotHtml(status) {
        return `<span class="admin-perf-dot admin-perf-dot-${window.escapeHtml(status || 'neutral')}" aria-hidden="true"></span>`;
    }

    function adminPerfRowHtml(row) {
        // Media storage's usage bar renders as a second, full-width line
        // under the label/value/pill row (see .admin-perf-bar's own comment
        // in Style/owner_dashboard.css) rather than squeezed into that row.
        const barHtml = (typeof row.barPct === 'number')
            ? `<div class="admin-progress-track admin-perf-bar" role="progressbar" aria-label="${window.escapeHtml(row.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, Math.max(0, row.barPct))}" aria-valuetext="${window.escapeHtml(row.barValueText || `${row.barPct}%`)}"><div class="admin-progress-fill admin-perf-bar-fill-${window.escapeHtml(row.status || 'neutral')}" style="width: ${Math.min(100, Math.max(0, row.barPct))}%;"></div></div>`
            : '';
        const detailHtml = row.details ? `<span class="admin-perf-item-detail">${window.escapeHtml(row.details)}</span>` : '';
        return `
            <div class="admin-perf-item"${row.storageUsage ? ' data-admin-perf-storage' : ''}>
                <div class="admin-perf-item-row">
                    <span class="admin-perf-item-label">${adminPerfDotHtml(row.status)}${window.escapeHtml(row.label)}</span>
                    <span class="admin-perf-item-value">${window.escapeHtml(row.value)}</span>
                    ${adminPerfPillHtml(row)}
                </div>
                ${detailHtml}
                ${barHtml}
            </div>
        `;
    }

    // ------------------------------------------------------------------
    // Website performance — doughnut chart ("like a pie graph"). Chart.js
    // is loaded from the CDN in Pages/owner_dashboard.html's <head>, ahead
    // of this file, so window.Chart is already defined here unless that
    // CDN request itself failed (checked once below, mirroring how
    // event/chart.js guards the SAME global for the booking trend chart).
    // One instance, created once and updated in place on every refresh —
    // never destroyed/recreated — exactly like event/chart.js's
    // bookingChart/updateCharts() do for that other chart on this page.
    // ------------------------------------------------------------------
    let adminPerfChart = null;
    // The tooltip label callback below is defined once, at chart creation,
    // but needs each refresh's live values/pillText — it reads them off
    // this module-level array (kept in sync by renderAdminPerfChart())
    // rather than closing over a single refresh's now-stale `rows` param.
    let adminPerfLatestRows = [];

    function getAdminPerfThemeColors() {
        const style = getComputedStyle(document.documentElement);
        return {
            ink: style.getPropertyValue('--color-ink').trim(),
            line: style.getPropertyValue('--color-line').trim(),
            bgCard: style.getPropertyValue('--color-bg-card').trim(),
        };
    }

    // The 4 slice/dot colors — good/problem/neutral reuse the same design
    // tokens as .admin-perf-pill-good/-problem/-neutral; warn uses the
    // dedicated --color-perf-warn amber (see that variable's own comment in
    // Style/owner_dashboard.css for why it isn't --color-primary here).
    function adminPerfSliceColor(status) {
        const style = getComputedStyle(document.documentElement);
        if (status === 'good') return style.getPropertyValue('--color-court-green').trim();
        if (status === 'warn') return style.getPropertyValue('--color-perf-warn').trim();
        if (status === 'problem') return style.getPropertyValue('--color-alert').trim();
        return style.getPropertyValue('--color-ink-faint').trim(); // neutral / unavailable / anything else
    }

    // Re-applies current theme colors to the existing chart instance —
    // called after every refresh AND on 'themechange', same split
    // event/chart.js's updateCharts() does for the booking trend chart.
    function paintAdminPerfChart() {
        if (!adminPerfChart) return;
        const theme = getAdminPerfThemeColors();
        adminPerfChart.data.datasets[0].backgroundColor = adminPerfLatestRows.map((row) => adminPerfSliceColor(row.status));
        adminPerfChart.data.datasets[0].borderColor = theme.bgCard;
        adminPerfChart.options.plugins.tooltip.backgroundColor = theme.bgCard;
        adminPerfChart.options.plugins.tooltip.borderColor = theme.line;
        adminPerfChart.options.plugins.tooltip.titleColor = theme.ink;
        adminPerfChart.options.plugins.tooltip.bodyColor = theme.ink;
        adminPerfChart.update();
    }

    // Builds the doughnut the first time, then just updates its data/colors
    // in place on every subsequent call (see this section's own comment
    // above for why). window.Chart missing (CDN failed) or the canvas not
    // being in the DOM both no-op here — Style/owner_dashboard.css's
    // .admin-perf-no-chart (set once, below) hides the now-empty chart
    // column so the legend list alone fills the card.
    function renderAdminPerfChart(rows) {
        adminPerfLatestRows = rows;
        const canvas = document.querySelector('[data-admin-perf-chart]');
        if (!canvas || typeof window.Chart === 'undefined') return;

        if (!adminPerfChart) {
            const theme = getAdminPerfThemeColors();
            adminPerfChart = new Chart(canvas, {
                type: 'doughnut',
                data: {
                    labels: rows.map((row) => row.label),
                    datasets: [{
                        // Three EQUAL slices — status (color), not magnitude,
                        // is what this ring encodes; a real check value
                        // (e.g. milliseconds vs. a booking count) has no
                        // shared unit to size slices by anyway.
                        data: rows.map(() => 1),
                        backgroundColor: rows.map((row) => adminPerfSliceColor(row.status)),
                        borderColor: theme.bgCard,
                        borderWidth: 2,
                    }],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '68%',
                    animation: { duration: 400 },
                    plugins: {
                        legend: { display: false }, // the legend list beside it IS the legend
                        tooltip: {
                            backgroundColor: theme.bgCard,
                            borderColor: theme.line,
                            borderWidth: 1,
                            titleColor: theme.ink,
                            bodyColor: theme.ink,
                            padding: 10,
                            displayColors: false,
                            callbacks: {
                                title: () => '',
                                label: (ctx) => {
                                    const row = adminPerfLatestRows[ctx.dataIndex];
                                    if (!row) return '';
                                    return `${row.label}: ${row.value} · ${row.pillText || 'Info'}`;
                                },
                            },
                        },
                    },
                },
            });
            return;
        }

        adminPerfChart.data.labels = rows.map((row) => row.label);
        adminPerfChart.data.datasets[0].data = rows.map(() => 1);
        paintAdminPerfChart();
    }

    // Center-of-the-ring overlay — the overall word (never 'neutral', see
    // worstAdminPerfStatus()) plus the static "3 checks" already in the
    // markup. Pure CSS class swap, so it stays correct across theme changes
    // on its own (no JS re-render needed, unlike the canvas ring itself).
    function updateAdminPerfChartCenter(overall) {
        const statusEl = document.querySelector('[data-admin-perf-chart-status]');
        if (!statusEl) return;
        statusEl.textContent = ADMIN_PERF_OVERALL_LABELS[overall] || '—';
        statusEl.className = `admin-perf-chart-status admin-perf-chart-status-${overall}`;
    }

    let adminPerfIsRunning = false;

    async function refreshWebsitePerformance() {
        const listRoot = document.querySelector('[data-admin-perf-list]');
        if (!listRoot) return;
        if (adminPerfIsRunning) return; // ignore an overlapping Run check click / interval tick
        adminPerfIsRunning = true;

        const overallEl = document.querySelector('[data-admin-perf-overall]');
        const lastCheckedEl = document.querySelector('[data-admin-perf-last-checked]');
        const runBtn = document.querySelector('[data-admin-perf-run]');
        const runBtnOriginalLabel = runBtn ? runBtn.textContent : null;
        if (runBtn) {
            runBtn.disabled = true;
            runBtn.textContent = 'Checking…';
        }

        try {
            const [storage, pageLoad, serverResponse] = await Promise.all([
                checkAdminPerfMediaStorage(),
                Promise.resolve(checkAdminPerfPageLoad()),
                checkAdminPerfServerResponse(),
            ]);
            const connection = checkAdminPerfConnection();
            const rows = buildAdminPerfGroups({
                storage, pageLoad, serverResponse,
                errorCount: inigosyncSessionErrorCount, connection,
            });

            listRoot.innerHTML = rows.map(adminPerfRowHtml).join('');
            renderAdminPerfChart(rows);

            const overall = worstAdminPerfStatus(rows);
            if (overallEl) {
                overallEl.textContent = ADMIN_PERF_OVERALL_LABELS[overall];
                overallEl.className = `admin-perf-pill admin-perf-overall admin-perf-pill-${overall}`;
            }
            updateAdminPerfChartCenter(overall);
            if (lastCheckedEl) {
                const checkedAt = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                lastCheckedEl.textContent = `Last checked ${checkedAt}`;
            }
        } catch (err) {
            // Should be unreachable (every check* function catches its own
            // errors), but a card stuck on "Running checks…" forever would
            // be worse than an honest failure message.
            console.error('[admin] failed to run the website performance checks', err);
            listRoot.innerHTML = '<p style="color: var(--color-ink-faint);">Could not run the performance checks. Please try again.</p>';
        } finally {
            adminPerfIsRunning = false;
            if (runBtn) {
                runBtn.disabled = false;
                runBtn.textContent = runBtnOriginalLabel || 'Run check';
            }
        }
    }

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

    const adminPerfRunBtn = document.querySelector('[data-admin-perf-run]');
    if (adminPerfRunBtn) adminPerfRunBtn.addEventListener('click', refreshWebsitePerformance);

    // Chart.js availability is fixed for the life of the page (either the
    // <head> CDN <script> tag succeeded before this file ever ran, or it
    // didn't) — checked once, matching event/chart.js's own one-time
    // `typeof Chart === 'undefined'` guard for the booking trend chart.
    const adminPerfBodyEl = document.querySelector('[data-admin-perf-body]');
    if (adminPerfBodyEl && typeof window.Chart === 'undefined') {
        console.warn('[admin] Chart.js failed to load from the CDN — Website performance will show the legend list only.');
        adminPerfBodyEl.classList.add('admin-perf-no-chart');
    }

    // Re-color (not rebuild) the doughnut on theme changes — same approach
    // event/chart.js's updateCharts() takes for the booking trend chart.
    document.addEventListener('themechange', paintAdminPerfChart);

    document.addEventListener('inigosync:profile-ready', refreshWebsitePerformance);
    window.setInterval(refreshWebsitePerformance, ADMIN_PERF_REFRESH_MS);

    // First run deliberately keyed to the window 'load' event (deferred one
    // more tick via setTimeout) rather than called plainly here alongside
    // this file's other "on load" refreshers: Page load (check #2) reads
    // Navigation Timing fields that are only populated once 'load' finishes
    // DISPATCHING — reading them from directly inside a 'load' listener
    // itself can still observe 0 on some browsers, hence the setTimeout(…,
    // 0) to hop past that same event loop turn. Falls back to running
    // immediately if 'load' has, unusually, already fired by the time this
    // line runs (e.g. a very slow parse of everything before this script
    // tag) — DOMContentLoaded (which this whole block already runs inside
    // of) always fires before 'load', so that's the only case this guards.
    if (document.readyState === 'complete') {
        refreshWebsitePerformance();
    } else {
        window.addEventListener('load', () => window.setTimeout(refreshWebsitePerformance, 0), { once: true });
    }

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
    // from data-admin-toggle-staff-form to data-admin-staff-add. Submit
    // logic (staffSubmitBtn below) is unchanged other than how it closes
    // the dialog on success.
    // ------------------------------------------------------------------
    const staffModal = document.querySelector('[data-admin-staff-modal]');
    const staffForm = document.querySelector('[data-admin-staff-form]');
    const staffAddBtns = document.querySelectorAll('[data-admin-staff-add]');

    function resetStaffForm() {
        if (!staffForm) return;
        const nameInput = staffForm.querySelector('[data-admin-staff-name]');
        const emailInput = staffForm.querySelector('[data-admin-staff-email]');
        if (nameInput) nameInput.value = '';
        if (emailInput) emailInput.value = '';
        const roleSelect = staffForm.querySelector('[data-admin-staff-role]');
        if (roleSelect) roleSelect.selectedIndex = 0;

        // Revision S3 (database/schema/018_staff_details.sql) — all five optional.
        const addressInput = staffForm.querySelector('[data-admin-staff-address]');
        const birthdateInput = staffForm.querySelector('[data-admin-staff-birthdate]');
        const genderSelect = staffForm.querySelector('[data-admin-staff-gender]');
        const emergencyNameInput = staffForm.querySelector('[data-admin-staff-emergency-name]');
        const emergencyNumberInput = staffForm.querySelector('[data-admin-staff-emergency-number]');
        if (addressInput) addressInput.value = '';
        if (birthdateInput) birthdateInput.value = '';
        const ageInput = staffForm.querySelector('[data-admin-staff-age]');
        if (ageInput) ageInput.value = '';
        if (genderSelect) genderSelect.selectedIndex = 0;
        if (emergencyNameInput) emergencyNameInput.value = '';
        if (emergencyNumberInput) emergencyNumberInput.value = '';
    }

    // Revision S3 — Birthdate can never be set in the future. Set once here
    // (rather than baked into the HTML's static max="…", which would
    // silently go stale) for both the Add New Staff modal's field and the
    // Edit/View staff modal's field further below.
    function todayDateInputValue() {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    const staffAddBirthdateInput = document.querySelector('[data-admin-staff-birthdate]');
    if (staffAddBirthdateInput) staffAddBirthdateInput.max = todayDateInputValue();

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

    function closeStaffModal() {
        if (!staffModalIsOpen || !staffModal) return;
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
        btn.addEventListener('click', closeStaffModal);
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
        if (e.key === 'Escape' && staffModalIsOpen) closeStaffModal();
    });

    const staffTable = document.querySelector('[data-admin-staff-table]');
    const staffSubmitBtn = document.querySelector('[data-admin-staff-submit]');
    const staffSearch = document.querySelector('[data-admin-staff-search]');
    const staffStatusFilter = document.querySelector('[data-admin-staff-status-filter]');
    const staffPositionFilter = document.querySelector('[data-admin-staff-position-filter]');
    const staffPagination = document.querySelector('[data-admin-staff-pagination]');
    const staffPageInfo = document.querySelector('[data-admin-staff-page-info]');
    const staffPagePrev = document.querySelector('[data-admin-staff-page-prev]');
    const staffPageNext = document.querySelector('[data-admin-staff-page-next]');
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
            const nameInput = document.querySelector('[data-admin-staff-name]');
            const emailInput = document.querySelector('[data-admin-staff-email]');
            const roleSelect = document.querySelector('[data-admin-staff-role]');
            const addressInput = document.querySelector('[data-admin-staff-address]');
            const birthdateInput = document.querySelector('[data-admin-staff-birthdate]');
            const genderSelect = document.querySelector('[data-admin-staff-gender]');
            const emergencyNameInput = document.querySelector('[data-admin-staff-emergency-name]');
            const emergencyNumberInput = document.querySelector('[data-admin-staff-emergency-number]');

            const name = nameInput ? nameInput.value.trim() : '';
            const email = emailInput ? emailInput.value.trim() : '';
            const position = roleSelect ? roleSelect.value : '';

            if (!name || !email) {
                if (!name && nameInput) nameInput.focus();
                else if (emailInput) emailInput.focus();
                return;
            }

            if (!['Secretary', 'Court Attendant'].includes(position) || !birthdateInput?.value || birthdateInput.value > todayDateInputValue() || computeAdminStaffAge(birthdateInput.value) === null) {
                window.InigoToast?.show('Choose a staff position and enter a valid birthdate.', true);
                birthdateInput?.focus(); return;
            }
            if (!emailInput.checkValidity()) { emailInput.reportValidity(); return; }

            // Revision S3 — the emergency contact number is optional, but
            // validated the same way as everywhere else in this app
            // whenever a value IS entered; checked BEFORE the invite goes
            // out so a typo here never leaves the owner staring at an
            // already-sent invite with no way back to fix just this field.
            const emergencyNumberRaw = emergencyNumberInput ? emergencyNumberInput.value.trim() : '';
            let emergency_contact_number = '';
            if (emergencyNumberRaw) {
                if (!window.validatePhMobile) {
                    window.InigoToast?.show('Unable to validate the emergency contact number right now. Please try again shortly.', true);
                    return;
                }
                const check = window.validatePhMobile(emergencyNumberRaw);
                if (!check.valid) {
                    window.InigoToast?.show(`Emergency contact number: ${check.message}`, true);
                    emergencyNumberInput?.focus();
                    return;
                }
                emergency_contact_number = check.normalized;
            }

            if (!window.sb || !window.SUPABASE_URL) {
                window.InigoToast?.show('Unable to reach the server right now. Please try again shortly.', true);
                return;
            }

            staffSubmitBtn.disabled = true;
            staffSubmitBtn.textContent = 'Sending invite…';

            try {
                const { data: { session } } = await window.sb.auth.getSession();
                if (!session) throw new Error('Your session expired. Please log in again.');

                const res = await fetch(`${window.SUPABASE_URL}/functions/v1/invite-staff`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${session.access_token}`
                    },
                    body: JSON.stringify({ email, full_name: name, position, role: 'staff', birthdate: birthdateInput.value, address: addressInput?.value.trim() || '', gender: genderSelect?.value || '', emergency_contact_name: emergencyNameInput?.value.trim() || '', emergency_contact_number })
                });

                const result = await res.json().catch(() => ({}));
                if (!res.ok) {
                    throw new Error(result.error || 'Could not send the invite.');
                }

                refreshStaffList();
                resetStaffForm();
                closeStaffModal();
                recordOwnerActivity(`Staff account invited: ${name}`, 'staff');
            } catch (err) {
                window.InigoToast?.show(err.message || 'Could not send the invite. Please try again.', true);
            } finally {
                staffSubmitBtn.disabled = false;
                staffSubmitBtn.textContent = 'Send Invite';
            }
        });
    }

    // ------------------------------------------------------------------
    // Staff Management — Edit/View staff modal (Revision S3). Replaces the
    // old inline Edit, which toggled the Name/Position cells into <input>s
    // in place — there was no room in a table cell for five more fields
    // (database/schema/018_staff_details.sql). One dialog now serves BOTH
    // actions: data-admin-view-staff and data-admin-edit-staff (wired in
    // wireStaffRowActions() below) both call openStaffEditModal(profile,
    // mode) — 'view' disables every field, hides Save, and relabels Cancel
    // to Close, purely in JS, so there is exactly one form to keep in sync
    // rather than two near-identical dialogs. Same
    // .admin-modal-overlay/.admin-modal shell + open/close idiom (Esc/
    // backdrop mousedown+click/×, focus-first-field) as the Add New Staff
    // modal above.
    // ------------------------------------------------------------------
    const staffEditModal = document.querySelector('[data-admin-staff-edit-modal]');
    const staffEditDialog = document.querySelector('[data-admin-staff-edit-dialog]');
    const staffEditBirthdateInput = document.querySelector('[data-admin-staff-edit-birthdate]');
    if (staffEditBirthdateInput) staffEditBirthdateInput.max = todayDateInputValue();

    [[staffAddBirthdateInput, '[data-admin-staff-age]'], [staffEditBirthdateInput, '[data-admin-staff-edit-age]']].forEach(([input, selector]) => {
        input?.addEventListener('input', () => { document.querySelector(selector).value = computeAdminStaffAge(input.value) ?? ''; });
    });

    const STAFF_EDIT_MODAL_CLOSE_DELAY_MS = 250;
    let staffEditModalHideTimer = null;
    let staffEditModalIsOpen = false;
    let staffEditModalLastFocused = null;
    let staffEditModalProfileId = null;

    function fillStaffEditForm(profile) {
        if (!staffEditDialog) return;
        const set = (sel, val) => {
            const el = staffEditDialog.querySelector(sel);
            if (el) el.value = val;
        };
        set('[data-admin-staff-edit-name]', profile.full_name || '');
        set('[data-admin-staff-edit-position]', profile.position || '');
        set('[data-admin-staff-edit-mobile]', profile.contact_num || '');
        set('[data-admin-staff-edit-address]', profile.address || '');
        set('[data-admin-staff-edit-birthdate]', profile.birthdate || '');
        set('[data-admin-staff-edit-age]', computeAdminStaffAge(profile.birthdate) ?? '');
        set('[data-admin-staff-edit-gender]', profile.gender || '');
        set('[data-admin-staff-edit-emergency-name]', profile.emergency_contact_name || '');
        set('[data-admin-staff-edit-emergency-number]', profile.emergency_contact_number || '');

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

    function setStaffEditFieldsDisabled(disabled) {
        if (!staffEditDialog) return;
        staffEditDialog.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = disabled; });
    }

    function openStaffEditModal(profile, mode) {
        if (!staffEditModal || !staffEditDialog) return;
        staffEditModalLastFocused = document.activeElement;
        staffEditModalProfileId = profile.id;
        fillStaffEditForm(profile);
        setStaffEditFieldsDisabled(mode === 'view');

        const viewingDetails = mode === 'view';
        const detailsView = staffEditDialog.querySelector('[data-admin-staff-details-view]');
        const detailsEdit = staffEditDialog.querySelector('[data-admin-staff-details-edit]');
        if (detailsView) detailsView.hidden = !viewingDetails;
        if (detailsEdit) detailsEdit.hidden = viewingDetails;

        const titleEl = staffEditDialog.querySelector('[data-admin-staff-edit-modal-title]');
        if (titleEl) titleEl.textContent = mode === 'view' ? 'Staff Details' : 'Edit Staff';
        const saveBtn = staffEditDialog.querySelector('[data-admin-staff-edit-submit]');
        if (saveBtn) saveBtn.hidden = mode === 'view';
        const cancelBtn = staffEditDialog.querySelector('.admin-btn-ghost[data-admin-staff-edit-modal-close]');
        if (cancelBtn) cancelBtn.textContent = mode === 'view' ? 'Close' : 'Cancel';

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

        const firstField = mode === 'view' ? cancelBtn : staffEditDialog.querySelector('input, select, textarea');
        if (firstField) firstField.focus();
    }

    function closeStaffEditModal() {
        if (!staffEditModalIsOpen || !staffEditModal) return;
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
            const get = (sel) => staffEditDialog.querySelector(sel)?.value.trim() || '';

            const full_name = get('[data-admin-staff-edit-name]');
            if (!full_name) {
                window.InigoToast?.show("Enter the staff member's full name.", true);
                return;
            }
            const position = get('[data-admin-staff-edit-position]');
            const birthdate = get('[data-admin-staff-edit-birthdate]');
            if (!['Secretary', 'Court Attendant'].includes(position) || (birthdate && (birthdate > todayDateInputValue() || computeAdminStaffAge(birthdate) === null))) {
                window.InigoToast?.show('Choose a valid position and birthdate.', true); return;
            }

            const emergencyNumberRaw = get('[data-admin-staff-edit-emergency-number]');
            let emergency_contact_number = '';
            if (emergencyNumberRaw) {
                const check = window.validatePhMobile ? window.validatePhMobile(emergencyNumberRaw) : { valid: false, message: 'Mobile validation is unavailable right now.' };
                if (!check.valid) {
                    window.InigoToast?.show(`Emergency contact number: ${check.message}`, true);
                    return;
                }
                emergency_contact_number = check.normalized;
            }

            const fullPatch = {
                full_name,
                position,
                address: get('[data-admin-staff-edit-address]'),
                birthdate: staffEditDialog.querySelector('[data-admin-staff-edit-birthdate]')?.value || null,
                gender: staffEditDialog.querySelector('[data-admin-staff-edit-gender]')?.value || '',
                emergency_contact_name: get('[data-admin-staff-edit-emergency-name]'),
                emergency_contact_number,
            };

            staffEditSubmitBtn.disabled = true;
            let { error } = await window.sb.from('profiles').update(fullPatch).eq('id', staffEditModalProfileId);

            // Revision S3 — database/schema/018_staff_details.sql not
            // applied yet: retry with just the three columns the old
            // inline Edit already relied on, same schema-mismatch-retry
            // idiom as every other write in this file
            // (isSchemaMismatchError's own comment above).
            let usedReducedPayload = false;
            if (error && isSchemaMismatchError(error)) {
                ({ error } = await window.sb.from('profiles').update({ full_name, position }).eq('id', staffEditModalProfileId));
                usedReducedPayload = true;
            }

            staffEditSubmitBtn.disabled = false;

            if (error) {
                window.InigoToast?.show(error.message || 'Could not save changes.', true);
                return;
            }

            closeStaffEditModal();
            refreshStaffList();
            recordOwnerActivity(`Staff account updated: ${full_name}`, 'staff');
            window.InigoToast?.show(usedReducedPayload
                ? 'Staff updated — address/birthdate/gender/emergency contact need a database update (see database/schema/018_staff_details.sql).'
                : 'Staff updated.');
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
        const statusLabels = { active: 'Active', disabled: 'Deactivated', pending: 'Invited' };
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
            pending: ['pending', 'Invited'],
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
        // full_name/email/position are set by whoever filled in the staff
        // invite/edit form (and, before Phase 2, an admin — but this same
        // rendering path is what a promoted/self-edited account would also
        // flow through), so they're escaped before touching innerHTML — a
        // name like `<img src=x onerror=alert(1)>` must render as literal
        // text in this admin session, not run. staffStatusBadge() only
        // returns markup built from a fixed internal map, not profile data,
        // so it's safe as-is.
        //
        // Revision A1, decision A4 — a disabled account additionally gets
        // an Activate button (mirrors the court cards' Activate/Deactivate
        // pair); an active/invited account keeps just Deactivate, unchanged.
        //
        // Revision S3 — data-admin-staff-name-cell moved onto an inner
        // <span> (was the whole <td>) so a second <span class="admin-staff-meta">
        // ("24 yrs · Male", Style/owner_dashboard.css) can sit under the name
        // without corrupting the name-only .textContent every confirm()
        // message below (Reset Password/Deactivate/Activate) reads from
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
                    <button type="button" hidden data-admin-reset-password>Reset Password</button>
                    <button type="button" hidden data-admin-edit-staff>Edit</button>
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
            if (staffPageInfo) staffPageInfo.textContent = `Page ${staffPage} of ${pageCount} · ${filtered.length} staff`;
            if (staffPagePrev) staffPagePrev.disabled = staffPage <= 1;
            if (staffPageNext) staffPageNext.disabled = staffPage >= pageCount;
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
        // Never set a shared default password. The staff member receives a
        // short-lived recovery link and chooses their own replacement.
        scope.querySelectorAll('[data-admin-reset-password]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const row = btn.closest('tr');
                if (!row || !window.sb) return;
                const name = row.querySelector('[data-admin-staff-name-cell]')?.textContent || 'this account';
                const email = row.__staffProfile?.email || row.cells[1]?.textContent?.trim();
                if (!email) {
                    window.InigoToast?.show('This staff account has no email address.', true);
                    return;
                }

                const accepted = await window.InigoOwnerUI?.confirm({
                    title: 'Send password reset link?',
                    message: `Email a password recovery link to ${name} at ${email}?`,
                    confirmLabel: 'Send reset link',
                });
                if (!accepted) return;

                btn.disabled = true;
                try {
                    const { error } = await window.sb.auth.resetPasswordForEmail(email, {
                        redirectTo: new URL('../index.html', window.location.href).href,
                    });
                    if (error) throw error;
                    window.InigoToast?.show(`Recovery email requested for ${name}. Ask them to check their inbox.`);
                    recordOwnerActivity(`Staff password recovery requested: ${name}`, 'staff');
                } catch (error) {
                    window.InigoToast?.show(error.message || 'Could not send the recovery email.', true);
                } finally {
                    btn.disabled = false;
                }
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
        <button type="button" data-admin-staff-command="edit">Edit staff</button>
        <button type="button" data-admin-staff-command="reset">Send password reset</button>
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
            reset: '[data-admin-reset-password]',
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
    // The database's RLS protects writes; PayMongo secrets never reach this
    // page. The payment-health function returns safe connection metadata.
    // ------------------------------------------------------------------
    const ownerPaymentPercent = document.querySelector('[data-owner-payment-percent]');
    const ownerPaymentSave = document.querySelector('[data-owner-payment-save]');
    const ownerPaymentMessage = document.querySelector('[data-owner-payment-message]');
    const ownerPaymongoApi = document.querySelector('[data-owner-paymongo-api]');
    const ownerPaymongoWebhook = document.querySelector('[data-owner-paymongo-webhook]');
    const ownerPaymongoLast = document.querySelector('[data-owner-paymongo-last-payment]');
    const ownerPaymongoRefresh = document.querySelector('[data-owner-paymongo-refresh]');
    const ownerPaymentInputs = Object.fromEntries(['cash', 'card', 'gcash'].map(method => [method,
        document.querySelector(`[data-owner-payment-method="${method}"]`)]));
    const ownerPaymentDefaults = { downpaymentPct: 50, cashEnabled: true, cardEnabled: false, gcashEnabled: true };
    let ownerPaymentLoadGeneration = 0;

    function setOwnerPaymentMessage(message, isError = false) {
        if (!ownerPaymentMessage) return;
        ownerPaymentMessage.textContent = message || '';
        ownerPaymentMessage.classList.toggle('is-error', Boolean(isError));
        ownerPaymentMessage.classList.toggle('is-success', Boolean(message) && !isError);
    }

    function paintOwnerPaymentSettings(settings) {
        if (ownerPaymentPercent) ownerPaymentPercent.value = String(settings.downpaymentPct ?? 50);
        if (ownerPaymentInputs.cash) ownerPaymentInputs.cash.checked = settings.cashEnabled !== false;
        if (ownerPaymentInputs.card) ownerPaymentInputs.card.checked = settings.cardEnabled === true;
        if (ownerPaymentInputs.gcash) ownerPaymentInputs.gcash.checked = settings.gcashEnabled !== false;
    }

    async function loadOwnerPaymentSettings() {
        if (!ownerPaymentSave) return;
        const generation = ++ownerPaymentLoadGeneration;
        setOwnerPaymentMessage('Loading payment settings…');
        ownerPaymentSave.disabled = true;
        if (!window.sb) {
            setOwnerPaymentMessage('Payment settings are unavailable until the server connection is ready.', true);
            return;
        }
        try {
            const { data, error } = await window.sb.from('app_settings')
                .select('downpayment_pct,cash_enabled,card_enabled,gcash_enabled')
                .eq('id', true).maybeSingle();
            if (generation !== ownerPaymentLoadGeneration) return;
            if (error) throw error;
            if (data) {
                paintOwnerPaymentSettings({
                    downpaymentPct: Number(data.downpayment_pct),
                    cashEnabled: data.cash_enabled,
                    cardEnabled: data.card_enabled,
                    gcashEnabled: data.gcash_enabled,
                });
                setOwnerPaymentMessage('Settings loaded. Changes apply to new checkouts.');
            } else {
                paintOwnerPaymentSettings(ownerPaymentDefaults);
                setOwnerPaymentMessage('Using the default 50% deposit and enabled GCash and cash options.');
            }
            ownerPaymentSave.disabled = false;
        } catch (error) {
            if (generation !== ownerPaymentLoadGeneration) return;
            console.error('[admin] payment settings could not be loaded', error);
            setOwnerPaymentMessage('Payment settings could not be loaded. Try refreshing the page.', true);
        }
    }

    async function saveOwnerPaymentSettings() {
        if (!ownerPaymentSave || !window.sb) return;
        const rawPercent = ownerPaymentPercent?.value.trim() || '';
        const percent = Number(rawPercent);
        if (!rawPercent || !Number.isFinite(percent) || percent <= 0 || percent >= 100 || !/^\d+(\.\d{1,2})?$/.test(rawPercent)) {
            setOwnerPaymentMessage('Enter a down payment greater than 0% and less than 100%, using up to two decimal places.', true);
            ownerPaymentPercent?.focus();
            return;
        }
        const settings = {
            downpayment_pct: percent,
            cash_enabled: Boolean(ownerPaymentInputs.cash?.checked),
            card_enabled: Boolean(ownerPaymentInputs.card?.checked),
            gcash_enabled: Boolean(ownerPaymentInputs.gcash?.checked),
        };
        if (!settings.card_enabled && !settings.gcash_enabled) {
            setOwnerPaymentMessage('Enable at least one online payment method (Card or GCash) for customer bookings.', true);
            ownerPaymentInputs.card?.focus();
            return;
        }
        if (window.inigosyncProfile?.role !== 'admin') {
            setOwnerPaymentMessage('Only the owner can change payment settings.', true);
            return;
        }
        ownerPaymentSave.disabled = true;
        ownerPaymentSave.textContent = 'Saving…';
        setOwnerPaymentMessage('Saving payment settings…');
        try {
            const { error } = await window.sb.from('app_settings').update(settings).eq('id', true);
            if (error) throw error;
            window.InigoAppSettings?.invalidateSettings();
            await window.InigoAppSettings?.getSettings({ force: true });
            setOwnerPaymentMessage('Payment settings saved. They apply to new checkouts; existing bookings keep their agreed amount.');
        } catch (error) {
            console.error('[admin] payment settings save failed', error);
            setOwnerPaymentMessage(error.message || 'Payment settings could not be saved. Please try again.', true);
        } finally {
            ownerPaymentSave.disabled = false;
            ownerPaymentSave.textContent = 'Save payment settings';
        }
    }

    async function refreshPayMongoHealth() {
        if (!ownerPaymongoApi) return;
        [ownerPaymongoApi, ownerPaymongoWebhook, ownerPaymongoLast].forEach(el => { if (el) el.textContent = 'Checking…'; });
        if (!window.sb?.functions) {
            [ownerPaymongoApi, ownerPaymongoWebhook, ownerPaymongoLast].forEach(el => { if (el) el.textContent = 'Unavailable'; });
            return;
        }
        if (ownerPaymongoRefresh) ownerPaymongoRefresh.disabled = true;
        try {
            const { data, error } = await window.sb.functions.invoke('payment-health');
            if (error) throw error;
            ownerPaymongoApi.textContent = data?.api_connected === true ? 'Connected' : data?.api_connected === false ? 'Not connected' : 'Unavailable';
            ownerPaymongoWebhook.textContent = data?.webhook_configured === true ? 'Ready' : data?.webhook_configured === false ? 'Not set up' : 'Unavailable';
            ownerPaymongoLast.textContent = data?.last_confirmed_payment_at
                ? formatActivityTime(data.last_confirmed_payment_at)
                : data?.last_confirmed_payment_at === null ? 'No confirmed payments yet' : 'Unavailable';
        } catch (error) {
            console.warn('[admin] PayMongo health check is unavailable', error);
            [ownerPaymongoApi, ownerPaymongoWebhook, ownerPaymongoLast].forEach(el => { if (el) el.textContent = 'Unavailable'; });
        } finally {
            if (ownerPaymongoRefresh) ownerPaymongoRefresh.disabled = false;
        }
    }

    ownerPaymentSave?.addEventListener('click', saveOwnerPaymentSettings);
    ownerPaymongoRefresh?.addEventListener('click', refreshPayMongoHealth);

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
    let bookingRulesLoading = false;
    let bookingRulesEditing = false;
    let bookingRulesLoaded = false;

    function setBookingRulesMessage(message, isError = false) {
        if (!bookingRulesMessage) return;
        bookingRulesMessage.textContent = message;
        bookingRulesMessage.classList.toggle('is-error', isError);
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
            const rules = effectiveRules[0] || rulesList.slice().sort((a, b) => String(a.effective_from || '').localeCompare(String(b.effective_from || '')))[0];
            if (!rules || !Array.isArray(rules.weekly_hours)) throw new Error('The booking rules response is incomplete.');
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
                close.value = String(day.closes_at || '').slice(0, 5);
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
        setBookingRulesEditing(true);
        setBookingRulesMessage('Edit the weekly hours, effective date, or no-show grace period, then save the Working Time Schedule.');
        bookingRulesEffective?.focus();
    });

    bookingRulesCancel?.addEventListener('click', async () => {
        if (!bookingRulesEditing || bookingRulesLoading) return;
        bookingRulesLoading = false;
        bookingRulesEdit.disabled = true;
        bookingRulesCancel.disabled = true;
        setBookingRulesEditing(false);
        setBookingRulesMessage('Discarding unsaved schedule changes…');
        await loadBookingRules();
        bookingRulesCancel.disabled = false;
        bookingRulesEdit?.focus();
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
            if (!isClosed && (!opensAt || !closesAt || opensAt >= closesAt)) {
                setBookingRulesMessage(`Set a closing time after the opening time for ${row.querySelector('th')?.textContent || 'each open day'}.`, true);
                row.querySelector('[data-owner-rules-open]')?.focus();
                return;
            }
            weeklyHours.push({ weekday, opens_at: isClosed ? null : opensAt, closes_at: isClosed ? null : closesAt, is_closed: isClosed });
        }
        if (weeklyHours.length !== 7) { setBookingRulesMessage('The weekly schedule must include all seven days.', true); return; }

        const accepted = await window.InigoOwnerUI?.confirm({
            title: 'Save Working Time Schedule?',
            message: `Apply these opening hours and a ${graceMinutes}-minute no-show grace period from ${effectiveFrom}?`,
            confirmLabel: 'Save schedule',
        });
        if (!accepted) return;

        bookingRulesSave.disabled = true;
        setBookingRulesMessage('Saving rules and checking existing reservations…');
        try {
            const { error } = await window.sb.rpc('owner_save_booking_rules', {
                p_weekly_hours: weeklyHours,
                p_grace_minutes: graceMinutes,
                p_effective_from: effectiveFrom,
            });
            if (error) throw error;
            setBookingRulesMessage('Working Time Schedule saved. The shared availability schedule will use it from the effective date.');
            window.InigoToast?.show('Working Time Schedule saved.');
            setBookingRulesEditing(false);
            bookingRulesEdit?.focus();
        } catch (error) {
            console.error('[admin] booking rules could not be saved', error);
            setBookingRulesMessage(error.message || 'Booking rules could not be saved. Check for conflicts with existing reservations.', true);
        } finally {
            bookingRulesSave.disabled = false;
        }
    });

    // Announcements are server-authored and audience-scoped. A blank publish
    // time means publish now; an explicit datetime is interpreted as Manila
    // wall time before the server validates and schedules it.
    const announcementForm = document.querySelector('[data-owner-announcement-form]');
    const announcementList = document.querySelector('[data-owner-announcement-list]');
    const announcementMessage = document.querySelector('[data-owner-announcement-message]');
    const announcementSubmit = document.querySelector('[data-owner-announcement-submit]');
    const announcementPages = document.querySelector('[data-owner-announcement-pages]');
    const announcementPageLabel = document.querySelector('[data-owner-announcement-page]');
    const ANNOUNCEMENT_PAGE_SIZE = 10;
    let announcementPage = 0;
    let announcementCount = 0;
    let announcementGeneration = 0;
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

    async function loadOwnerAnnouncements() {
        if (!window.sb || !announcementList) return;
        const generation = ++announcementGeneration;
        announcementList.innerHTML = '<p class="admin-form-hint">Loading announcements…</p>';
        try {
            const { data, error } = await window.sb.rpc('owner_list_announcements', {
                p_offset: announcementPage * ANNOUNCEMENT_PAGE_SIZE,
                p_limit: ANNOUNCEMENT_PAGE_SIZE,
            });
            if (generation !== announcementGeneration) return;
            if (error) throw error;
            const result = Array.isArray(data) ? data[0] : data;
            if (!result || !Array.isArray(result.rows)) throw new Error('The announcements response is incomplete.');
            announcementCount = Number(result.total_count) || 0;
            announcementList.innerHTML = result.rows.length ? result.rows.map(item => {
                const publishDate = item.publish_at ? new Date(item.publish_at) : null;
                const publishLabel = publishDate && !Number.isNaN(publishDate.valueOf()) ? formatActivityTime(publishDate.toISOString()) : 'Immediately';
                const status = String(item.status || 'published').replace(/[_-]+/g, ' ');
                return `<article class="owner-announcement-row"><div class="owner-announcement-row-head"><h5>${window.escapeHtml(item.title || 'Announcement')}</h5><span class="owner-announcement-status">${window.escapeHtml(status)}</span></div><p>${window.escapeHtml(item.body || '')}</p><div class="owner-announcement-row-meta"><span>${window.escapeHtml(audienceLabels[item.audience] || 'Audience')}</span><time datetime="${window.escapeHtml(item.publish_at || item.created_at || '')}">${window.escapeHtml(publishLabel)}</time></div></article>`;
            }).join('') : '<p class="admin-form-hint">No announcements have been published or scheduled.</p>';
            if (announcementPages) announcementPages.hidden = announcementCount <= ANNOUNCEMENT_PAGE_SIZE;
            if (announcementPageLabel) announcementPageLabel.textContent = `Page ${announcementPage + 1} of ${Math.max(1, Math.ceil(announcementCount / ANNOUNCEMENT_PAGE_SIZE))}`;
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

    announcementForm?.addEventListener('submit', async event => {
        event.preventDefault();
        if (!window.sb || !announcementSubmit) return;
        const title = document.querySelector('[data-owner-announcement-title]')?.value.trim() || '';
        const body = document.querySelector('[data-owner-announcement-body]')?.value.trim() || '';
        const audience = document.querySelector('[data-owner-announcement-audience]')?.value || '';
        const publishInput = document.querySelector('[data-owner-announcement-publish-at]')?.value || '';
        const publishAt = localManilaDateTimeToIso(publishInput);
        if (!title || !body || !['customers', 'staff', 'both'].includes(audience)) { setAnnouncementMessage('Enter a title, message, and valid audience.', true); return; }
        if (publishInput && !publishAt) { setAnnouncementMessage('Choose a valid publication time.', true); return; }
        announcementSubmit.disabled = true;
        announcementSubmit.textContent = 'Publishing…';
        setAnnouncementMessage(publishAt ? 'Scheduling announcement…' : 'Publishing announcement…');
        try {
            const { error } = await window.sb.rpc('owner_publish_announcement', {
                p_title: title,
                p_body: body,
                p_audience: audience,
                p_publish_at: publishAt,
            });
            if (error) throw error;
            announcementForm.reset();
            announcementPage = 0;
            setAnnouncementMessage(publishAt ? 'Announcement scheduled.' : 'Announcement published.');
            window.InigoToast?.show(publishAt ? 'Announcement scheduled.' : 'Announcement published.');
            await loadOwnerAnnouncements();
        } catch (error) {
            console.error('[admin] announcement could not be published', error);
            setAnnouncementMessage(error.message || 'The announcement could not be published. Try again.', true);
        } finally {
            announcementSubmit.disabled = false;
            announcementSubmit.textContent = 'Publish announcement';
        }
    });
    document.querySelector('[data-owner-announcement-refresh]')?.addEventListener('click', () => loadOwnerAnnouncements());
    document.querySelector('[data-owner-announcement-prev]')?.addEventListener('click', () => { if (announcementPage > 0) { announcementPage -= 1; loadOwnerAnnouncements(); } });
    document.querySelector('[data-owner-announcement-next]')?.addEventListener('click', () => { if ((announcementPage + 1) * ANNOUNCEMENT_PAGE_SIZE < announcementCount) { announcementPage += 1; loadOwnerAnnouncements(); } });

    // Owner activity: a compact bell list and a paginated detail page.
    const adminNotif = document.querySelector('[data-admin-notif]');
    const adminNotifTrigger = document.querySelector('[data-admin-notif-trigger]');
    const adminNotifMenu = document.querySelector('[data-admin-notif-menu]');
    const adminNotifList = document.querySelector('[data-admin-notif-list]');
    const adminNotifDot = document.querySelector('[data-admin-notif-dot]');
    const adminNotifMarkAll = document.querySelector('[data-admin-notif-mark-all]');
    const adminNotifSelection = document.querySelector('[data-admin-notif-selection]');
    const adminNotifSearch = document.querySelector('[data-admin-notif-search]');
    const adminNotifPagination = document.querySelector('[data-admin-notif-pagination]');
    const adminNotifPages = document.querySelector('[data-admin-notif-pages]');
    const OWNER_NOTIF_PAGE_SIZE = 8;
    const notificationDetail = document.querySelector('[data-owner-notification-detail]');
    const notificationDetailBody = document.querySelector('[data-owner-notification-detail-body]');
    const notificationModal = document.querySelector('[data-owner-notification-modal]');
    let selectedNotificationId = null;
    const auditPanel = document.querySelector('[data-admin-panel="audit"]');
    const auditRows = document.querySelector('[data-owner-audit-rows]');
    const auditStatus = document.querySelector('[data-owner-audit-status]');
    const auditSearch = document.querySelector('[data-owner-audit-search]');
    const auditFrom = document.querySelector('[data-owner-audit-from]');
    const auditTo = document.querySelector('[data-owner-audit-to]');
    const auditCategory = document.querySelector('[data-owner-audit-category]');
    const auditActor = document.querySelector('[data-owner-audit-actor]');
    const auditRole = document.querySelector('[data-owner-audit-role]');
    const auditPagination = document.querySelector('[data-owner-audit-pagination]');
    const auditPageInfo = document.querySelector('[data-owner-audit-page-info]');
    const auditPrev = document.querySelector('[data-owner-audit-prev]');
    const auditNext = document.querySelector('[data-owner-audit-next]');
    const AUDIT_PAGE_SIZE = 25;
    let auditPage = 0;
    let auditGeneration = 0;
    let auditSearchTimer = null;
    const formatActivityTime = value => new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });

    function auditDateBoundaryIso(value, addDay = false) {
        if (!value) return null;
        const date = new Date(`${value}T00:00:00+08:00`);
        if (Number.isNaN(date.valueOf())) return null;
        if (addDay) date.setUTCDate(date.getUTCDate() + 1);
        return date.toISOString();
    }

    function auditCategoryLabel(value) {
        return ({ account: 'Account', booking: 'Booking', payment: 'Payment', staff: 'Staff', owner: 'Owner activity' })[value] || 'Activity';
    }

    function auditRoleLabel(value) {
        return ({ admin: 'Owner', staff: 'Staff', customer: 'Customer', system: 'System' })[value] || 'System';
    }

    function renderAuditTrailRows(rows) {
        if (!auditRows) return;
        auditRows.innerHTML = rows.length ? rows.map(item => {
            const amount = item.amount !== null && item.amount !== undefined && Number.isFinite(Number(item.amount))
                ? `₱${Number(item.amount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
            const record = item.target_type || item.target_id ? `${item.target_type || 'Record'}${item.target_id ? ` #${item.target_id}` : ''}` : '—';
            const cellValue = value => {
                const text = String(value ?? '—');
                const escaped = window.escapeHtml(text);
                return `<span class="owner-audit-cell-value" title="${escaped}">${escaped}</span>`;
            };
            const eventId = String(item.event_id || '—');
            const eventLabel = humanizeStaffAction(item.action);
            const actorName = item.actor_name || 'Deleted account';
            const category = auditCategoryLabel(item.category);
            const role = auditRoleLabel(item.actor_role);
            const timeLabel = formatActivityTime(item.created_at);
            return `<tr>
                <td><time datetime="${window.escapeHtml(item.created_at || '')}" class="owner-audit-cell-value" title="${window.escapeHtml(timeLabel)}">${window.escapeHtml(timeLabel)}</time></td>
                <td><code class="owner-audit-cell-value" title="${window.escapeHtml(eventId)}">${window.escapeHtml(eventId)}</code></td>
                <td>${cellValue(eventLabel)}</td>
                <td>${cellValue(category)}</td>
                <td>${cellValue(actorName)}</td>
                <td>${cellValue(role)}</td>
                <td>${cellValue(record)}</td>
                <td>${cellValue(amount)}</td>
                <td>${cellValue(item.summary || '—')}</td>
            </tr>`;
        }).join('') : '<tr><td colspan="9">No events match these filters.</td></tr>';
    }

    async function loadAuditTrail() {
        if (!window.sb || !auditRows) return;
        const generation = ++auditGeneration;
        auditRows.setAttribute('aria-busy', 'true');
        if (auditStatus) auditStatus.textContent = 'Loading audit trail…';
        if (auditPagination) auditPagination.hidden = true;
        try {
            const { data, error } = await window.sb.rpc('owner_audit_trail', {
                p_search: auditSearch?.value.trim() || '',
                p_from: auditDateBoundaryIso(auditFrom?.value),
                p_to: auditDateBoundaryIso(auditTo?.value, true),
                p_category: auditCategory?.value || 'all',
                p_actor_id: auditActor?.value && auditActor.value !== 'all' ? auditActor.value : null,
                p_actor_role: auditRole?.value || 'all',
                p_offset: auditPage * AUDIT_PAGE_SIZE,
                p_limit: AUDIT_PAGE_SIZE,
            });
            if (generation !== auditGeneration) return;
            if (error) throw error;
            const actors = Array.isArray(data?.actors) ? data.actors : [];
            const selectedActor = auditActor?.value || 'all';
            if (auditActor) {
                const selectedActorLabel = auditActor.selectedOptions[0]?.textContent || 'Staff member · Staff';
                auditActor.innerHTML = '<option value="all">All actors</option>' + actors.map(actor =>
                    `<option value="${window.escapeHtml(actor.id)}">${window.escapeHtml(actor.name)} · ${window.escapeHtml(auditRoleLabel(actor.role))}</option>`
                ).join('');
                if (actors.some(actor => actor.id === selectedActor)) auditActor.value = selectedActor;
                else if (selectedActor !== 'all') {
                    const option = document.createElement('option');
                    option.value = selectedActor;
                    option.textContent = selectedActorLabel;
                    auditActor.append(option);
                    auditActor.value = selectedActor;
                } else auditActor.value = 'all';
            }
            const rows = Array.isArray(data?.rows) ? data.rows : [];
            const total = Math.max(0, Number(data?.total_count) || 0);
            renderAuditTrailRows(rows);
            const pageCount = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
            if (auditStatus) auditStatus.textContent = `${total.toLocaleString()} ${total === 1 ? 'event' : 'events'} recorded`;
            if (auditPagination) auditPagination.hidden = total <= AUDIT_PAGE_SIZE;
            if (auditPageInfo) auditPageInfo.textContent = `Page ${auditPage + 1} of ${pageCount}`;
            if (auditPrev) auditPrev.disabled = auditPage <= 0;
            if (auditNext) auditNext.disabled = auditPage + 1 >= pageCount;
        } catch (error) {
            if (generation !== auditGeneration) return;
            console.error('[admin] audit trail could not be loaded', error);
            if (auditStatus) auditStatus.textContent = 'Audit trail could not be loaded. Try refreshing.';
            if (auditRows) auditRows.innerHTML = '<tr><td colspan="9">Audit trail could not be loaded.</td></tr>';
        } finally {
            if (generation === auditGeneration) auditRows.setAttribute('aria-busy', 'false');
        }
    }

    const resetAuditPage = () => { auditPage = 0; loadAuditTrail(); };
    auditSearch?.addEventListener('input', () => {
        auditPage = 0;
        window.clearTimeout(auditSearchTimer);
        auditSearchTimer = window.setTimeout(loadAuditTrail, 250);
    });
    [auditFrom, auditTo, auditCategory, auditActor, auditRole].forEach(input => input?.addEventListener('change', resetAuditPage));
    document.querySelector('[data-owner-audit-refresh]')?.addEventListener('click', loadAuditTrail);
    auditPrev?.addEventListener('click', () => { if (auditPage > 0) { auditPage -= 1; loadAuditTrail(); } });
    auditNext?.addEventListener('click', () => { auditPage += 1; loadAuditTrail(); });
    function closeAdminNotifMenu() {
        adminNotif?.removeAttribute('data-open');
        adminNotifTrigger?.setAttribute('aria-expanded', 'false');
    }
    function positionAdminNotifMenu() {
        if (!adminNotifTrigger) return;
        const triggerRect = adminNotifTrigger.getBoundingClientRect();
        adminNotif?.style.setProperty('--admin-notif-menu-top', `${Math.max(8, triggerRect.bottom + 10)}px`);
    }
    adminNotifTrigger?.addEventListener('click', event => {
        event.stopPropagation();
        const wasOpen = adminNotif.hasAttribute('data-open');
        closeProfileMenu(); closeAdminNotifMenu();
        if (!wasOpen) { positionAdminNotifMenu(); adminNotif.setAttribute('data-open', ''); adminNotifTrigger.setAttribute('aria-expanded', 'true'); refreshOwnerActivityNotifications(); }
    });
    adminNotifMenu?.addEventListener('click', event => event.stopPropagation());
    window.addEventListener('resize', () => { if (adminNotif?.hasAttribute('data-open')) positionAdminNotifMenu(); });
    document.addEventListener('click', event => { if (!adminNotif?.contains(event.target)) closeAdminNotifMenu(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeAdminNotifMenu(); });
    async function recordOwnerActivity(title, targetSection, detail = '') {
        if (!window.sb || !window.inigosyncProfile?.id) return;
        const { error } = await window.sb.from('owner_activity').insert({
            owner_id: window.inigosyncProfile.id, title, target_section: targetSection,
            detail: detail || ({staff: 'A staff account was updated in Staff Management.', settings: 'The owner updated their account settings.'}[targetSection] || title),
        });
        if (error) console.error('[admin] activity save failed', error);
        else refreshOwnerActivityNotifications();
    }
    window.InigoOwnerUI.recordActivity = recordOwnerActivity;
    let ownerActivityNotifCount = 0;
    let ownerNotifPage = 0;
    let ownerNotifGeneration = 0;
    let ownerNotifSearchTimer = null;
    async function refreshOwnerActivityNotifications() {
        if (!window.sb || !window.inigosyncProfile?.id) return;
        const ownerId = window.inigosyncProfile.id;
        const generation = ++ownerNotifGeneration;
        selectedOwnerActivityIds.clear();
        if (ownerNotifSelect) ownerNotifSelect.value = 'none';
        const search = adminNotifSearch?.value.trim() || '';
        let rowsQuery = window.sb.from('owner_activity').select('id,title,created_at,seen_at', { count: 'exact' })
            .eq('owner_id', ownerId).order('created_at', { ascending: false })
            .range(ownerNotifPage * OWNER_NOTIF_PAGE_SIZE, (ownerNotifPage + 1) * OWNER_NOTIF_PAGE_SIZE - 1);
        if (search) {
            const escapedSearch = search.replace(/[\\%_"]/g, character => `\\${character}`);
            const quotedPattern = `"%${escapedSearch}%"`;
            rowsQuery = rowsQuery.or(`title.ilike.${quotedPattern},detail.ilike.${quotedPattern}`);
        }
        if (adminNotifList) adminNotifList.setAttribute('aria-busy', 'true');
        const [latest, unread] = await Promise.all([
            rowsQuery,
            window.sb.from('owner_activity').select('id', { count: 'exact', head: true }).eq('owner_id', ownerId).is('seen_at', null),
        ]);
        if (generation !== ownerNotifGeneration) return;
        if (latest.error) {
            if (adminNotifList) adminNotifList.innerHTML = '<p class="admin-notif-empty">Notifications could not be loaded.</p>';
            if (adminNotifPagination) adminNotifPagination.hidden = true;
            if (adminNotifList) adminNotifList.setAttribute('aria-busy', 'false');
            return;
        }
        ownerActivityNotifRows = latest.data || [];
        ownerActivityNotifCount = Math.max(0, Number(latest.count) || 0);
        if (adminNotifList) adminNotifList.innerHTML = ownerActivityNotifRows.length ? ownerActivityNotifRows.map(item => `<div class="admin-notif-item${item.seen_at ? ' is-seen' : ' is-unseen'}" data-owner-activity-id="${window.escapeHtml(item.id)}"><input type="checkbox" class="admin-notif-select-row" data-owner-notif-select-row="${window.escapeHtml(item.id)}" aria-label="Select ${window.escapeHtml(item.title)}"><button type="button" class="admin-notif-open" data-owner-activity-open><span class="admin-notif-dot pending" aria-hidden="true"></span><span class="admin-notif-item-body"><strong>${window.escapeHtml(item.title)}</strong><span>${window.escapeHtml(formatActivityTime(item.created_at))} · ${item.seen_at ? 'Read' : 'Unread'}</span></span></button></div>`).join('') : `<p class="admin-notif-empty">${search ? 'No notifications match your search.' : 'No owner activity yet.'}</p>`;
        if (adminNotifList) adminNotifList.scrollTop = 0;
        const pageCount = Math.max(1, Math.ceil(ownerActivityNotifCount / OWNER_NOTIF_PAGE_SIZE));
        if (adminNotifPagination) adminNotifPagination.hidden = ownerActivityNotifCount <= OWNER_NOTIF_PAGE_SIZE;
        if (adminNotifPages) {
            const pageIndexes = pageCount <= 7
                ? Array.from({ length: pageCount }, (_, index) => index)
                : [...new Set([0, ownerNotifPage - 1, ownerNotifPage, ownerNotifPage + 1, pageCount - 1].filter(page => page >= 0 && page < pageCount))].sort((a, b) => a - b);
            let previousPage = -1;
            adminNotifPages.innerHTML = pageIndexes.map(page => {
                const gap = page - previousPage > 1 ? '<span aria-hidden="true">…</span>' : '';
                previousPage = page;
                return `${gap}<button type="button" data-owner-notif-page="${page}" aria-label="Page ${page + 1}"${page === ownerNotifPage ? ' aria-current="page"' : ''}>${page + 1}</button>`;
            }).join('');
        }
        const prev = document.querySelector('[data-admin-notif-prev]');
        const next = document.querySelector('[data-admin-notif-next]');
        if (prev) prev.disabled = ownerNotifPage <= 0;
        if (next) next.disabled = ownerNotifPage + 1 >= pageCount;
        syncOwnerNotificationSelection();
        if (!unread.error) {
            if (adminNotifDot) adminNotifDot.hidden = !unread.count;
        }
        if (adminNotifList) adminNotifList.setAttribute('aria-busy', 'false');
    }
    async function openNotification(id) {
        selectedNotificationId = id;
        setActivePanel('audit');
        if (notificationDetailBody) notificationDetailBody.innerHTML = '<p class="admin-form-hint">Loading notification…</p>';
        window.InigoOwnerUI.open(notificationModal);
        const { data, error } = await window.sb.from('owner_activity').select('id,title,detail,target_section,created_at,seen_at').eq('id', id).eq('owner_id', window.inigosyncProfile.id).single();
        if (selectedNotificationId !== id) return;
        if (error) { if (notificationDetailBody) notificationDetailBody.innerHTML = '<p class="admin-form-hint">This notification could not be loaded.</p>'; return; }
        const seenResult = data.seen_at ? { error: null } : await window.sb.from('owner_activity').update({ seen_at: new Date().toISOString() }).eq('id', id).eq('owner_id', window.inigosyncProfile.id);
        if (notificationDetailBody) notificationDetailBody.innerHTML = `<h3 id="ownerNotificationDetailTitle">${window.escapeHtml(data.title)}</h3><time datetime="${window.escapeHtml(data.created_at)}">${window.escapeHtml(formatActivityTime(data.created_at))} · ${seenResult.error ? 'Unread' : 'Read'}</time><p>${window.escapeHtml(data.detail || 'This earlier notification contains only the activity title and date.')}</p><button type="button" class="admin-btn-secondary" data-notification-go>Open ${window.escapeHtml(panelMeta[data.target_section]?.title || 'Overview')}</button>`;
        notificationDetailBody?.querySelector('[data-notification-go]')?.addEventListener('click', () => {
            window.InigoOwnerUI.close(notificationModal);
            const target = data.target_section === 'notifications' ? 'audit' : data.target_section;
            setActivePanel(panelMeta[target] ? target : 'audit');
        });
        refreshOwnerActivityNotifications();
    }
    const selectedOwnerActivityIds = new Set();
    let ownerActivityNotifRows = [];
    const ownerNotifSelect = document.querySelector('[data-admin-notif-select]');
    const ownerNotifSelectedLabel = document.querySelector('[data-admin-notif-selected]');
    const ownerNotifMarkSelected = document.querySelector('[data-admin-notif-mark-selected]');
    function syncOwnerNotificationSelection() {
        const selecting = adminNotif?.hasAttribute('data-selecting');
        if (adminNotifSelection) adminNotifSelection.hidden = !selecting;
        if (ownerNotifMarkSelected) ownerNotifMarkSelected.hidden = !selecting;
        adminNotifMarkAll?.setAttribute('aria-expanded', String(Boolean(selecting)));
        adminNotifList?.querySelectorAll('[data-owner-notif-select-row]').forEach(checkbox => {
            checkbox.checked = selectedOwnerActivityIds.has(checkbox.dataset.ownerNotifSelectRow);
            checkbox.closest('.admin-notif-item')?.classList.toggle('is-selected', checkbox.checked);
        });
        if (ownerNotifSelectedLabel) ownerNotifSelectedLabel.textContent = `${selectedOwnerActivityIds.size} selected`;
        if (ownerNotifMarkSelected) ownerNotifMarkSelected.disabled = selectedOwnerActivityIds.size === 0;
    }
    adminNotifList?.addEventListener('change', event => {
        const checkbox = event.target.closest('[data-owner-notif-select-row]');
        if (!checkbox) return;
        event.stopPropagation();
        if (checkbox.checked) selectedOwnerActivityIds.add(checkbox.dataset.ownerNotifSelectRow);
        else selectedOwnerActivityIds.delete(checkbox.dataset.ownerNotifSelectRow);
        syncOwnerNotificationSelection();
    });
    adminNotifList?.addEventListener('click', event => {
        routeOwnerActivityOpen(event.target, id => openNotification(id).catch(() => window.InigoToast?.show('Could not open notification.', true)));
    });
    document.querySelectorAll('[data-owner-notification-close]').forEach(button => button.addEventListener('click', () => window.InigoOwnerUI.close(notificationModal)));
    let notificationBackdropPressed = false;
    notificationModal?.addEventListener('pointerdown', event => { notificationBackdropPressed = event.target === notificationModal; });
    notificationModal?.addEventListener('click', event => {
        if (event.target === notificationModal && notificationBackdropPressed) window.InigoOwnerUI.close(notificationModal);
        notificationBackdropPressed = false;
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && notificationModal && !notificationModal.hidden) window.InigoOwnerUI.close(notificationModal); });
    ownerNotifSelect?.addEventListener('change', () => {
        selectedOwnerActivityIds.clear();
        const mode = ownerNotifSelect.value;
        ownerActivityNotifRows.filter(item => mode === 'all' || (mode === 'read' && item.seen_at) || (mode === 'unread' && !item.seen_at))
            .forEach(item => selectedOwnerActivityIds.add(String(item.id)));
        syncOwnerNotificationSelection();
    });
    ownerNotifMarkSelected?.addEventListener('click', async () => {
        const ids = [...selectedOwnerActivityIds];
        if (!ids.length || !window.sb || !window.inigosyncProfile?.id) return;
        ownerNotifMarkSelected.disabled = true;
        try {
            const { error } = await window.sb.from('owner_activity').update({ seen_at: new Date().toISOString() })
                .in('id', ids).eq('owner_id', window.inigosyncProfile.id).is('seen_at', null);
            if (error) throw error;
            await refreshOwnerActivityNotifications();
        } catch (error) {
            console.error('[admin] selected notifications could not be marked read', error);
            window.InigoToast?.show(error.message || 'Could not mark selected notifications as read.', true);
            await refreshOwnerActivityNotifications();
        } finally {
            ownerNotifMarkSelected.disabled = selectedOwnerActivityIds.size === 0;
        }
    });
    adminNotifMarkAll?.addEventListener('click', () => {
        if (adminNotif?.hasAttribute('data-selecting')) {
            adminNotif.removeAttribute('data-selecting');
            selectedOwnerActivityIds.clear();
            if (ownerNotifSelect) ownerNotifSelect.value = 'none';
        } else adminNotif?.setAttribute('data-selecting', '');
        syncOwnerNotificationSelection();
    });
    adminNotifSearch?.addEventListener('input', () => {
        window.clearTimeout(ownerNotifSearchTimer);
        ownerNotifPage = 0;
        selectedOwnerActivityIds.clear();
        if (ownerNotifSelect) ownerNotifSelect.value = 'none';
        syncOwnerNotificationSelection();
        ownerNotifSearchTimer = window.setTimeout(() => refreshOwnerActivityNotifications(), 220);
    });
    document.querySelector('[data-admin-notif-prev]')?.addEventListener('click', () => {
        if (ownerNotifPage > 0) { ownerNotifPage -= 1; refreshOwnerActivityNotifications(); }
    });
    document.querySelector('[data-admin-notif-next]')?.addEventListener('click', () => {
        if ((ownerNotifPage + 1) * OWNER_NOTIF_PAGE_SIZE < ownerActivityNotifCount) {
            ownerNotifPage += 1;
            refreshOwnerActivityNotifications();
        }
    });
    adminNotifPages?.addEventListener('click', event => {
        const button = event.target.closest('[data-owner-notif-page]');
        if (!button) return;
        const page = Number(button.dataset.ownerNotifPage);
        if (Number.isInteger(page) && page >= 0 && page < Math.ceil(ownerActivityNotifCount / OWNER_NOTIF_PAGE_SIZE) && page !== ownerNotifPage) {
            ownerNotifPage = page;
            refreshOwnerActivityNotifications();
        }
    });
    document.addEventListener('inigosync:profile-ready', refreshOwnerActivityNotifications);
    window.setInterval(() => { if (!document.hidden) refreshOwnerActivityNotifications(); }, 15000);
    refreshOwnerActivityNotifications();

    // ------------------------------------------------------------------
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
    // The owner gets a crop preview before a square JPEG data URL is staged
    // in profiles.avatar_url. Cancelling the crop leaves the current draft
    // untouched; only Save writes the resulting image.
    // ------------------------------------------------------------------
    const AVATAR_MAX_RAW_BYTES = 5 * 1024 * 1024;
    const AVATAR_OUTPUT_SIZE = 256;
    const AVATAR_JPEG_QUALITY = 0.82;

    const adminAvatarFileInput = document.querySelector('[data-admin-avatar-file]');
    const adminAvatarUploadBtn = document.querySelector('[data-admin-avatar-upload-trigger]');
    const adminAvatarRemoveBtn = document.querySelector('[data-admin-avatar-remove]');
    const adminAvatarSaveBtn = document.querySelector('[data-admin-avatar-save]');
    const adminAvatarModal = document.querySelector('[data-admin-avatar-modal]');
    let stagedAvatarUrl;

    document.querySelector('[data-admin-profile-edit]')?.addEventListener('click', () => {
        paintOwnerDetails(window.inigosyncProfile || {});
        const modal = document.querySelector('[data-admin-settings-profile-modal]');
        window.InigoOwnerUI.open(modal);
        refreshLinkedGoogleEmails();
    });
    document.querySelector('[data-admin-avatar-edit]')?.addEventListener('click', () => {
        stagedAvatarUrl = window.inigosyncProfile?.avatar_url || null;
        renderAdminProfile(window.inigosyncProfile || {});
        if (adminAvatarRemoveBtn) adminAvatarRemoveBtn.hidden = !stagedAvatarUrl;
        window.InigoOwnerUI.open(adminAvatarModal);
    });
    document.querySelectorAll('[data-admin-settings-cancel="profile"], [data-admin-avatar-cancel]').forEach((button) => {
        button.addEventListener('click', () => {
            const modal = button.closest('.admin-modal-overlay');
            window.InigoOwnerUI.close(modal);
            if (button.hasAttribute('data-admin-avatar-cancel')) renderAdminProfile(window.inigosyncProfile || {});
        });
    });

    const accountModals = [adminAvatarModal, document.querySelector('[data-admin-settings-profile-modal]')].filter(Boolean);
    accountModals.forEach(modal => {
        let backdropStart = false;
        modal.addEventListener('pointerdown', event => { backdropStart = event.target === modal; });
        modal.addEventListener('click', event => { if (backdropStart && event.target === modal) modal.querySelector('[data-admin-avatar-cancel], [data-admin-settings-cancel="profile"]')?.click(); backdropStart = false; });
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') accountModals.find(modal => !modal.hidden)?.querySelector('[data-admin-avatar-cancel], [data-admin-settings-cancel="profile"]')?.click();
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
            if (file.size > AVATAR_MAX_RAW_BYTES) {
                window.InigoToast?.show('That image is too large — please choose one under 5 MB.', true);
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
                stagedAvatarUrl = dataUrl;
                const preview = adminAvatarModal?.querySelector('.admin-avatar-upload-preview');
                if (preview) preview.innerHTML = `<img class="admin-avatar-img" src="${window.escapeHtml(dataUrl)}" alt="Profile photo preview">`;
                if (adminAvatarRemoveBtn) adminAvatarRemoveBtn.hidden = false;
            } catch (err) {
                console.error('[admin] avatar crop failed', err);
                window.InigoToast?.show('Could not process that image. Please try a different file.', true);
            } finally {
                adminAvatarUploadBtn.disabled = false;
                adminAvatarUploadBtn.textContent = originalLabel;
            }
        });
    }

    adminAvatarRemoveBtn?.addEventListener('click', () => {
        stagedAvatarUrl = null;
        const preview = adminAvatarModal?.querySelector('.admin-avatar-upload-preview');
        if (preview) preview.textContent = (window.inigosyncProfile?.full_name || 'Owner').split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
        adminAvatarRemoveBtn.hidden = true;
    });
    adminAvatarSaveBtn?.addEventListener('click', async () => {
        adminAvatarSaveBtn.disabled = true;
        const ok = await saveAdminAvatarUrl(stagedAvatarUrl);
        adminAvatarSaveBtn.disabled = false;
        if (ok) {
            window.InigoOwnerUI.close(adminAvatarModal);
            window.InigoToast?.show(stagedAvatarUrl ? 'Profile photo updated.' : 'Profile photo removed.');
        }
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
    function renderAdminProfile(profile) {
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
        if (nameInput) nameInput.value = profile.full_name || '';
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

    function paintOwnerDetails(profile) {
        const savedMobile = window.validatePhMobile?.(profile.contact_num || '');
        const fields = [
            ['[data-admin-settings-mobile]', savedMobile?.valid ? savedMobile.normalized : (profile.contact_num || '')],
            ['[data-admin-settings-address]', profile.address || ''],
            ['[data-admin-settings-birthdate]', profile.birthdate || ''],
            ['[data-admin-settings-gender]', profile.gender || ''],
        ];
        fields.forEach(([selector, value]) => {
            const field = document.querySelector(selector);
            if (field) field.value = value;
        });
        const values = [
            ['[data-admin-profile-address]', profile.address || '—'],
            ['[data-admin-profile-age]', computeAdminStaffAge(profile.birthdate) === null ? '—' : `${computeAdminStaffAge(profile.birthdate)} years old`],
            ['[data-admin-profile-gender]', profile.gender || '—'],
            ['[data-admin-profile-birthdate]', profile.birthdate || '—'],
        ];
        values.forEach(([selector, value]) => {
            const target = document.querySelector(selector);
            if (target) target.textContent = value;
        });
        if (ownerMobileMessage) {
            ownerMobileMessage.textContent = !profile.contact_num
                ? 'A contact number is optional. We check Philippine format, mobile type, active status, and whether another account uses it. This does not confirm ownership.'
                : profile.contact_num_validated
                    ? `Validated as an active Philippine mobile number${formatOwnerPhoneValidationDate(profile.contact_num_validated_at)}. Ownership and use by other accounts are not confirmed.`
                    : 'This saved number has not been validated for format, mobile type, and active status.';
            ownerMobileMessage.classList.remove('is-error');
        }
        const removeMobileBtn = document.querySelector('[data-admin-mobile-remove]');
        if (removeMobileBtn) removeMobileBtn.hidden = !profile.contact_num;
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
            ownerDetailsLoaded = true;
            paintOwnerDetails(window.inigosyncProfile);
            renderAdminProfile(window.inigosyncProfile);
        }
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

    const adminProfileSaveBtn = document.querySelector('[data-admin-settings-save="profile"]');
    const ownerMobileValidateBtn = document.querySelector('[data-admin-mobile-validate]');
    const ownerMobileRemoveBtn = document.querySelector('[data-admin-mobile-remove]');
    const ownerMobileMessage = document.querySelector('[data-admin-mobile-message]');
    const ownerMobileInput = document.querySelector('[data-admin-settings-mobile]');
    let ownerMobileCheckTimer = null;
    let ownerMobileRequestId = 0;
    let ownerMobileCheckedNumber = '';
    let ownerMobileCheckPassed = false;
    let ownerMobileCheckedAt = 0;
    const OWNER_PHONE_PROOF_MAX_AGE_MS = 4 * 60 * 1000;
    const ownerMobileRecentChecks = new Map();

    function setOwnerMobileMessage(message, isError = false) {
        if (!ownerMobileMessage) return;
        ownerMobileMessage.textContent = message;
        ownerMobileMessage.classList.toggle('is-error', isError);
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
        return reason === 'not_mobile' ? 'This is not classified as a Philippine mobile number.'
            : reason === 'in_use' ? 'This number is already in use by another account.'
            : reason === 'inactive' ? 'The provider reports that this number is not active.'
                : reason === 'status_unknown' ? 'The provider could not confirm the number status. Try again later.'
                    : 'Enter a valid Philippine mobile number.';
    }

    function ownerMobileInputMatches(normalized) {
        const current = window.validatePhMobile?.(ownerMobileInput?.value || '');
        return current?.valid === true && current.normalized === normalized;
    }

    async function checkOwnerMobile(normalized, requestId) {
        if (!window.sb || !window.inigosyncProfile) return;
        const currentCheck = window.validatePhMobile?.(window.inigosyncProfile.contact_num || '');
        if (currentCheck?.valid && normalized === currentCheck.normalized && window.inigosyncProfile.contact_num_validated) {
            ownerMobileCheckedNumber = normalized;
            ownerMobileCheckPassed = true;
            ownerMobileCheckedAt = Date.now();
            ownerMobileValidateBtn.disabled = true;
            setOwnerMobileMessage(`Already validated as an active Philippine mobile number${formatOwnerPhoneValidationDate(window.inigosyncProfile.contact_num_validated_at)}. Use by other accounts was not checked again.`);
            return;
        }
        setOwnerMobileMessage('Checking mobile type and active status…');
        try {
            const { data, error } = await window.sb.functions.invoke('validate-contact-phone', { body: { phone: normalized } });
            if (requestId !== ownerMobileRequestId || !ownerMobileInputMatches(normalized)) return;
            if (error) throw new Error(await ownerPhoneFunctionError(error));
            if (data?.valid !== true) {
                throw new Error(ownerPhoneFailureMessage(data?.reason));
            }
            if (data.phone_type !== 'mobile' || !/^\+639\d{9}$/.test(data.normalized || '')
                || data.normalized !== `+63${normalized.slice(1)}` || data.line_status !== 'active') {
                throw new Error('The provider returned an unsupported validation result. Try again later.');
            }
            ownerMobileCheckedNumber = normalized;
            ownerMobileCheckPassed = true;
            ownerMobileCheckedAt = Date.now();
            ownerMobileRecentChecks.set(normalized, ownerMobileCheckedAt);
            ownerMobileValidateBtn.disabled = currentCheck?.valid && normalized === currentCheck.normalized
                && window.inigosyncProfile.contact_num_validated === true;
            setOwnerMobileMessage('Available for this account and classified as an active Philippine mobile number. Save number to add it to your profile. This does not confirm ownership or guarantee reachability.');
        } catch (error) {
            if (requestId !== ownerMobileRequestId || !ownerMobileInputMatches(normalized)) return;
            ownerMobileCheckPassed = false;
            ownerMobileValidateBtn.disabled = true;
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
        ownerMobileValidateBtn.disabled = true;
        const raw = ownerMobileInput.value.trim();
        if (!raw) {
            setOwnerMobileMessage('A contact number is optional. Format, mobile type, active status, and use by another account are checked automatically. This does not confirm ownership or guarantee reachability.');
            return;
        }
        const localCheck = window.validatePhMobile?.(raw);
        if (!localCheck?.valid) {
            setOwnerMobileMessage('Enter a Philippine mobile number, such as 09171234567 or +639171234567.');
            return;
        }
        const savedCheck = window.validatePhMobile?.(window.inigosyncProfile?.contact_num || '');
        if (savedCheck?.valid && savedCheck.normalized === localCheck.normalized && window.inigosyncProfile?.contact_num_validated) {
            ownerMobileCheckedNumber = localCheck.normalized;
            ownerMobileCheckPassed = true;
            ownerMobileCheckedAt = Date.now();
            setOwnerMobileMessage(`Already validated as an active Philippine mobile number${formatOwnerPhoneValidationDate(window.inigosyncProfile.contact_num_validated_at)}. Use by other accounts was not checked again.`);
            return;
        }
        const recentCheckAt = ownerMobileRecentChecks.get(localCheck.normalized) || 0;
        if (recentCheckAt && Date.now() - recentCheckAt < OWNER_PHONE_PROOF_MAX_AGE_MS) {
            ownerMobileCheckedNumber = localCheck.normalized;
            ownerMobileCheckPassed = true;
            ownerMobileCheckedAt = recentCheckAt;
            ownerMobileValidateBtn.disabled = false;
            setOwnerMobileMessage('Available for this account and classified as an active Philippine mobile number. Save number to add it to your profile. This does not confirm ownership or guarantee reachability.');
            return;
        }
        setOwnerMobileMessage('Valid Philippine mobile format. Checking mobile type and active status…');
        ownerMobileCheckTimer = setTimeout(() => checkOwnerMobile(localCheck.normalized, requestId), 700);
    });

    ownerMobileValidateBtn?.addEventListener('click', async () => {
        if (!window.sb || !window.inigosyncProfile || !ownerMobileInput) return;
        const check = window.validatePhMobile?.(ownerMobileInput.value || '');
        if (!check?.valid || !ownerMobileCheckPassed || ownerMobileCheckedNumber !== check.normalized) {
            setOwnerMobileMessage('Wait for a successful automatic status check before saving this number.', true);
            return;
        }
        if (Date.now() - ownerMobileCheckedAt >= OWNER_PHONE_PROOF_MAX_AGE_MS) {
            ownerMobileCheckPassed = false;
            ownerMobileValidateBtn.disabled = true;
            setOwnerMobileMessage('The status check expired. Checking the number again…');
            checkOwnerMobile(check.normalized, ++ownerMobileRequestId);
            return;
        }
        const currentCheck = window.validatePhMobile?.(window.inigosyncProfile.contact_num || '');
        if (currentCheck?.valid && check.normalized === currentCheck.normalized && window.inigosyncProfile.contact_num_validated) {
            setOwnerMobileMessage('This number is already saved and validated; no provider lookup was used.');
            return;
        }
        ownerMobileValidateBtn.disabled = true;
        try {
            const { error: saveError } = await window.sb.from('profiles')
                .update({ contact_num: `+63${check.normalized.slice(1)}` }).eq('id', window.inigosyncProfile.id);
            if (saveError) throw saveError;
            window.inigosyncProfile.contact_num = `+63${check.normalized.slice(1)}`;
            window.inigosyncProfile.contact_num_validated = true;
            window.inigosyncProfile.contact_num_validated_at = new Date().toISOString();
            renderAdminProfile(window.inigosyncProfile);
            paintOwnerDetails(window.inigosyncProfile);
            recordOwnerActivity('Owner contact number validated', 'settings');
            setOwnerMobileMessage('Saved; available for this account and validated as an active Philippine mobile number. This does not confirm ownership or guarantee reachability.');
            window.InigoToast?.show('Contact number validated and saved.');
        } catch (error) {
            ownerMobileValidateBtn.disabled = false;
            console.error('[admin] contact number save failed', error);
            setOwnerMobileMessage(error.message || 'Could not save the number. Try again.', true);
        }
    });

    ownerMobileRemoveBtn?.addEventListener('click', async () => {
        if (!window.sb || !window.inigosyncProfile || !window.inigosyncProfile.contact_num) return;
        ownerMobileRemoveBtn.disabled = true;
        try {
            const { error } = await window.sb.from('profiles').update({ contact_num: null }).eq('id', window.inigosyncProfile.id);
            if (error) throw error;
            window.inigosyncProfile.contact_num = null;
            window.inigosyncProfile.contact_num_validated = false;
            window.inigosyncProfile.contact_num_validated_at = null;
            const mobileInput = document.querySelector('[data-admin-settings-mobile]');
            if (mobileInput) mobileInput.value = '';
            renderAdminProfile(window.inigosyncProfile);
            paintOwnerDetails(window.inigosyncProfile);
            setOwnerMobileMessage('Contact number removed. You can add one later.');
            window.InigoToast?.show('Contact number removed.');
        } catch (error) {
            setOwnerMobileMessage(error.message || 'Could not remove the contact number.', true);
        } finally { ownerMobileRemoveBtn.disabled = false; }
    });

    if (adminProfileSaveBtn) {
        adminProfileSaveBtn.addEventListener('click', async () => {
            if (!window.sb || !window.inigosyncProfile) return;

            const nameInput = document.querySelector('[data-admin-settings-name]');
            const mobileInput = document.querySelector('[data-admin-settings-mobile]');
            const addressInput = document.querySelector('[data-admin-settings-address]');
            const birthdateInput = document.querySelector('[data-admin-settings-birthdate]');
            const genderInput = document.querySelector('[data-admin-settings-gender]');
            const newName = nameInput ? nameInput.value.trim() : '';
            const mobileRaw = mobileInput ? mobileInput.value.trim() : '';
            const address = addressInput ? addressInput.value.trim() : '';
            const birthdate = birthdateInput?.value || null;
            const gender = genderInput?.value || '';

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
                ownerMobileValidateBtn.disabled = true;
                setOwnerMobileMessage('The status check expired. Checking the number again…');
                checkOwnerMobile(requestedMobile, ++ownerMobileRequestId);
            }
            const nameChanged = newName !== (window.inigosyncProfile.full_name || '');
            const detailsChanged = mobileNeedsRemoval || mobileReadyToSave
                || address !== (window.inigosyncProfile.address || '')
                || birthdate !== (window.inigosyncProfile.birthdate || null)
                || gender !== (window.inigosyncProfile.gender || '');
            if (!nameChanged && !detailsChanged) {
                if (mobileNeedsValidation) {
                    setOwnerMobileMessage('Use Validate & save to check and save the new mobile number.', true);
                    ownerMobileValidateBtn?.focus();
                    return;
                }
                window.InigoToast?.show('Nothing to save.');
                return;
            }

            adminProfileSaveBtn.disabled = true;
            try {
                if (nameChanged || detailsChanged) {
                    const profilePatch = { full_name: newName, address, birthdate, gender };
                    if (mobileNeedsRemoval) profilePatch.contact_num = null;
                    if (mobileReadyToSave) profilePatch.contact_num = `+63${requestedMobile.slice(1)}`;
                    const { error } = await window.sb.from('profiles').update(profilePatch).eq('id', window.inigosyncProfile.id);
                    if (error) throw error;
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

                renderAdminProfile(window.inigosyncProfile);
                paintOwnerDetails(window.inigosyncProfile);
                if (nameChanged || detailsChanged) recordOwnerActivity('Owner profile updated', 'settings');
                if (mobileNeedsValidation) {
                    setOwnerMobileMessage('Other profile details were saved. Wait for the automatic status check before saving the new number.', true);
                    window.InigoToast?.show('Profile details saved. Check the new mobile number before saving it.');
                } else {
                    window.InigoToast?.show('Profile updated.');
                    window.InigoOwnerUI.close(document.querySelector('[data-admin-settings-profile-modal]'));
                }
            } catch (err) {
                window.InigoToast?.show(err.message || 'Could not save your changes.', true);
            } finally {
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
            ? emails.map((email) => `<p class="admin-form-hint">✓ ${window.escapeHtml(email)} · Google verified</p>`).join('')
            : '<p class="admin-form-hint">No additional Google account linked yet.</p>';
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
    const pwStepPanels = document.querySelectorAll('[data-admin-pw-step]');
    const pwStepIndicators = document.querySelectorAll('[data-admin-pw-step-indicator]');
    const pwBackBtn = document.querySelector('[data-admin-pw-back]');
    const pwNextBtn = document.querySelector('[data-admin-pw-next]');
    const adminPasswordSaveBtn = document.querySelector('[data-admin-settings-save="password"]');
    const pwCurrentInput = document.querySelector('[data-admin-pw-current]');
    const pwNewInput = document.querySelector('[data-admin-pw-new]');
    const pwConfirmInput = document.querySelector('[data-admin-pw-confirm]');

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

        if (pwBackBtn) pwBackBtn.hidden = adminPwWizardStep !== 2;
        if (adminPasswordSaveBtn) adminPasswordSaveBtn.hidden = adminPwWizardStep !== 2;
        if (pwNextBtn) {
            pwNextBtn.hidden = adminPwWizardStep !== 1;
            pwNextBtn.disabled = !(pwCurrentInput && pwCurrentInput.value !== '');
        }
    }

    function goToAdminPwStep(step) {
        adminPwWizardStep = step === 2 ? 2 : 1;
        renderAdminPwWizard();
    }

    function resetAdminPwWizard() {
        [pwCurrentInput, pwNewInput, pwConfirmInput].forEach((input) => { if (input) input.value = ''; });
        goToAdminPwStep(1);
    }

    if (pwCurrentInput) pwCurrentInput.addEventListener('input', renderAdminPwWizard);
    if (pwNextBtn) {
        pwNextBtn.addEventListener('click', () => {
            if (pwNextBtn.disabled) return;
            goToAdminPwStep(2);
        });
    }
    if (pwBackBtn) pwBackBtn.addEventListener('click', () => goToAdminPwStep(1));

    // Establishes the correct initial hidden/disabled state for the nav
    // buttons (matching the `disabled`/`hidden` attributes already baked
    // into the markup as a no-JS baseline) and paints the step-1 indicator.
    renderAdminPwWizard();

    if (adminPasswordSaveBtn) {
        adminPasswordSaveBtn.addEventListener('click', async () => {
            if (!window.sb || !window.inigosyncProfile) return;
            const currentPassword = pwCurrentInput?.value;
            const newPassword = pwNewInput?.value;
            const confirmPassword = pwConfirmInput?.value;

            if (!currentPassword) {
                window.InigoToast?.show('Enter your current password.', true);
                goToAdminPwStep(1);
                return;
            }
            if (!newPassword || newPassword.length < ADMIN_PW_MIN_LENGTH) {
                window.InigoToast?.show(`New password must be at least ${ADMIN_PW_MIN_LENGTH} characters.`, true);
                return;
            }
            if (newPassword !== confirmPassword) {
                window.InigoToast?.show('Passwords do not match.', true);
                return;
            }

            adminPasswordSaveBtn.disabled = true;

            // S3 (Revision A1 fix) — re-verify against the AUTH session's
            // OWN current email first, falling back to profiles.email only
            // if no session email is available. profiles.email can lag a
            // just-confirmed email change (see syncConfirmedAdminEmail
            // above, and S2's own note on this same lag) or simply be
            // stale from before this session loaded; signInWithPassword()
            // against a stale address would fail with "Current password is
            // incorrect" even when the password typed is exactly right.
            const { data: pwSessionData } = await window.sb.auth.getSession();
            const verifyEmail = pwSessionData?.session?.user?.email || window.inigosyncProfile.email;

            // "Current password" re-verified via signInWithPassword() before
            // anything changes — Supabase has no separate "verify password"
            // call, and this confirms the person at the keyboard actually
            // knows it before the password is changed.
            const { error: verifyError } = await window.sb.auth.signInWithPassword({
                email: verifyEmail,
                password: currentPassword,
            });

            if (verifyError) {
                adminPasswordSaveBtn.disabled = false;
                window.InigoToast?.show('Current password is incorrect.', true);
                goToAdminPwStep(1);
                return;
            }

            const { error } = await window.sb.auth.updateUser({ password: newPassword });
            adminPasswordSaveBtn.disabled = false;

            if (error) {
                window.InigoToast?.show(error.message || 'Could not update your password.', true);
                return;
            }

            resetAdminPwWizard();
            window.InigoToast?.show('Password updated.');
            recordOwnerActivity('Owner password updated', 'settings');
        });
    }

    // ------------------------------------------------------------------
    // Account Settings — Cancel buttons. Profile discards in-progress edits
    // back to the last-saved values; Password resets the wizard to step 1
    // and clears every field (Revision A1, decision A9 — this button was
    // kept from the pre-wizard markup rather than dropped, since the
    // customer dashboard's own wizard has no exact equivalent to port).
    // ------------------------------------------------------------------
    document.querySelectorAll('[data-admin-settings-cancel]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.adminSettingsCancel;
            if (mode === 'profile') {
                if (window.inigosyncProfile) {
                    renderAdminProfile(window.inigosyncProfile);
                    paintOwnerDetails(window.inigosyncProfile);
                }
            } else if (mode === 'password') {
                resetAdminPwWizard();
            }
        });
    });

    // Owner review inbox reads only the privacy-safe view. Rating filters
    // and paging are server-side so every published booking review is
    // reachable without loading the entire table into the browser.
    const reviewList = document.querySelector('[data-admin-review-list]');
    const reviewSummary = document.querySelector('[data-admin-review-summary]');
    const reviewPager = document.querySelector('[data-admin-review-pagination]');
    let reviewRatingFilter = 'all';
    let reviewPage = 0;
    let reviewRequest = 0;
    const REVIEW_PAGE_SIZE = 10;
    async function loadOwnerReviews() {
        if (!reviewList || !window.sb) return;
        const request = ++reviewRequest;
        reviewList.setAttribute('aria-busy', 'true');
        let query = window.sb.from('public_booking_reviews').select('id,display_name,rating,comment,created_at', { count: 'exact' })
            .order('created_at', { ascending: false }).range(reviewPage * REVIEW_PAGE_SIZE, (reviewPage + 1) * REVIEW_PAGE_SIZE - 1);
        if (reviewRatingFilter !== 'all') query = query.eq('rating', Number(reviewRatingFilter));
        const [{ data, count, error }, summaryResult] = await Promise.all([query, window.sb.rpc('owner_review_summary')]);
        if (request !== reviewRequest) return;
        reviewList.setAttribute('aria-busy', 'false');
        if (error) {
            reviewList.innerHTML = '<p class="admin-form-hint">Reviews could not be loaded. Check your owner access and try again.</p>';
            if (reviewSummary) reviewSummary.textContent = 'Review list unavailable';
            console.error('[admin] owner reviews query failed', error);
            return;
        }
        const total = count || 0;
        if (reviewSummary) {
            const summary = Array.isArray(summaryResult.data) ? summaryResult.data[0] : summaryResult.data;
            if (summaryResult.error || !summary) reviewSummary.textContent = 'Overall rating unavailable';
            else {
                const count = Number(summary.total_count || 0);
                reviewSummary.classList.add('owner-review-summary');
            const score = count ? Number(summary.average_rating).toFixed(1) : '—';
            const roundedStars = count ? Math.max(0, Math.min(5, Math.round(Number(summary.average_rating)))) : 0;
            reviewSummary.innerHTML = `<strong class="owner-review-score">${score} / 5.0</strong>${count ? `<span class="owner-review-average-stars" aria-label="${roundedStars} out of 5 stars">${'★'.repeat(roundedStars)}${'☆'.repeat(5 - roundedStars)}</span>` : ''}`;
            }
        }
        reviewList.innerHTML = data?.length ? data.map((review) => `<article class="admin-review-item"><div class="admin-review-item-head"><strong>${window.escapeHtml(review.display_name || 'Customer')}</strong><span aria-label="${Number(review.rating)} out of 5 stars">${'★'.repeat(Number(review.rating))}${'☆'.repeat(5 - Number(review.rating))}</span></div><p>${window.escapeHtml(review.comment || 'No written comment.')}</p><time datetime="${window.escapeHtml(review.created_at)}">${window.escapeHtml(new Date(review.created_at).toLocaleDateString())}</time></article>`).join('') : '<p class="admin-form-hint">There are no reviews in this filter.</p>';
        const pages = Math.max(1, Math.ceil(total / REVIEW_PAGE_SIZE));
        if (reviewPager) reviewPager.hidden = total <= REVIEW_PAGE_SIZE;
        const info = document.querySelector('[data-admin-review-page-info]');
        const prev = document.querySelector('[data-admin-review-prev]');
        const next = document.querySelector('[data-admin-review-next]');
        if (info) info.textContent = `Page ${reviewPage + 1} of ${pages}`;
        if (prev) prev.disabled = reviewPage <= 0;
        if (next) next.disabled = reviewPage + 1 >= pages;
    }
    // Private feedback is separate from public booking reviews: it has no
    // booking eligibility requirement and is visible to active staff/admin
    // accounts through the feedback table's RLS policy.
    const ownerDirectFeedback = document.querySelector('[data-owner-direct-feedback]');
    const ownerFeedbackMore = document.querySelector('[data-owner-feedback-more]');
    const OWNER_FEEDBACK_PAGE_SIZE = 10;
    let ownerFeedbackVisibleCount = OWNER_FEEDBACK_PAGE_SIZE;
    let ownerFeedbackRequest = 0;
    async function loadOwnerFeedback(reset = true) {
        if (!ownerDirectFeedback || !window.sb) return;
        if (reset) ownerFeedbackVisibleCount = OWNER_FEEDBACK_PAGE_SIZE;
        const request = ++ownerFeedbackRequest;
        ownerDirectFeedback.setAttribute('aria-busy', 'true');
        try {
            const { data, count, error } = await window.sb.from('feedback')
                .select('id,rating,message,created_at', { count: 'exact' })
                .order('created_at', { ascending: false })
                .range(0, ownerFeedbackVisibleCount - 1);
            if (request !== ownerFeedbackRequest) return;
            ownerDirectFeedback.setAttribute('aria-busy', 'false');
            if (error) throw error;
            ownerDirectFeedback.innerHTML = data?.length ? data.map((entry) => {
                const rating = Number(entry.rating);
                const stars = Number.isInteger(rating) && rating >= 1 && rating <= 5
                    ? `<span aria-label="${rating} out of 5 stars">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</span>`
                    : '';
                return `<article class="admin-review-item"><div class="admin-review-item-head"><strong>Customer feedback</strong>${stars}</div><p>${window.escapeHtml(entry.message || '')}</p><time datetime="${window.escapeHtml(entry.created_at)}">${window.escapeHtml(new Date(entry.created_at).toLocaleDateString())}</time></article>`;
            }).join('') : '<p class="admin-form-hint">No direct customer feedback yet.</p>';
            if (ownerFeedbackMore) ownerFeedbackMore.hidden = (count || 0) <= ownerFeedbackVisibleCount;
        } catch (error) {
            if (request !== ownerFeedbackRequest) return;
            ownerDirectFeedback.setAttribute('aria-busy', 'false');
            ownerDirectFeedback.innerHTML = '<p class="admin-form-hint">Direct feedback could not be loaded. Check your owner access and try again.</p>';
            if (ownerFeedbackMore) ownerFeedbackMore.hidden = true;
            console.error('[admin] direct customer feedback query failed', error);
        }
    }
    ownerFeedbackMore?.addEventListener('click', () => {
        ownerFeedbackVisibleCount += OWNER_FEEDBACK_PAGE_SIZE;
        loadOwnerFeedback(false);
    });
    document.querySelectorAll('[data-admin-review-rating]').forEach((button) => button.addEventListener('click', () => {
        reviewRatingFilter = button.dataset.adminReviewRating || 'all'; reviewPage = 0;
        document.querySelectorAll('[data-admin-review-rating]').forEach((item) => { item.classList.toggle('is-active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
        loadOwnerReviews();
    }));
    document.querySelector('[data-admin-review-prev]')?.addEventListener('click', () => { if (reviewPage > 0) { reviewPage -= 1; loadOwnerReviews(); } });
    document.querySelector('[data-admin-review-next]')?.addEventListener('click', () => { reviewPage += 1; loadOwnerReviews(); });
    document.addEventListener('inigosync:owner-panel', event => { if (event.detail === 'feedback') { loadOwnerReviews(); loadOwnerFeedback(); } });
    window.setInterval(() => { if (!document.hidden && document.querySelector('[data-admin-panel="feedback"].is-active')) { loadOwnerReviews(); loadOwnerFeedback(false); } }, 15000);
    document.addEventListener('inigosync:profile-ready', () => { loadOwnerReviews(); loadOwnerFeedback(); });
    if (window.inigosyncProfile) { loadOwnerReviews(); loadOwnerFeedback(); }
});
