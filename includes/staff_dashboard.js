document.addEventListener('DOMContentLoaded', async () => {
    // ------------------------------------------------------------------
    // Panel switching (sidebar + topbar shortcuts)
    // ------------------------------------------------------------------
    const panels = document.querySelectorAll('[data-staff-panel]');
    const titleEl = document.querySelector('[data-staff-title]');
    const subtitleEl = document.querySelector('[data-staff-subtitle]');

    const panelMeta = {
        overview: { title: 'Booking Overview', subtitle: "Today's and upcoming court activity across the app." },
        walkin: { title: 'Walk-In Management', subtitle: 'Record a walk-in customer and print or download their receipt.' },
        schedule: { title: 'Court Schedule', subtitle: 'Hour-by-hour availability per court/unit.' },
        transactions: { title: 'Transaction Records', subtitle: 'Every booking and walk-in for the selected date range, with time-in/out.' },
        // Revision S1 (implementation_plan.md, decision S7) — not in
        // .staff-nav, only reachable from the topbar dropdown's "View
        // Profile"; setActivePanel() below still works unmodified since it
        // just looks this key up.
        profile: { title: 'My Profile', subtitle: 'Your account, at a glance.' },
        settings: { title: 'Account Settings', subtitle: 'Update your personal details and manage your staff account password.' },
    };

    function setActivePanel(name) {
        panels.forEach((panel) => {
            panel.classList.toggle('is-active', panel.dataset.staffPanel === name);
        });

        document.querySelectorAll('[data-staff-nav]').forEach((btn) => {
            if (btn.closest('.staff-nav')) {
                btn.classList.toggle('is-active', btn.dataset.staffNav === name);
            }
        });

        const meta = panelMeta[name];
        if (meta && titleEl && subtitleEl) {
            titleEl.textContent = meta.title;
            subtitleEl.textContent = meta.subtitle;
        }

        closeMobileSidebar();
        closeProfileMenu();
        // closeStaffNotifMenu is a hoisted function declaration defined
        // further down this file (Notifications section, Revision S1,
        // decision S8) — safe to call from here regardless of source order,
        // same reasoning includes/owner_dashboard.js documents for its own
        // closeAdminNotifMenu.
        closeStaffNotifMenu();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    document.querySelectorAll('[data-staff-nav]').forEach((btn) => {
        btn.addEventListener('click', () => setActivePanel(btn.dataset.staffNav));
    });

    // ------------------------------------------------------------------
    // Mobile sidebar toggle
    // ------------------------------------------------------------------
    const mobileToggle = document.querySelector('[data-staff-mobile-toggle]');
    const scrim = document.querySelector('[data-staff-scrim]');

    function closeMobileSidebar() {
        document.body.classList.remove('staff-sidebar-open');
        if (mobileToggle) mobileToggle.setAttribute('aria-expanded', 'false');
    }

    if (mobileToggle) {
        mobileToggle.addEventListener('click', () => {
            const isOpen = document.body.classList.toggle('staff-sidebar-open');
            mobileToggle.setAttribute('aria-expanded', String(isOpen));
        });
    }
    if (scrim) scrim.addEventListener('click', closeMobileSidebar);

    // ------------------------------------------------------------------
    // Profile dropdown
    // ------------------------------------------------------------------
    const profile = document.querySelector('[data-staff-profile]');
    const profileTrigger = document.querySelector('[data-staff-profile-trigger]');

    function closeProfileMenu() {
        if (profile) profile.removeAttribute('data-open');
    }

    if (profileTrigger && profile) {
        profileTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            closeStaffNotifMenu();
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

    // Logout is wired in includes/authGuard.js (real Supabase sign-out) via
    // document.querySelectorAll('[data-staff-logout]') — Revision S1,
    // decision S7 removed the sidebar's own Log Out button, leaving only
    // the topbar dropdown's; that querySelectorAll binding needs no change.

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
    const clockEl = document.querySelector('[data-staff-clock]');
    function renderClock() {
        if (!clockEl) return;
        const now = new Date();
        const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        clockEl.textContent = `${dateStr} · ${timeStr}`;
    }
    renderClock();
    window.setInterval(renderClock, 30000);

    // ------------------------------------------------------------------
    // Shared helpers — date ranges, schema-mismatch detection, stat tiles,
    // profile-name lookups, occupancy windows, and the S1 derived-status
    // rule. Used across Booking Overview, Walk-In, Court Schedule,
    // Transaction Records, and Notifications below.
    // ------------------------------------------------------------------

    // "Today" in the browser's local timezone — the only timestamp field
    // every relevant table is guaranteed to have (time_date) is filtered
    // against this everywhere "today" is needed.
    function todayRange() {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
        return { start, end };
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

    function todayDateInputValue() {
        const { start } = todayRange();
        const y = start.getFullYear();
        const m = String(start.getMonth() + 1).padStart(2, '0');
        const d = String(start.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function formatIsoTime12h(iso) {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '—';
        return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }

    // True when a Supabase/PostgREST error means "this column/table doesn't
    // exist" — i.e. database/schema/004_staff_module.sql or 016_walkin_
    // checkin.sql hasn't been applied yet — as opposed to a real error (RLS
    // rejection, network issue, etc.).
    function isSchemaMismatchError(error) {
        if (!error) return false;
        const code = error.code || '';
        const message = String(error.message || '').toLowerCase();
        return code === 'PGRST204' || code === 'PGRST205' || code === '42703' || code === '42P01'
            || message.includes('could not find') || message.includes('does not exist')
            || message.includes('schema cache');
    }

    // Every element sharing a data-staff-stat key gets the same value.
    function setStat(key, value) {
        document.querySelectorAll(`[data-staff-stat="${key}"]`).forEach((el) => {
            el.textContent = String(value);
        });
    }

    // Shared by Overview/Schedule/Transactions/Notifications (customer_id ->
    // name) — no PostgREST embed, since a real FK from booking.customer_id
    // to profiles.id isn't confirmed in this repo-invisible table (see
    // database/schema/004_staff_module.sql's header note). Ported from
    // includes/owner_dashboard.js's fetchProfileNamesByIds().
    async function fetchProfileNamesByIds(ids) {
        const uniqueIds = Array.from(new Set((ids || []).filter(Boolean).map(String)));
        const map = new Map();
        if (!uniqueIds.length || !window.sb) return map;

        const { data, error } = await window.sb.from('profiles').select('id, full_name').in('id', uniqueIds);
        if (error) {
            console.error('[staff] failed to load customer names', error);
            return map;
        }
        (data || []).forEach((p) => map.set(String(p.id), p.full_name || 'Customer'));
        return map;
    }

    // [start, end) for one business hour on a given date base — shared by
    // the Court Schedule grid and the walk-in wizard's Step 3 occupancy
    // check.
    function hourWindow(hour, dateBase) {
        const start = new Date(dateBase);
        start.setHours(hour, 0, 0, 0);
        return { start, end: new Date(start.getTime() + 60 * 60 * 1000) };
    }

    function windowsOverlap(a, b) {
        return a.start < b.end && b.start < a.end;
    }

    // Kept equal to database/schema/004_staff_module.sql's
    // booking.duration_minutes DEFAULT.
    const DEFAULT_DURATION_MINUTES = 60;

    // [start, end] for a `booking` OR `walk_in_booking` row — both share
    // this time_date + optional end_at/duration_minutes shape once
    // database/schema/012_booking_time_range.sql and
    // 016_walkin_checkin.sql are applied. Falls back to
    // DEFAULT_DURATION_MINUTES, never invents a longer/shorter guess.
    function rowWindow(row) {
        const start = new Date(row.time_date);
        if (row.end_at) {
            const end = new Date(row.end_at);
            if (!Number.isNaN(end.getTime())) return { start, end };
        }
        const minutesRaw = Number(row.duration_minutes);
        const minutes = Number.isFinite(minutesRaw) && minutesRaw > 0 ? minutesRaw : DEFAULT_DURATION_MINUTES;
        return { start, end: new Date(start.getTime() + minutes * 60000) };
    }

    // ------------------------------------------------------------------
    // Revision S1, decision S1 — status is DERIVED, never written (besides
    // checked_in_at itself):
    //   Booked      - not checked in, still within the 30-minute grace
    //                 window of time_date (covers both "hasn't started yet"
    //                 and "just started, hasn't been walked over to yet").
    //   In play     - checked in, now < end (rowWindow's end).
    //   Completed   - checked in, now >= end — this IS the "auto time-out"
    //                 decision S1 calls for; checked_out_at is never
    //                 written, the completed state is computed fresh on
    //                 every render.
    //   Unattended  - not checked in, now > time_date + 30 minutes.
    // A row whose real `status` is already 'cancelled' or 'completed'
    // passes straight through — those are real, already-settled facts this
    // never overrides.
    // ------------------------------------------------------------------
    const UNATTENDED_GRACE_MINUTES = 30;

    function staffDerivedStatus(row) {
        const raw = String(row.status || '').toLowerCase();
        if (raw === 'cancelled') return 'cancelled';
        if (raw === 'completed') return 'completed';

        if (row.checked_in_at) {
            const { end } = rowWindow(row);
            return Date.now() >= end.getTime() ? 'completed' : 'inplay';
        }

        const start = new Date(row.time_date);
        if (Number.isNaN(start.getTime())) return 'booked';
        const graceDeadline = start.getTime() + UNATTENDED_GRACE_MINUTES * 60000;
        return Date.now() > graceDeadline ? 'unattended' : 'booked';
    }

    const STAFF_STATUS_LABELS = { booked: 'Booked', inplay: 'In play', completed: 'Completed', unattended: 'Unattended', cancelled: 'Cancelled' };
    function staffStatusLabel(status) {
        return STAFF_STATUS_LABELS[status] || (status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown');
    }

    // Time-In is offered only for a row that hasn't been checked in yet
    // (Booked or Unattended — both mean exactly that), and only once we're
    // within TIME_IN_LEAD_MINUTES of the booked start (so staff can't time
    // someone in hours ahead of their slot).
    const TIME_IN_LEAD_MINUTES = 15;
    function staffCanTimeIn(row, status) {
        if (status !== 'booked' && status !== 'unattended') return false;
        if (row.checked_in_at) return false;
        const startMs = new Date(row.time_date).getTime();
        if (Number.isNaN(startMs)) return false;
        return Date.now() >= startMs - TIME_IN_LEAD_MINUTES * 60000;
    }

    // `walk_in_booking` has no tracked CREATE TABLE in this repo (same
    // "created directly in the live Supabase project before this repo
    // tracked schema files" story as `booking` — see database/schema/
    // 004_staff_module.sql's header note), so its primary-key column name
    // is not confirmed. select('*') always returns whichever real columns
    // exist, so the first of these candidates actually present on a given
    // row IS the real PK column — both its name (for .eq()) and its value.
    const WALKIN_ID_CANDIDATES = ['id', 'walkin_id', 'walk_in_id', 'walk_in_booking_id'];
    function walkinIdField(row) {
        for (let i = 0; i < WALKIN_ID_CANDIDATES.length; i++) {
            const key = WALKIN_ID_CANDIDATES[i];
            if (row && row[key] !== undefined && row[key] !== null) return key;
        }
        return null;
    }

    // Merges `booking` + `walk_in_booking` rows into one normalized shape
    // both Booking Overview and Transaction Records render from — every
    // field staffDerivedStatus()/rowWindow() need (status, checked_in_at,
    // time_date, end_at, duration_minutes) plus display fields (courts,
    // unit, payment, sourceType, customerId/customerName, raw). Shared here
    // (Revision S1) so the two panels can never disagree about what a
    // "booking" or "walk-in" row looks like.
    function mergeBookingRows(bookingRows, walkinRows) {
        const merged = [];
        (bookingRows || []).forEach((b) => merged.push({
            sourceType: 'booking',
            raw: b,
            customerId: b.customer_id || null,
            customerName: null,
            courts: b.courts || b.sports || '',
            unit: b.court_unit || '',
            time_date: b.time_date,
            end_at: b.end_at || null,
            duration_minutes: b.duration_minutes,
            checked_in_at: b.checked_in_at || null,
            status: b.status,
            payment: 'Online',
        }));
        (walkinRows || []).forEach((w) => merged.push({
            sourceType: 'walkin',
            raw: w,
            customerId: null,
            customerName: w.customer_name || 'Walk-in customer',
            courts: w.courts || w.sports || '',
            unit: w.court_unit || '',
            time_date: w.time_date,
            end_at: w.end_at || null,
            duration_minutes: w.duration_minutes,
            checked_in_at: w.checked_in_at || null,
            status: w.status,
            payment: w.payment_method || '—',
        }));
        return merged;
    }

    if (!window.InigoCourtsData) {
        // Should never happen — includes/courtsData.js must load before
        // this file (see the <script> order in Pages/staff_dashboard.html).
        console.error('[staff] window.InigoCourtsData is missing — check that includes/courtsData.js loads before includes/staff_dashboard.js.');
    }
    if (!window.InigoBusinessHours) {
        // Should never happen — includes/businessHours.js must load before
        // this file (see the <script> order in Pages/staff_dashboard.html).
        console.error('[staff] window.InigoBusinessHours is missing — check that includes/businessHours.js loads before includes/staff_dashboard.js.');
    }

    // ------------------------------------------------------------------
    // Payment helpers — Revision S2 (implementation_plan.md, decisions S12/
    // S14). Shared by the Booking Overview row renderer, the Transaction
    // Records row renderer, and the Time-In payment popup (further below)
    // so all three read a booking/walk-in's money the exact same way and
    // can never disagree.
    // ------------------------------------------------------------------

    // Peso amount, always 2 decimals (Revision S2, S11).
    function formatStaffPeso(amount) {
        return `₱${Number(amount).toFixed(2)}`;
    }

    // Court list for the rate × hours fallback below, when a row's own
    // amount_total is still null (a pre-Revision-S2 row, database/schema/
    // 017_booking_payment.sql not applied yet, or a genuinely Rate-TBA
    // court). window.InigoCourtsData.getCourts() memoizes its own promise,
    // so this is cheap even though the walk-in wizard (loadWalkinCourts()
    // below) and the Court Schedule (refreshCourtSchedule() further below)
    // each already hold their own copy — a small dedicated cache here keeps
    // this feature self-contained instead of reaching into either of theirs.
    let timeInCourtsCache = [];
    async function loadTimeInCourtsCache() {
        if (!window.InigoCourtsData) return;
        timeInCourtsCache = await window.InigoCourtsData.getCourts();
    }
    loadTimeInCourtsCache();

    function findStaffCourtByName(name) {
        if (!name) return null;
        return timeInCourtsCache.find((c) => c.name === name) || null;
    }

    function quoteStaffUnitRate(row, start, end) {
        const court = findStaffCourtByName(row.courts);
        if (!court || !window.InigoCourtsData) return null;
        const units = window.InigoCourtsData.resolveCourtUnits(court).units;
        const unit = units.find((item) => row.raw.court_unit_inventory_id && String(item.id) === String(row.raw.court_unit_inventory_id));
        const quantity = Math.max(1, Math.min(100, Number(row.raw.rate_quantity) || 1));
        if (unit?.rateUnit === '/set' && typeof unit.rateDay === 'number') return unit.rateDay * quantity;
        if (typeof unit?.rateDay === 'number') {
            if (typeof unit.rateNight !== 'number' || unit.rateNight === unit.rateDay) {
                return unit.rateDay * Math.max(0, (end.getTime() - start.getTime()) / 3600000);
            }
            const match = /^(\d{2}):(\d{2})/.exec(String(walkinState.nightRateStartsAt || ''));
            if (!match) return null;
            const cutoff = Number(match[1]) * 60 + Number(match[2]);
            let total = 0;
            for (let t = start.getTime(); t < end.getTime(); t += 60000) {
                const local = new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
                const [hour, minute] = local.split(':').map(Number);
                total += (hour * 60 + minute >= cutoff ? unit.rateNight : unit.rateDay) / 60;
            }
            return Math.round(total * 100) / 100;
        }
        if (court.rate !== null && court.rate !== undefined && court.rateUnit === '/hr') {
            return Number(court.rate) * Math.max(0, (end.getTime() - start.getTime()) / 3600000);
        }
        return null;
    }

    // { start, end, hours, total, paid, balance } for a merged Overview/
    // Transactions row (mergeBookingRows() above). row.raw.amount_total/
    // amount_paid only exist once 017_booking_payment.sql is applied —
    // select('*') already tolerates their absence (both simply read as
    // `undefined`, same "column may not exist yet" idiom every other reader
    // in this file uses), so this degrades to the rate × hours fallback
    // below instead of throwing. total stays null ("Rate TBA") when neither
    // a recorded amount_total nor a resolvable court rate exists — never an
    // invented peso figure.
    function timeInPaymentInfo(row) {
        const { start, end } = rowWindow(row);
        const hours = Math.max(1, Math.round((end.getTime() - start.getTime()) / 3600000));

        const rawPaid = row.raw.amount_paid;
        const paid = (rawPaid === null || rawPaid === undefined || Number.isNaN(Number(rawPaid))) ? 0 : Number(rawPaid);
        const rawTotal = row.raw.amount_total;
        const parsedTotal = (rawTotal === null || rawTotal === undefined || rawTotal === '') ? null : Number(rawTotal);
        const totalIsTrusted = Boolean(row.raw.rate_unit_snapshot || row.raw.payment_id || paid > 0);
        let total = parsedTotal !== null && Number.isFinite(parsedTotal) && totalIsTrusted ? parsedTotal : null;
        if (total === null) total = quoteStaffUnitRate(row, start, end);

        const balance = total === null ? null : Math.max(0, total - paid);
        return { start, end, hours, total, paid, balance };
    }

    // Overview/Transactions Payment column (Revision S2, S14) — one label:
    // "Paid · <method>" once amount_paid covers amount_total, "Due ₱X" while
    // a balance remains, "Rate TBA" while the total itself is unknown. A
    // walk-in that has no known total still recorded HOW it paid
    // (payment_method, database/schema/016_walkin_checkin.sql) even without
    // a peso figure, so it shows that instead of a bare "Rate TBA".
    function staffPaymentLabel(row) {
        const info = timeInPaymentInfo(row);
        const walkinMethod = (row.sourceType === 'walkin' && row.payment && row.payment !== '—') ? row.payment : null;

        if (info.total === null) return walkinMethod || 'Rate TBA';
        if (info.total > 0 && info.paid >= info.total) {
            const method = row.raw.balance_payment_method || walkinMethod;
            return method ? `Paid · ${method}` : 'Paid';
        }
        if (info.balance > 0) return `Due ${formatStaffPeso(info.balance)}`;
        return walkinMethod || 'Rate TBA';
    }

    // Re-wires a table's filter chips + search box against its CURRENT
    // <tbody> rows. Called after every render (rows are always fully
    // replaced, not patched) — the chips/search input themselves are never
    // replaced, so this idiom is safe to re-run every time, same pattern
    // this file has always used.
    function wireFilterableTable(scopeName) {
        const group = document.querySelector(`[data-staff-filter-group="${scopeName}"]`);
        const searchInput = document.querySelector(`[data-staff-search="${scopeName}"]`);
        const table = document.querySelector(`[data-staff-table="${scopeName}"]`);
        if (!table) return;
        const rows = Array.from(table.querySelectorAll('tbody tr'));

        let activeFilter = 'all';
        let query = '';

        function applyFilters() {
            rows.forEach((row) => {
                const matchesFilter = activeFilter === 'all' || row.dataset.status === activeFilter;
                const matchesQuery = !query || row.textContent.toLowerCase().includes(query);
                row.style.display = (matchesFilter && matchesQuery) ? '' : 'none';
            });
        }

        if (group) {
            group.querySelectorAll('[data-staff-chip]').forEach((chip) => {
                chip.addEventListener('click', () => {
                    group.querySelectorAll('[data-staff-chip]').forEach((c) => c.classList.remove('is-active'));
                    chip.classList.add('is-active');
                    activeFilter = chip.dataset.staffFilter;
                    applyFilters();
                });
            });
        }

        if (searchInput) {
            searchInput.addEventListener('input', () => {
                query = searchInput.value.trim().toLowerCase();
                applyFilters();
            });
        }
    }

    // ------------------------------------------------------------------
    // Booking Overview — Revision S1, decision S1. Today's + upcoming
    // bookings (pending/confirmed/completed) merged with today's walk-ins
    // into one list, newest-start-first. Confirm/Decline/Time-Out are gone
    // entirely; the only action is Time-In, and status is always derived
    // (staffDerivedStatus() above), never read straight off `status`.
    // ------------------------------------------------------------------
    const overviewTableBody = document.querySelector('[data-staff-table="overview"] tbody');
    let overviewRows = [];

    // Fetches with select('*') rather than an explicit column list — this
    // table's exact shape (whether database/schema/004_staff_module.sql's
    // checked_in_at, 012_booking_time_range.sql's end_at/court_unit, or
    // this revision's own 016_walkin_checkin.sql columns exist yet) is
    // never guaranteed, and select('*') simply returns whatever DOES exist
    // instead of erroring on a column that doesn't — no schema-mismatch
    // retry needed on the read side at all.
    async function fetchOverviewBookings() {
        if (!window.sb) return { ok: false, rows: [] };
        const { start } = todayRange();
        const { data, error } = await window.sb
            .from('booking')
            .select('*')
            .in('status', ['pending', 'confirmed', 'completed'])
            .gte('time_date', start.toISOString())
            .order('time_date', { ascending: true });
        if (error) {
            console.error('[staff] failed to load bookings', error);
            return { ok: false, rows: [] };
        }
        return { ok: true, rows: data || [] };
    }

    async function fetchTodayWalkins() {
        if (!window.sb) return { ok: false, rows: [] };
        const { start, end } = todayRange();
        const { data, error } = await window.sb
            .from('walk_in_booking')
            .select('*')
            .gte('time_date', start.toISOString())
            .lt('time_date', end.toISOString())
            .order('time_date', { ascending: true });
        if (error) {
            console.error("[staff] failed to load today's walk-ins", error);
            return { ok: false, rows: [] };
        }
        return { ok: true, rows: data || [] };
    }

    // "3:00 PM – 5:00 PM" for today's rows; "Sep 18, 3:00 PM – 5:00 PM" for
    // a future row — Overview now spans "today + upcoming" (S1), not just
    // today, so a row on a different day needs its date spelled out.
    function formatOverviewTimeCell(row) {
        const { start, end } = rowWindow(row);
        const timeLabel = `${formatIsoTime12h(row.time_date)} – ${formatIsoTime12h(end.toISOString())}`;
        if (start.toDateString() === new Date().toDateString()) return timeLabel;
        const dateLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return `${dateLabel}, ${timeLabel}`;
    }

    function renderOverviewStats(rows) {
        const { start, end } = todayRange();
        const startMs = start.getTime();
        const endMs = end.getTime();
        const todayRows = rows.filter((r) => {
            const t = new Date(r.time_date).getTime();
            return t >= startMs && t < endMs;
        });

        const bookingsToday = todayRows.filter((r) => r.sourceType === 'booking').length;
        const walkinsToday = todayRows.filter((r) => r.sourceType === 'walkin').length;
        const inPlayNow = todayRows.filter((r) => staffDerivedStatus(r) === 'inplay').length;
        const stillToCome = todayRows.filter((r) => staffDerivedStatus(r) === 'booked').length;

        setStat('bookings-today', bookingsToday);
        setStat('walkins-today', walkinsToday);
        setStat('inplay-now', inPlayNow);
        setStat('still-to-come', stillToCome);
    }

    function staffActionCellHtml(row, status) {
        if (!staffCanTimeIn(row, status)) return '';
        return '<button type="button" class="staff-mini-btn is-primary" data-staff-action="timein">Time-In</button>';
    }

    // Every value below can be customer-controlled (customer name, a
    // walk-in's typed name) or DB content staff/admin can edit (courts) —
    // escaped before it touches innerHTML.
    function renderOverviewRow(row) {
        const status = staffDerivedStatus(row);
        const fallbackName = row.sourceType === 'walkin' ? 'Walk-in customer' : 'Customer';
        const customerName = window.escapeHtml(row.customerName || fallbackName);
        const courtLabel = window.escapeHtml(row.courts || '—');
        const unitLabel = row.unit ? window.escapeHtml(row.unit) : '';
        const sourceLabel = row.sourceType === 'walkin' ? 'Walk-in' : 'Online';
        const sourceClass = row.sourceType === 'walkin' ? 'walkin' : 'online';
        // Revision S2 (implementation_plan.md, S14) — Paid · <method> / Due
        // ₱X / Rate TBA, derived from real amounts instead of just the
        // source label (staffPaymentLabel(), Shared helpers section above).
        const paymentLabel = window.escapeHtml(staffPaymentLabel(row));
        const statusLabel = window.escapeHtml(staffStatusLabel(status));

        const tr = document.createElement('tr');
        tr.dataset.status = status;
        tr.innerHTML = `
            <td class="staff-cell-main">${customerName}</td>
            <td>${courtLabel}${unitLabel ? `<span class="staff-cell-sub">${unitLabel}</span>` : ''}</td>
            <td>${window.escapeHtml(formatOverviewTimeCell(row))}</td>
            <td><span class="staff-status ${sourceClass}">${sourceLabel}</span></td>
            <td>${paymentLabel}</td>
            <td><span class="staff-status ${window.escapeHtml(status)}">${statusLabel}</span></td>
            <td>${staffActionCellHtml(row, status)}</td>
        `;
        return tr;
    }

    async function refreshBookingOverview() {
        if (!overviewTableBody || !window.sb) return;

        const [bookingsRes, walkinsRes] = await Promise.all([fetchOverviewBookings(), fetchTodayWalkins()]);
        if (!bookingsRes.ok) {
            overviewTableBody.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--color-ink-faint);">Could not load bookings right now.</td></tr>';
            return;
        }

        const merged = mergeBookingRows(bookingsRes.rows, walkinsRes.ok ? walkinsRes.rows : []);
        merged.sort((a, b) => new Date(a.time_date) - new Date(b.time_date));

        const nameMap = await fetchProfileNamesByIds(merged.filter((r) => r.sourceType === 'booking').map((r) => r.customerId));
        merged.forEach((r) => {
            if (r.sourceType === 'booking') r.customerName = nameMap.get(String(r.customerId)) || 'Customer';
        });

        overviewRows = merged;
        renderOverviewStats(merged);

        overviewTableBody.innerHTML = '';
        if (merged.length === 0) {
            overviewTableBody.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--color-ink-faint);">No bookings yet.</td></tr>';
            wireFilterableTable('overview');
            return;
        }

        merged.forEach((row, i) => {
            const tr = renderOverviewRow(row);
            tr.dataset.rowIndex = String(i);
            overviewTableBody.appendChild(tr);
        });

        wireFilterableTable('overview');
    }

    // Revision S2 (implementation_plan.md, decisions S11/S14) — Time-In no
    // longer writes checked_in_at directly from this row action; it opens
    // the Time-In payment popup instead (openTimeInModal()/
    // wireTimeInButtons(), defined in the "Time-In payment popup" section
    // below — hoisted `function` declarations, safe to call from here
    // regardless of source order). The popup performs the update
    // (applyTimeInPatch()) once the staff member confirms, writes the audit
    // log entry, and refreshes Overview/Schedule/Transactions/Notifications
    // itself — the same work the old inline handler here used to do,
    // now made once instead of being duplicated for Transaction Records'
    // identical button (wired the same way further below).
    wireTimeInButtons(overviewTableBody, () => overviewRows);

    refreshBookingOverview();
    document.addEventListener('inigosync:profile-ready', refreshBookingOverview);

    // ------------------------------------------------------------------
    // Walk-In Management — Revision S1, decisions S3/S4. Replaces the old
    // single-page form (duration 1/2/3h + start time + GCash/Cash) with a
    // 5-step wizard: ① Customer -> ② Sport & court -> ③ Time (today only,
    // From/To limited to free hours) -> ④ Payment -> ⑤ Review & save. On
    // success the wizard is swapped for a receipt card (Download PNG /
    // Print / New walk-in).
    // ------------------------------------------------------------------
    const walkinWizardWrap = document.querySelector('[data-staff-walkin-wizard-wrap]');
    const walkinReceiptWrap = document.querySelector('[data-staff-walkin-receipt-wrap]');
    const walkinReceiptEl = document.querySelector('[data-staff-walkin-receipt]');

    const walkinStepPanels = document.querySelectorAll('[data-staff-walkin-step]');
    const walkinStepIndicators = document.querySelectorAll('[data-staff-walkin-step-indicator]');
    const walkinBackBtn = document.querySelector('[data-staff-walkin-back]');
    const walkinNextBtn = document.querySelector('[data-staff-walkin-next]');
    const walkinSaveBtn = document.querySelector('[data-staff-walkin-save]');

    const walkinNameInput = document.querySelector('[data-staff-walkin-name]');
    const walkinMobileInput = document.querySelector('[data-staff-walkin-mobile]');
    const walkinSportChips = document.querySelector('[data-staff-walkin-sport-chips]');
    const walkinUnitWrap = document.querySelector('[data-staff-walkin-unit-wrap]');
    const walkinUnitLabel = document.querySelector('[data-staff-walkin-unit-label]');
    const walkinUnitSelect = document.querySelector('[data-staff-walkin-unit-select]');
    const walkinFromSelect = document.querySelector('[data-staff-walkin-from]');
    const walkinToSelect = document.querySelector('[data-staff-walkin-to]');
    const walkinTimeRange = document.querySelector('[data-staff-walkin-time-range]');
    const walkinToWrap = document.querySelector('[data-staff-walkin-to-wrap]');
    const walkinSetQuantityWrap = document.querySelector('[data-staff-walkin-set-quantity-wrap]');
    const walkinOpenWindowsEl = document.querySelector('[data-staff-walkin-open-windows]');
    const walkinPaymentOptionEls = document.querySelectorAll('[data-staff-walkin-step="4"] [data-staff-payment-option]');
    const walkinCashUnavailableEl = document.querySelector('[data-staff-walkin-cash-unavailable]');

    const walkinSummaryName = document.querySelector('[data-staff-walkin-summary-name]');
    const walkinSummaryMobile = document.querySelector('[data-staff-walkin-summary-mobile]');
    const walkinSummaryCourt = document.querySelector('[data-staff-walkin-summary-court]');
    const walkinSummaryTime = document.querySelector('[data-staff-walkin-summary-time]');
    const walkinSummaryRateLabel = document.querySelector('[data-staff-walkin-summary-rate-label]');
    const walkinSummaryRate = document.querySelector('[data-staff-walkin-summary-rate]');
    const walkinSummaryPayment = document.querySelector('[data-staff-walkin-summary-payment]');
    const walkinSummaryTotal = document.querySelector('[data-staff-walkin-summary-total]');
    const walkinRateQuantityInput = document.querySelector('[data-staff-rate-quantity]');

    const WALKIN_STEP_COUNT = 5;
    let walkinWizardStep = 1;
    let staffCashEnabled = true;

    let walkinState = {
        name: '',
        mobile: '',
        mobileError: false,
        courts: [],
        court: null,
        unit: null,
        unitId: null,
        rateDay: null,
        rateNight: null,
        rateUnit: '/hr',
        rateQuantity: 1,
        nightRateStartsAt: null,
        startHour: null,
        endHour: null,
        payment: 'cash',
    };

    // { ok, rows } — today's bookings/walk-ins for the CURRENTLY selected
    // court, refreshed by refreshWalkinTimePickers() below. Same shape as
    // includes/Dashboard.js's slotGridBookings/slotGridWalkins.
    let walkinBookings = { ok: true, rows: [] };
    let walkinWalkins = { ok: true, rows: [] };
    let walkinRequestSeq = 0;

    function applyStaffPaymentSettings(settings) {
        staffCashEnabled = settings?.cashEnabled !== false;
        document.querySelectorAll('[data-staff-walkin-cash-option], [data-staff-timein-cash-option]').forEach((option) => {
            option.hidden = !staffCashEnabled;
            if (!staffCashEnabled) {
                option.classList.remove('is-selected');
                const radio = option.querySelector('input[type="radio"]');
                if (radio) radio.checked = false;
            }
        });
        if (walkinCashUnavailableEl) walkinCashUnavailableEl.hidden = staffCashEnabled;
        if (!staffCashEnabled && walkinState.payment === 'cash') walkinState.payment = null;
        if (staffCashEnabled && !walkinState.payment) walkinState.payment = 'cash';
        if (!staffCashEnabled && timeInSelectedMethod === 'Cash') {
            timeInSelectedMethod = null;
            if (timeInModalRow && timeInModalIsOpen) renderTimeInModal(timeInModalRow);
        }
        renderWalkinWizard();
        updateWalkinSummary();
    }

    function walkinStepIsReady(step) {
        if (step === 1) return Boolean(walkinState.name) && !walkinState.mobileError;
        if (step === 2) {
            if (!walkinState.court || !window.InigoCourtsData) return false;
            const { units } = window.InigoCourtsData.resolveCourtUnits(walkinState.court);
            return units.length > 1 ? Boolean(walkinState.unit) : true;
        }
        if (step === 3) return walkinState.startHour !== null && walkinState.endHour !== null;
        if (step === 4) return Boolean(walkinState.payment) && (walkinState.payment !== 'cash' || staffCashEnabled);
        return true;
    }

    function renderWalkinWizard() {
        walkinStepPanels.forEach((panel) => {
            panel.classList.toggle('is-active', Number(panel.dataset.staffWalkinStep) === walkinWizardStep);
        });
        walkinStepIndicators.forEach((el) => {
            const n = Number(el.dataset.staffWalkinStepIndicator);
            el.classList.toggle('is-current', n === walkinWizardStep);
            el.classList.toggle('is-done', n < walkinWizardStep);
            el.setAttribute('aria-current', n === walkinWizardStep ? 'step' : 'false');
        });
        if (walkinBackBtn) walkinBackBtn.hidden = walkinWizardStep === 1;
        if (walkinNextBtn) {
            walkinNextBtn.hidden = walkinWizardStep === WALKIN_STEP_COUNT;
            walkinNextBtn.disabled = !walkinStepIsReady(walkinWizardStep);
        }
        if (walkinWizardStep === WALKIN_STEP_COUNT) updateWalkinSummary();
    }

    function goToWalkinStep(step) {
        walkinWizardStep = Math.min(Math.max(1, step), WALKIN_STEP_COUNT);
        renderWalkinWizard();
    }

    if (walkinNextBtn) {
        walkinNextBtn.addEventListener('click', () => {
            if (walkinNextBtn.disabled) return;
            goToWalkinStep(walkinWizardStep + 1);
        });
    }
    if (walkinBackBtn) walkinBackBtn.addEventListener('click', () => goToWalkinStep(walkinWizardStep - 1));

    // ---- Step 1 — Customer ----
    if (walkinNameInput) {
        walkinNameInput.addEventListener('input', () => {
            walkinState.name = walkinNameInput.value.trim();
            renderWalkinWizard();
        });
    }
    if (walkinMobileInput) {
        walkinMobileInput.addEventListener('input', () => {
            const raw = walkinMobileInput.value.trim();
            if (!raw) {
                walkinState.mobile = '';
                walkinState.mobileError = false;
            } else {
                const check = window.validatePhMobile(raw);
                walkinState.mobile = check.valid ? check.normalized : '';
                walkinState.mobileError = !check.valid;
            }
            renderWalkinWizard();
        });
    }

    // ---- Step 2 — Sport & court/unit ----
    function renderWalkinSportChips() {
        if (!walkinSportChips) return;
        walkinSportChips.innerHTML = walkinState.courts.map((court) => {
            const active = walkinState.court && String(walkinState.court.id) === String(court.id);
            return `<button type="button" class="staff-chip${active ? ' is-active' : ''}" data-staff-chip data-staff-walkin-sport="${window.escapeHtml(String(court.id))}">${window.escapeHtml(court.name)}</button>`;
        }).join('');

        walkinSportChips.querySelectorAll('[data-staff-walkin-sport]').forEach((chip) => {
            chip.addEventListener('click', () => {
                const court = walkinState.courts.find((c) => String(c.id) === chip.dataset.staffWalkinSport);
                if (court) selectWalkinCourt(court);
            });
        });
    }

    function selectWalkinCourt(court) {
        walkinState.court = court;
        const { pickerLabel, units } = window.InigoCourtsData.resolveCourtUnits(court);

        if (units.length > 1) {
            if (walkinUnitWrap) walkinUnitWrap.hidden = false;
            if (walkinUnitLabel) walkinUnitLabel.textContent = pickerLabel;
            if (walkinUnitSelect) {
                walkinUnitSelect.innerHTML = units.map((u, i) => {
                    const label = u.label || `Unit ${i + 1}`;
                    return `<option value="${window.escapeHtml(label)}" data-unit-id="${window.escapeHtml(u.id || '')}">${window.escapeHtml(label)}</option>`;
                }).join('');
                walkinState.unit = units[0].label || 'Unit 1';
                walkinState.unitId = units[0].id || null;
                setWalkinUnitRate(units[0], court);
                walkinUnitSelect.value = walkinState.unit;
            }
        } else {
            if (walkinUnitWrap) walkinUnitWrap.hidden = true;
            walkinState.unit = (units[0] && units[0].label) || null;
            walkinState.unitId = (units[0] && units[0].id) || null;
            setWalkinUnitRate(units[0], court);
        }

        renderWalkinSportChips();
        resetWalkinTimeSelectionAndRefresh();
        renderWalkinWizard();
    }

    function setWalkinUnitRate(unit, court) {
        walkinState.rateDay = unit?.rateDay ?? null;
        walkinState.rateNight = unit?.rateNight ?? null;
        walkinState.rateUnit = unit && (typeof unit.rateDay === 'number' || typeof unit.rateNight === 'number') ? (unit.rateUnit || court?.rateUnit || '/hr') : (court?.rateUnit || '/hr');
        walkinState.rate = unit?.rate ?? court?.rate ?? null;
    }

    if (walkinUnitSelect) {
        walkinUnitSelect.addEventListener('change', () => {
            walkinState.unit = walkinUnitSelect.value || null;
            walkinState.unitId = walkinUnitSelect.selectedOptions[0]?.dataset.unitId || null;
            const units = window.InigoCourtsData.resolveCourtUnits(walkinState.court).units;
            setWalkinUnitRate(units.find((u) => String(u.id || '') === String(walkinState.unitId || '')) || units[0], walkinState.court);
            resetWalkinTimeSelectionAndRefresh();
            renderWalkinWizard();
        });
    }

    async function loadWalkinCourts() {
        if (!window.InigoCourtsData) return;
        const courts = await window.InigoCourtsData.getCourts();
        const hasInventory = courts.some((court) => Array.isArray(court.bookableUnits) || court.inventoryLoadFailed);
        walkinState.courts = hasInventory
            ? courts.filter((court) => !court.inventoryLoadFailed
                && (!Array.isArray(court.bookableUnits) || court.bookableUnits.length > 0))
            : courts;
        renderWalkinSportChips();
    }
    loadWalkinCourts();
    if (window.InigoAppSettings) window.InigoAppSettings.getSettings().then((settings) => {
        walkinState.nightRateStartsAt = settings.nightRateStartsAt || null;
        applyStaffPaymentSettings(settings);
        updateWalkinSummary();
    });

    // ---- Step 3 — Time (today only) ----
    // Ported from includes/Dashboard.js's fetchDayOccupancy()/
    // computeFreeWindows()/renderTimePickers() (Revision 5, D3) — same
    // From/To picker shape, minus a date parameter (a walk-in is always
    // today, per S3).
    async function fetchWalkinOccupancyForCourt(courtName) {
        if (!window.sb || !courtName) return { ok: false, rows: [] };
        const { start, end } = todayRange();
        let res;
        try {
            res = await window.sb.rpc('court_occupancy', {
                from_at: start.toISOString(), to_at: end.toISOString(),
            });
        } catch (error) {
            console.error('[staff] failed to load occupancy for the walk-in time pickers', error);
            return { ok: false, rows: [] };
        }
        if (res.error) {
            console.error('[staff] failed to load occupancy for the walk-in time pickers', res.error);
            return { ok: false, rows: [] };
        }
        return { ok: true, rows: (res.data || []).filter((row) => sameCourtName(row.courts, courtName)) };
    }

    function isWalkinHourPast(hour) {
        const { start } = todayRange();
        return hourWindow(hour, start).start.getTime() < Date.now();
    }

    // Bookings match the same "same unit, or both no-unit" rule
    // includes/Dashboard.js's isSlotHourBooked() uses. Walk-ins differ per
    // decision S3: a walk-in with NO recorded unit blocks every unit of
    // that court (it can't be narrowed down — safer to over-block than
    // risk a double-booking); a walk-in WITH a unit only blocks that unit.
    function isWalkinHourBooked(hour) {
        const { start } = todayRange();
        const slot = hourWindow(hour, start);
        const currentUnit = walkinState.unit || '';

        if (walkinBookings.ok) {
            const bookingMatch = walkinBookings.rows.some((row) => {
                if (!courtUnitsOverlap(row.court_unit, currentUnit)) return false;
                return windowsOverlap(rowWindow(row), slot);
            });
            if (bookingMatch) return true;
        }

        if (walkinWalkins.ok) {
            return walkinWalkins.rows.some((row) => {
                return courtUnitsOverlap(row.court_unit, currentUnit) && windowsOverlap(rowWindow(row), slot);
            });
        }
        return false;
    }

    function walkinSlotStatus(hour) {
        if (isWalkinHourPast(hour)) return 'past';
        if (isWalkinHourBooked(hour)) return 'booked';
        return 'available';
    }

    function computeWalkinFreeWindows() {
        if (!window.InigoBusinessHours) return [];
        const hours = window.InigoBusinessHours.hoursRange();
        const windows = [];
        let runStart = null;
        hours.forEach((hour) => {
            if (walkinSlotStatus(hour) === 'available') {
                if (runStart === null) runStart = hour;
            } else if (runStart !== null) {
                windows.push({ startHour: runStart, endHourExclusive: hour });
                runStart = null;
            }
        });
        if (runStart !== null) windows.push({ startHour: runStart, endHourExclusive: window.InigoBusinessHours.CLOSE_HOUR });
        return windows;
    }

    function renderWalkinTimePickers() {
        if (!walkinFromSelect || !walkinToSelect || !window.InigoBusinessHours) return;

        const perSet = walkinState.rateUnit === '/set';
        if (walkinTimeRange) walkinTimeRange.classList.toggle('has-sets', perSet);
        if (walkinToWrap) walkinToWrap.hidden = perSet;
        if (walkinSetQuantityWrap) walkinSetQuantityWrap.hidden = !perSet;

        if (!walkinState.court) {
            walkinFromSelect.innerHTML = '<option value="">Select a sport first</option>';
            walkinToSelect.innerHTML = '<option value="">Select a sport first</option>';
            walkinFromSelect.disabled = true;
            walkinToSelect.disabled = true;
            if (walkinOpenWindowsEl) walkinOpenWindowsEl.textContent = 'Select a sport first.';
            renderWalkinWizard();
            return;
        }

        if (!walkinBookings.ok || !walkinWalkins.ok) {
            walkinFromSelect.innerHTML = '<option value="">Unavailable</option>';
            walkinToSelect.innerHTML = '<option value="">Unavailable</option>';
            walkinFromSelect.disabled = true;
            walkinToSelect.disabled = true;
            if (walkinOpenWindowsEl) walkinOpenWindowsEl.textContent = 'Could not check live availability right now — please try again.';
            renderWalkinWizard();
            return;
        }

        const fmt = window.InigoBusinessHours.formatHourLabel;
        const windows = computeWalkinFreeWindows();

        if (windows.length === 0) {
            walkinFromSelect.innerHTML = '<option value="">No times available</option>';
            walkinToSelect.innerHTML = '<option value="">No times available</option>';
            walkinFromSelect.disabled = true;
            walkinToSelect.disabled = true;
            walkinState.startHour = null;
            walkinState.endHour = null;
            if (walkinOpenWindowsEl) {
                const noneBooked = window.InigoBusinessHours.hoursRange().every((h) => walkinSlotStatus(h) !== 'booked');
                walkinOpenWindowsEl.textContent = noneBooked ? 'No more times available today.' : 'Fully booked today.';
            }
            renderWalkinWizard();
            return;
        }

        const requiredHours = perSet ? Math.max(1, Math.min(100, Number(walkinState.rateQuantity) || 1)) : 1;
        const freeHours = [];
        windows.forEach((w) => {
            for (let h = w.startHour; h + requiredHours <= w.endHourExclusive; h++) freeHours.push(h);
        });
        if (freeHours.length === 0) {
            walkinFromSelect.innerHTML = '<option value="">No times available</option>';
            walkinToSelect.innerHTML = '<option value="">No times available</option>';
            walkinFromSelect.disabled = true;
            walkinToSelect.disabled = true;
            walkinState.startHour = null;
            walkinState.endHour = null;
            if (walkinOpenWindowsEl) walkinOpenWindowsEl.textContent = perSet
                ? `No open time block is long enough for ${requiredHours} set${requiredHours === 1 ? '' : 's'}.`
                : 'No more times available today.';
            renderWalkinWizard();
            return;
        }
        if (walkinState.startHour !== null && !freeHours.includes(walkinState.startHour)) {
            walkinState.startHour = null;
            walkinState.endHour = null;
        }

        walkinFromSelect.disabled = false;
        const fromPlaceholder = `<option value=""${walkinState.startHour === null ? ' selected' : ''} disabled>Select a start time</option>`;
        const fromOptions = freeHours.map((h) => `<option value="${h}"${h === walkinState.startHour ? ' selected' : ''}>${window.escapeHtml(fmt(h))}</option>`).join('');
        walkinFromSelect.innerHTML = fromPlaceholder + fromOptions;

        if (perSet) {
            walkinState.endHour = walkinState.startHour === null ? null : walkinState.startHour + requiredHours - 1;
            walkinToSelect.innerHTML = '<option value="">Selected set duration</option>';
            walkinToSelect.disabled = true;
        } else if (walkinState.startHour === null) {
            walkinToSelect.innerHTML = '<option value="" selected disabled>Select a start time first</option>';
            walkinToSelect.disabled = true;
        } else {
            const run = windows.find((w) => walkinState.startHour >= w.startHour && walkinState.startHour < w.endHourExclusive);
            const runEndExclusive = run ? run.endHourExclusive : walkinState.startHour + 1;
            const toPlaceholder = `<option value=""${walkinState.endHour === null ? ' selected' : ''} disabled>Select an end time</option>`;
            const toOptions = [];
            for (let endExclusive = walkinState.startHour + 1; endExclusive <= runEndExclusive; endExclusive++) {
                const endHourValue = endExclusive - 1;
                toOptions.push(`<option value="${endHourValue}"${endHourValue === walkinState.endHour ? ' selected' : ''}>${window.escapeHtml(fmt(endExclusive))}</option>`);
            }
            walkinToSelect.innerHTML = toPlaceholder + toOptions.join('');
            walkinToSelect.disabled = false;
        }

        if (walkinOpenWindowsEl) {
            const windowLabels = windows.map((w) => `${fmt(w.startHour)} – ${fmt(w.endHourExclusive)}`).join(', ');
            walkinOpenWindowsEl.textContent = `Open today: ${windowLabels}`;
        }
        renderWalkinWizard();
    }

    if (walkinFromSelect) {
        walkinFromSelect.addEventListener('change', () => {
            const value = walkinFromSelect.value;
            walkinState.startHour = value === '' ? null : Number(value);
            walkinState.endHour = null;
            renderWalkinTimePickers();
            updateWalkinSummary();
        });
    }
    if (walkinToSelect) {
        walkinToSelect.addEventListener('change', () => {
            const value = walkinToSelect.value;
            walkinState.endHour = value === '' ? null : Number(value);
            renderWalkinWizard();
            updateWalkinSummary();
        });
    }

    async function refreshWalkinTimePickers() {
        if (!walkinFromSelect || !walkinToSelect) return;
        const mySeq = ++walkinRequestSeq;
        if (!walkinState.court) { renderWalkinTimePickers(); return; }

        walkinFromSelect.innerHTML = '<option value="">Checking availability…</option>';
        walkinToSelect.innerHTML = '<option value="">Checking availability…</option>';
        walkinFromSelect.disabled = true;
        walkinToSelect.disabled = true;
        if (walkinOpenWindowsEl) walkinOpenWindowsEl.textContent = 'Checking availability…';

        const occupancyRes = await fetchWalkinOccupancyForCourt(walkinState.court.name);
        if (mySeq !== walkinRequestSeq) return; // a newer refresh already owns the pickers
        walkinBookings = { ok: occupancyRes.ok, rows: occupancyRes.rows.filter((row) => row.source === 'online') };
        walkinWalkins = { ok: occupancyRes.ok, rows: occupancyRes.rows.filter((row) => row.source === 'walkin' || row.source === 'maintenance') };
        renderWalkinTimePickers();
    }

    function resetWalkinTimeSelectionAndRefresh() {
        walkinState.startHour = null;
        walkinState.endHour = null;
        refreshWalkinTimePickers();
    }

    // ---- Step 4 — Payment ----
    walkinPaymentOptionEls.forEach((option) => {
        option.addEventListener('click', () => {
            const radio = option.querySelector('input[type="radio"]');
            if (!radio) return;
            walkinPaymentOptionEls.forEach((o) => o.classList.remove('is-selected'));
            option.classList.add('is-selected');
            radio.checked = true;
            walkinState.payment = radio.dataset.staffPayment;
            updateWalkinSummary();
        });
    });

    // ---- Step 5 — Review & save ----
    function walkinHoursSelected() {
        if (walkinState.startHour === null) return 0;
        const effectiveEnd = walkinState.endHour !== null ? walkinState.endHour : walkinState.startHour;
        return effectiveEnd - walkinState.startHour + 1;
    }

    function walkinTimeRangeLabel() {
        const hours = walkinHoursSelected();
        if (hours === 0 || !window.InigoBusinessHours) return null;
        const effectiveEnd = walkinState.endHour !== null ? walkinState.endHour : walkinState.startHour;
        const fmt = window.InigoBusinessHours.formatHourLabel;
        if (walkinState.rateUnit === '/set') {
            return `${fmt(walkinState.startHour)} – ${fmt(effectiveEnd + 1)} · ${walkinState.rateQuantity} set${walkinState.rateQuantity === 1 ? '' : 's'} · 60 min each`;
        }
        return `${fmt(walkinState.startHour)} – ${fmt(effectiveEnd + 1)} · ${hours} hr${hours === 1 ? '' : 's'}`;
    }

    function updateWalkinSummary() {
        const hours = walkinHoursSelected();
        const court = walkinState.court;
        const hasRate = typeof walkinState.rateDay === 'number' || (court && walkinState.rate !== null && walkinState.rate !== undefined);
        let amount = null;
        if (walkinState.rateUnit === '/set' && typeof walkinState.rateDay === 'number') amount = walkinState.rateDay * walkinState.rateQuantity;
        else if (hours > 0 && hasRate) {
            if (typeof walkinState.rateDay === 'number' && (typeof walkinState.rateNight !== 'number' || walkinState.rateDay === walkinState.rateNight)) {
                amount = walkinState.rateDay * hours;
            } else if (typeof walkinState.rateDay !== 'number' && typeof walkinState.rate === 'number') {
                amount = walkinState.rate * hours;
            } else amount = walkinHourlyAmount(hours);
        }

        if (walkinSummaryName) walkinSummaryName.textContent = walkinState.name || '—';
        if (walkinSummaryMobile) walkinSummaryMobile.textContent = walkinState.mobile || 'Not provided';
        if (walkinSummaryCourt) {
            const unitPart = walkinState.unit ? ` · ${walkinState.unit}` : '';
            walkinSummaryCourt.textContent = court ? `${court.name}${unitPart}` : '—';
        }
        if (walkinSummaryTime) walkinSummaryTime.textContent = walkinTimeRangeLabel() || '— Select a time —';
        if (walkinSummaryRateLabel) walkinSummaryRateLabel.textContent = amount !== null ? 'Estimated total' : 'Rate';
        if (walkinSummaryRate) walkinSummaryRate.textContent = hasRate ? (walkinState.rateUnit === '/set' ? `₱${walkinState.rateDay}/set × ${walkinState.rateQuantity}` : `₱${walkinState.rateDay ?? walkinState.rate}${walkinState.rateUnit} · ${hours} hr${hours === 1 ? '' : 's'}`) : 'Rate TBA';
        if (walkinSummaryPayment) walkinSummaryPayment.textContent = walkinState.payment === 'cash' ? 'Cash' : 'Unavailable';
        if (walkinSummaryTotal) walkinSummaryTotal.textContent = amount !== null ? `₱${amount.toFixed(2)}` : 'Rate TBA';
    }

    if (walkinRateQuantityInput) walkinRateQuantityInput.addEventListener('input', () => {
        walkinState.rateQuantity = Math.max(1, Math.min(100, Number.parseInt(walkinRateQuantityInput.value, 10) || 1));
        walkinRateQuantityInput.value = String(walkinState.rateQuantity);
        if (walkinState.rateUnit === '/set') renderWalkinTimePickers();
        updateWalkinSummary();
    });

    function walkinHourlyAmount(hours) {
        const match = /^(\d{2}):(\d{2})/.exec(String(walkinState.nightRateStartsAt || ''));
        if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || walkinState.startHour === null) return null;
        const cutoffMinutes = Number(match[1]) * 60 + Number(match[2]);
        let total = 0;
        for (let h = walkinState.startHour; h < walkinState.startHour + hours; h += 1) {
            const start = h * 60;
            const nightMinutes = Math.max(0, start + 60 - Math.max(start, cutoffMinutes));
            total += (60 - nightMinutes) / 60 * walkinState.rateDay + nightMinutes / 60 * walkinState.rateNight;
        }
        return total;
    }

    // ---- Receipt (S4) — same store-receipt/ticket look as the customer
    // dashboard's .dash-receipt-card (includes/Dashboard.js's
    // renderReceiptCard()/downloadReceiptAsPng()), ported under
    // staff-receipt-* names. ----
    function formatWalkinDateLabel(iso) {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function renderStaffReceipt(receipt) {
        if (!walkinReceiptEl) return;
        const amount = receipt.amountTotal !== undefined && receipt.amountTotal !== null ? Number(receipt.amountTotal) : null;
        const hasAmount = typeof amount === 'number' && Number.isFinite(amount);
        const rateLineLabel = hasAmount ? 'Saved reservation total' : 'Amount';
        const rateLineAmount = hasAmount ? `₱${amount.toFixed(2)}` : 'Rate TBA';
        const totalAmount = hasAmount ? `₱${amount.toFixed(2)}` : 'Rate TBA';
        const idAttr = window.escapeHtml(String(receipt.id));
        const courtLabel = receipt.unit ? `${receipt.courtName} · ${receipt.unit}` : receipt.courtName;

        walkinReceiptEl.innerHTML = `
            <div class="staff-receipt-card" data-staff-receipt-card>
                <div class="staff-receipt-brand">
                    <span class="staff-receipt-brand-name">IñigoSync</span>
                    <span class="staff-receipt-brand-tag">Walk-in receipt</span>
                </div>
                <p class="staff-receipt-no">Walk-in receipt #${idAttr}</p>

                <div class="staff-receipt-divider"></div>

                <div class="staff-receipt-top">
                    <h4>${window.escapeHtml(courtLabel)}</h4>
                </div>

                <div class="staff-receipt-meta">
                    <div class="staff-summary-row"><span>Customer</span><strong>${window.escapeHtml(receipt.customerName)}</strong></div>
                    ${receipt.customerMobile ? `<div class="staff-summary-row"><span>Mobile</span><strong>${window.escapeHtml(receipt.customerMobile)}</strong></div>` : ''}
                    <div class="staff-summary-row"><span>Date</span><strong>${window.escapeHtml(formatWalkinDateLabel(receipt.startIso))}</strong></div>
                    <div class="staff-summary-row"><span>Time</span><strong>${window.escapeHtml(formatIsoTime12h(receipt.startIso))} – ${window.escapeHtml(formatIsoTime12h(receipt.endIso))}</strong></div>
                </div>

                <div class="staff-receipt-divider"></div>

                <div class="staff-receipt-meta">
                    <div class="staff-summary-row"><span>${window.escapeHtml(rateLineLabel)}</span><strong>${window.escapeHtml(rateLineAmount)}</strong></div>
                    <div class="staff-summary-row"><span>Payment method</span><strong>${window.escapeHtml(receipt.paymentLabel)}</strong></div>
                </div>

                <div class="staff-receipt-total">
                    <span>Total</span>
                    <span>${window.escapeHtml(totalAmount)}</span>
                </div>

                <div class="staff-receipt-divider"></div>

                <p class="staff-receipt-thanks">Thank you for visiting Iñigos Sports Center!</p>

                <div class="staff-receipt-actions">
                    <button type="button" class="staff-btn-primary" data-staff-receipt-download="${idAttr}">Download PNG</button>
                    <button type="button" class="staff-btn-ghost" data-staff-receipt-print>Print</button>
                    <button type="button" class="staff-btn-ghost" data-staff-walkin-reset>New walk-in</button>
                </div>
            </div>
        `;
    }

    function canvasToBlobAsyncStaff(canvas) {
        return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    }

    // Same canvas.toBlob() + programmatic <a download> approach as
    // includes/Dashboard.js's downloadReceiptAsPng() — reliable across
    // device types, unlike piping canvas.toDataURL() straight into a link.
    async function downloadStaffReceiptAsPng(card, filenameId) {
        if (!window.html2canvas) {
            window.InigoToast?.show("Download isn't available right now — please refresh and try again.", true);
            return false;
        }
        card.classList.add('is-capturing');
        try {
            const canvas = await window.html2canvas(card, {
                backgroundColor: null,
                scale: Math.min(window.devicePixelRatio || 1, 2) || 1,
                useCORS: true,
            });
            const blob = await canvasToBlobAsyncStaff(canvas);
            if (!blob) throw new Error('canvas.toBlob returned no data');

            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `inigosync-walkin-receipt-${filenameId}.png`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 4000);
            return true;
        } catch (err) {
            console.error('[staff] receipt PNG download failed', err);
            window.InigoToast?.show('Could not generate the receipt image. Please try again.', true);
            return false;
        } finally {
            card.classList.remove('is-capturing');
        }
    }

    function resetWalkinWizard() {
        const courts = walkinState.courts;
        const nightRateStartsAt = walkinState.nightRateStartsAt || null;
        walkinState = { name: '', mobile: '', mobileError: false, courts, court: null, unit: null, unitId: null, rateDay: null, rateNight: null, rateUnit: '/hr', rateQuantity: 1, nightRateStartsAt, startHour: null, endHour: null, payment: staffCashEnabled ? 'cash' : null };
        if (walkinRateQuantityInput) walkinRateQuantityInput.value = '1';
        if (walkinNameInput) walkinNameInput.value = '';
        if (walkinMobileInput) walkinMobileInput.value = '';
        if (walkinUnitWrap) walkinUnitWrap.hidden = true;
        renderWalkinSportChips();
        walkinBookings = { ok: true, rows: [] };
        walkinWalkins = { ok: true, rows: [] };
        renderWalkinTimePickers();
        walkinPaymentOptionEls.forEach((option) => {
            const radio = option.querySelector('input[type="radio"]');
            const isCash = staffCashEnabled && Boolean(radio && radio.dataset.staffPayment === 'cash');
            option.classList.toggle('is-selected', isCash);
            if (radio) radio.checked = isCash;
        });
        updateWalkinSummary();
        goToWalkinStep(1);
    }

    if (walkinSaveBtn) {
        walkinSaveBtn.addEventListener('click', async () => {
            if (walkinSaveBtn.disabled) return;
            if (!window.sb || !window.inigosyncProfile) {
                window.InigoToast?.show('Unable to reach the server right now. Please try again shortly.', true);
                return;
            }
            if (!walkinState.name) { window.InigoToast?.show("Enter the customer's name.", true); goToWalkinStep(1); return; }
            if (!walkinState.court) { window.InigoToast?.show('Select a sport/court.', true); goToWalkinStep(2); return; }
            if (walkinState.startHour === null || walkinState.endHour === null) { window.InigoToast?.show('Select a start and end time.', true); goToWalkinStep(3); return; }
            if (!staffCashEnabled || walkinState.payment !== 'cash') {
                window.InigoToast?.show('Cash collection is unavailable. Ask the owner to enable Cash in Payment Configuration.', true);
                goToWalkinStep(4);
                return;
            }

            const requestedSelection = {
                courtName: walkinState.court.name,
                unit: walkinState.unit || '',
                startHour: walkinState.startHour,
                endHour: walkinState.endHour,
                rateUnit: walkinState.rateUnit,
                rateQuantity: walkinState.rateQuantity,
                name: walkinState.name,
                mobile: walkinState.mobile,
                payment: walkinState.payment,
            };
            walkinSaveBtn.disabled = true;
            walkinSaveBtn.textContent = 'Checking availability…';

            // Re-check both reservation channels from one occupancy
            // snapshot immediately before inserting. The database's shared
            // exclusion constraint is still the final race-safe guard.
            const recheck = await fetchWalkinOccupancyForCourt(requestedSelection.courtName);
            if (!recheck.ok) {
                walkinSaveBtn.disabled = false;
                walkinSaveBtn.textContent = 'Save Walk-In';
                window.InigoToast?.show('Could not verify live availability. Please try again.', true);
                refreshWalkinTimePickers();
                return;
            }
            if ((walkinState.court?.name || '') !== requestedSelection.courtName
                || (walkinState.unit || '') !== requestedSelection.unit
                || walkinState.startHour !== requestedSelection.startHour
                || walkinState.endHour !== requestedSelection.endHour
                || walkinState.rateUnit !== requestedSelection.rateUnit
                || walkinState.rateQuantity !== requestedSelection.rateQuantity
                || walkinState.name !== requestedSelection.name
                || walkinState.mobile !== requestedSelection.mobile
                || walkinState.payment !== requestedSelection.payment) {
                walkinSaveBtn.disabled = false;
                walkinSaveBtn.textContent = 'Save Walk-In';
                window.InigoToast?.show('Your selection changed. Please review the updated time and save again.', true);
                refreshWalkinTimePickers();
                return;
            }
            walkinBookings = { ok: true, rows: recheck.rows.filter((row) => row.source === 'online') };
            walkinWalkins = { ok: true, rows: recheck.rows.filter((row) => row.source === 'walkin' || row.source === 'maintenance') };
            let conflict = false;
            if (walkinBookings.ok && walkinWalkins.ok) {
                for (let h = walkinState.startHour; h <= walkinState.endHour; h++) {
                    if (isWalkinHourBooked(h)) { conflict = true; break; }
                }
            }
            if (conflict) {
                window.InigoToast?.show('That time was just taken — please pick another time.', true);
                walkinSaveBtn.disabled = false;
                walkinSaveBtn.textContent = 'Save Walk-In';
                walkinState.startHour = null;
                walkinState.endHour = null;
                renderWalkinTimePickers();
                updateWalkinSummary();
                goToWalkinStep(3);
                return;
            }

            const hours = walkinState.endHour - walkinState.startHour + 1;
            const todayStr = todayDateInputValue();
            const startIso = new Date(`${todayStr}T${String(walkinState.startHour).padStart(2, '0')}:00:00`).toISOString();
            const endIso = new Date(`${todayStr}T${String(walkinState.endHour + 1).padStart(2, '0')}:00:00`).toISOString();
            const paymentLabel = 'Cash';

            // Revision S2 (implementation_plan.md, decisions S12/S13b) —
            // amount_total (rate × hours when the court's rate is known,
            // else null — same "Rate TBA" honesty rule the summary/receipt
            // above already use) and amount_paid (a walk-in pays at the
            // desk, so it equals amount_total the moment the rate is known;
            // zero otherwise) only exist once database/schema/
            // 017_booking_payment.sql is applied.
            let amountTotal = null;
            if (walkinState.rateUnit === '/set' && typeof walkinState.rateDay === 'number') amountTotal = walkinState.rateDay * walkinState.rateQuantity;
            else if (typeof walkinState.rateDay === 'number' && (typeof walkinState.rateNight !== 'number' || walkinState.rateDay === walkinState.rateNight)) amountTotal = walkinState.rateDay * hours;
            else if (typeof walkinState.rateDay !== 'number' && typeof walkinState.rate === 'number') amountTotal = walkinState.rate * hours;
            else if (typeof walkinState.rateDay === 'number' && typeof walkinState.rateNight === 'number') amountTotal = walkinHourlyAmount(hours);
            const amountPaid = amountTotal !== null ? amountTotal : 0;

            const fullPayload = {
                staff_id: window.inigosyncProfile.id,
                sports: walkinState.court.sportName || walkinState.court.name,
                courts: walkinState.court.name,
                court_listing_id: walkinState.court.id || null,
                court_unit: walkinState.unit || null,
                court_unit_inventory_id: walkinState.unitId || null,
                customer_name: walkinState.name,
                customer_mobile: walkinState.mobile || null,
                time_date: startIso,
                end_at: endIso,
                duration_minutes: hours * 60,
                payment_method: paymentLabel,
                status: 'pending',
                payment_id: null,
                amount_total: amountTotal,
                amount_paid: amountPaid,
                rate_quantity: walkinState.rateUnit === '/set' ? walkinState.rateQuantity : 1,
            };

            walkinSaveBtn.disabled = true;
            walkinSaveBtn.textContent = 'Saving…';

            // court_unit/end_at/payment_method only exist once
            // database/schema/016_walkin_checkin.sql is applied;
            // amount_total/amount_paid only exist once
            // 017_booking_payment.sql is applied. Three tiers, not two: a
            // database with 016 but not yet 017 (the expected state right
            // after this revision ships, until the owner runs 017) should
            // still keep its per-unit availability/end time/payment method
            // — it only has to drop the two NEWEST columns, not fall all the
            // way back to the pre-016 shape. Same "never fake success"
            // schema-mismatch retry idiom this file has always used for
            // walk-in inserts, just with an extra rung. Court, unit, and
            // time fields are never dropped because that would save a slot
            // different from the one the availability check approved.
            let { data, error } = await window.sb.from('walk_in_booking').insert(fullPayload).select();
            let missingPaymentColumnsOnly = false;
            if (error && isSchemaMismatchError(error)) {
                const paymentColumnsDroppedPayload = {
                    staff_id: fullPayload.staff_id,
                    sports: fullPayload.sports,
                    courts: fullPayload.courts,
                    court_unit: fullPayload.court_unit,
                    court_unit_inventory_id: fullPayload.court_unit_inventory_id,
                    customer_name: fullPayload.customer_name,
                    customer_mobile: fullPayload.customer_mobile,
                    time_date: fullPayload.time_date,
                    end_at: fullPayload.end_at,
                    duration_minutes: fullPayload.duration_minutes,
                    payment_method: fullPayload.payment_method,
                    status: fullPayload.status,
                    payment_id: fullPayload.payment_id,
                };
                ({ data, error } = await window.sb.from('walk_in_booking').insert(paymentColumnsDroppedPayload).select());
                if (!error) {
                    missingPaymentColumnsOnly = true;
                }
            }

            walkinSaveBtn.disabled = false;
            walkinSaveBtn.textContent = 'Save Walk-In';

            if (error) {
                window.InigoToast?.show(error.code === '23P01'
                    ? 'That court and time were just taken. Please choose another slot.'
                    : (error.message || 'Could not record this walk-in.'), true);
                if (error.code === '23P01') refreshWalkinTimePickers();
                return;
            }

            const savedRow = (data && data[0]) || null;
            const idField = savedRow ? walkinIdField(savedRow) : null;
            const receiptId = (savedRow && idField) ? savedRow[idField] : Date.now();

            let saveNote = 'Walk-in recorded.';
            if (missingPaymentColumnsOnly) {
                saveNote = 'Walk-in recorded — payment amounts need database/schema/017_booking_payment.sql.';
            }
            window.InigoToast?.show(saveNote);

            const savedAmountTotal = savedRow && savedRow.amount_total !== null && savedRow.amount_total !== undefined
                ? Number(savedRow.amount_total) : null;
            renderStaffReceipt({
                id: receiptId,
                customerName: walkinState.name,
                customerMobile: walkinState.mobile || null,
                courtName: walkinState.court.name,
                unit: walkinState.unit,
                startIso,
                endIso,
                hours,
                amountTotal: Number.isFinite(savedAmountTotal) ? savedAmountTotal : null,
                paymentLabel,
            });

            if (walkinWizardWrap) walkinWizardWrap.hidden = true;
            if (walkinReceiptWrap) walkinReceiptWrap.hidden = false;

            refreshBookingOverview();
            refreshCourtSchedule();
            refreshTransactions();
            refreshStaffNotifications();
        });
    }

    // Event delegation — the receipt markup is fully replaced on every
    // save, so this binds once on the never-replaced wrapper instead of on
    // the buttons themselves.
    if (walkinReceiptWrap) {
        walkinReceiptWrap.addEventListener('click', async (e) => {
            const downloadBtn = e.target.closest('[data-staff-receipt-download]');
            const printBtn = e.target.closest('[data-staff-receipt-print]');
            const resetBtn = e.target.closest('[data-staff-walkin-reset]');

            if (downloadBtn) {
                const card = downloadBtn.closest('.staff-receipt-card');
                if (!card) return;
                const original = downloadBtn.textContent;
                downloadBtn.disabled = true;
                downloadBtn.textContent = 'Preparing…';
                const ok = await downloadStaffReceiptAsPng(card, downloadBtn.dataset.staffReceiptDownload || 'receipt');
                downloadBtn.disabled = false;
                downloadBtn.textContent = original;
                if (ok) window.InigoToast?.show('Receipt downloaded.');
                return;
            }
            if (printBtn) {
                window.print();
                return;
            }
            if (resetBtn) {
                if (walkinWizardWrap) walkinWizardWrap.hidden = false;
                if (walkinReceiptWrap) walkinReceiptWrap.hidden = true;
                resetWalkinWizard();
            }
        });
    }

    renderWalkinWizard();
    updateWalkinSummary();
    renderWalkinTimePickers();

    // ------------------------------------------------------------------
    // Time-In payment popup — Revision S2 (implementation_plan.md, decisions
    // S11/S14). Opened by every Time-In button (Booking Overview above and
    // Transaction Records further below, both via wireTimeInButtons()
    // below) INSTEAD of writing checked_in_at immediately (Revision S1's
    // behaviour) — shows the booking/walk-in's Total/Paid so far/Balance
    // due (timeInPaymentInfo(), Shared helpers section above) and, when a
    // balance is owed, requires picking Cash/Online payment before the
    // confirm button both collects it and times the customer in. Same
    // mousedown+click backdrop-detection / Esc / focus-management modal
    // idiom as includes/owner_dashboard.js's [data-admin-court-modal]/
    // [data-admin-staff-modal], ported here under staff-modal-*/
    // staff-timein-* names (Style/staff_dashboard.css's new
    // .staff-modal-overlay/.staff-modal rules).
    // ------------------------------------------------------------------
    const timeInModal = document.querySelector('[data-staff-timein-modal]');
    const timeInDialog = document.querySelector('[data-staff-timein-dialog]');
    const timeInCustomerEl = document.querySelector('[data-staff-timein-customer]');
    const timeInCourtEl = document.querySelector('[data-staff-timein-court]');
    const timeInDateEl = document.querySelector('[data-staff-timein-date]');
    const timeInTimeEl = document.querySelector('[data-staff-timein-time]');
    const timeInHoursEl = document.querySelector('[data-staff-timein-hours]');
    const timeInTotalEl = document.querySelector('[data-staff-timein-total]');
    const timeInPaidEl = document.querySelector('[data-staff-timein-paid]');
    const timeInBalanceEl = document.querySelector('[data-staff-timein-balance]');
    const timeInNoteEl = document.querySelector('[data-staff-timein-note]');
    const timeInPaymentWrap = document.querySelector('[data-staff-timein-payment-wrap]');
    const timeInPaymentOptionEls = document.querySelectorAll('[data-staff-timein-payment-wrap] [data-staff-payment-option]');
    const timeInConfirmBtn = document.querySelector('[data-staff-timein-confirm]');
    const timeInCancelBtn = document.querySelector('[data-staff-timein-cancel]');
    const timeInCloseBtn = document.querySelector('[data-staff-timein-close]');

    const TIMEIN_MODAL_CLOSE_DELAY_MS = 250;
    let timeInModalHideTimer = null;
    let timeInModalIsOpen = false;
    let timeInModalLastFocused = null;
    let timeInModalRow = null;
    let timeInSelectedMethod = null;
    let timeInRefreshSeq = 0;

    // { table, idField, idValue } for either source type — booking_id for a
    // booking (same column timeInBooking() used pre-S2), or whichever
    // WALKIN_ID_CANDIDATES key is actually present for a walk-in.
    function rowTableTarget(row) {
        if (row.sourceType === 'booking') {
            return { table: 'booking', idField: 'booking_id', idValue: row.raw.booking_id };
        }
        const idField = walkinIdField(row.raw);
        return { table: 'walk_in_booking', idField, idValue: idField ? row.raw[idField] : null };
    }

    async function fetchFreshTimeInRow(row) {
        const target = rowTableTarget(row);
        if (!target.idField || target.idValue === null || target.idValue === undefined) {
            return { error: "Can't identify this record." };
        }
        const { data, error } = await window.sb.from(target.table).select('*').eq(target.idField, target.idValue).maybeSingle();
        if (error || !data) return { error: error?.message || 'Could not refresh this payment status.' };
        const fresh = target.table === 'booking'
            ? mergeBookingRows([data], [])[0]
            : mergeBookingRows([], [data])[0];
        fresh.customerName = row.customerName || fresh.customerName;
        return { row: fresh };
    }

    function timeInBalanceConfirmed(row) {
        const rawTotal = row?.raw?.amount_total;
        const rawPaid = row?.raw?.amount_paid;
        if (rawTotal === null || rawTotal === undefined || rawPaid === null || rawPaid === undefined) return false;
        const total = Number(rawTotal);
        const paid = Number(rawPaid);
        return Number.isFinite(total) && total >= 0 && Number.isFinite(paid) && paid >= total;
    }

    // Paints every field/row/note/button in the popup for `row` — called
    // once on open (openTimeInModal below); nothing here mutates `row`
    // itself, so re-opening the SAME row after a failed confirm just
    // re-derives the identical state.
    function renderTimeInModal(row) {
        const info = timeInPaymentInfo(row);
        const fallbackName = row.sourceType === 'walkin' ? 'Walk-in customer' : 'Customer';

        if (timeInCustomerEl) timeInCustomerEl.textContent = row.customerName || fallbackName;
        if (timeInCourtEl) timeInCourtEl.textContent = row.unit ? `${row.courts || '—'} · ${row.unit}` : (row.courts || '—');
        if (timeInDateEl) timeInDateEl.textContent = formatWalkinDateLabel(info.start.toISOString());
        if (timeInTimeEl) timeInTimeEl.textContent = `${formatIsoTime12h(info.start.toISOString())} – ${formatIsoTime12h(info.end.toISOString())}`;
        if (timeInHoursEl) {
            timeInHoursEl.textContent = row.raw.rate_unit_snapshot === '/set'
                ? `${Math.max(1, Number(row.raw.rate_quantity) || 1)} set${Number(row.raw.rate_quantity) === 1 ? '' : 's'} · 60 min each`
                : `${info.hours} hr${info.hours === 1 ? '' : 's'}`;
        }

        const knownTotal = info.total !== null;
        const needsPayment = knownTotal && info.balance > 0;

        if (timeInTotalEl) timeInTotalEl.textContent = knownTotal ? formatStaffPeso(info.total) : 'Rate TBA';
        if (timeInPaidEl) timeInPaidEl.textContent = knownTotal ? formatStaffPeso(info.paid) : 'Rate TBA';
        if (timeInBalanceEl) timeInBalanceEl.textContent = knownTotal ? formatStaffPeso(info.balance) : 'Rate TBA';

        timeInSelectedMethod = null;
        timeInPaymentOptionEls.forEach((option) => {
            option.classList.remove('is-selected');
            const radio = option.querySelector('input[type="radio"]');
            if (radio) radio.checked = false;
        });
        if (timeInPaymentWrap) timeInPaymentWrap.hidden = !needsPayment;

        if (timeInNoteEl) {
            if (!knownTotal) {
                timeInNoteEl.textContent = 'Rate TBA — nothing to collect yet.';
                timeInNoteEl.hidden = false;
            } else if (!needsPayment) {
                timeInNoteEl.textContent = 'Fully paid.';
                timeInNoteEl.hidden = false;
            } else {
                timeInNoteEl.hidden = true;
            }
        }

        if (timeInConfirmBtn) {
            if (needsPayment) {
                timeInConfirmBtn.textContent = timeInSelectedMethod === 'PayMongo'
                    ? `Pay ${formatStaffPeso(info.balance)} with PayMongo`
                    : `Collect ${formatStaffPeso(info.balance)} & Time-In`;
                timeInConfirmBtn.disabled = true;
            } else {
                timeInConfirmBtn.textContent = 'Time-In';
                timeInConfirmBtn.disabled = false;
            }
        }
    }

    async function openTimeInModal(row) {
        if (!timeInModal) return;
        const requestSeq = ++timeInRefreshSeq;
        timeInModalRow = row;
        timeInModalLastFocused = document.activeElement;
        renderTimeInModal(row);

        if (timeInModalHideTimer) { window.clearTimeout(timeInModalHideTimer); timeInModalHideTimer = null; }
        timeInModal.hidden = false;
        // Force a synchronous layout flush so the browser commits the
        // hidden->visible state before [data-open] flips opacity to 1 —
        // same trick includes/owner_dashboard.js's modals use.
        void timeInModal.offsetWidth;
        timeInModal.setAttribute('data-open', '');
        timeInModalIsOpen = true;

        if (timeInConfirmBtn) {
            timeInConfirmBtn.disabled = true;
            timeInConfirmBtn.textContent = 'Checking payment…';
        }

        // No single obvious "first field" to focus — the payment radios are
        // hidden in two of the three cases — so the dialog itself gets
        // initial focus (it carries tabindex="-1" precisely for this).
        if (timeInDialog) timeInDialog.focus();

        const freshResult = await fetchFreshTimeInRow(row);
        if (!timeInModalIsOpen || requestSeq !== timeInRefreshSeq) return;
        if (freshResult.error) {
            if (timeInNoteEl) {
                timeInNoteEl.textContent = 'Could not refresh the latest payment status. Close this window and try again.';
                timeInNoteEl.hidden = false;
            }
            if (timeInConfirmBtn) timeInConfirmBtn.textContent = 'Status unavailable';
            return;
        }
        timeInModalRow = freshResult.row;
        renderTimeInModal(freshResult.row);
    }

    function closeTimeInModal() {
        if (!timeInModalIsOpen || !timeInModal) return;
        timeInModalIsOpen = false;
        timeInRefreshSeq += 1;
        timeInModalRow = null;

        timeInModal.removeAttribute('data-open');
        if (timeInModalHideTimer) window.clearTimeout(timeInModalHideTimer);
        timeInModalHideTimer = window.setTimeout(() => {
            timeInModal.hidden = true;
            timeInModalHideTimer = null;
        }, TIMEIN_MODAL_CLOSE_DELAY_MS);

        if (timeInModalLastFocused && typeof timeInModalLastFocused.focus === 'function' && document.contains(timeInModalLastFocused)) {
            timeInModalLastFocused.focus();
        }
        timeInModalLastFocused = null;
    }

    // Shared by Booking Overview and Transaction Records — both tables
    // render the identical Time-In button (staffActionCellHtml() above) and
    // must open the identical popup; `getRows` reads whichever array that
    // table's own refresh function most recently populated (overviewRows/
    // transactionRows), since rows are fully replaced (not patched) on
    // every refresh and a plain per-button listener would not survive that.
    function wireTimeInButtons(tbody, getRows) {
        if (!tbody) return;
        tbody.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-staff-action="timein"]');
            if (!btn || btn.disabled) return;
            const tr = btn.closest('tr');
            if (!tr) return;
            const row = getRows()[Number(tr.dataset.rowIndex)];
            if (!row) return;
            openTimeInModal(row);
        });
    }

    if (timeInCloseBtn) timeInCloseBtn.addEventListener('click', closeTimeInModal);
    if (timeInCancelBtn) timeInCancelBtn.addEventListener('click', closeTimeInModal);

    // Same mousedown+click pair as includes/owner_dashboard.js's modals — a
    // plain 'click' listener on the overlay also fires when a drag STARTS
    // inside the dialog and ENDS on the backdrop once released there; only
    // treat it as a real backdrop click when BOTH events landed on the
    // overlay element itself, not a descendant.
    let timeInModalMouseDownOnBackdrop = false;
    if (timeInModal) {
        timeInModal.addEventListener('mousedown', (e) => {
            timeInModalMouseDownOnBackdrop = e.target === timeInModal;
        });
        timeInModal.addEventListener('click', (e) => {
            if (e.target === timeInModal && timeInModalMouseDownOnBackdrop) closeTimeInModal();
            timeInModalMouseDownOnBackdrop = false;
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && timeInModalIsOpen) closeTimeInModal();
    });

    timeInPaymentOptionEls.forEach((option) => {
        option.addEventListener('click', () => {
            if (option.hidden) return;
            const radio = option.querySelector('input[type="radio"]');
            if (!radio) return;
            timeInPaymentOptionEls.forEach((o) => o.classList.remove('is-selected'));
            option.classList.add('is-selected');
            radio.checked = true;
            timeInSelectedMethod = radio.dataset.staffTimeinMethod;
            if (timeInConfirmBtn) {
                const info = timeInPaymentInfo(timeInModalRow);
                timeInConfirmBtn.disabled = false;
                timeInConfirmBtn.textContent = timeInSelectedMethod === 'PayMongo'
                    ? `Pay ${formatStaffPeso(info.balance)} with PayMongo`
                    : `Collect ${formatStaffPeso(info.balance)} & Time-In`;
            }
        });
    });

    if (timeInConfirmBtn) {
        timeInConfirmBtn.addEventListener('click', async () => {
            if (timeInConfirmBtn.disabled || !timeInModalRow || !window.sb) return;
            const cachedRow = timeInModalRow;
            const target = rowTableTarget(cachedRow);
            if (!target.idField || target.idValue === null || target.idValue === undefined) {
                window.InigoToast?.show("Can't identify this record.", true);
                return;
            }
            const source = cachedRow.sourceType === 'booking' ? 'booking' : 'walkin';
            timeInConfirmBtn.disabled = true;
            timeInConfirmBtn.textContent = 'Checking payment…';

            const freshResult = await fetchFreshTimeInRow(cachedRow);
            if (freshResult.error) {
                timeInConfirmBtn.disabled = false;
                renderTimeInModal(cachedRow);
                window.InigoToast?.show(freshResult.error, true);
                return;
            }
            const row = freshResult.row;
            timeInModalRow = row;
            const info = timeInPaymentInfo(row);
            const needsPayment = info.total !== null && info.balance > 0;
            if (needsPayment && !timeInSelectedMethod) {
                renderTimeInModal(row);
                window.InigoToast?.show('Choose Cash or PayMongo first.', true);
                return;
            }

            if (needsPayment && timeInSelectedMethod === 'PayMongo') {
                timeInConfirmBtn.textContent = 'Opening PayMongo…';
                let checkout;
                try {
                    checkout = await window.sb.functions.invoke('paymongo-balance-checkout', {
                        body: { source, id: String(target.idValue) },
                    });
                } catch (error) {
                    checkout = { error };
                }
                const checkoutUrl = checkout?.data?.checkout_url;
                if (checkout?.error || typeof checkoutUrl !== 'string' || !checkoutUrl.startsWith('https://checkout.paymongo.com/')) {
                    timeInConfirmBtn.disabled = false;
                    renderTimeInModal(row);
                    window.InigoToast?.show(checkout?.error?.message || 'Could not start PayMongo checkout.', true);
                    return;
                }
                window.location.assign(checkoutUrl);
                return;
            }

            timeInConfirmBtn.textContent = needsPayment ? 'Collecting cash…' : 'Confirming attendance…';
            let collection;
            try {
                collection = await window.sb.rpc('staff_collect_cash_and_check_in', {
                    p_source: source,
                    p_id: String(target.idValue),
                });
            } catch (error) {
                collection = { error };
            }
            if (collection?.error || collection?.data?.ok === false || collection?.data?.success === false) {
                timeInConfirmBtn.disabled = false;
                renderTimeInModal(row);
                window.InigoToast?.show(collection?.error?.message || collection?.data?.message || 'Could not confirm payment and attendance.', true);
                return;
            }

            if (needsPayment) {
                window.InigoToast?.show(`Timed in · ${formatStaffPeso(info.balance)} collected in Cash.`);
            } else {
                window.InigoToast?.show('Timed in.');
            }

            closeTimeInModal();
            refreshBookingOverview();
            refreshCourtSchedule();
            refreshTransactions();
            refreshStaffNotifications();
        });
    }

    // ------------------------------------------------------------------
    // Court Schedule — Revision S1, decision S5. Per-unit hourly
    // availability grid for a chosen date (default/min today), replacing
    // the old fixed 2-hour/all-courts-as-columns CSS grid. One row per
    // UNIT of the selected sport (resolveCourtUnits()); "All Courts" lists
    // every unit of every sport, each row prefixed with its court name.
    // ------------------------------------------------------------------
    const scheduleDateInput = document.querySelector('[data-staff-schedule-date]');
    const scheduleSportTabs = document.querySelector('[data-staff-sport-tabs]');
    const scheduleTable = document.querySelector('[data-staff-schedule-grid]');

    let scheduleActiveSport = 'all';
    let scheduleDate = todayDateInputValue();
    let scheduleCourtsCache = [];
    let scheduleBookingsCache = [];
    let scheduleWalkinsCache = [];
    let scheduleNameMap = new Map();
    let scheduleDataOk = true;
    let scheduleRequestSeq = 0;

    if (scheduleDateInput) {
        scheduleDateInput.min = todayDateInputValue();
        scheduleDateInput.value = scheduleDate;
        scheduleDateInput.addEventListener('change', () => {
            const minStr = todayDateInputValue();
            if (scheduleDateInput.value < minStr) {
                scheduleDateInput.value = minStr;
                window.InigoToast?.show("You can't view a date in the past — showing today instead.", true);
            }
            scheduleDate = scheduleDateInput.value;
            refreshCourtSchedule();
        });
    }

    // Groups active court rows by sport, then flattens each court's units
    // (resolveCourtUnits()) into one row per unit. A row is prefixed with
    // its court's own name whenever more than one court row shares a sport
    // (Bowling's Duckpin/Ten-Pin) or the view is "All Courts" — otherwise
    // (the common case: one court per sport) the unit label alone is
    // enough context.
    function scheduleRowsForSport(sportSlug, courts) {
        if (!window.InigoCourtsData) return [];
        const matching = sportSlug === 'all' ? courts : courts.filter((c) => c.sportSlug === sportSlug);

        const bySport = new Map();
        matching.forEach((c) => {
            const key = c.sportSlug || c.sportName || c.name;
            if (!bySport.has(key)) bySport.set(key, []);
            bySport.get(key).push(c);
        });

        const rows = [];
        matching.forEach((court) => {
            const key = court.sportSlug || court.sportName || court.name;
            const siblingCount = bySport.get(key).length;
            const { units } = window.InigoCourtsData.resolveCourtUnits(court);
            units.forEach((unit, i) => {
                const unitValue = unit.label || '';
                const displayUnit = unit.label || court.name;
                const rowLabel = (sportSlug === 'all' || siblingCount > 1) ? `${court.name} — ${displayUnit}` : displayUnit;
                rows.push({ court, unitValue, rowLabel, key: `${court.id}:${i}` });
            });
        });
        return rows;
    }

    function scheduleTooltipFor(row, sourceLabel, nameOverride) {
        const name = nameOverride || scheduleNameMap.get(String(row.customer_id)) || 'Customer';
        const { start, end } = rowWindow(row);
        const startLabel = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const endLabel = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return `${name} (${sourceLabel}) ${startLabel}–${endLabel}`;
    }

    // Past takes priority over booked (same precedence
    // includes/Dashboard.js's own slotHourStatus() uses for the Overview
    // peek strip) — an elapsed hour reads as past regardless of whether it
    // was ever booked.
    function scheduleCellInfo(row, hour, dateBase, bookings, walkins) {
        const slot = hourWindow(hour, dateBase);
        if (scheduleDate === todayDateInputValue() && slot.start.getTime() < Date.now()) {
            return { cls: 'is-past', title: '' };
        }

        const bookingMatch = bookings.find((b) => {
            if (!sameCourtName(b.courts, row.court.name)) return false;
            if (!courtUnitsOverlap(b.court_unit, row.unitValue)) return false;
            return windowsOverlap(rowWindow(b), slot);
        });
        if (bookingMatch) return { cls: 'is-booked', title: scheduleTooltipFor(bookingMatch, 'Online') };

        const walkinMatch = walkins.find((w) => {
            if (w.source === 'maintenance') return false;
            if (!sameCourtName(w.courts, row.court.name)) return false;
            if (!courtUnitsOverlap(w.court_unit, row.unitValue)) return false;
            return windowsOverlap(rowWindow(w), slot);
        });
        if (walkinMatch) return { cls: 'is-booked', title: scheduleTooltipFor(walkinMatch, 'Walk-in', walkinMatch.customer_name || 'Walk-in customer') };

        const maintenanceMatch = walkins.find((m) => m.source === 'maintenance'
            && sameCourtName(m.courts, row.court.name)
            && courtUnitsOverlap(m.court_unit, row.unitValue)
            && windowsOverlap(rowWindow(m), slot));
        if (maintenanceMatch) {
            const { start, end } = rowWindow(maintenanceMatch);
            const startLabel = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
            const endLabel = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
            return { cls: 'is-booked', label: 'Maintenance', title: `${maintenanceMatch.note || 'Court maintenance'} · ${startLabel}–${endLabel}` };
        }

        return { cls: 'is-open', title: '' };
    }

    function renderCourtSchedule(courts, bookings, walkins) {
        if (!scheduleTable || !window.InigoCourtsData || !window.InigoBusinessHours) return;
        const hours = window.InigoBusinessHours.hoursRange();
        const dateBase = new Date(`${scheduleDate}T00:00:00`);
        const rows = scheduleRowsForSport(scheduleActiveSport, courts);

        const thead = scheduleTable.querySelector('thead');
        const tbody = scheduleTable.querySelector('tbody');
        if (!thead || !tbody) return;

        thead.innerHTML = `<tr><th>Court / Unit</th>${hours.map((h) => `<th>${window.escapeHtml(window.InigoBusinessHours.formatHourRangeLabelShort(h))}</th>`).join('')}<th>Open hours</th></tr>`;

        if (!scheduleDataOk) {
            tbody.innerHTML = `<tr><td colspan="${hours.length + 2}" style="text-align:center; color: var(--color-ink-faint);">Could not verify live availability. Please refresh the schedule.</td></tr>`;
            return;
        }

        if (rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${hours.length + 2}" style="text-align:center; color: var(--color-ink-faint);">No courts to show.</td></tr>`;
            return;
        }

        tbody.innerHTML = rows.map((row) => {
            let openCount = 0;
            const cells = hours.map((hour) => {
                const info = scheduleCellInfo(row, hour, dateBase, bookings, walkins);
                if (info.cls === 'is-open') openCount += 1;
                const titleAttr = info.title ? ` title="${window.escapeHtml(info.title)}"` : '';
                const label = info.label || (info.cls === 'is-booked' ? 'Booked' : (info.cls === 'is-past' ? '—' : 'Open'));
                return `<td class="staff-schedule-cell ${info.cls}"${titleAttr}>${label}</td>`;
            }).join('');
            return `<tr><td>${window.escapeHtml(row.rowLabel)}</td>${cells}<td class="staff-schedule-trailer">${openCount} open hour${openCount === 1 ? '' : 's'}</td></tr>`;
        }).join('');
    }

    async function renderScheduleSportTabs() {
        if (!scheduleSportTabs || !window.InigoCourtsData) return;
        const sports = await window.InigoCourtsData.getSports();
        const chips = ['<button type="button" class="staff-chip is-active" data-staff-chip data-staff-sport="all">All Courts</button>']
            .concat(sports.map((s) => `<button type="button" class="staff-chip" data-staff-chip data-staff-sport="${window.escapeHtml(s.slug)}">${window.escapeHtml(s.name)}</button>`));
        scheduleSportTabs.innerHTML = chips.join('');
        scheduleActiveSport = 'all';

        scheduleSportTabs.querySelectorAll('[data-staff-chip]').forEach((chip) => {
            chip.addEventListener('click', () => {
                scheduleSportTabs.querySelectorAll('[data-staff-chip]').forEach((c) => c.classList.remove('is-active'));
                chip.classList.add('is-active');
                scheduleActiveSport = chip.dataset.staffSport;
                renderCourtSchedule(scheduleCourtsCache, scheduleBookingsCache, scheduleWalkinsCache);
            });
        });
    }

    async function refreshCourtSchedule() {
        if (!scheduleTable || !window.sb || !window.InigoCourtsData) return;

        const mySeq = ++scheduleRequestSeq;
        const dateBase = new Date(`${scheduleDate}T00:00:00`);
        const dayEnd = new Date(dateBase.getFullYear(), dateBase.getMonth(), dateBase.getDate() + 1);
        let courts;
        let occupancyRes;
        try {
            [courts, occupancyRes] = await Promise.all([
                window.InigoCourtsData.getCourts(),
                window.sb.rpc('court_occupancy', {
                    from_at: dateBase.toISOString(), to_at: dayEnd.toISOString(),
                }),
            ]);
        } catch (error) {
            console.error('[staff] failed to load court schedule availability', error);
            if (mySeq !== scheduleRequestSeq) return;
            scheduleDataOk = false;
            renderCourtSchedule(scheduleCourtsCache, [], []);
            return;
        }
        if (mySeq !== scheduleRequestSeq) return;
        if (occupancyRes.error) console.error('[staff] failed to load court schedule availability', occupancyRes.error);
        scheduleDataOk = !occupancyRes.error;
        const rows = scheduleDataOk ? (occupancyRes.data || []) : [];
        const bookings = rows.filter((row) => row.source === 'online');
        const walkins = rows.filter((row) => row.source === 'walkin' || row.source === 'maintenance');

        scheduleNameMap = new Map();

        scheduleCourtsCache = courts;
        scheduleBookingsCache = bookings;
        scheduleWalkinsCache = walkins;
        renderCourtSchedule(courts, bookings, walkins);
    }

    renderScheduleSportTabs();
    refreshCourtSchedule();
    document.addEventListener('inigosync:profile-ready', refreshCourtSchedule);

    // ------------------------------------------------------------------
    // Transaction Records — Revision S1, decision S6. A time-in log:
    // bookings + walk-ins for a chosen date range (default today..today),
    // union, newest first, with Timed in/Timed out columns. `audit_log` is
    // no longer read here; every value below comes straight from the
    // real booking/walk_in_booking rows via the same staffDerivedStatus()/
    // mergeBookingRows() Booking Overview uses, so the two panels can never
    // disagree about a row's status.
    // ------------------------------------------------------------------
    const transactionsTableBody = document.querySelector('[data-staff-table="transactions"] tbody');
    const txFromInput = document.querySelector('[data-staff-tx-from]');
    const txToInput = document.querySelector('[data-staff-tx-to]');
    // Revision S2 (implementation_plan.md, decisions S11/S14) — this
    // table's own rows, indexed the same way overviewRows is above, so its
    // Action column's Time-In button (added below) can open the same
    // Time-In payment popup Booking Overview uses.
    let transactionRows = [];

    if (txFromInput) txFromInput.value = todayDateInputValue();
    if (txToInput) txToInput.value = todayDateInputValue();
    if (txFromInput) txFromInput.addEventListener('change', refreshTransactions);
    if (txToInput) txToInput.addEventListener('change', refreshTransactions);

    async function refreshTransactions() {
        if (!transactionsTableBody || !window.sb) return;

        const fromStr = (txFromInput && txFromInput.value) || todayDateInputValue();
        const toStr = (txToInput && txToInput.value) || todayDateInputValue();
        const rangeStart = new Date(`${fromStr}T00:00:00`);
        const rangeEndExclusive = new Date(new Date(`${toStr}T00:00:00`).getTime() + 24 * 60 * 60 * 1000);

        const [bookingsRes, walkinsRes] = await Promise.all([
            window.sb.from('booking').select('*').gte('time_date', rangeStart.toISOString()).lt('time_date', rangeEndExclusive.toISOString()),
            window.sb.from('walk_in_booking').select('*').gte('time_date', rangeStart.toISOString()).lt('time_date', rangeEndExclusive.toISOString()),
        ]);

        if (bookingsRes.error && walkinsRes.error) {
            console.error('[staff] failed to load transaction records', bookingsRes.error, walkinsRes.error);
            transactionsTableBody.innerHTML = '<tr><td colspan="10" style="text-align:center; color: var(--color-ink-faint);">Could not load transaction records right now.</td></tr>';
            return;
        }
        if (bookingsRes.error) console.error('[staff] failed to load bookings for transactions', bookingsRes.error);
        if (walkinsRes.error) console.error('[staff] failed to load walk-ins for transactions', walkinsRes.error);

        const bookings = bookingsRes.error ? [] : (bookingsRes.data || []);
        const walkins = walkinsRes.error ? [] : (walkinsRes.data || []);
        const merged = mergeBookingRows(bookings, walkins);
        merged.sort((a, b) => new Date(b.time_date) - new Date(a.time_date)); // newest first (S6) — Overview sorts ascending instead

        const nameMap = await fetchProfileNamesByIds(merged.filter((r) => r.sourceType === 'booking').map((r) => r.customerId));
        merged.forEach((r) => {
            if (r.sourceType === 'booking') r.customerName = nameMap.get(String(r.customerId)) || 'Customer';
        });

        transactionRows = merged;
        transactionsTableBody.innerHTML = '';
        if (merged.length === 0) {
            transactionsTableBody.innerHTML = '<tr><td colspan="10" style="text-align:center; color: var(--color-ink-faint);">No transactions in this date range.</td></tr>';
            wireFilterableTable('transactions');
            return;
        }

        merged.forEach((row, i) => {
            const status = staffDerivedStatus(row);
            const { end } = rowWindow(row);
            const timedIn = row.checked_in_at ? formatIsoTime12h(row.checked_in_at) : '—';
            // "Timed out" is DERIVED (S6) — the end-of-booking time once the
            // session is Completed (checked in AND now >= end); never a
            // real checked_out_at write (S1's "auto time-out" rule).
            const timedOut = status === 'completed' ? formatIsoTime12h(end.toISOString()) : '—';
            const fallbackName = row.sourceType === 'walkin' ? 'Walk-in customer' : 'Customer';

            const tr = document.createElement('tr');
            tr.dataset.status = row.sourceType; // source filter chips (all/online/walkin) key off this
            tr.dataset.rowIndex = String(i);
            tr.innerHTML = `
                <td>${window.escapeHtml(new Date(row.time_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</td>
                <td class="staff-cell-main">${window.escapeHtml(row.customerName || fallbackName)}</td>
                <td>${window.escapeHtml(row.courts || '—')}${row.unit ? `<span class="staff-cell-sub">${window.escapeHtml(row.unit)}</span>` : ''}</td>
                <td>${window.escapeHtml(formatIsoTime12h(row.time_date))} – ${window.escapeHtml(formatIsoTime12h(end.toISOString()))}</td>
                <td><span class="staff-status ${row.sourceType === 'walkin' ? 'walkin' : 'online'}">${row.sourceType === 'walkin' ? 'Walk-in' : 'Online'}</span></td>
                <td>${window.escapeHtml(staffPaymentLabel(row))}</td>
                <td>${window.escapeHtml(timedIn)}</td>
                <td>${window.escapeHtml(timedOut)}</td>
                <td><span class="staff-status ${window.escapeHtml(status)}">${window.escapeHtml(staffStatusLabel(status))}</span></td>
                <td>${staffActionCellHtml(row, status)}</td>
            `;
            transactionsTableBody.appendChild(tr);
        });

        wireFilterableTable('transactions');
    }

    wireTimeInButtons(transactionsTableBody, () => transactionRows);

    refreshTransactions();
    document.addEventListener('inigosync:profile-ready', refreshTransactions);

    // ------------------------------------------------------------------
    // Notifications — Revision S1, decision S8. Ported from the owner
    // dashboard's bell (includes/owner_dashboard.js's [data-admin-notif*])
    // under staff-* names: items = bookings starting in the next 60
    // minutes, bookings created today, and today's walk-ins; unread dot vs
    // localStorage; click -> Overview; refresh on load, on
    // 'inigosync:profile-ready', and every 60 s; closes on outside
    // click/Esc (and when the profile dropdown opens, and vice versa —
    // see closeProfileMenu()/setActivePanel() above).
    // ------------------------------------------------------------------
    const staffNotif = document.querySelector('[data-staff-notif]');
    const staffNotifTrigger = document.querySelector('[data-staff-notif-trigger]');
    const staffNotifList = document.querySelector('[data-staff-notif-list]');
    const staffNotifDot = document.querySelector('[data-staff-notif-dot]');
    const STAFF_NOTIF_SEEN_KEY = 'inigosync-staff-notif-seen';
    const STAFF_NOTIF_REFRESH_MS = 60000;
    const STAFF_NOTIF_SOON_MINUTES = 60;

    function closeStaffNotifMenu() {
        if (staffNotif) staffNotif.removeAttribute('data-open');
        if (staffNotifTrigger) staffNotifTrigger.setAttribute('aria-expanded', 'false');
    }

    let staffNotifLatestAt = null;

    function markStaffNotifSeen() {
        if (!staffNotifLatestAt) return;
        try { localStorage.setItem(STAFF_NOTIF_SEEN_KEY, staffNotifLatestAt); } catch (_) { /* best-effort only */ }
        if (staffNotifDot) staffNotifDot.hidden = true;
    }

    if (staffNotifTrigger && staffNotif) {
        staffNotifTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = staffNotif.hasAttribute('data-open');
            closeProfileMenu();
            if (isOpen) {
                closeStaffNotifMenu();
            } else {
                staffNotif.setAttribute('data-open', '');
                staffNotifTrigger.setAttribute('aria-expanded', 'true');
                markStaffNotifSeen();
            }
        });

        document.addEventListener('click', (e) => {
            if (!staffNotif.contains(e.target)) closeStaffNotifMenu();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeStaffNotifMenu();
        });
    }

    function renderStaffNotificationItem(item) {
        return `<button type="button" class="staff-notif-item" data-staff-notif-item>
            <span class="staff-notif-dot ${item.dotClass}"></span>
            <span class="staff-notif-item-body">
                <strong>${window.escapeHtml(item.title)}</strong>
                <span>${window.escapeHtml(item.body)}</span>
            </span>
        </button>`;
    }

    async function refreshStaffNotifications() {
        if (!staffNotifList || !window.sb) return;

        let soonRows = [];
        let newTodayRows = [];
        let walkinRows = [];
        let loadFailed = false;

        try {
            const { start: todayStart } = todayRange();
            const nowIso = new Date().toISOString();
            const soonIso = new Date(Date.now() + STAFF_NOTIF_SOON_MINUTES * 60000).toISOString();

            const [soonRes, newTodayRes, walkinRes] = await Promise.all([
                window.sb.from('booking').select('*')
                    .in('status', ['pending', 'confirmed'])
                    .gte('time_date', nowIso).lte('time_date', soonIso)
                    .order('time_date', { ascending: true }).limit(10),
                window.sb.from('booking').select('*')
                    .gte('created_at', todayStart.toISOString())
                    .order('created_at', { ascending: false }).limit(10),
                fetchTodayWalkins(),
            ]);

            if (!soonRes.error) soonRows = soonRes.data || [];
            else { console.error('[staff] failed to load starting-soon notifications', soonRes.error); loadFailed = true; }

            if (!newTodayRes.error) newTodayRows = newTodayRes.data || [];
            else { console.error('[staff] failed to load new-booking notifications', newTodayRes.error); loadFailed = true; }

            walkinRows = walkinRes.ok ? walkinRes.rows : [];
        } catch (err) {
            console.error('[staff] failed to load notifications', err);
            staffNotifList.innerHTML = '<p class="staff-notif-empty">Could not load notifications.</p>';
            return;
        }

        const nameMap = await fetchProfileNamesByIds([
            ...soonRows.map((b) => b.customer_id),
            ...newTodayRows.map((b) => b.customer_id),
        ]);

        const soonItems = soonRows.map((b) => ({
            dotClass: 'soon',
            createdAt: b.time_date,
            title: `${nameMap.get(String(b.customer_id)) || 'A customer'} starts soon`,
            body: `${b.courts || 'A court'}${b.court_unit ? ` · ${b.court_unit}` : ''} · ${formatIsoTime12h(b.time_date)}`,
        }));
        const newTodayItems = newTodayRows.map((b) => ({
            dotClass: 'booking',
            createdAt: b.created_at || b.time_date,
            title: `${nameMap.get(String(b.customer_id)) || 'A customer'} booked ${b.courts || 'a court'}`,
            body: `Today · ${formatIsoTime12h(b.time_date)}`,
        }));
        const walkinItems = walkinRows.map((w) => ({
            dotClass: 'walkin',
            createdAt: w.time_date,
            title: `${w.customer_name || 'A walk-in customer'} — walk-in`,
            body: `${w.courts || w.sports || 'A court'} · ${formatIsoTime12h(w.time_date)}`,
        }));

        const items = [...soonItems, ...newTodayItems, ...walkinItems]
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .slice(0, 15);

        staffNotifList.innerHTML = items.length || loadFailed
            ? `${loadFailed ? '<p class="staff-notif-empty">Couldn\'t load some notifications.</p>' : ''}${items.map(renderStaffNotificationItem).join('')}`
            : '<p class="staff-notif-empty">No notifications yet.</p>';

        staffNotifLatestAt = items.length ? items[0].createdAt : null;

        let lastSeen = null;
        try { lastSeen = localStorage.getItem(STAFF_NOTIF_SEEN_KEY); } catch (_) { /* ignore */ }
        const hasUnread = Boolean(staffNotifLatestAt) && (!lastSeen || new Date(staffNotifLatestAt) > new Date(lastSeen));
        if (staffNotifDot) staffNotifDot.hidden = !hasUnread;
    }

    if (staffNotifList) {
        staffNotifList.addEventListener('click', (e) => {
            if (e.target.closest('[data-staff-notif-item]')) {
                closeStaffNotifMenu();
                setActivePanel('overview');
            }
        });
    }

    refreshStaffNotifications();
    document.addEventListener('inigosync:profile-ready', refreshStaffNotifications);
    window.setInterval(refreshStaffNotifications, STAFF_NOTIF_REFRESH_MS);

    // ------------------------------------------------------------------
    // Account Settings — Profile Photo upload/remove. Same pipeline as the
    // owner dashboard's Profile Photo card (Pages/owner_dashboard.html,
    // includes/owner_dashboard.js), via the shared includes/imageTools.js:
    // a 256×256 center-cropped JPEG data URL written straight into
    // profiles.avatar_url — no Storage bucket needed for avatars.
    // ------------------------------------------------------------------
    const STAFF_AVATAR_OUTPUT_SIZE = 256;
    const STAFF_AVATAR_JPEG_QUALITY = 0.82;

    const staffAvatarFileInput = document.querySelector('[data-staff-avatar-file]');
    const staffAvatarUploadBtn = document.querySelector('[data-staff-avatar-upload-trigger]');
    const staffAvatarRemoveBtn = document.querySelector('[data-staff-avatar-remove]');

    // Only a data: URL (freshly downscaled) or an https:// URL is ever
    // painted as an <img src> in renderStaffProfile() below — guards
    // against a malformed/unexpected avatar_url value resolving as a
    // relative/unsafe URL.
    function isRenderableStaffAvatarUrl(value) {
        return typeof value === 'string' && value.length > 0 && (value.startsWith('data:') || value.startsWith('https://'));
    }

    async function saveStaffAvatarUrl(avatarUrl) {
        if (!window.sb || !window.inigosyncProfile) {
            window.InigoToast?.show('Unable to reach the server right now. Please try again shortly.', true);
            return false;
        }
        const { error } = await window.sb.from('profiles').update({ avatar_url: avatarUrl }).eq('id', window.inigosyncProfile.id);
        if (error) {
            console.error('[staff] avatar_url update failed', error);
            window.InigoToast?.show(error.message || 'Could not save your photo. Please try again.', true);
            return false;
        }
        window.inigosyncProfile.avatar_url = avatarUrl;
        renderStaffProfile(window.inigosyncProfile);
        return true;
    }

    if (staffAvatarUploadBtn && staffAvatarFileInput) {
        staffAvatarUploadBtn.addEventListener('click', () => staffAvatarFileInput.click());
    }

    if (staffAvatarFileInput) {
        staffAvatarFileInput.addEventListener('change', async () => {
            const file = staffAvatarFileInput.files && staffAvatarFileInput.files[0];
            staffAvatarFileInput.value = '';
            if (!file || !window.InigoImageTools) return;

            const originalLabel = staffAvatarUploadBtn ? staffAvatarUploadBtn.textContent : '';
            if (staffAvatarUploadBtn) {
                staffAvatarUploadBtn.disabled = true;
                staffAvatarUploadBtn.textContent = 'Uploading…';
            }
            if (staffAvatarRemoveBtn) staffAvatarRemoveBtn.disabled = true;

            try {
                const dataUrl = await window.InigoImageTools.downscaleImageToDataUrl(file, { size: STAFF_AVATAR_OUTPUT_SIZE, quality: STAFF_AVATAR_JPEG_QUALITY });
                const ok = await saveStaffAvatarUrl(dataUrl);
                if (ok) window.InigoToast?.show('Profile photo updated.');
            } catch (err) {
                console.error('[staff] avatar upload failed', err);
                window.InigoToast?.show((err && err.message) || 'Could not process that image. Please try a different file.', true);
            } finally {
                if (staffAvatarUploadBtn) {
                    staffAvatarUploadBtn.disabled = false;
                    staffAvatarUploadBtn.textContent = originalLabel;
                }
                if (staffAvatarRemoveBtn) staffAvatarRemoveBtn.disabled = false;
            }
        });
    }

    if (staffAvatarRemoveBtn) {
        staffAvatarRemoveBtn.addEventListener('click', async () => {
            staffAvatarRemoveBtn.disabled = true;
            if (staffAvatarUploadBtn) staffAvatarUploadBtn.disabled = true;
            const ok = await saveStaffAvatarUrl(null);
            staffAvatarRemoveBtn.disabled = false;
            if (staffAvatarUploadBtn) staffAvatarUploadBtn.disabled = false;
            if (ok) window.InigoToast?.show('Profile photo removed.');
        });
    }

    // ------------------------------------------------------------------
    // Profile panel — Revision S1, decision S7. Opened only from the
    // topbar dropdown's "View Profile" (data-staff-panel="profile" lives
    // outside .staff-nav, so setActivePanel() never highlights anything in
    // the sidebar for it). Paints every .staff-avatar (topbar + profile
    // hero), same img-vs-initials idiom as
    // includes/owner_dashboard.js's renderAdminProfile(). Name/contact
    // editing lives in Account Settings' Personal Information card below.
    // ------------------------------------------------------------------
    function renderStaffProfile(profile) {
        const initials = (profile.full_name || profile.email || '?')
            .split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
        const avatarUrl = isRenderableStaffAvatarUrl(profile.avatar_url) ? profile.avatar_url : null;

        document.querySelectorAll('.staff-avatar').forEach((el) => {
            if (avatarUrl) {
                el.innerHTML = `<img class="staff-avatar-img" src="${window.escapeHtml(avatarUrl)}" alt="">`;
            } else {
                el.textContent = initials;
            }
        });
        if (staffAvatarRemoveBtn) staffAvatarRemoveBtn.hidden = !avatarUrl;

        document.querySelectorAll('[data-staff-profile-name]').forEach((el) => { el.textContent = profile.full_name || 'Staff'; });

        const positionEl = document.querySelector('[data-staff-profile-position]');
        if (positionEl) positionEl.textContent = profile.position || '—';
        const emailEl = document.querySelector('[data-staff-profile-email]');
        if (emailEl) emailEl.textContent = profile.email || '—';
        const mobileEl = document.querySelector('[data-staff-profile-mobile]');
        if (mobileEl) mobileEl.textContent = profile.contact_num || '—';

        const nameInput = document.querySelector('[data-staff-settings-name]');
        const mobileInput = document.querySelector('[data-staff-settings-mobile]');
        if (nameInput) nameInput.value = profile.full_name || '';
        if (mobileInput) mobileInput.value = profile.contact_num || '';

        // Revision S3 (database/schema/018_staff_details.sql) — these five
        // live outside authGuard.js's fixed login-gate select, so `profile`
        // only carries them once loadStaffProfileDetails() below has run at
        // least once and copied them onto window.inigosyncProfile; until
        // then they simply read as blank, same as every other field here
        // before its first real value arrives.
        const addressInput = document.querySelector('[data-staff-settings-address]');
        const birthdateInput = document.querySelector('[data-staff-settings-birthdate]');
        const genderInput = document.querySelector('[data-staff-settings-gender]');
        const emergencyNameInput = document.querySelector('[data-staff-settings-emergency-name]');
        const emergencyNumberInput = document.querySelector('[data-staff-settings-emergency-number]');
        if (addressInput) addressInput.value = profile.address || '';
        if (birthdateInput) birthdateInput.value = profile.birthdate || '';
        if (genderInput) genderInput.value = profile.gender || '';
        if (emergencyNameInput) emergencyNameInput.value = profile.emergency_contact_name || '';
        if (emergencyNumberInput) emergencyNumberInput.value = profile.emergency_contact_number || '';
    }

    document.addEventListener('inigosync:profile-ready', (e) => renderStaffProfile(e.detail));
    if (window.inigosyncProfile) renderStaffProfile(window.inigosyncProfile);

    // "Member since" — authGuard.js's shared profiles select (see that
    // file's own column list) does not include created_at, so this is a
    // small, separate, tolerate-failure fetch — "—" not-loaded-yet
    // convention, never a fake date.
    function formatStaffMemberSince(createdAt) {
        const d = new Date(createdAt);
        if (!createdAt || Number.isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }

    // Revision S3 (database/schema/018_staff_details.sql) — age is always
    // DERIVED from birthdate, never stored, so it can never drift out of
    // date the way a saved figure would the moment a birthday passes.
    // Parsed as local midnight (T00:00:00), not bare "YYYY-MM-DD" (which
    // Date() reads as UTC midnight) — otherwise a browser west of UTC would
    // print the day BEFORE the real birthdate.
    function computeStaffAge(birthdateStr) {
        if (!birthdateStr) return null;
        const dob = new Date(`${birthdateStr}T00:00:00`);
        if (Number.isNaN(dob.getTime())) return null;
        const now = new Date();
        let age = now.getFullYear() - dob.getFullYear();
        const monthDiff = now.getMonth() - dob.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) age -= 1;
        return age;
    }

    // "24 yrs · Jan 5, 2002" — View Profile's Age row shows both the
    // derived figure and the source date together, so it's never a bare
    // number with no way to double-check it.
    function formatStaffAge(birthdateStr) {
        const age = computeStaffAge(birthdateStr);
        if (age === null) return '—';
        const dob = new Date(`${birthdateStr}T00:00:00`);
        const dateLabel = dob.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        return `${age} yrs · ${dateLabel}`;
    }

    // "Maria Cruz · 0917…" — falls back to whichever half is actually
    // filled in (an emergency contact can have a name with no number yet,
    // or vice versa) rather than showing a dangling separator.
    function formatStaffEmergencyContact(name, number) {
        const n = String(name || '').trim();
        const num = String(number || '').trim();
        if (n && num) return `${n} · ${num}`;
        return n || num || '—';
    }

    // Revision S3 — folds the old loadStaffProfileMemberSince() into one
    // request for every field the Profile panel's dl needs that
    // authGuard.js's shared login-gate select doesn't carry (created_at
    // included, same reasoning that function already documented). A
    // schema-mismatch response (018 not applied yet) degrades to "—" on
    // every one of these rows plus a small hint, never a broken panel;
    // Account Settings' matching inputs are primed by re-running
    // renderStaffProfile() against the now-enriched window.inigosyncProfile
    // rather than duplicating the "find each input, set its value" lines a
    // second time here.
    async function loadStaffProfileDetails() {
        if (!window.sb || !window.inigosyncProfile) return;

        const memberSinceEl = document.querySelector('[data-staff-profile-member-since]');
        const addressEl = document.querySelector('[data-staff-profile-address]');
        const ageEl = document.querySelector('[data-staff-profile-age]');
        const genderEl = document.querySelector('[data-staff-profile-gender]');
        const emergencyEl = document.querySelector('[data-staff-profile-emergency]');
        const detailsHints = document.querySelectorAll('[data-staff-profile-details-hint], [data-staff-settings-details-hint]');

        const { data, error } = await window.sb
            .from('profiles')
            .select('address, birthdate, gender, emergency_contact_name, emergency_contact_number, created_at')
            .eq('id', window.inigosyncProfile.id)
            .single();

        if (error) {
            if (!isSchemaMismatchError(error)) console.error('[staff] failed to load profile details', error);
            if (memberSinceEl) memberSinceEl.textContent = '—';
            [addressEl, ageEl, genderEl, emergencyEl].forEach((el) => { if (el) el.textContent = '—'; });
            detailsHints.forEach((el) => { el.hidden = false; });
            return;
        }

        detailsHints.forEach((el) => { el.hidden = true; });

        if (memberSinceEl) memberSinceEl.textContent = formatStaffMemberSince(data.created_at);
        if (addressEl) addressEl.textContent = data.address || '—';
        if (ageEl) ageEl.textContent = formatStaffAge(data.birthdate);
        if (genderEl) genderEl.textContent = data.gender || '—';
        if (emergencyEl) emergencyEl.textContent = formatStaffEmergencyContact(data.emergency_contact_name, data.emergency_contact_number);

        window.inigosyncProfile.address = data.address || '';
        window.inigosyncProfile.birthdate = data.birthdate || null;
        window.inigosyncProfile.gender = data.gender || '';
        window.inigosyncProfile.emergency_contact_name = data.emergency_contact_name || '';
        window.inigosyncProfile.emergency_contact_number = data.emergency_contact_number || '';
        renderStaffProfile(window.inigosyncProfile);
    }

    document.addEventListener('inigosync:profile-ready', loadStaffProfileDetails);
    if (window.inigosyncProfile) loadStaffProfileDetails();

    // ------------------------------------------------------------------
    // Account Settings — Personal Information (Revision S1, decision S7 —
    // moved in from the old Staff Profile tab) + a 2-step Change Password
    // wizard (decision S9), ported from includes/owner_dashboard.js's
    // data-admin-pw-* under data-staff-pw-* names.
    // ------------------------------------------------------------------
    // Revision S3 — Birthdate can never be set in the future; today's date
    // is computed once here (todayDateInputValue() is a hoisted function
    // declaration further up this file, in the Walk-In section, safe to
    // call from here regardless of source order — same reasoning this
    // file already gives for closeStaffNotifMenu()) rather than baked into
    // the HTML's static max="…", which would silently go stale.
    const staffSettingsBirthdateInput = document.querySelector('[data-staff-settings-birthdate]');
    if (staffSettingsBirthdateInput) staffSettingsBirthdateInput.max = todayDateInputValue();

    const staffSettingsSaveProfileBtn = document.querySelector('[data-staff-settings-save="profile"]');
    if (staffSettingsSaveProfileBtn) {
        staffSettingsSaveProfileBtn.addEventListener('click', async () => {
            if (!window.sb || !window.inigosyncProfile) return;
            const nameInput = document.querySelector('[data-staff-settings-name]');
            const mobileInput = document.querySelector('[data-staff-settings-mobile]');
            const addressInput = document.querySelector('[data-staff-settings-address]');
            const birthdateInput = document.querySelector('[data-staff-settings-birthdate]');
            const genderInput = document.querySelector('[data-staff-settings-gender]');
            const emergencyNameInput = document.querySelector('[data-staff-settings-emergency-name]');
            const emergencyNumberInput = document.querySelector('[data-staff-settings-emergency-number]');
            const full_name = nameInput ? nameInput.value.trim() : '';
            const mobileRaw = mobileInput ? mobileInput.value.trim() : '';

            if (!full_name) {
                window.InigoToast?.show('Enter your full name.', true);
                nameInput?.focus();
                return;
            }

            // Mobile is optional (a staff account's contact_num can be
            // blank) but validated the same way as everywhere else in this
            // app whenever a value IS entered.
            let contact_num = '';
            if (mobileRaw) {
                const check = window.validatePhMobile(mobileRaw);
                if (!check.valid) {
                    window.InigoToast?.show(check.message, true);
                    mobileInput?.focus();
                    return;
                }
                contact_num = check.normalized;
            }

            // Revision S3 — the emergency contact's number is optional
            // (unlike the account's own mobile above, an emergency contact
            // might not be on file yet at all) but gets the exact same
            // PH-mobile validation whenever a value IS entered.
            const emergencyNumberRaw = emergencyNumberInput ? emergencyNumberInput.value.trim() : '';
            let emergency_contact_number = '';
            if (emergencyNumberRaw) {
                const emCheck = window.validatePhMobile(emergencyNumberRaw);
                if (!emCheck.valid) {
                    window.InigoToast?.show(`Emergency contact number: ${emCheck.message}`, true);
                    emergencyNumberInput?.focus();
                    return;
                }
                emergency_contact_number = emCheck.normalized;
            }

            const fullPatch = {
                full_name,
                contact_num,
                address: addressInput ? addressInput.value.trim() : '',
                // A `date` column rejects '' outright (only a real date or
                // NULL) — unlike every text field here, an empty birthdate
                // must become null, never ''.
                birthdate: (birthdateInput && birthdateInput.value) ? birthdateInput.value : null,
                gender: genderInput ? genderInput.value : '',
                emergency_contact_name: emergencyNameInput ? emergencyNameInput.value.trim() : '',
                emergency_contact_number,
            };

            staffSettingsSaveProfileBtn.disabled = true;
            let { error } = await window.sb.from('profiles').update(fullPatch).eq('id', window.inigosyncProfile.id);

            // Revision S3 (database/schema/018_staff_details.sql) — not
            // applied yet: retry with just full_name/contact_num, the two
            // columns every prior revision already relied on, same
            // schema-mismatch-retry idiom the Walk-In wizard's save uses
            // further up this file.
            let usedReducedPayload = false;
            if (error && isSchemaMismatchError(error)) {
                ({ error } = await window.sb.from('profiles').update({ full_name, contact_num }).eq('id', window.inigosyncProfile.id));
                usedReducedPayload = true;
            }

            staffSettingsSaveProfileBtn.disabled = false;

            if (error) {
                window.InigoToast?.show(error.message || 'Could not save your changes.', true);
                return;
            }

            Object.assign(window.inigosyncProfile, fullPatch);
            renderStaffProfile(window.inigosyncProfile);
            window.InigoToast?.show(usedReducedPayload
                ? 'Profile updated — address/birthdate/gender/emergency contact need a database update (ask the owner to run 018).'
                : 'Profile updated.');
        });
    }

    document.querySelectorAll('[data-staff-settings-cancel="profile"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (window.inigosyncProfile) renderStaffProfile(window.inigosyncProfile);
        });
    });

    // ---- Password visibility toggles ----
    document.querySelectorAll('[data-staff-toggle-password]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const input = btn.previousElementSibling;
            if (!input) return;
            const isHidden = input.type === 'password';
            input.type = isHidden ? 'text' : 'password';
            btn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
        });
    });

    // ---- Change Password — 2-step wizard (decision S9) ----
    const STAFF_PW_MIN_LENGTH = 8;
    const pwStepPanels = document.querySelectorAll('[data-staff-pw-step]');
    const pwStepIndicators = document.querySelectorAll('[data-staff-pw-step-indicator]');
    const pwBackBtn = document.querySelector('[data-staff-pw-back]');
    const pwNextBtn = document.querySelector('[data-staff-pw-next]');
    const staffPasswordSaveBtn = document.querySelector('[data-staff-settings-save="password"]');
    const pwCurrentInput = document.querySelector('[data-staff-pw-current]');
    const pwNewInput = document.querySelector('[data-staff-pw-new]');
    const pwConfirmInput = document.querySelector('[data-staff-pw-confirm]');

    let staffPwWizardStep = 1;

    function renderStaffPwWizard() {
        pwStepPanels.forEach((panel) => {
            panel.classList.toggle('is-active', Number(panel.dataset.staffPwStep) === staffPwWizardStep);
        });
        pwStepIndicators.forEach((el) => {
            const n = Number(el.dataset.staffPwStepIndicator);
            el.classList.toggle('is-current', n === staffPwWizardStep);
            el.classList.toggle('is-done', n < staffPwWizardStep);
            el.setAttribute('aria-current', n === staffPwWizardStep ? 'step' : 'false');
        });
        if (pwBackBtn) pwBackBtn.hidden = staffPwWizardStep !== 2;
        if (staffPasswordSaveBtn) staffPasswordSaveBtn.hidden = staffPwWizardStep !== 2;
        if (pwNextBtn) {
            pwNextBtn.hidden = staffPwWizardStep !== 1;
            pwNextBtn.disabled = !(pwCurrentInput && pwCurrentInput.value !== '');
        }
    }

    function goToStaffPwStep(step) {
        staffPwWizardStep = step === 2 ? 2 : 1;
        renderStaffPwWizard();
    }

    function resetStaffPwWizard() {
        [pwCurrentInput, pwNewInput, pwConfirmInput].forEach((input) => { if (input) input.value = ''; });
        goToStaffPwStep(1);
    }

    if (pwCurrentInput) pwCurrentInput.addEventListener('input', renderStaffPwWizard);
    if (pwNextBtn) {
        pwNextBtn.addEventListener('click', () => {
            if (pwNextBtn.disabled) return;
            goToStaffPwStep(2);
        });
    }
    if (pwBackBtn) pwBackBtn.addEventListener('click', () => goToStaffPwStep(1));

    // Establishes the correct initial hidden/disabled state for the nav
    // buttons and paints the step-1 indicator.
    renderStaffPwWizard();

    if (staffPasswordSaveBtn) {
        staffPasswordSaveBtn.addEventListener('click', async () => {
            if (!window.sb || !window.inigosyncProfile) return;
            const currentPassword = pwCurrentInput?.value;
            const newPassword = pwNewInput?.value;
            const confirmPassword = pwConfirmInput?.value;

            if (!currentPassword) {
                window.InigoToast?.show('Enter your current password.', true);
                goToStaffPwStep(1);
                return;
            }
            if (!newPassword || newPassword.length < STAFF_PW_MIN_LENGTH) {
                window.InigoToast?.show(`New password must be at least ${STAFF_PW_MIN_LENGTH} characters.`, true);
                return;
            }
            if (newPassword !== confirmPassword) {
                window.InigoToast?.show('Passwords do not match.', true);
                return;
            }

            staffPasswordSaveBtn.disabled = true;

            // Re-verify against the AUTH session's OWN current email first,
            // falling back to profiles.email only if no session email is
            // available (same S3-fix reasoning as
            // includes/owner_dashboard.js's password wizard).
            const { data: pwSessionData } = await window.sb.auth.getSession();
            const verifyEmail = pwSessionData?.session?.user?.email || window.inigosyncProfile.email;

            const { error: verifyError } = await window.sb.auth.signInWithPassword({ email: verifyEmail, password: currentPassword });
            if (verifyError) {
                staffPasswordSaveBtn.disabled = false;
                window.InigoToast?.show('Current password is incorrect.', true);
                goToStaffPwStep(1);
                return;
            }

            const { error } = await window.sb.auth.updateUser({ password: newPassword });
            staffPasswordSaveBtn.disabled = false;

            if (error) {
                window.InigoToast?.show(error.message || 'Could not update your password.', true);
                return;
            }

            resetStaffPwWizard();
            window.InigoToast?.show('Password updated.');
        });
    }

    document.querySelectorAll('[data-staff-settings-cancel="password"]').forEach((btn) => {
        btn.addEventListener('click', () => resetStaffPwWizard());
    });

    async function fetchBalanceReturnRow(source, id) {
        const table = source === 'booking' ? 'booking' : 'walk_in_booking';
        const idFields = source === 'booking' ? ['booking_id'] : WALKIN_ID_CANDIDATES;
        let lastError = null;
        for (const idField of idFields) {
            const result = await window.sb.from(table).select('*').eq(idField, id).maybeSingle();
            if (!result.error) {
                if (!result.data) return { error: 'This reservation could not be found.' };
                const row = source === 'booking'
                    ? mergeBookingRows([result.data], [])[0]
                    : mergeBookingRows([], [result.data])[0];
                return { row };
            }
            lastError = result.error;
            if (!isSchemaMismatchError(result.error)) break;
        }
        return { error: lastError?.message || 'Could not refresh the reservation after checkout.' };
    }

    const balanceReturnUrl = new URL(window.location.href);
    const balanceReturnKind = balanceReturnUrl.searchParams.get('balance_checkout');
    if (balanceReturnKind) {
        const source = balanceReturnUrl.searchParams.get('source');
        const id = balanceReturnUrl.searchParams.get('id');
        balanceReturnUrl.searchParams.delete('balance_checkout');
        balanceReturnUrl.searchParams.delete('source');
        balanceReturnUrl.searchParams.delete('id');
        window.history.replaceState({}, document.title,
            `${balanceReturnUrl.pathname}${balanceReturnUrl.search}${balanceReturnUrl.hash}`);

        if ((source !== 'booking' && source !== 'walkin') || !id || !/^\d+$/.test(id) || !window.sb) {
            window.InigoToast?.show('Could not identify the reservation returned from checkout.', true);
        } else if (balanceReturnKind === 'cancel') {
            window.InigoToast?.show('PayMongo checkout was cancelled. No balance payment was recorded and attendance is not confirmed.', true);
        } else if (balanceReturnKind === 'return') {
            const result = await fetchBalanceReturnRow(source, id);
            if (result.error) {
                window.InigoToast?.show(result.error, true);
            } else if (timeInBalanceConfirmed(result.row)) {
                window.InigoToast?.show('PayMongo confirmed the balance. Review the reservation and confirm attendance.');
                openTimeInModal(result.row);
            } else {
                window.InigoToast?.show('Payment is still processing. No attendance was recorded. Refresh shortly to check PayMongo confirmation.', true);
            }
        }

        refreshBookingOverview();
        refreshCourtSchedule();
        refreshTransactions();
        refreshStaffNotifications();
    }
});
