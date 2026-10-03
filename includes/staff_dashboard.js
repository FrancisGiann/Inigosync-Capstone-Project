document.addEventListener('DOMContentLoaded', async () => {
    const STAFF_TIME_ZONE = 'Asia/Manila';
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
        activity: { title: 'Customer Activity Log', subtitle: 'Customer sign-ins, bookings, payments, and attendance.' },
        notifications: { title: 'Notifications', subtitle: 'Updates and announcements for your staff account.' },
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
        if (profileTrigger) profileTrigger.setAttribute('aria-expanded', 'false');
    }

    if (profileTrigger && profile) {
        profileTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            closeStaffNotifMenu();
            if (profile.hasAttribute('data-open')) {
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
        const dateStr = now.toLocaleDateString('en-US', { timeZone: STAFF_TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric' });
        const timeStr = now.toLocaleTimeString('en-US', { timeZone: STAFF_TIME_ZONE, hour: 'numeric', minute: '2-digit' });
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

    // Business days are anchored to Asia/Manila regardless of the device
    // timezone. The returned range is a pair of absolute instants suitable
    // for Supabase timestamptz filters.
    function manilaDate(value = new Date()) {
        if (window.InigoBusinessHours?.dateInManila) return window.InigoBusinessHours.dateInManila(value);
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: STAFF_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(value instanceof Date ? value : new Date(value));
        const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        return `${values.year}-${values.month}-${values.day}`;
    }

    function manilaDateTime(dateStr, hour, minute = 0) {
        const [year, month, day] = String(dateStr).split('-').map(Number);
        return new Date(Date.UTC(year, month - 1, day, Number(hour) - 8, Number(minute)));
    }

    function todayRange() {
        const dateStr = manilaDate(new Date());
        const start = manilaDateTime(dateStr, 0);
        const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
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
        return manilaDate(new Date());
    }

    function formatIsoTime12h(iso) {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '—';
        return d.toLocaleTimeString('en-US', { timeZone: STAFF_TIME_ZONE, hour: 'numeric', minute: '2-digit' });
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
        const dateStr = typeof dateBase === 'string' ? dateBase : manilaDate(dateBase);
        const start = manilaDateTime(dateStr, hour);
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
    //   Completed   - checked in, now >= end or the server has stored an
    //                 exit at the scheduled end.
    //   Unattended  - the server released the reservation after its grace
    //                 period; local time alone never releases a slot.
    // A row whose real `status` is already 'cancelled' or 'completed'
    // passes straight through — those are real, already-settled facts this
    // never overrides.
    // ------------------------------------------------------------------
    function staffDerivedStatus(row) {
        const raw = String(row.status || '').toLowerCase();
        if (raw === 'cancelled') return 'cancelled';
        if (raw === 'unattended') return 'unattended';
        if (raw === 'completed') return 'completed';

        if (row.checked_out_at) return 'completed';
        if (row.checked_in_at) {
            const { end } = rowWindow(row);
            return Date.now() >= end.getTime() ? 'completed' : 'inplay';
        }

        return 'booked';
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
        if (status !== 'booked') return false;
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
            checked_out_at: b.checked_out_at || null,
            status: b.status,
            sports: b.sports || '',
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
            checked_out_at: w.checked_out_at || null,
            status: w.status,
            sports: w.sports || '',
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

    const filterableTableState = new Map();
    // Replaces the current row set while keeping one persistent filter
    // state and one set of listeners per table. This preserves visible
    // search/filter controls after background refreshes without accumulating
    // handlers that point at detached rows.
    function wireFilterableTable(scopeName) {
        const group = document.querySelector(`[data-staff-filter-group="${scopeName}"]`);
        const searchInput = document.querySelector(`[data-staff-search="${scopeName}"]`);
        const table = document.querySelector(`[data-staff-table="${scopeName}"]`);
        if (!table) return;
        let state = filterableTableState.get(scopeName);
        if (!state) {
            state = {
                activeFilter: group?.querySelector('[data-staff-chip].is-active')?.dataset.staffFilter || 'all',
                query: searchInput?.value.trim().toLowerCase() || '',
                rows: [],
                bound: false,
            };
            filterableTableState.set(scopeName, state);
        }
        state.rows = Array.from(table.querySelectorAll('tbody tr'));

        const applyFilters = () => {
            state.rows.forEach((row) => {
                const matchesFilter = state.activeFilter === 'all' || row.dataset.status === state.activeFilter;
                const matchesQuery = !state.query || row.textContent.toLowerCase().includes(state.query);
                row.style.display = (matchesFilter && matchesQuery) ? '' : 'none';
            });
        };

        if (group && !state.bound) {
            group.querySelectorAll('[data-staff-chip]').forEach((chip) => {
                chip.addEventListener('click', () => {
                    group.querySelectorAll('[data-staff-chip]').forEach((c) => c.classList.remove('is-active'));
                    chip.classList.add('is-active');
                    state.activeFilter = chip.dataset.staffFilter;
                    applyFilters();
                });
            });
        }

        if (searchInput && !state.bound) {
            searchInput.addEventListener('input', () => {
                state.query = searchInput.value.trim().toLowerCase();
                applyFilters();
            });
        }
        if (group) group.querySelectorAll('[data-staff-chip]').forEach((chip) => {
            chip.classList.toggle('is-active', chip.dataset.staffFilter === state.activeFilter);
        });
        state.bound = true;
        applyFilters();
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
        if (manilaDate(start) === todayDateInputValue()) return timeLabel;
        const dateLabel = start.toLocaleDateString('en-US', { timeZone: STAFF_TIME_ZONE, month: 'short', day: 'numeric' });
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
        if (staffCanTimeIn(row, status)) return '<button type="button" class="staff-mini-btn is-primary" data-staff-action="timein">Time-In</button>';
        if (status === 'inplay') return '<button type="button" class="staff-mini-btn" data-staff-action="timeout">Time-Out</button>';
        return '';
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
            <td>${window.escapeHtml(row.sports || '—')}</td>
            <td>${courtLabel}</td>
            <td>${unitLabel || '—'}</td>
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
            overviewTableBody.innerHTML = '<tr><td colspan="9" class="staff-table-message">Could not load bookings right now.</td></tr>';
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
        renderArrivalActions(merged);

        overviewTableBody.innerHTML = '';
        if (merged.length === 0) {
            overviewTableBody.innerHTML = '<tr><td colspan="9" class="staff-table-message">No bookings yet.</td></tr>';
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

    const arrivalsTableBody = document.querySelector('[data-staff-table="arrivals"] tbody');
    function renderArrivalActions(rows) {
        if (!arrivalsTableBody) return;
        const arrivals = rows.filter((row) => {
            const status = staffDerivedStatus(row);
            const payment = timeInPaymentInfo(row);
            return status === 'booked' && (staffCanTimeIn(row, status) || (payment.balance !== null && payment.balance > 0));
        }).sort((a, b) => new Date(a.time_date) - new Date(b.time_date));
        arrivalsTableBody.innerHTML = arrivals.length ? '' : '<tr><td colspan="6" class="staff-table-message">No arrivals need action right now.</td></tr>';
        arrivals.forEach((row) => {
            const status = staffDerivedStatus(row);
            const info = timeInPaymentInfo(row);
            const tr = document.createElement('tr');
            tr.dataset.rowIndex = String(overviewRows.indexOf(row));
            tr.innerHTML = `<td class="staff-cell-main">${window.escapeHtml(row.customerName || 'Customer')}</td>
                <td>${window.escapeHtml(row.sports || '—')}</td>
                <td>${window.escapeHtml(row.courts || '—')}${row.unit ? `<span class="staff-cell-sub">${window.escapeHtml(row.unit)}</span>` : ''}</td>
                <td>${window.escapeHtml(formatOverviewTimeCell(row))}</td>
                <td>${info.balance === null ? 'Amount pending' : window.escapeHtml(formatStaffPeso(info.balance))}</td>
                <td>${staffCanTimeIn(row, status) ? '<button type="button" class="staff-mini-btn is-primary" data-staff-action="timein">Collect &amp; Time-In</button>' : '<span class="staff-status booked">Upcoming</span>'}</td>`;
            arrivalsTableBody.appendChild(tr);
        });
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
    wireTimeInButtons(arrivalsTableBody, () => overviewRows);

    refreshBookingOverview();
    document.addEventListener('inigosync:profile-ready', refreshBookingOverview);
    // Recompute Manila-day cards and derived attendance states while the
    // dashboard stays open. todayRange() is timezone anchored, so this also
    // rolls the four counters over after Asia/Manila midnight.
    window.setInterval(refreshBookingOverview, 60000);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refreshBookingOverview();
    });

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
    const walkinCustomerModeInputs = document.querySelectorAll('[data-staff-customer-mode]');
    const walkinAccountSearchWrap = document.querySelector('[data-staff-account-search-wrap]');
    const walkinCustomerSearch = document.querySelector('[data-staff-customer-search]');
    const walkinCustomerResults = document.querySelector('[data-staff-customer-results]');
    const walkinCustomerSelected = document.querySelector('[data-staff-customer-selected]');
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
    const walkinHourGrid = document.querySelector('[data-staff-walkin-hour-grid]');
    const walkinDurationSelect = document.querySelector('[data-staff-walkin-duration]');
    const walkinLinesEl = document.querySelector('[data-staff-walkin-lines]');
    const walkinReviewLinesEl = document.querySelector('[data-staff-walkin-review-lines]');
    const walkinAddLineBtn = document.querySelector('[data-staff-walkin-add-line]');
    const walkinCurrentRangeEl = document.querySelector('[data-staff-walkin-current-range]');
    const walkinOnlineFeeNote = document.querySelector('[data-staff-walkin-online-fee-note]');
    const walkinPaymentOptionEls = document.querySelectorAll('[data-staff-walkin-step="4"] [data-staff-payment-option]');
    const walkinCashUnavailableEl = document.querySelector('[data-staff-walkin-cash-unavailable]');
    const walkinQrUnavailableEl = document.querySelector('[data-staff-walkin-qr-unavailable]');
    const walkinAcknowledgmentNote = document.querySelector('[data-staff-walkin-acknowledgment-note]');

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
    let staffGcashEnabled = true;

    let walkinState = {
        name: '',
        mobile: '',
        customerId: null,
        customerMode: 'guest',
        customerSearchResult: null,
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
        durationHours: 1,
        items: [],
        payment: 'cash',
    };
    let walkinBusinessRules = null;
    let walkinCustomerSearchTimer = null;
    let walkinQrPollTimer = null;
    let activeWalkinQr = null;
    let walkinQrCheckInFlight = false;

    // { ok, rows } — today's bookings/walk-ins for the CURRENTLY selected
    // court, refreshed by refreshWalkinTimePickers() below. Same shape as
    // includes/Dashboard.js's slotGridBookings/slotGridWalkins.
    let walkinBookings = { ok: true, rows: [] };
    let walkinWalkins = { ok: true, rows: [] };
    let walkinRequestSeq = 0;

    function applyStaffPaymentSettings(settings) {
        staffCashEnabled = settings?.cashEnabled !== false;
        staffGcashEnabled = settings?.gcashEnabled !== false;
        document.querySelectorAll('[data-staff-walkin-cash-option], [data-staff-timein-cash-option]').forEach((option) => {
            option.hidden = !staffCashEnabled;
            if (!staffCashEnabled) {
                option.classList.remove('is-selected');
                const radio = option.querySelector('input[type="radio"]');
                if (radio) radio.checked = false;
            }
        });
        const qrOption = document.querySelector('[data-staff-walkin-qr-option]');
        if (qrOption) qrOption.hidden = !staffGcashEnabled;
        if (walkinQrUnavailableEl) walkinQrUnavailableEl.hidden = staffGcashEnabled;
        if (walkinCashUnavailableEl) walkinCashUnavailableEl.hidden = staffCashEnabled;
        if (!staffCashEnabled && walkinState.payment === 'cash') walkinState.payment = null;
        if (staffCashEnabled && !walkinState.payment) walkinState.payment = 'cash';
        if (!staffGcashEnabled && walkinState.payment === 'paymongo_qr') {
            walkinState.payment = staffCashEnabled ? 'cash' : 'paymongo';
        }
        walkinPaymentOptionEls.forEach((option) => {
            const radio = option.querySelector('input[type="radio"]');
            option.classList.toggle('is-selected', Boolean(radio && radio.dataset.staffPayment === walkinState.payment));
            if (radio) radio.checked = radio.dataset.staffPayment === walkinState.payment;
        });
        if (!staffCashEnabled && timeInSelectedMethod === 'Cash') {
            timeInSelectedMethod = null;
            if (timeInModalRow && timeInModalIsOpen) renderTimeInModal(timeInModalRow);
        }
        renderWalkinWizard();
        updateWalkinSummary();
    }

    function walkinStepIsReady(step) {
        if (step === 1) return Boolean(walkinState.name) && !walkinState.mobileError
            && (walkinState.customerMode !== 'account' || Boolean(walkinState.customerId));
        if (step === 2) {
            if (!walkinState.court || !window.InigoCourtsData) return false;
            const { units } = window.InigoCourtsData.resolveCourtUnits(walkinState.court);
            return units.length > 1 ? Boolean(walkinState.unit) : true;
        }
        if (step === 3) return Boolean(walkinBusinessRules?.authoritative)
            && ((walkinState.startHour !== null && walkinState.endHour !== null)
                || (!walkinState.court && walkinState.items.length > 0));
        if (step === 4) return Boolean(walkinState.payment)
            && (walkinState.payment !== 'cash' || staffCashEnabled)
            && (walkinState.payment !== 'paymongo_qr' || staffGcashEnabled);
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
        if (walkinSaveBtn) {
            walkinSaveBtn.disabled = !walkinState.items.length || !walkinBusinessRules?.authoritative
                || (walkinState.payment === 'cash' && !staffCashEnabled)
                || (walkinState.payment === 'paymongo_qr' && !staffGcashEnabled);
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
            if (walkinWizardStep === 3) {
                const line = buildWalkinLine();
                if (line) {
                    walkinState.items.push(line);
                    clearWalkinCurrentLine();
                    renderWalkinLines();
                } else if (!walkinState.items.length || walkinState.court) return;
            }
            goToWalkinStep(walkinWizardStep + 1);
        });
    }
    if (walkinBackBtn) walkinBackBtn.addEventListener('click', () => goToWalkinStep(walkinWizardStep - 1));

    // ---- Step 1 — Customer ----
    if (walkinNameInput) {
        walkinNameInput.addEventListener('input', () => {
            walkinState.name = walkinNameInput.value.trim();
            if (walkinState.customerMode === 'guest') walkinState.customerId = null;
            renderWalkinWizard();
        });
    }

    walkinCustomerModeInputs.forEach((input) => input.addEventListener('change', () => {
        if (!input.checked) return;
        walkinState.customerMode = input.value === 'account' ? 'account' : 'guest';
        walkinState.customerId = null;
        walkinState.customerSearchResult = null;
        if (walkinAccountSearchWrap) walkinAccountSearchWrap.hidden = walkinState.customerMode !== 'account';
        if (walkinCustomerResults) { walkinCustomerResults.hidden = true; walkinCustomerResults.replaceChildren(); }
        if (walkinCustomerSelected) { walkinCustomerSelected.hidden = true; walkinCustomerSelected.textContent = ''; }
        if (walkinCustomerSearch) walkinCustomerSearch.value = '';
        if (walkinNameInput) { walkinNameInput.readOnly = walkinState.customerMode === 'account'; walkinNameInput.value = ''; }
        if (walkinMobileInput) { walkinMobileInput.readOnly = walkinState.customerMode === 'account'; walkinMobileInput.value = ''; }
        walkinState.name = '';
        walkinState.mobile = '';
        walkinState.mobileError = false;
        renderWalkinWizard();
    }));

    if (walkinCustomerSearch) walkinCustomerSearch.addEventListener('input', () => {
        window.clearTimeout(walkinCustomerSearchTimer);
        const query = walkinCustomerSearch.value.trim();
        if (!walkinCustomerResults) return;
        if (query.length < 2) {
            walkinCustomerResults.hidden = true;
            walkinCustomerResults.replaceChildren();
            return;
        }
        walkinCustomerResults.hidden = false;
        walkinCustomerResults.innerHTML = '<p class="staff-customer-results-state">Searching customer accounts…</p>';
        walkinCustomerSearchTimer = window.setTimeout(async () => {
            if (!window.sb) return;
            const safe = query.replace(/[^\p{L}\p{N}@.+_\-\s]/gu, ' ').trim();
            let result;
            try {
                result = await window.sb.from('profiles').select('id,full_name,email,contact_num')
                    .eq('role', 'customer').eq('status', 'active')
                    .or(`full_name.ilike.%${safe}%,email.ilike.%${safe}%,contact_num.ilike.%${safe}%`)
                    .order('full_name', { ascending: true }).limit(8);
            } catch (error) { result = { error }; }
            if (walkinCustomerSearch.value.trim() !== query) return;
            if (result.error) {
                console.error('[staff] customer account search failed', result.error);
                walkinCustomerResults.innerHTML = '<p class="staff-customer-results-state">Could not search customer accounts.</p>';
                return;
            }
            const matches = result.data || [];
            walkinCustomerResults.innerHTML = matches.length ? matches.map((customer) => `<button type="button" role="option" class="staff-customer-result" data-staff-customer-id="${window.escapeHtml(customer.id)}"><strong>${window.escapeHtml(customer.full_name || 'Customer')}</strong><span>${window.escapeHtml(customer.email || customer.contact_num || '')}</span></button>`).join('') : '<p class="staff-customer-results-state">No matching accounts.</p>';
            walkinCustomerResults.querySelectorAll('[data-staff-customer-id]').forEach((button) => button.addEventListener('click', () => {
                const customer = matches.find((item) => String(item.id) === button.dataset.staffCustomerId);
                if (!customer) return;
                walkinState.customerId = customer.id;
                walkinState.customerSearchResult = customer;
                walkinState.name = customer.full_name || '';
                walkinState.mobile = customer.contact_num || '';
                walkinState.mobileError = false;
                if (walkinNameInput) walkinNameInput.value = walkinState.name;
                if (walkinMobileInput) walkinMobileInput.value = walkinState.mobile;
                if (walkinCustomerSelected) {
                    walkinCustomerSelected.textContent = `Linked to ${customer.full_name || 'customer account'}; this visit will appear in their history.`;
                    walkinCustomerSelected.hidden = false;
                }
                walkinCustomerResults.hidden = true;
                renderWalkinWizard();
            }));
        }, 250);
    });
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
        const slot = hourWindow(hour, todayDateInputValue());
        const now = Date.now();
        if (slot.end.getTime() <= now) return true;
        const configuredGraceMinutes = Number(walkinBusinessRules?.graceMinutes);
        const graceMinutes = Number.isInteger(configuredGraceMinutes) && configuredGraceMinutes >= 0
            ? configuredGraceMinutes : 30;
        // Time-In and no-show rules use this same inclusive deadline:
        // the slot remains eligible at start + grace, then closes after it.
        return now > slot.start.getTime() + graceMinutes * 60 * 1000;
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

    // New staff wizard uses a visible hourly grid, with one selected start
    // and a duration selector. These declarations intentionally replace the
    // old single-range picker implementation above while preserving its
    // shared occupancy loader and pricing helpers.
    let walkinHoursForDay = [];
    function walkinSlotStatus(hour) {
        if (isWalkinHourPast(hour)) return 'past';
        const { start, end } = hourWindow(hour, todayDateInputValue());
        const overlap = [...walkinBookings.rows, ...walkinWalkins.rows].filter((row) => {
            if (!sameCourtName(row.courts, walkinState.court?.name || '')) return false;
            if (!courtUnitsOverlap(row.court_unit, walkinState.unit || '')) return false;
            return windowsOverlap(rowWindow(row), { start, end });
        });
        if (overlap.some((row) => row.source === 'maintenance')) return 'maintenance';
        if (overlap.some((row) => ['hold', 'checkout_hold', 'payment_hold', 'temporary_hold'].includes(String(row.source || '').toLowerCase()))) return 'held';
        if (overlap.length) return 'unavailable';
        return 'open';
    }

    function computeWalkinFreeWindows() {
        const hours = walkinHoursForDay;
        const windows = [];
        let runStart = null;
        hours.forEach((hour) => {
            if (walkinSlotStatus(hour) === 'open') {
                if (runStart === null) runStart = hour;
            } else if (runStart !== null) {
                windows.push({ startHour: runStart, endHourExclusive: hour });
                runStart = null;
            }
        });
        if (runStart !== null && hours.length) windows.push({ startHour: runStart, endHourExclusive: hours[hours.length - 1] + 1 });
        return windows;
    }

    function renderWalkinTimePickers() {
        if (!walkinHourGrid || !window.InigoBusinessHours) return;
        const isSetRate = walkinState.rateUnit === '/set';
        if (walkinSetQuantityWrap) walkinSetQuantityWrap.hidden = !isSetRate;
        if (walkinDurationSelect) {
            walkinDurationSelect.closest('[data-staff-walkin-duration-wrap]')?.toggleAttribute('hidden', isSetRate);
            if (!isSetRate) walkinState.durationHours = Math.max(1, Number(walkinDurationSelect.value) || walkinState.durationHours || 1);
        }
        if (!walkinState.court) {
            walkinHourGrid.innerHTML = '<p class="staff-form-hint">Select a sport and court first.</p>';
            if (walkinOpenWindowsEl) walkinOpenWindowsEl.textContent = 'Select a sport and court first.';
            return;
        }
        if (!walkinBusinessRules?.authoritative) {
            walkinHourGrid.innerHTML = '<p class="staff-form-hint">Operating hours could not be verified. Try again before creating this order.</p>';
            if (walkinOpenWindowsEl) walkinOpenWindowsEl.textContent = 'Hours unavailable.';
            return;
        }
        if (!walkinBookings.ok || !walkinWalkins.ok) {
            walkinHourGrid.innerHTML = '<p class="staff-form-hint">Availability could not be verified. Refresh before creating this order.</p>';
            if (walkinOpenWindowsEl) walkinOpenWindowsEl.textContent = 'Live availability is unavailable.';
            return;
        }
        if (walkinBusinessRules?.isClosed) {
            walkinHourGrid.innerHTML = '<p class="staff-form-hint">The facility is closed on this date.</p>';
            if (walkinOpenWindowsEl) walkinOpenWindowsEl.textContent = 'Closed today.';
            return;
        }
        const duration = isSetRate ? Math.max(1, Math.min(100, Number(walkinState.rateQuantity) || 1)) : Math.max(1, Number(walkinState.durationHours) || 1);
        const availableStarts = new Set();
        for (const startHour of walkinHoursForDay) {
            const block = Array.from({ length: duration }, (_, offset) => startHour + offset);
            if (block.every((hour) => walkinHoursForDay.includes(hour) && walkinSlotStatus(hour) === 'open')) availableStarts.add(startHour);
        }
        if (!availableStarts.has(walkinState.startHour)) {
            walkinState.startHour = null;
            walkinState.endHour = null;
        }
        const fmt = window.InigoBusinessHours.formatHourLabel;
        const labels = { open: 'Open', unavailable: 'Unavailable', held: 'Temporarily held', maintenance: 'Maintenance', past: 'Unavailable' };
        walkinHourGrid.innerHTML = walkinHoursForDay.map((hour) => {
            const slotStatus = walkinSlotStatus(hour);
            const canStart = availableStarts.has(hour);
            const selected = walkinState.startHour === hour;
            const state = canStart ? 'open' : slotStatus;
            return `<button type="button" class="staff-hour-slot is-${state}${selected ? ' is-selected' : ''}" data-staff-walkin-hour="${hour}" aria-pressed="${selected}" ${canStart ? '' : 'disabled'}>
                <strong>${window.escapeHtml(fmt(hour))}</strong><span>${window.escapeHtml(canStart ? `Open · ${duration}h available` : labels[slotStatus] || 'Unavailable')}</span>
            </button>`;
        }).join('') || '<p class="staff-form-hint">No opening hours are configured for this date.</p>';
        walkinHourGrid.querySelectorAll('[data-staff-walkin-hour]').forEach((button) => button.addEventListener('click', () => {
            walkinState.startHour = Number(button.dataset.staffWalkinHour);
            walkinState.endHour = walkinState.startHour + duration - 1;
            renderWalkinTimePickers();
            updateWalkinSummary();
            renderWalkinWizard();
        }));
        if (walkinCurrentRangeEl) walkinCurrentRangeEl.textContent = walkinTimeRangeLabel() || '';
        if (walkinOpenWindowsEl) walkinOpenWindowsEl.textContent = availableStarts.size ? `${availableStarts.size} available start time${availableStarts.size === 1 ? '' : 's'} for this duration.` : `No continuous ${duration}-hour slot is available.`;
    }

    async function refreshWalkinTimePickers() {
        if (!walkinHourGrid) return;
        const mySeq = ++walkinRequestSeq;
        walkinBusinessRules = window.InigoBusinessHours?.getForDate
            ? await window.InigoBusinessHours.getForDate(todayDateInputValue()).catch(() => null)
            : null;
        if (!walkinBusinessRules?.authoritative) {
            walkinHoursForDay = [];
            walkinBookings = { ok: false, rows: [] };
            walkinWalkins = { ok: false, rows: [] };
            renderWalkinTimePickers();
            renderWalkinWizard();
            return;
        }
        const open = Number(walkinBusinessRules?.openHour ?? window.InigoBusinessHours?.OPEN_HOUR ?? 8);
        const close = Number(walkinBusinessRules?.closeHour ?? window.InigoBusinessHours?.CLOSE_HOUR ?? 20);
        walkinHoursForDay = walkinBusinessRules?.isClosed || close <= open ? [] : Array.from({ length: close - open }, (_, index) => open + index);
        if (!walkinState.court) { renderWalkinTimePickers(); return; }
        walkinHourGrid.innerHTML = '<p class="staff-form-hint">Checking live availability…</p>';
        if (walkinOpenWindowsEl) walkinOpenWindowsEl.textContent = 'Checking live availability…';
        const occupancyRes = await fetchWalkinOccupancyForCourt(walkinState.court.name);
        if (mySeq !== walkinRequestSeq) return;
        walkinBookings = { ok: occupancyRes.ok, rows: occupancyRes.rows.filter((row) => row.source === 'online') };
        walkinWalkins = { ok: occupancyRes.ok, rows: occupancyRes.rows.filter((row) => row.source !== 'online') };
        renderWalkinTimePickers();
    }

    function resetWalkinTimeSelectionAndRefresh() {
        walkinState.startHour = null;
        walkinState.endHour = null;
        refreshWalkinTimePickers();
    }

    function estimateCurrentWalkinAmount() {
        const hours = walkinHoursSelected();
        if (walkinState.rateUnit === '/set' && typeof walkinState.rateDay === 'number') return walkinState.rateDay * walkinState.rateQuantity;
        if (!hours) return null;
        if (typeof walkinState.rateDay === 'number' && (typeof walkinState.rateNight !== 'number' || walkinState.rateDay === walkinState.rateNight)) return walkinState.rateDay * hours;
        if (typeof walkinState.rateDay !== 'number' && typeof walkinState.rate === 'number') return walkinState.rate * hours;
        if (typeof walkinState.rateDay === 'number' && typeof walkinState.rateNight === 'number') return walkinHourlyAmount(hours);
        return null;
    }

    function buildWalkinLine() {
        if (!walkinState.court || walkinState.startHour === null || walkinState.endHour === null) return null;
        const date = todayDateInputValue();
        const startsAt = manilaDateTime(date, walkinState.startHour).toISOString();
        const endsAt = manilaDateTime(date, walkinState.endHour + 1).toISOString();
        return {
            listingId: walkinState.court.id,
            unitId: walkinState.unitId || null,
            sport: walkinState.court.sportName || walkinState.court.name,
            court: walkinState.court.name,
            unit: walkinState.unit || '',
            startsAt,
            endsAt,
            startHour: walkinState.startHour,
            endHour: walkinState.endHour,
            rateQuantity: walkinState.rateUnit === '/set' ? walkinState.rateQuantity : 1,
            subtotal: estimateCurrentWalkinAmount(),
        };
    }

    function clearWalkinCurrentLine() {
        walkinState.court = null;
        walkinState.unit = null;
        walkinState.unitId = null;
        walkinState.rateDay = null;
        walkinState.rateNight = null;
        walkinState.rate = null;
        walkinState.rateUnit = '/hr';
        walkinState.startHour = null;
        walkinState.endHour = null;
        walkinState.durationHours = 1;
        if (walkinDurationSelect) walkinDurationSelect.value = '1';
        if (walkinRateQuantityInput) walkinRateQuantityInput.value = '1';
        if (walkinUnitWrap) walkinUnitWrap.hidden = true;
    }

    function renderWalkinLines() {
        if (!walkinLinesEl) return;
        walkinLinesEl.innerHTML = walkinState.items.length ? `<strong>Added booking lines</strong>${walkinState.items.map((line, index) => `<div class="staff-walkin-line"><span>${index + 1}. ${window.escapeHtml(line.sport)} · ${window.escapeHtml(line.court)}${line.unit ? ` · ${window.escapeHtml(line.unit)}` : ''}<small>${window.escapeHtml(formatIsoTime12h(line.startsAt))}–${window.escapeHtml(formatIsoTime12h(line.endsAt))}</small></span><strong>${line.subtotal === null ? 'Rate pending' : window.escapeHtml(formatStaffPeso(line.subtotal))}</strong><button type="button" class="staff-icon-btn" aria-label="Remove line ${index + 1}" data-staff-walkin-remove-line="${index}">×</button></div>`).join('')}` : '';
        walkinLinesEl.querySelectorAll('[data-staff-walkin-remove-line]').forEach((button) => button.addEventListener('click', () => {
            walkinState.items.splice(Number(button.dataset.staffWalkinRemoveLine), 1);
            renderWalkinLines();
            updateWalkinSummary();
            renderWalkinWizard();
        }));
    }

    if (walkinDurationSelect) walkinDurationSelect.addEventListener('change', () => {
        walkinState.durationHours = Number(walkinDurationSelect.value) || 1;
        walkinState.startHour = null;
        walkinState.endHour = null;
        renderWalkinTimePickers();
        updateWalkinSummary();
        renderWalkinWizard();
    });
    if (walkinAddLineBtn) walkinAddLineBtn.addEventListener('click', () => {
        const line = buildWalkinLine();
        if (!line) return;
        walkinState.items.push(line);
        clearWalkinCurrentLine();
        renderWalkinLines();
        renderWalkinSportChips();
        refreshWalkinTimePickers();
        updateWalkinSummary();
        goToWalkinStep(2);
    });

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
            renderWalkinWizard();
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

    function updateWalkinSummary() {
        const subtotal = walkinState.items.reduce((sum, item) => item.subtotal === null ? null : (sum === null ? item.subtotal : sum + item.subtotal), 0);
        if (walkinSummaryName) walkinSummaryName.textContent = walkinState.name || '—';
        if (walkinSummaryMobile) walkinSummaryMobile.textContent = walkinState.mobile || 'Not provided';
        if (walkinSummaryPayment) walkinSummaryPayment.textContent = walkinState.payment === 'paymongo_qr'
            ? 'E-wallet QR · GCash'
            : walkinState.payment === 'paymongo' ? 'PayMongo online' : 'Cash';
        if (walkinSummaryTotal) walkinSummaryTotal.textContent = subtotal === null ? 'Confirm at front desk' : formatStaffPeso(subtotal);
        if (walkinOnlineFeeNote) walkinOnlineFeeNote.hidden = !['paymongo', 'paymongo_qr'].includes(walkinState.payment);
        if (walkinAcknowledgmentNote) walkinAcknowledgmentNote.textContent = walkinState.payment === 'paymongo_qr'
            ? 'A payment acknowledgment is available only after PayMongo confirms payment.'
            : 'Payment acknowledgment and entry pass — not a BIR invoice or official receipt.';
        if (walkinSaveBtn) walkinSaveBtn.textContent = walkinState.payment === 'paymongo_qr'
            ? 'Show GCash QR'
            : walkinState.payment === 'paymongo' ? 'Next · Pay online' : 'Complete cash payment';
        if (walkinReviewLinesEl) {
            walkinReviewLinesEl.innerHTML = walkinState.items.map((item, index) => `<div class="staff-walkin-review-line">
                <div><strong>${index + 1}. ${window.escapeHtml(item.sport)} · ${window.escapeHtml(item.court)}${item.unit ? ` · ${window.escapeHtml(item.unit)}` : ''}</strong>
                <span>${window.escapeHtml(formatWalkinDateLabel(item.startsAt))} · ${window.escapeHtml(formatIsoTime12h(item.startsAt))}–${window.escapeHtml(formatIsoTime12h(item.endsAt))}</span></div>
                <strong>${item.subtotal === null ? 'Rate pending' : window.escapeHtml(formatStaffPeso(item.subtotal))}</strong></div>`).join('');
        }
        if (walkinCurrentRangeEl) walkinCurrentRangeEl.textContent = walkinTimeRangeLabel() || '';
        if (walkinLinesEl && walkinState.items.length) renderWalkinLines();
    }

    // ---- Receipt (S4) — same store-receipt/ticket look as the customer
    // dashboard's .dash-receipt-card (includes/Dashboard.js's
    // renderReceiptCard()/downloadReceiptAsPng()), ported under
    // staff-receipt-* names. ----
    function formatWalkinDateLabel(iso) {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('en-US', { timeZone: STAFF_TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric' });
    }

    function renderStaffReceipt(receipt, target = walkinReceiptEl, context = 'walkin') {
        if (!target) return;
        const idAttr = window.escapeHtml(String(receipt.receipt_number || receipt.receipt_id || receipt.id || '—'));
        const items = Array.isArray(receipt.items) ? receipt.items : [];
        const amountText = (value) => value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : formatStaffPeso(Number(value));
        const itemSubtotalText = (item) => item.subtotal_minor !== null && item.subtotal_minor !== undefined
            ? amountText(Number(item.subtotal_minor) / 100)
            : amountText(item.subtotal);
        const amountFromMinor = (minor, fallback) => minor !== null && minor !== undefined
            ? amountText(Number(minor) / 100)
            : amountText(fallback);
        const courtSubtotal = amountFromMinor(receipt.court_subtotal_minor, receipt.court_subtotal ?? receipt.subtotal);
        const paymentReceived = amountFromMinor(receipt.amount_paid_minor ?? receipt.payment_base_minor, receipt.amount_paid ?? receipt.subtotal);
        const remainingBalance = amountFromMinor(receipt.remaining_balance_minor ?? receipt.remaining_minor, receipt.remaining_balance);
        const processingFee = amountFromMinor(receipt.fee_minor, receipt.fee);
        const customerCharged = amountFromMinor(receipt.gross_minor, receipt.total);
        const disclaimer = receipt.disclaimer || 'Payment acknowledgment and entry pass — not a BIR invoice or official receipt.';

        target.innerHTML = `
            <div class="staff-receipt-card" data-staff-receipt-card>
                <div class="staff-receipt-brand">
                    <span class="staff-receipt-brand-name">IñigoSync</span>
                    <span class="staff-receipt-brand-tag">Payment acknowledgment</span>
                </div>
                <p class="staff-receipt-no">Acknowledgment #${idAttr}</p>

                <div class="staff-receipt-divider"></div>

                <div class="staff-receipt-meta">
                    <div class="staff-summary-row"><span>Customer</span><strong>${window.escapeHtml(receipt.customer_name || 'Customer')}</strong></div>
                    ${receipt.mobile ? `<div class="staff-summary-row"><span>Mobile</span><strong>${window.escapeHtml(receipt.mobile)}</strong></div>` : ''}
                    <div class="staff-summary-row"><span>Issued</span><strong>${window.escapeHtml(formatWalkinDateLabel(receipt.issued_at || new Date().toISOString()))}</strong></div>
                </div>

                <div class="staff-receipt-divider"></div>

                <div class="staff-receipt-items">${items.map((item) => `<div class="staff-receipt-item">
                    <strong>${window.escapeHtml(item.sport || 'Sport')} · ${window.escapeHtml(item.court || 'Court')}${item.unit ? ` · ${window.escapeHtml(item.unit)}` : ''}</strong>
                    <span>${window.escapeHtml(formatWalkinDateLabel(item.starts_at))}</span>
                    <span>${window.escapeHtml(formatIsoTime12h(item.starts_at))}–${window.escapeHtml(formatIsoTime12h(item.ends_at))}</span>
                    <span>${window.escapeHtml(itemSubtotalText(item))}</span>
                </div>`).join('')}</div>

                <div class="staff-receipt-divider"></div>

                <div class="staff-receipt-meta">
                    <div class="staff-summary-row"><span>Court subtotal</span><strong>${window.escapeHtml(courtSubtotal)}</strong></div>
                    <div class="staff-summary-row"><span>Payment received</span><strong>${window.escapeHtml(paymentReceived)}</strong></div>
                    <div class="staff-summary-row"><span>Remaining balance</span><strong>${window.escapeHtml(remainingBalance)}</strong></div>
                    <div class="staff-summary-row"><span>Processing fee</span><strong>${window.escapeHtml(processingFee)}</strong></div>
                    <div class="staff-summary-row"><span>Payment method</span><strong>${window.escapeHtml(receipt.payment_method || '—')}</strong></div>
                    <div class="staff-summary-row"><span>Payment status</span><strong>${window.escapeHtml(receipt.payment_status || '—')}</strong></div>
                </div>

                <div class="staff-receipt-total">
                    <span>Customer charged</span>
                    <span>${window.escapeHtml(customerCharged)}</span>
                </div>

                <div class="staff-receipt-divider"></div>

                <p class="staff-receipt-thanks">Thank you for visiting Iñigos Sports Center!</p>
                <p class="staff-receipt-disclaimer">${window.escapeHtml(disclaimer)}</p>

                <div class="staff-receipt-actions">
                    <button type="button" class="staff-btn-primary" data-staff-receipt-download="${idAttr}">Download PNG</button>
                    <button type="button" class="staff-btn-ghost" data-staff-receipt-print>Print</button>
                    ${context === 'walkin' ? '<button type="button" class="staff-btn-ghost" data-staff-walkin-reset>New walk-in</button>' : '<button type="button" class="staff-btn-ghost" data-staff-receipt-close>Close</button>'}
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
        stopWalkinQrPolling();
        activeWalkinQr = null;
        const courts = walkinState.courts;
        const nightRateStartsAt = walkinState.nightRateStartsAt || null;
        walkinState = { name: '', mobile: '', customerId: null, customerMode: 'guest', customerSearchResult: null, mobileError: false, courts, court: null, unit: null, unitId: null, rateDay: null, rateNight: null, rate: null, rateUnit: '/hr', rateQuantity: 1, nightRateStartsAt, startHour: null, endHour: null, durationHours: 1, items: [], payment: staffCashEnabled ? 'cash' : 'paymongo' };
        if (walkinRateQuantityInput) walkinRateQuantityInput.value = '1';
        if (walkinDurationSelect) walkinDurationSelect.value = '1';
        if (walkinNameInput) walkinNameInput.value = '';
        if (walkinMobileInput) walkinMobileInput.value = '';
        if (walkinCustomerSearch) walkinCustomerSearch.value = '';
        if (walkinCustomerResults) { walkinCustomerResults.hidden = true; walkinCustomerResults.replaceChildren(); }
        if (walkinCustomerSelected) walkinCustomerSelected.hidden = true;
        walkinCustomerModeInputs.forEach((input) => { input.checked = input.value === 'guest'; });
        if (walkinAccountSearchWrap) walkinAccountSearchWrap.hidden = true;
        if (walkinNameInput) walkinNameInput.readOnly = false;
        if (walkinMobileInput) walkinMobileInput.readOnly = false;
        if (walkinLinesEl) walkinLinesEl.replaceChildren();
        if (walkinUnitWrap) walkinUnitWrap.hidden = true;
        renderWalkinSportChips();
        walkinBookings = { ok: true, rows: [] };
        walkinWalkins = { ok: true, rows: [] };
        renderWalkinTimePickers();
        walkinPaymentOptionEls.forEach((option) => {
            const radio = option.querySelector('input[type="radio"]');
            const isSelected = Boolean(radio && radio.dataset.staffPayment === walkinState.payment);
            option.classList.toggle('is-selected', isSelected);
            if (radio) radio.checked = isSelected;
        });
        updateWalkinSummary();
        goToWalkinStep(1);
    }

    let walkinLastOrderId = null;
    function normalizeRpcRow(data) {
        if (Array.isArray(data)) return data[0] || null;
        return data && typeof data === 'object' ? (data.data && !data.order_id ? normalizeRpcRow(data.data) : data) : null;
    }

    async function loadWalkinAcknowledgment(orderId) {
        if (!window.sb || !orderId) return { error: 'Order reference is missing.' };
        let result;
        try { result = await window.sb.rpc('get_walkin_order_acknowledgment', { p_order_id: String(orderId) }); }
        catch (error) { result = { error }; }
        const row = normalizeRpcRow(result?.data);
        if (result?.error) return { error: result.error.message || 'Could not load the acknowledgment.' };
        if (!row || !Array.isArray(row.items) || !row.items.length || !['paid', 'succeeded', 'completed'].includes(String(row.payment_status || '').toLowerCase())) {
            return { pending: true, error: 'Payment has not been confirmed yet. The acknowledgment becomes available after PayMongo confirms payment.' };
        }
        return { receipt: row };
    }

    function safePayMongoCheckoutUrl(value) {
        if (typeof value !== 'string' || value.length > 4096) return null;
        try {
            const url = new URL(value);
            if (url.protocol !== 'https:' || url.origin !== 'https://checkout.paymongo.com'
                || url.username || url.password || url.pathname === '/') return null;
            return url.href;
        } catch (_) { return null; }
    }

    function parseWalkinCheckoutExpiry(value) {
        let timestamp = NaN;
        if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
            const numeric = Number(value);
            timestamp = numeric > 1000000000000 ? numeric : numeric * 1000;
        } else if (typeof value === 'string') timestamp = new Date(value).getTime();
        return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8640000000000000 ? timestamp : null;
    }

    function formatWalkinCheckoutExpiry(timestamp) {
        return new Intl.DateTimeFormat('en-PH', {
            timeZone: STAFF_TIME_ZONE, dateStyle: 'medium', timeStyle: 'short',
        }).format(new Date(timestamp));
    }

    function stopWalkinQrPolling() {
        if (walkinQrPollTimer !== null) window.clearTimeout(walkinQrPollTimer);
        walkinQrPollTimer = null;
    }

    function renderWalkinQrError(orderId, amount, message) {
        stopWalkinQrPolling();
        activeWalkinQr = { orderId, amount, checkoutUrl: null, expiresAtMs: null, startedAt: Date.now() };
        if (walkinWizardWrap) walkinWizardWrap.hidden = true;
        if (walkinReceiptWrap) walkinReceiptWrap.hidden = false;
        if (!walkinReceiptEl) return;
        walkinReceiptEl.innerHTML = `<div class="staff-card staff-receipt-pending">
            <h3>GCash QR unavailable</h3>
            <p>${window.escapeHtml(message)} The walk-in order is still pending. Retry to prepare its PayMongo checkout QR.</p>
            <button type="button" class="staff-btn-primary" data-staff-walkin-qr-checkout-retry="${window.escapeHtml(String(orderId))}">Retry checkout setup</button>
            <button type="button" class="staff-btn-ghost" data-staff-walkin-reset>New walk-in</button>
        </div>`;
        const retry = walkinReceiptEl.querySelector('[data-staff-walkin-qr-checkout-retry]');
        if (retry) retry.dataset.amount = Number.isFinite(amount) ? String(amount) : '';
    }

    function scheduleWalkinQrPoll() {
        stopWalkinQrPolling();
        const active = activeWalkinQr;
        if (!active || !active.checkoutUrl || !active.expiresAtMs) return;
        const remaining = active.expiresAtMs - Date.now();
        if (remaining <= 0) {
            hideExpiredWalkinQr();
            setWalkinQrStatus('Checkout expired. Check once more for a late payment confirmation.', true);
            return;
        }
        const elapsed = Date.now() - active.startedAt;
        const delay = elapsed < 60000 ? 5000 : elapsed < 300000 ? 10000 : 30000;
        walkinQrPollTimer = window.setTimeout(() => checkWalkinQrPayment(active.orderId, false), Math.min(delay, remaining));
    }

    function setWalkinQrStatus(message, expired = false) {
        const status = walkinReceiptEl?.querySelector('[data-staff-walkin-qr-status]');
        if (!status) return;
        status.textContent = message;
        status.classList.toggle('is-expired', expired);
    }

    function hideExpiredWalkinQr() {
        const image = walkinReceiptEl?.querySelector('[data-staff-walkin-qr-image]');
        if (image) image.textContent = 'QR expired';
        const title = walkinReceiptEl?.querySelector('#staffWalkinQrTitle');
        if (title) title.textContent = 'Checkout expired';
    }

    function renderWalkinQrPanel(orderId, amount, checkoutUrl, expiresAtMs) {
        if (typeof window.qrcode !== 'function') {
            renderWalkinQrError(orderId, amount, 'The local QR generator is unavailable on this screen.');
            return false;
        }
        try {
            const expired = Date.now() >= expiresAtMs;
            let svg = '';
            if (!expired) {
                const code = window.qrcode(0, 'M');
                code.addData(checkoutUrl, 'Byte');
                code.make();
                svg = code.createSvgTag(4, 4, 'PayMongo GCash checkout QR code', 'PayMongo checkout QR');
            }
            activeWalkinQr = { orderId, amount, checkoutUrl, expiresAtMs, startedAt: Date.now() };
            if (walkinWizardWrap) walkinWizardWrap.hidden = true;
            if (walkinReceiptWrap) walkinReceiptWrap.hidden = false;
            if (!walkinReceiptEl) return false;
            const amountText = Number.isFinite(amount) ? formatStaffPeso(amount) : 'Confirm in PayMongo';
            walkinReceiptEl.innerHTML = `<section class="staff-walkin-qr-card" aria-labelledby="staffWalkinQrTitle">
                <div class="staff-walkin-qr-code" data-staff-walkin-qr-image>${expired ? 'QR expired' : svg}</div>
                <div class="staff-walkin-qr-copy">
                    <span class="staff-form-label">PayMongo checkout · GCash</span>
                    <h3 id="staffWalkinQrTitle">${expired ? 'Checkout expired' : 'Scan to pay'}</h3>
                    <p>Ask the customer to scan this QR with their phone, then finish payment on PayMongo. This QR opens a hosted checkout; it is not a direct wallet transfer.</p>
                    <div class="staff-walkin-qr-meta">
                        <div class="staff-summary-row"><span>Amount before processing fee</span><strong>${window.escapeHtml(amountText)}</strong></div>
                        <p>PayMongo shows any processing fee and the final amount before the customer pays.</p>
                        <p class="staff-walkin-qr-status" data-staff-walkin-qr-status role="status" aria-live="polite">${expired ? 'Checkout expired. Check once more for a late payment confirmation.' : 'Waiting for PayMongo payment confirmation…'}</p>
                        <div class="staff-summary-row"><span>Checkout expires</span><time datetime="${new Date(expiresAtMs).toISOString()}">${window.escapeHtml(formatWalkinCheckoutExpiry(expiresAtMs))}</time></div>
                    </div>
                    <div class="staff-walkin-qr-actions">
                        <button type="button" class="staff-btn-ghost" data-staff-walkin-qr-check>Check payment status</button>
                        <button type="button" class="staff-btn-ghost" data-staff-walkin-reset>New walk-in</button>
                    </div>
                </div>
            </section>`;
            if (!expired) scheduleWalkinQrPoll();
            return true;
        } catch (error) {
            console.error('[staff] local walk-in QR generation failed', error);
            renderWalkinQrError(orderId, amount, 'Could not generate the local checkout QR.');
            return false;
        }
    }

    function showWalkinQrCheckoutData(orderId, amount, checkoutData) {
        const checkoutUrl = safePayMongoCheckoutUrl(checkoutData?.checkout_url);
        const expiresAtMs = parseWalkinCheckoutExpiry(checkoutData?.expires_at);
        if (!checkoutUrl || !expiresAtMs) {
            renderWalkinQrError(orderId, amount,
                !checkoutUrl ? 'PayMongo did not return a valid checkout.paymongo.com URL.'
                    : 'PayMongo did not return a valid checkout expiry.');
            return false;
        }
        const checkoutMinor = checkoutData?.base_minor === null || checkoutData?.base_minor === undefined
            ? NaN : Number(checkoutData.base_minor);
        const authoritativeAmount = Number.isSafeInteger(checkoutMinor) && checkoutMinor > 0
            ? checkoutMinor / 100 : amount;
        return renderWalkinQrPanel(orderId, authoritativeAmount, checkoutUrl, expiresAtMs);
    }

    async function checkWalkinQrPayment(orderId, manual = true) {
        const active = activeWalkinQr;
        if (!active || String(active.orderId) !== String(orderId) || !active.checkoutUrl || walkinQrCheckInFlight) return;
        const expired = Date.now() >= active.expiresAtMs;
        if (expired && !manual) {
            hideExpiredWalkinQr();
            setWalkinQrStatus('Checkout expired. Check once more for a late payment confirmation.', true);
            stopWalkinQrPolling();
            return;
        }
        walkinQrCheckInFlight = true;
        const checkButton = walkinReceiptEl?.querySelector('[data-staff-walkin-qr-check]');
        if (manual && checkButton) { checkButton.disabled = true; checkButton.textContent = 'Checking…'; }
        const result = await loadWalkinAcknowledgment(orderId);
        walkinQrCheckInFlight = false;
        if (activeWalkinQr !== active) return;
        if (manual && checkButton?.isConnected) { checkButton.disabled = false; checkButton.textContent = 'Check payment status'; }
        if (result.receipt) {
            stopWalkinQrPolling();
            activeWalkinQr = null;
            renderStaffReceipt(result.receipt);
            window.InigoToast?.show('PayMongo confirmed payment. The acknowledgment is ready to print or download.');
            refreshBookingOverview();
            refreshCourtSchedule();
            refreshTransactions();
            refreshStaffNotifications();
            return;
        }
        if (expired) {
            hideExpiredWalkinQr();
            setWalkinQrStatus(result.error && !result.pending
                ? 'Checkout expired. Payment status could not be verified; retry the check before recording payment.'
                : 'Checkout expired. No payment acknowledgment is available until PayMongo confirms payment.', true);
            return;
        }
        setWalkinQrStatus(result.error && !result.pending
            ? 'Could not verify payment yet. The screen will retry automatically; you can also check again.'
            : 'Waiting for PayMongo payment confirmation…');
        scheduleWalkinQrPoll();
    }

    async function prepareWalkinQrCheckout(orderId, amount) {
        let checkout;
        try {
            checkout = await window.sb.functions.invoke('staff-walkin-checkout', {
                body: { order_id: String(orderId), channel: 'gcash' },
            });
        } catch (error) { checkout = { error }; }
        if (checkout?.error) {
            renderWalkinQrError(orderId, amount,
                checkout.error.message || 'Could not prepare the PayMongo checkout.');
            return false;
        }
        return showWalkinQrCheckoutData(orderId, amount, checkout?.data);
    }

    async function showWalkinAcknowledgment(orderId) {
        walkinLastOrderId = orderId;
        const result = await loadWalkinAcknowledgment(orderId);
        if (walkinWizardWrap) walkinWizardWrap.hidden = true;
        if (walkinReceiptWrap) walkinReceiptWrap.hidden = false;
        if (result.receipt) {
            renderStaffReceipt(result.receipt);
            return true;
        }
        if (walkinReceiptEl) {
            walkinReceiptEl.innerHTML = `<div class="staff-card staff-receipt-pending"><h3>Payment acknowledgment pending</h3><p>${window.escapeHtml(result.error)}</p><button type="button" class="staff-btn-ghost" data-staff-receipt-retry="${window.escapeHtml(orderId)}">Check payment again</button><button type="button" class="staff-btn-ghost" data-staff-walkin-reset>New walk-in</button></div>`;
        }
        return false;
    }

    const staffReceiptModal = document.querySelector('[data-staff-receipt-modal]');
    const staffReceiptDialog = document.querySelector('[data-staff-receipt-dialog]');
    const staffReceiptModalContent = document.querySelector('[data-staff-receipt-modal-content]');
    const staffShell = document.querySelector('.staff-shell');
    let staffReceiptModalLastFocus = null;

    function updateStaffModalBackground() {
        if (staffShell) staffShell.inert = Boolean((staffReceiptModal && !staffReceiptModal.hidden) || (timeInModal && !timeInModal.hidden));
    }

    function containStaffDialogTab(event, dialog) {
        if (!dialog) return;
        const focusable = Array.from(dialog.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
            .filter((element) => !element.closest('[hidden]') && !element.closest('[inert]') && element.getClientRects().length > 0);
        if (!focusable.length) {
            event.preventDefault();
            dialog.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (active === last || active === dialog || !dialog.contains(active))) {
            event.preventDefault();
            first.focus();
        }
    }

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab') return;
        if (staffReceiptModal && !staffReceiptModal.hidden) containStaffDialogTab(event, staffReceiptDialog);
        else if (timeInModal && !timeInModal.hidden) containStaffDialogTab(event, timeInDialog);
    });

    function openTransactionAcknowledgment(payment) {
        if (!payment || !staffReceiptModalContent || !staffReceiptModal) return;
        staffReceiptModalContent.innerHTML = '<p class="staff-notif-empty">Loading payment acknowledgment…</p>';
        staffReceiptModal.hidden = false;
        staffReceiptModalLastFocus = document.activeElement;
        updateStaffModalBackground();
        staffReceiptDialog?.focus();
        const ack = normalizeRpcRow(payment.acknowledgment);
        if (!ack) {
            staffReceiptModalContent.innerHTML = '<p class="staff-notif-empty">This payment does not have a saved acknowledgment.</p>';
            return;
        }
        const paymentStatus = String(ack.payment_status || '').toLowerCase();
        if (!['paid', 'succeeded', 'completed', 'partially_paid', 'partially paid', 'partially_settled'].includes(paymentStatus)) {
            staffReceiptModalContent.innerHTML = '<p class="staff-notif-empty">No payment acknowledgment is available until a payment is confirmed.</p>';
            return;
        }
        renderStaffReceipt(ack, staffReceiptModalContent, 'transaction');
    }

    function closeStaffReceiptModal() {
        if (!staffReceiptModal) return;
        staffReceiptModal.hidden = true;
        updateStaffModalBackground();
        staffReceiptModalContent?.replaceChildren();
        if (staffReceiptModalLastFocus?.focus) staffReceiptModalLastFocus.focus();
        staffReceiptModalLastFocus = null;
    }

    if (staffReceiptModal) {
        staffReceiptModal.addEventListener('click', async (event) => {
            if (event.target === staffReceiptModal || event.target.closest('[data-staff-receipt-close]')) {
                closeStaffReceiptModal();
                return;
            }
            const downloadBtn = event.target.closest('[data-staff-receipt-download]');
            if (downloadBtn) {
                const card = downloadBtn.closest('.staff-receipt-card');
                if (!card) return;
                const original = downloadBtn.textContent;
                downloadBtn.disabled = true;
                downloadBtn.textContent = 'Preparing…';
                const ok = await downloadStaffReceiptAsPng(card, downloadBtn.dataset.staffReceiptDownload || 'receipt');
                downloadBtn.disabled = false;
                downloadBtn.textContent = original;
                if (ok) window.InigoToast?.show('Acknowledgment downloaded.');
                return;
            }
            if (event.target.closest('[data-staff-receipt-print]')) window.print();
        });
        document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !staffReceiptModal.hidden) closeStaffReceiptModal(); });
    }

    // The walk-in is one atomic server-side order. If the RPC is unavailable,
    // fail closed; never fall back to inserting separate reservation rows.
    document.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-staff-walkin-save]');
        if (!button) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (button.disabled) return;
        if (!window.sb || !window.inigosyncProfile) {
            window.InigoToast?.show('Unable to reach the server. Try again shortly.', true);
            return;
        }
        if (!walkinState.name || (walkinState.customerMode === 'account' && !walkinState.customerId)) {
            window.InigoToast?.show('Choose an existing customer account or enter a guest name.', true);
            goToWalkinStep(1);
            return;
        }
        if (!walkinState.items.length) {
            window.InigoToast?.show('Add at least one available booking line.', true);
            goToWalkinStep(2);
            return;
        }
        if (walkinState.payment === 'cash' && !staffCashEnabled) {
            window.InigoToast?.show('Cash payment is currently unavailable.', true);
            return;
        }
        if (walkinState.payment === 'paymongo_qr' && !staffGcashEnabled) {
            window.InigoToast?.show('GCash checkout is currently unavailable.', true);
            return;
        }
        if (walkinState.items.some((item) => !Number.isFinite(item.subtotal)
            || item.subtotal <= 0 || !Number.isSafeInteger(Math.round(item.subtotal * 100)))) {
            window.InigoToast?.show('A court price is unavailable. Refresh availability and review the order again.', true);
            return;
        }
        if (walkinState.payment === 'paymongo' && !window.confirm('You will be redirected to PayMongo to complete the online payment. Continue?')) return;

        button.disabled = true;
        const originalText = button.textContent;
        button.textContent = 'Checking availability…';
        const requestedLines = walkinState.items.map((item) => ({ ...item }));
        const rpcItems = requestedLines.map((item) => ({
            listing_id: item.listingId,
            unit_id: item.unitId,
            starts_at: item.startsAt,
            ends_at: item.endsAt,
            rate_quantity: item.rateQuantity,
            quoted_minor: Math.round(item.subtotal * 100),
        }));
        let create;
        try {
            create = await window.sb.rpc('staff_create_walkin_order_quoted', {
                p_customer_id: walkinState.customerId || null,
                p_guest_name: walkinState.customerId ? null : walkinState.name,
                p_guest_mobile: walkinState.mobile || null,
                p_items: rpcItems,
                p_payment_method: walkinState.payment === 'paymongo_qr' ? 'paymongo' : walkinState.payment,
            });
        } catch (error) { create = { error }; }
        const order = normalizeRpcRow(create?.data);
        if (create?.error || !order?.order_id) {
            button.disabled = false;
            button.textContent = originalText;
            window.InigoToast?.show(create?.error?.message || 'Could not create the walk-in order. No reservation was saved.', true);
            return;
        }

        if (walkinState.payment === 'paymongo') {
            button.textContent = 'Opening PayMongo…';
            let checkout;
            try { checkout = await window.sb.functions.invoke('staff-walkin-checkout', { body: { order_id: String(order.order_id) } }); }
            catch (error) { checkout = { error }; }
            const checkoutUrl = safePayMongoCheckoutUrl(checkout?.data?.checkout_url);
            if (checkout?.error || !checkoutUrl) {
                button.disabled = false;
                button.textContent = originalText;
                window.InigoToast?.show(checkout?.error?.message || 'PayMongo did not return a valid checkout.paymongo.com URL. The order is still pending; retry from Transactions after checking its status.', true);
                refreshBookingOverview();
                refreshTransactions();
                return;
            }
            window.location.assign(checkoutUrl);
            return;
        }

        if (walkinState.payment === 'paymongo_qr') {
            button.textContent = 'Preparing GCash QR…';
            const orderMinor = order.base_minor === null || order.base_minor === undefined
                ? NaN : Number(order.base_minor);
            const amount = Number.isSafeInteger(orderMinor) && orderMinor > 0 ? orderMinor / 100 : null;
            await prepareWalkinQrCheckout(order.order_id, amount);
            refreshBookingOverview();
            refreshCourtSchedule();
            refreshTransactions();
            refreshStaffNotifications();
            return;
        }

        button.textContent = 'Loading acknowledgment…';
        await showWalkinAcknowledgment(order.order_id);
        window.InigoToast?.show('Walk-in order recorded.');
        refreshBookingOverview();
        refreshCourtSchedule();
        refreshTransactions();
        refreshStaffNotifications();
        button.disabled = false;
        button.textContent = originalText;
    }, true);

    // Event delegation — the receipt markup is fully replaced on every
    // save, so this binds once on the never-replaced wrapper instead of on
    // the buttons themselves.
    if (walkinReceiptWrap) {
        walkinReceiptWrap.addEventListener('click', async (e) => {
            const downloadBtn = e.target.closest('[data-staff-receipt-download]');
            const printBtn = e.target.closest('[data-staff-receipt-print]');
            const resetBtn = e.target.closest('[data-staff-walkin-reset]');
            const retryBtn = e.target.closest('[data-staff-receipt-retry]');
            const qrCheckBtn = e.target.closest('[data-staff-walkin-qr-check]');
            const qrCheckoutRetryBtn = e.target.closest('[data-staff-walkin-qr-checkout-retry]');

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
            if (retryBtn) {
                retryBtn.disabled = true;
                retryBtn.textContent = 'Checking…';
                await showWalkinAcknowledgment(retryBtn.dataset.staffReceiptRetry);
                return;
            }
            if (qrCheckBtn) {
                await checkWalkinQrPayment(activeWalkinQr?.orderId, true);
                return;
            }
            if (qrCheckoutRetryBtn) {
                const orderId = qrCheckoutRetryBtn.dataset.staffWalkinQrCheckoutRetry;
                const amount = qrCheckoutRetryBtn.dataset.amount === '' ? null : Number(qrCheckoutRetryBtn.dataset.amount);
                qrCheckoutRetryBtn.disabled = true;
                qrCheckoutRetryBtn.textContent = 'Preparing…';
                const ready = await prepareWalkinQrCheckout(orderId, amount);
                if (!ready) refreshTransactions();
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
        updateStaffModalBackground();
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
            updateStaffModalBackground();
            if (timeInModalLastFocused && typeof timeInModalLastFocused.focus === 'function' && document.contains(timeInModalLastFocused)) {
                timeInModalLastFocused.focus();
            }
            timeInModalLastFocused = null;
        }, TIMEIN_MODAL_CLOSE_DELAY_MS);
    }

    // Shared by Booking Overview and Transaction Records — both tables
    // render the identical Time-In button (staffActionCellHtml() above) and
    // must open the identical popup; `getRows` reads whichever array that
    // table's own refresh function most recently populated (overviewRows/
    // transactionRows), since rows are fully replaced (not patched) on
    // every refresh and a plain per-button listener would not survive that.
    function wireTimeInButtons(tbody, getRows) {
        if (!tbody) return;
        tbody.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-staff-action]');
            if (!btn || btn.disabled) return;
            const tr = btn.closest('tr');
            if (!tr) return;
            const row = getRows()[Number(tr.dataset.rowIndex)];
            if (!row) return;
            if (btn.dataset.staffAction === 'timein') {
                openTimeInModal(row);
                return;
            }
            if (btn.dataset.staffAction === 'timeout') {
                const target = rowTableTarget(row);
                if (!target.idValue || !window.sb) return;
                btn.disabled = true;
                btn.textContent = 'Recording…';
                const source = row.sourceType === 'booking' ? 'booking' : 'walkin';
                let result;
                try { result = await window.sb.rpc('staff_record_time_out', { p_source: source, p_id: String(target.idValue) }); }
                catch (error) { result = { error }; }
                if (result?.error || result?.data?.ok === false || result?.data?.success === false) {
                    btn.disabled = false;
                    btn.textContent = 'Time-Out';
                    window.InigoToast?.show(result?.error?.message || result?.data?.message || 'Could not record Time-Out.', true);
                    return;
                }
                window.InigoToast?.show('Time-Out recorded.');
                refreshBookingOverview();
                refreshCourtSchedule();
                refreshTransactions();
                refreshStaffNotifications();
            }
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
    const scheduleSearchInput = document.querySelector('[data-staff-schedule-search]');
    const scheduleSortSelect = document.querySelector('[data-staff-schedule-sort]');

    let scheduleActiveSport = 'all';
    let scheduleDate = todayDateInputValue();
    let scheduleCourtsCache = [];
    let scheduleBookingsCache = [];
    let scheduleWalkinsCache = [];
    let scheduleNameMap = new Map();
    let scheduleDataOk = true;
    let scheduleRulesCache = null;
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
            return { cls: 'is-unavailable', label: 'Unavailable', title: '' };
        }

        const bookingMatch = bookings.find((b) => {
            if (!sameCourtName(b.courts, row.court.name)) return false;
            if (!courtUnitsOverlap(b.court_unit, row.unitValue)) return false;
            return windowsOverlap(rowWindow(b), slot);
        });
        const maintenanceMatch = walkins.find((m) => m.source === 'maintenance'
            && sameCourtName(m.courts, row.court.name)
            && courtUnitsOverlap(m.court_unit, row.unitValue)
            && windowsOverlap(rowWindow(m), slot));
        if (maintenanceMatch) {
            const { start, end } = rowWindow(maintenanceMatch);
            return { cls: 'is-maintenance', label: 'Maintenance', title: `${maintenanceMatch.note || 'Court maintenance'} · ${formatIsoTime12h(start.toISOString())}–${formatIsoTime12h(end.toISOString())}` };
        }

        const heldMatch = walkins.find((h) => ['hold', 'checkout_hold', 'payment_hold', 'temporary_hold'].includes(String(h.source || '').toLowerCase())
            && sameCourtName(h.courts, row.court.name)
            && courtUnitsOverlap(h.court_unit, row.unitValue)
            && windowsOverlap(rowWindow(h), slot));
        if (heldMatch) return { cls: 'is-held', label: 'Temporarily held', title: scheduleTooltipFor(heldMatch, 'Checkout hold') };
        if (bookingMatch) return { cls: 'is-unavailable', label: 'Unavailable', title: scheduleTooltipFor(bookingMatch, 'Online booking') };

        const walkinMatch = walkins.find((w) => {
            if (w.source === 'maintenance' || ['hold', 'checkout_hold', 'payment_hold', 'temporary_hold'].includes(String(w.source || '').toLowerCase())) return false;
            if (!sameCourtName(w.courts, row.court.name)) return false;
            if (!courtUnitsOverlap(w.court_unit, row.unitValue)) return false;
            return windowsOverlap(rowWindow(w), slot);
        });
        if (walkinMatch) return { cls: 'is-unavailable', label: 'Unavailable', title: scheduleTooltipFor(walkinMatch, 'Walk-in', walkinMatch.customer_name || 'Walk-in customer') };

        return { cls: 'is-open', title: '' };
    }

    function renderCourtSchedule(courts, bookings, walkins) {
        if (!scheduleTable || !window.InigoCourtsData || !window.InigoBusinessHours) return;
        const openHour = Number(scheduleRulesCache?.openHour ?? window.InigoBusinessHours.OPEN_HOUR ?? 8);
        const closeHour = Number(scheduleRulesCache?.closeHour ?? window.InigoBusinessHours.CLOSE_HOUR ?? 20);
        const hours = scheduleRulesCache?.isClosed || closeHour <= openHour ? [] : Array.from({ length: closeHour - openHour }, (_, index) => openHour + index);
        const dateBase = scheduleDate;
        let rows = scheduleRowsForSport(scheduleActiveSport, courts);
        const query = (scheduleSearchInput?.value || '').trim().toLocaleLowerCase();
        if (query) rows = rows.filter((row) => `${row.rowLabel} ${row.court.sportName || ''} ${row.court.name} ${row.unitValue}`.toLocaleLowerCase().includes(query));

        const openCountFor = (row) => hours.reduce((sum, hour) => sum + (scheduleCellInfo(row, hour, dateBase, scheduleBookingsCache, scheduleWalkinsCache).cls === 'is-open' ? 1 : 0), 0);
        const sortBy = scheduleSortSelect?.value || 'name-asc';
        rows.sort((a, b) => {
            if (sortBy === 'name-desc') return b.rowLabel.localeCompare(a.rowLabel, undefined, { numeric: true, sensitivity: 'base' });
            if (sortBy === 'unit-asc') return a.unitValue.localeCompare(b.unitValue, undefined, { numeric: true, sensitivity: 'base' }) || a.rowLabel.localeCompare(b.rowLabel);
            if (sortBy === 'open-desc') return openCountFor(b) - openCountFor(a) || a.rowLabel.localeCompare(b.rowLabel);
            return a.rowLabel.localeCompare(b.rowLabel, undefined, { numeric: true, sensitivity: 'base' });
        });

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
                const label = info.label || (info.cls === 'is-open' ? 'Open' : 'Unavailable');
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
        const dateBase = manilaDateTime(scheduleDate, 0);
        const dayEnd = new Date(dateBase.getTime() + 24 * 60 * 60 * 1000);
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
        const walkins = rows.filter((row) => row.source !== 'online');

        scheduleNameMap = new Map();

        scheduleCourtsCache = courts;
        scheduleRulesCache = window.InigoBusinessHours?.getForDate
            ? await window.InigoBusinessHours.getForDate(scheduleDate).catch(() => null)
            : null;
        if (!scheduleRulesCache?.authoritative) scheduleDataOk = false;
        scheduleBookingsCache = bookings;
        scheduleWalkinsCache = walkins;
        renderCourtSchedule(courts, bookings, walkins);
    }

    renderScheduleSportTabs();
    if (scheduleSearchInput) scheduleSearchInput.addEventListener('input', () => renderCourtSchedule(scheduleCourtsCache, scheduleBookingsCache, scheduleWalkinsCache));
    if (scheduleSortSelect) scheduleSortSelect.addEventListener('change', () => renderCourtSchedule(scheduleCourtsCache, scheduleBookingsCache, scheduleWalkinsCache));
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
    const txSortSelect = document.querySelector('[data-staff-tx-sort]');
    // Revision S2 (implementation_plan.md, decisions S11/S14) — this
    // table's own rows, indexed the same way overviewRows is above, so its
    // Action column's Time-In button (added below) can open the same
    // Time-In payment popup Booking Overview uses.
    let transactionRows = [];
    const transactionPaymentHistoryCache = new Map();

    function transactionPaymentIdentity(row) {
        const source = row.sourceType === 'booking' ? 'booking' : 'walkin';
        const rawId = source === 'booking'
            ? row.raw.booking_id
            : (row.raw.walkin_id ?? row.raw.walk_in_booking_id ?? row.raw.id ?? row.raw.walkin_booking_id);
        const id = Number(rawId);
        return Number.isSafeInteger(id) && id > 0 ? { source, id, key: `${source}:${id}` } : null;
    }

    function transactionPaymentHistoryMarkup(history) {
        if (!history.length) return '<span class="staff-payment-history-empty">No completed payments recorded.</span>';
        const minorLabel = (value) => value === null || value === undefined || !Number.isFinite(Number(value))
            ? null : formatStaffPeso(Number(value) / 100);
        return `<ol class="staff-payment-history-list">${history.map((payment, index) => {
            const amounts = [];
            const base = minorLabel(payment.base_minor);
            const fee = minorLabel(payment.fee_minor);
            const gross = minorLabel(payment.gross_minor);
            const net = minorLabel(payment.net_minor);
            if (base !== null) amounts.push(`Base ${base}`);
            if (fee !== null) amounts.push(`Fee ${fee}`);
            if (gross !== null) amounts.push(`Customer paid ${gross}`);
            if (net !== null) amounts.push(`Net ${net}`);
            const method = window.escapeHtml(payment.method || 'Payment');
            const createdAt = payment.created_at
                ? new Date(payment.created_at).toLocaleString('en-US', { timeZone: STAFF_TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' })
                : 'Date unavailable';
            const receiptButton = payment.acknowledgment
                ? `<button type="button" class="staff-btn-ghost" data-staff-payment-ack="${index}">View acknowledgment</button>`
                : '<span class="staff-payment-history-empty">Acknowledgment unavailable</span>';
            return `<li><div class="staff-payment-history-details"><strong>${method}</strong><time>${window.escapeHtml(createdAt)}</time><span>${window.escapeHtml(amounts.join(' · ') || 'Amount unavailable')}</span></div>${receiptButton}</li>`;
        }).join('')}</ol>`;
    }

    async function loadTransactionPaymentHistory(row, button) {
        const identity = transactionPaymentIdentity(row);
        const cell = button.closest('[data-staff-payment-history-cell]');
        if (!identity || !cell || !window.sb) {
            if (cell) cell.innerHTML = '<span class="staff-payment-history-empty">Payment history unavailable.</span>';
            return;
        }
        button.disabled = true;
        button.textContent = 'Loading…';
        let result;
        try {
            result = await window.sb.rpc('staff_get_transaction_payment_history', {
                p_source: identity.source,
                p_id: identity.id,
            });
        } catch (error) { result = { error }; }
        if (result?.error) {
            cell.innerHTML = `<span class="staff-payment-history-empty">${window.escapeHtml(result.error.message || 'Could not load payment history.')}</span>`;
            return;
        }
        const payload = normalizeRpcRow(result.data) || {};
        const history = Array.isArray(payload.payment_history) ? payload.payment_history : [];
        transactionPaymentHistoryCache.set(identity.key, history);
        cell.innerHTML = transactionPaymentHistoryMarkup(history);
    }

    if (txFromInput) txFromInput.value = todayDateInputValue();
    if (txToInput) txToInput.value = todayDateInputValue();
    if (txFromInput) txFromInput.addEventListener('change', refreshTransactions);
    if (txToInput) txToInput.addEventListener('change', refreshTransactions);
    if (txSortSelect) txSortSelect.addEventListener('change', refreshTransactions);

    async function refreshTransactions() {
        if (!transactionsTableBody || !window.sb) return;

        const fromStr = (txFromInput && txFromInput.value) || todayDateInputValue();
        const toStr = (txToInput && txToInput.value) || todayDateInputValue();
        if (fromStr > toStr) {
            transactionsTableBody.innerHTML = '<tr><td colspan="13" class="staff-table-message">The start date must be on or before the end date.</td></tr>';
            return;
        }
        const rangeStart = manilaDateTime(fromStr, 0);
        const rangeEndExclusive = new Date(manilaDateTime(toStr, 0).getTime() + 24 * 60 * 60 * 1000);

        const [bookingsRes, walkinsRes] = await Promise.all([
            window.sb.from('booking').select('*').gte('time_date', rangeStart.toISOString()).lt('time_date', rangeEndExclusive.toISOString()),
            window.sb.from('walk_in_booking').select('*').gte('time_date', rangeStart.toISOString()).lt('time_date', rangeEndExclusive.toISOString()),
        ]);

        if (bookingsRes.error && walkinsRes.error) {
            console.error('[staff] failed to load transaction records', bookingsRes.error, walkinsRes.error);
            transactionsTableBody.innerHTML = '<tr><td colspan="13" class="staff-table-message">Could not load transaction records right now.</td></tr>';
            return;
        }
        if (bookingsRes.error) console.error('[staff] failed to load bookings for transactions', bookingsRes.error);
        if (walkinsRes.error) console.error('[staff] failed to load walk-ins for transactions', walkinsRes.error);

        const bookings = bookingsRes.error ? [] : (bookingsRes.data || []);
        const walkins = walkinsRes.error ? [] : (walkinsRes.data || []);
        const merged = mergeBookingRows(bookings, walkins);
        const sort = txSortSelect?.value || 'date-desc';
        const nameMap = await fetchProfileNamesByIds(merged.filter((r) => r.sourceType === 'booking').map((r) => r.customerId));
        merged.forEach((r) => {
            if (r.sourceType === 'booking') r.customerName = nameMap.get(String(r.customerId)) || 'Customer';
        });
        merged.sort((a, b) => {
            if (sort === 'name-asc') return String(a.customerName || '').localeCompare(String(b.customerName || ''), undefined, { sensitivity: 'base' });
            if (sort === 'name-desc') return String(b.customerName || '').localeCompare(String(a.customerName || ''), undefined, { sensitivity: 'base' });
            return (sort === 'date-asc' ? 1 : -1) * (new Date(a.time_date) - new Date(b.time_date));
        });

        transactionRows = merged;
        transactionPaymentHistoryCache.clear();
        transactionsTableBody.innerHTML = '';
        if (merged.length === 0) {
            transactionsTableBody.innerHTML = '<tr><td colspan="13" class="staff-table-message">No transactions in this date range.</td></tr>';
            wireFilterableTable('transactions');
            return;
        }

        const retryOrdersShown = new Set();
        merged.forEach((row, i) => {
            const status = staffDerivedStatus(row);
            const { end } = rowWindow(row);
            const timedIn = row.checked_in_at ? formatIsoTime12h(row.checked_in_at) : '—';
            // The server stores automatic exits at the reservation end and
            // staff-recorded early exits in checked_out_at. Legacy completed
            // rows without a stored exit show their scheduled end instead.
            const recordedExit = row.checked_out_at ? new Date(row.checked_out_at).getTime() : null;
            const automaticExit = recordedExit !== null && Math.abs(recordedExit - end.getTime()) < 60000;
            const timedOut = row.checked_out_at
                ? `${formatIsoTime12h(row.checked_out_at)} · ${automaticExit ? 'automatic' : 'recorded'}`
                : (status === 'completed' ? `${formatIsoTime12h(end.toISOString())} · scheduled` : '—');
            const fallbackName = row.sourceType === 'walkin' ? 'Walk-in customer' : 'Customer';
            const paymentInfo = timeInPaymentInfo(row);
            const paymentIdentity = transactionPaymentIdentity(row);
            const sportLabel = row.sports || row.raw.sports || '—';
            const courtLabel = row.courts || '—';
            const unitLabel = row.unit || '—';
            const paymentHistory = paymentIdentity
                ? `<div data-staff-payment-history-cell><button type="button" class="staff-btn-ghost" data-staff-payment-history-load>Load payment history</button></div>`
                : `<span>${window.escapeHtml(paymentInfo.total === null ? staffPaymentLabel(row) : `${formatStaffPeso(paymentInfo.paid)} paid / ${formatStaffPeso(paymentInfo.total)}`)}</span>`;
            const pendingWalkinOrderId = row.sourceType === 'walkin'
                ? (row.raw.walkin_order_id || row.raw.order_id || null)
                : null;
            // In an atomic PayMongo walk-in order, child reservations start
            // as pending and payment_method remains NULL until settlement.
            // Cash orders are created confirmed with a payment_id, so use the
            // server-backed order link + pending/no-payment state rather than
            // relying on that nullable child field.
            const pendingWalkin = Boolean(pendingWalkinOrderId)
                && String(row.raw.status || '').toLowerCase() === 'pending'
                && !row.raw.payment_id
                && !retryOrdersShown.has(String(pendingWalkinOrderId));
            if (pendingWalkin) retryOrdersShown.add(String(pendingWalkinOrderId));
            const retryWalkinAction = pendingWalkin
                ? `<button type="button" class="staff-mini-btn" data-staff-walkin-retry="${window.escapeHtml(String(pendingWalkinOrderId))}">Retry online checkout</button>`
                : '';

            const tr = document.createElement('tr');
            tr.dataset.status = row.sourceType; // source filter chips (all/online/walkin) key off this
            tr.dataset.rowIndex = String(i);
            tr.innerHTML = `
                <td>${window.escapeHtml(new Date(row.time_date).toLocaleDateString('en-US', { timeZone: STAFF_TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric' }))}</td>
                <td class="staff-cell-main">${window.escapeHtml(row.customerName || fallbackName)}</td>
                <td>${window.escapeHtml(sportLabel)}</td>
                <td>${window.escapeHtml(courtLabel)}</td>
                <td>${window.escapeHtml(unitLabel)}</td>
                <td>${window.escapeHtml(formatIsoTime12h(row.time_date))} – ${window.escapeHtml(formatIsoTime12h(end.toISOString()))}</td>
                <td><span class="staff-status ${row.sourceType === 'walkin' ? 'walkin' : 'online'}">${row.sourceType === 'walkin' ? 'Walk-in' : 'Online'}</span></td>
                <td>${window.escapeHtml(staffPaymentLabel(row))}</td>
                <td>${window.escapeHtml(timedIn)}</td>
                <td>${window.escapeHtml(timedOut)}</td>
                <td><span class="staff-status ${window.escapeHtml(status)}">${window.escapeHtml(staffStatusLabel(status))}</span></td>
                <td>${paymentHistory}</td>
                <td>${staffActionCellHtml(row, status)} ${retryWalkinAction}</td>
            `;
            transactionsTableBody.appendChild(tr);
        });

        wireFilterableTable('transactions');
    }

    wireTimeInButtons(transactionsTableBody, () => transactionRows);
    if (transactionsTableBody) transactionsTableBody.addEventListener('click', async (event) => {
        const historyButton = event.target.closest('[data-staff-payment-history-load]');
        const row = transactionRows[Number(event.target.closest('tr')?.dataset.rowIndex)];
        if (historyButton && row) {
            await loadTransactionPaymentHistory(row, historyButton);
            return;
        }
        const receiptButton = event.target.closest('[data-staff-payment-ack]');
        if (receiptButton && row) {
            const identity = transactionPaymentIdentity(row);
            const payment = identity && transactionPaymentHistoryCache.get(identity.key)?.[Number(receiptButton.dataset.staffPaymentAck)];
            if (payment) openTransactionAcknowledgment(payment);
            return;
        }
        const retryButton = event.target.closest('[data-staff-walkin-retry]');
        if (retryButton) {
            const orderId = retryButton.dataset.staffWalkinRetry;
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) return;
            if (!window.confirm('Continue to PayMongo to complete this pending walk-in payment?')) return;
            retryButton.disabled = true;
            retryButton.textContent = 'Opening PayMongo…';
            let checkout;
            try { checkout = await window.sb.functions.invoke('staff-walkin-checkout', { body: { order_id: orderId } }); }
            catch (error) { checkout = { error }; }
            if (!checkout?.error && String(checkout?.data?.channel || '').toLowerCase() === 'gcash') {
                const rawAmount = row?.raw?.amount_total;
                const amount = rawAmount === null || rawAmount === undefined || rawAmount === '' ? null : Number(rawAmount);
                retryButton.textContent = 'Opening GCash QR…';
                setActivePanel('walkin');
                showWalkinQrCheckoutData(orderId, Number.isFinite(amount) ? amount : null, checkout.data);
                return;
            }
            const checkoutUrl = safePayMongoCheckoutUrl(checkout?.data?.checkout_url);
            if (checkout?.error || !checkoutUrl) {
                retryButton.disabled = false;
                retryButton.textContent = 'Retry online checkout';
                window.InigoToast?.show(checkout?.error?.message || 'PayMongo did not return a valid checkout.paymongo.com URL. This order remains pending while its reservation hold is active.', true);
                return;
            }
            window.location.assign(checkoutUrl);
        }
    });

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
            }
        });

        document.addEventListener('click', (e) => {
            if (!staffNotif.contains(e.target)) closeStaffNotifMenu();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeStaffNotifMenu();
        });
    }

    const staffNotifMarkAll = document.querySelector('[data-staff-notif-mark-all]');
    const staffNotificationHistory = document.querySelector('[data-staff-notification-history]');
    const staffNotificationSearch = document.querySelector('[data-staff-notifications-search]');
    const staffNotificationPrev = document.querySelector('[data-staff-notifications-prev]');
    const staffNotificationNext = document.querySelector('[data-staff-notifications-next]');
    const staffNotificationPageLabel = document.querySelector('[data-staff-notifications-page]');
    const staffActivityBody = document.querySelector('[data-staff-activity-table] tbody');
    const staffActivitySearch = document.querySelector('[data-staff-activity-search]');
    const staffActivityFrom = document.querySelector('[data-staff-activity-from]');
    const staffActivityTo = document.querySelector('[data-staff-activity-to]');
    const staffActivitySort = document.querySelector('[data-staff-activity-sort]');
    const staffActivityPrev = document.querySelector('[data-staff-activity-prev]');
    const staffActivityNext = document.querySelector('[data-staff-activity-next]');
    const staffActivityPageLabel = document.querySelector('[data-staff-activity-page]');
    const STAFF_LIST_PAGE_SIZE = 20;
    let staffNotificationRows = [];
    let staffNotificationOffset = 0;
    let staffNotificationTotal = 0;
    let staffActivityOffset = 0;
    let staffActivityTotal = 0;
    let staffActivitySearchTimer = null;
    let staffNotificationSearchTimer = null;
    const selectedStaffNotificationKeys = new Set();
    const staffNotifSelect = document.querySelector('[data-staff-notif-select]');
    const staffNotifSelectedLabel = document.querySelector('[data-staff-notif-selected]');
    const staffNotifMarkSelected = document.querySelector('[data-staff-notif-mark-selected]');

    function syncStaffNotificationSelection() {
        staffNotifList?.querySelectorAll('[data-staff-notif-select-row]').forEach(checkbox => {
            checkbox.checked = selectedStaffNotificationKeys.has(checkbox.dataset.staffNotifSelectRow);
            checkbox.closest('.staff-notif-row')?.classList.toggle('is-selected', checkbox.checked);
        });
        if (staffNotifSelectedLabel) staffNotifSelectedLabel.textContent = `${selectedStaffNotificationKeys.size} selected`;
        if (staffNotifMarkSelected) staffNotifMarkSelected.disabled = selectedStaffNotificationKeys.size === 0;
    }

    function allowedStaffNotificationTarget(href) {
        if (!href) return '';
        try {
            const hash = new URL(String(href), window.location.href).hash.slice(1).toLowerCase();
            return ['overview', 'walkin', 'schedule', 'transactions', 'activity', 'notifications'].includes(hash) ? hash : '';
        } catch (_) { return ''; }
    }

    function renderStaffNotificationItem(item) {
        const category = String(item.category || 'booking').toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const key = String(item.key || '');
        return `<div class="staff-notif-row${item.read_at ? ' is-read' : ' is-unread'}" data-staff-notif-item data-staff-notification-key="${window.escapeHtml(key)}"><input type="checkbox" class="staff-notif-select-row" data-staff-notif-select-row="${window.escapeHtml(key)}" aria-label="Select ${window.escapeHtml(item.title || 'Update')}">
            <button type="button" class="staff-notif-item" data-staff-panel-target="${window.escapeHtml(allowedStaffNotificationTarget(item.href))}"><span class="staff-notif-dot ${window.escapeHtml(category)}" aria-hidden="true"></span><span class="staff-notif-item-body"><strong>${window.escapeHtml(item.title || 'Update')}</strong><span>${window.escapeHtml(item.body || '')}</span><small>${item.read_at ? 'Read' : 'Unread'}</small></span></button>
        </div>`;
    }

    async function fetchStaffNotifications(search = '', offset = 0, limit = STAFF_LIST_PAGE_SIZE) {
        if (!window.sb) return { rows: [], total: 0, unread: 0, error: 'Notifications are unavailable.' };
        let result;
        try { result = await window.sb.rpc('staff_list_notifications', { p_search: search, p_offset: offset, p_limit: limit }); }
        catch (error) { result = { error }; }
        if (result?.error) return { rows: [], total: 0, unread: 0, error: result.error.message || 'Could not load notifications.' };
        const payload = Array.isArray(result.data) ? { rows: result.data } : (normalizeRpcRow(result.data) || {});
        return { rows: payload.rows || payload.items || [], total: Number(payload.total_count || 0), unread: Number(payload.unread_count || 0) };
    }

    async function refreshStaffNotifications() {
        if (!staffNotifList || !window.sb) return;
        const result = await fetchStaffNotifications('', 0, 15);
        staffNotificationRows = result.rows;
        selectedStaffNotificationKeys.clear();
        if (staffNotifSelect) staffNotifSelect.value = 'none';
        staffNotifList.innerHTML = result.error ? `<p class="staff-notif-empty">${window.escapeHtml(result.error)}</p>`
            : (result.rows.length ? result.rows.map(renderStaffNotificationItem).join('') : '<p class="staff-notif-empty">No notifications yet.</p>');
        syncStaffNotificationSelection();
        if (staffNotifDot) staffNotifDot.hidden = result.error ? true : result.unread === 0;
    }

    async function markStaffNotificationRead(key) {
        if (!window.sb || !key) return false;
        let result;
        try { result = await window.sb.rpc('mark_notification_read', { p_key: key }); }
        catch (error) { result = { error }; }
        if (result?.error || result?.data === false) {
            const error = result?.error || new Error('The notification could not be marked as seen.');
            console.error('[staff] could not mark notification read', error);
            window.InigoToast?.show(error.message || 'Could not mark notification as seen.', true);
            return false;
        }
        await Promise.all([refreshStaffNotifications(), loadStaffNotificationHistory()]);
        return true;
    }

    async function markStaffNotifSeen() {
        if (!window.sb || !staffNotifMarkAll) return;
        staffNotifMarkAll.disabled = true;
        let result;
        try { result = await window.sb.rpc('staff_mark_all_notifications_read'); }
        catch (error) { result = { error }; }
        if (result?.error) {
            const message = result.error.message || 'Could not mark all notifications as seen.';
            console.error('[staff] could not mark all notifications as seen', result.error);
            window.InigoToast?.show(message, true);
            staffNotifMarkAll.disabled = false;
            return;
        }
        try { await Promise.all([refreshStaffNotifications(), loadStaffNotificationHistory()]); }
        finally { staffNotifMarkAll.disabled = false; }
    }

    async function loadStaffNotificationHistory() {
        if (!staffNotificationHistory) return;
        const result = await fetchStaffNotifications(staffNotificationSearch?.value.trim() || '', staffNotificationOffset, STAFF_LIST_PAGE_SIZE);
        if (result.error) {
            staffNotificationHistory.innerHTML = `<p class="staff-notif-empty">${window.escapeHtml(result.error)}</p>`;
            return;
        }
        staffNotificationTotal = result.total;
        staffNotificationHistory.innerHTML = result.rows.length ? result.rows.map((item) => `<article class="staff-history-item${item.read_at ? ' is-read' : ' is-unread'}">
            <span class="staff-history-mark" aria-hidden="true"></span><div><h3>${window.escapeHtml(item.title || 'Update')}</h3><p>${window.escapeHtml(item.body || '')}</p><time datetime="${window.escapeHtml(item.created_at || '')}">${window.escapeHtml(new Date(item.created_at).toLocaleString('en-US', { timeZone: STAFF_TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' }))}</time></div>
            <button type="button" class="staff-btn-ghost" data-staff-history-read="${window.escapeHtml(item.key || '')}" ${item.read_at ? 'disabled' : ''}>${item.read_at ? 'Seen' : 'Mark as seen'}</button></article>`).join('') : '<p class="staff-notif-empty">No notifications match your search.</p>';
        if (staffNotificationPageLabel) staffNotificationPageLabel.textContent = `Page ${Math.floor(staffNotificationOffset / STAFF_LIST_PAGE_SIZE) + 1}`;
        if (staffNotificationPrev) staffNotificationPrev.disabled = staffNotificationOffset <= 0;
        if (staffNotificationNext) staffNotificationNext.disabled = staffNotificationOffset + STAFF_LIST_PAGE_SIZE >= staffNotificationTotal;
    }

    if (staffNotifMarkAll) staffNotifMarkAll.addEventListener('click', markStaffNotifSeen);
    if (staffNotifList) staffNotifList.addEventListener('change', event => {
        const checkbox = event.target.closest('[data-staff-notif-select-row]');
        if (!checkbox) return;
        if (checkbox.checked) selectedStaffNotificationKeys.add(checkbox.dataset.staffNotifSelectRow);
        else selectedStaffNotificationKeys.delete(checkbox.dataset.staffNotifSelectRow);
        syncStaffNotificationSelection();
    });
    if (staffNotifList) staffNotifList.addEventListener('click', async (event) => {
        const item = event.target.closest('.staff-notif-item')?.closest('[data-staff-notif-item]');
        if (!item) return;
        const key = item.dataset.staffNotificationKey;
        const target = item.dataset.staffPanelTarget;
        if (key && !(await markStaffNotificationRead(key))) return;
        closeStaffNotifMenu();
        setActivePanel(target || 'overview');
    });
    staffNotifSelect?.addEventListener('change', () => {
        selectedStaffNotificationKeys.clear();
        const mode = staffNotifSelect.value;
        staffNotificationRows.filter(item => mode === 'all' || (mode === 'read' && item.read_at) || (mode === 'unread' && !item.read_at))
            .forEach(item => { if (item.key) selectedStaffNotificationKeys.add(String(item.key)); });
        syncStaffNotificationSelection();
    });
    staffNotifMarkSelected?.addEventListener('click', async () => {
        const keys = [...selectedStaffNotificationKeys];
        if (!keys.length || !window.sb) return;
        staffNotifMarkSelected.disabled = true;
        try {
            const results = await Promise.all(keys.map(key => window.sb.rpc('mark_notification_read', { p_key: key })));
            const failed = results.find(result => result?.error || result?.data === false);
            if (failed) throw failed.error || new Error('A notification could not be marked as read.');
            await Promise.all([refreshStaffNotifications(), loadStaffNotificationHistory()]);
        } catch (error) {
            console.error('[staff] selected notifications could not be marked read', error);
            window.InigoToast?.show(error.message || 'Could not mark selected notifications as read.', true);
            await Promise.all([refreshStaffNotifications(), loadStaffNotificationHistory()]);
        } finally {
            staffNotifMarkSelected.disabled = selectedStaffNotificationKeys.size === 0;
        }
    });
    if (staffNotificationHistory) staffNotificationHistory.addEventListener('click', (event) => {
        const button = event.target.closest('[data-staff-history-read]');
        if (button && !button.disabled) markStaffNotificationRead(button.dataset.staffHistoryRead);
    });
    if (staffNotificationSearch) staffNotificationSearch.addEventListener('input', () => {
        window.clearTimeout(staffNotificationSearchTimer);
        staffNotificationOffset = 0;
        staffNotificationSearchTimer = window.setTimeout(loadStaffNotificationHistory, 250);
    });
    if (staffNotificationPrev) staffNotificationPrev.addEventListener('click', () => { staffNotificationOffset = Math.max(0, staffNotificationOffset - STAFF_LIST_PAGE_SIZE); loadStaffNotificationHistory(); });
    if (staffNotificationNext) staffNotificationNext.addEventListener('click', () => { staffNotificationOffset += STAFF_LIST_PAGE_SIZE; loadStaffNotificationHistory(); });

    async function loadStaffCustomerActivity() {
        if (!staffActivityBody || !window.sb) return;
        const sortMap = { 'date-desc': 'newest', 'date-asc': 'oldest', 'name-asc': 'name_asc', 'name-desc': 'name_desc' };
        const from = staffActivityFrom?.value || null;
        const to = staffActivityTo?.value || null;
        if (from && to && from > to) {
            staffActivityBody.innerHTML = '<tr><td colspan="4" class="staff-table-message">The start date must be on or before the end date.</td></tr>';
            return;
        }
        let result;
        try {
            result = await window.sb.rpc('staff_customer_activity', {
                p_search: staffActivitySearch?.value.trim() || '',
                p_from: from,
                p_to: to,
                p_sort: sortMap[staffActivitySort?.value || 'date-desc'] || 'newest',
                p_offset: staffActivityOffset,
                p_limit: STAFF_LIST_PAGE_SIZE,
            });
        } catch (error) { result = { error }; }
        if (result?.error) {
            staffActivityBody.innerHTML = `<tr><td colspan="4" class="staff-table-message">${window.escapeHtml(result.error.message || 'Could not load customer activity.')}</td></tr>`;
            return;
        }
        const payload = Array.isArray(result.data)
            ? (result.data.length === 1 && result.data[0]?.rows ? result.data[0] : { rows: result.data })
            : (normalizeRpcRow(result.data) || {});
        const rows = payload.rows || [];
        staffActivityTotal = Number(payload.total_count || 0);
        staffActivityBody.innerHTML = rows.length ? rows.map((row) => {
            const details = row.details && typeof row.details === 'object' ? row.details : {};
            const action = String(row.action || '').toLowerCase();
            const detailParts = [];
            const summary = typeof row.details === 'string' ? row.details : (details.summary || details.description || details.message || '');
            if (summary) detailParts.push(summary);
            const bookingItem = [details.sport, details.court, details.unit].filter(Boolean).join(' · ');
            if (bookingItem) detailParts.push(bookingItem);
            if (details.starts_at) {
                const startLabel = `${formatWalkinDateLabel(details.starts_at)} · ${formatIsoTime12h(details.starts_at)}`;
                detailParts.push(details.ends_at ? `${startLabel}–${formatIsoTime12h(details.ends_at)}` : startLabel);
            } else if (details.ends_at) detailParts.push(`Ends ${formatIsoTime12h(details.ends_at)}`);
            const amountValue = details.amount ?? details.amount_paid ?? details.total;
            if (amountValue !== undefined && amountValue !== null && Number.isFinite(Number(amountValue))) detailParts.push(formatStaffPeso(Number(amountValue)));
            if (details.payment_method) detailParts.push(String(details.payment_method));
            if (details.payment_status || details.status) detailParts.push(String(details.payment_status || details.status));
            if (details.checked_in_at) detailParts.push(`Time-In ${formatIsoTime12h(details.checked_in_at)}`);
            if (details.checked_out_at) detailParts.push(`Time-Out ${formatIsoTime12h(details.checked_out_at)}`);
            if (action === 'sign_in' && details.sign_out_observed === false) detailParts.push('Sign-out unobserved');
            const detailText = [...new Set(detailParts)].join(' · ');
            const actionLabel = action === 'sign_in' ? 'Customer sign-in' : action === 'sign_out' ? 'Customer sign-out' : String(row.action || 'Activity').replaceAll('_', ' ');
            return `<tr><td>${window.escapeHtml(new Date(row.created_at).toLocaleString('en-US', { timeZone: STAFF_TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' }))}</td>
                <td class="staff-cell-main">${window.escapeHtml(row.customer_name || 'Customer')}</td><td>${window.escapeHtml(actionLabel)}</td><td>${window.escapeHtml(detailText)}</td></tr>`;
        }).join('') : '<tr><td colspan="4" class="staff-table-message">No customer activity matches these filters.</td></tr>';
        if (staffActivityPageLabel) staffActivityPageLabel.textContent = `Page ${Math.floor(staffActivityOffset / STAFF_LIST_PAGE_SIZE) + 1}`;
        if (staffActivityPrev) staffActivityPrev.disabled = staffActivityOffset <= 0;
        if (staffActivityNext) staffActivityNext.disabled = staffActivityOffset + STAFF_LIST_PAGE_SIZE >= staffActivityTotal;
    }

    if (staffActivityFrom) staffActivityFrom.addEventListener('change', () => { staffActivityOffset = 0; loadStaffCustomerActivity(); });
    if (staffActivityTo) staffActivityTo.addEventListener('change', () => { staffActivityOffset = 0; loadStaffCustomerActivity(); });
    if (staffActivitySort) staffActivitySort.addEventListener('change', () => { staffActivityOffset = 0; loadStaffCustomerActivity(); });
    if (staffActivitySearch) staffActivitySearch.addEventListener('input', () => {
        window.clearTimeout(staffActivitySearchTimer);
        staffActivityOffset = 0;
        staffActivitySearchTimer = window.setTimeout(loadStaffCustomerActivity, 250);
    });
    if (staffActivityPrev) staffActivityPrev.addEventListener('click', () => { staffActivityOffset = Math.max(0, staffActivityOffset - STAFF_LIST_PAGE_SIZE); loadStaffCustomerActivity(); });
    if (staffActivityNext) staffActivityNext.addEventListener('click', () => { staffActivityOffset += STAFF_LIST_PAGE_SIZE; loadStaffCustomerActivity(); });
    loadStaffCustomerActivity();

    if (staffNotifList) {
        staffNotifList.addEventListener('click', (e) => {
            if (e.target.closest('[data-staff-notif-item]')) e.stopImmediatePropagation();
        });
    }

    refreshStaffNotifications();
    document.addEventListener('inigosync:profile-ready', refreshStaffNotifications);
    window.setInterval(refreshStaffNotifications, STAFF_NOTIF_REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refreshStaffNotifications();
    });
    loadStaffNotificationHistory();

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

        let { data, error } = await window.sb
            .from('profiles')
            .select('address, birthdate, gender, emergency_contact_name, emergency_contact_number, created_at, contact_num_validated, contact_num_validated_at')
            .eq('id', window.inigosyncProfile.id)
            .single();

        // Keep personal details usable against older deployments that have
        // not applied the phone-validation columns yet. In that case the
        // UI reports the saved number's validation status as unavailable,
        // while changed numbers still need a live provider check on save.
        if (error && isSchemaMismatchError(error)) {
            const fallback = await window.sb
                .from('profiles')
                .select('address, birthdate, gender, emergency_contact_name, emergency_contact_number, created_at')
                .eq('id', window.inigosyncProfile.id)
                .single();
            if (!fallback.error) {
                data = fallback.data;
                error = null;
            }
        }

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
        window.inigosyncProfile.contact_num_validated = typeof data.contact_num_validated === 'boolean'
            ? data.contact_num_validated
            : null;
        window.inigosyncProfile.contact_num_validated_at = data.contact_num_validated_at || null;
        renderStaffProfile(window.inigosyncProfile);
        if (typeof refreshStaffPhoneValidationUi === 'function') refreshStaffPhoneValidationUi();
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

    const staffSettingsMobileInput = document.querySelector('[data-staff-settings-mobile]');
    const staffPhoneStatus = document.querySelector('[data-staff-phone-status]');
    let staffPhoneValidationBusy = false;

    function currentStaffMobileNormalized() {
        const current = window.inigosyncProfile?.contact_num || '';
        const check = current ? window.validatePhMobile(current) : null;
        return check?.valid ? check.normalized : '';
    }

    function typedStaffMobile() {
        const value = staffSettingsMobileInput?.value.trim() || '';
        if (!value) return { valid: true, normalized: '' };
        const check = window.validatePhMobile(value);
        return check.valid ? { valid: true, normalized: check.normalized } : check;
    }

    function refreshStaffPhoneValidationUi() {
        const parsed = typedStaffMobile();
        const unchanged = parsed.valid && parsed.normalized && parsed.normalized === currentStaffMobileNormalized();
        if (!staffPhoneStatus) return;
        if (!staffSettingsMobileInput?.value.trim()) {
            staffPhoneStatus.textContent = 'Contact number is optional. Saving a changed number checks its Philippine mobile format and type; it does not verify ownership or reachability.';
        } else if (!parsed.valid) {
            staffPhoneStatus.textContent = parsed.message || 'Enter a valid Philippine mobile number.';
        } else if (unchanged) {
            const validated = window.inigosyncProfile?.contact_num_validated;
            const checkedAt = window.inigosyncProfile?.contact_num_validated_at;
            if (validated === true) {
                const dateLabel = checkedAt ? new Date(checkedAt).toLocaleString('en-PH', {
                    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila',
                }) : '';
                staffPhoneStatus.textContent = `Saved number format/type check passed${dateLabel ? ` on ${dateLabel}` : ''}. Ownership and reachability are not verified.`;
            } else if (validated === false) {
                staffPhoneStatus.textContent = 'This is your current saved number. It has not passed the provider format/type check.';
            } else {
                staffPhoneStatus.textContent = 'This is your current saved number. Its provider validation status is unavailable.';
            }
        } else {
            staffPhoneStatus.textContent = 'Save Changes to check this number as an active Philippine mobile number. The check does not verify ownership or reachability.';
        }
    }

    if (staffSettingsMobileInput) staffSettingsMobileInput.addEventListener('input', refreshStaffPhoneValidationUi);
    document.addEventListener('inigosync:profile-ready', refreshStaffPhoneValidationUi);

    const staffSettingsSaveProfileBtn = document.querySelector('[data-staff-settings-save="profile"]');
    if (staffSettingsSaveProfileBtn) {
        staffSettingsSaveProfileBtn.addEventListener('click', async () => {
            if (!window.sb || !window.inigosyncProfile || staffPhoneValidationBusy) return;
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
            // app whenever a value IS entered. A changed number is checked
            // and saved in this one action; validation failure blocks the
            // entire profile write.
            let contact_num = '';
            let contactNumberChanged = false;
            let mobileCheck = null;
            if (mobileRaw) {
                mobileCheck = window.validatePhMobile(mobileRaw);
                if (!mobileCheck.valid) {
                    window.InigoToast?.show(mobileCheck.message, true);
                    mobileInput?.focus();
                    return;
                }
                contactNumberChanged = mobileCheck.normalized !== currentStaffMobileNormalized();
                if (!contactNumberChanged) contact_num = window.inigosyncProfile.contact_num || mobileCheck.normalized;
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
            staffPhoneValidationBusy = true;
            const saveButtonText = staffSettingsSaveProfileBtn.textContent;
            const restoreSaveButton = () => {
                staffPhoneValidationBusy = false;
                staffSettingsSaveProfileBtn.disabled = false;
                staffSettingsSaveProfileBtn.textContent = saveButtonText;
            };

            if (contactNumberChanged) {
                if (!window.sb?.functions?.invoke) {
                    restoreSaveButton();
                    const message = 'Phone validation is unavailable. No profile changes were saved; try again later.';
                    if (staffPhoneStatus) staffPhoneStatus.textContent = message;
                    window.InigoToast?.show(message, true);
                    return;
                }

                if (staffPhoneStatus) staffPhoneStatus.textContent = 'Checking the new number with the provider…';
                staffSettingsSaveProfileBtn.textContent = 'Checking number…';
                let validationResult;
                try {
                    validationResult = await window.sb.functions.invoke('validate-contact-phone', {
                        body: { phone: mobileCheck.normalized },
                    });
                } catch (validationError) {
                    validationResult = { error: validationError };
                }

                if (validationResult?.error) {
                    const message = 'Phone validation is unavailable. No profile changes were saved; try again later.';
                    restoreSaveButton();
                    if (staffPhoneStatus) staffPhoneStatus.textContent = message;
                    window.InigoToast?.show(message, true);
                    return;
                }

                const validation = normalizeRpcRow(validationResult?.data) || validationResult?.data || {};
                const returnedNumber = typeof validation.normalized === 'string' ? validation.normalized : '';
                const returnedCheck = returnedNumber ? window.validatePhMobile(returnedNumber) : null;
                const isCanonicalE164 = /^\+639\d{9}$/.test(returnedNumber);
                if (validation.valid !== true || validation.line_status !== 'active' || validation.phone_type !== 'mobile'
                    || !isCanonicalE164 || !returnedCheck?.valid || returnedCheck.normalized !== mobileCheck.normalized) {
                    const messages = {
                        inactive: 'The provider classified this number as inactive. No profile changes were saved.',
                        status_unknown: 'The provider could not confirm this number status. No profile changes were saved.',
                        not_mobile: 'The provider did not classify this as a mobile number. No profile changes were saved.',
                    };
                    const message = messages[validation.reason] || 'The provider could not validate this as an active Philippine mobile number. No profile changes were saved.';
                    restoreSaveButton();
                    if (staffPhoneStatus) staffPhoneStatus.textContent = message;
                    window.InigoToast?.show(message, true);
                    return;
                }

                // Persist exactly the provider's normalized E.164 value;
                // the database trigger consumes the one-use proof and
                // derives the validation fields server-side.
                contact_num = returnedNumber;
                fullPatch.contact_num = returnedNumber;
                if (staffPhoneStatus) staffPhoneStatus.textContent = 'Provider format/type checks passed for an active mobile number. Ownership and reachability are not verified.';
                staffSettingsSaveProfileBtn.textContent = 'Saving changes…';
            }

            let updateResult;
            try {
                updateResult = await window.sb.from('profiles').update(fullPatch).eq('id', window.inigosyncProfile.id);
            } catch (updateError) {
                updateResult = { error: updateError };
            }
            let { error } = updateResult || {};

            // Revision S3 (database/schema/018_staff_details.sql) — not
            // applied yet: retry with just full_name/contact_num, the two
            // columns every prior revision already relied on, same
            // schema-mismatch-retry idiom the Walk-In wizard's save uses
            // further up this file.
            let usedReducedPayload = false;
            if (error && isSchemaMismatchError(error)) {
                try {
                    ({ error } = await window.sb.from('profiles').update({ full_name, contact_num }).eq('id', window.inigosyncProfile.id));
                } catch (fallbackError) {
                    error = fallbackError;
                }
                usedReducedPayload = true;
            }

            restoreSaveButton();

            if (error) {
                if (contactNumberChanged && staffPhoneStatus) {
                    staffPhoneStatus.textContent = 'The number passed provider checks, but the profile could not be saved. No contact number was applied.';
                }
                window.InigoToast?.show(error.message || 'Could not save your changes.', true);
                return;
            }

            Object.assign(window.inigosyncProfile, fullPatch);
            if (staffPhoneStatus) staffPhoneStatus.textContent = !contact_num
                ? 'Contact number removed.'
                : contactNumberChanged
                    ? 'Contact number saved. Provider format/type checks passed; ownership and reachability are not verified.'
                    : 'Contact number is saved.';
            renderStaffProfile(window.inigosyncProfile);
            await loadStaffProfileDetails();
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
        if (staffPasswordSaveBtn) {
            const matches = Boolean(pwNewInput?.value && pwNewInput.value.length >= STAFF_PW_MIN_LENGTH && pwNewInput.value === pwConfirmInput?.value);
            staffPasswordSaveBtn.disabled = staffPwWizardStep !== 2 || !matches;
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

    [pwCurrentInput, pwNewInput, pwConfirmInput].forEach((input) => input?.addEventListener('input', renderStaffPwWizard));
    if (pwNextBtn) {
        pwNextBtn.addEventListener('click', async () => {
            if (pwNextBtn.disabled) return;
            pwNextBtn.disabled = true;
            pwNextBtn.textContent = 'Verifying…';
            const { data: pwSessionData } = await window.sb.auth.getSession();
            const verifyEmail = pwSessionData?.session?.user?.email || window.inigosyncProfile?.email;
            const { error } = await window.sb.auth.signInWithPassword({ email: verifyEmail, password: pwCurrentInput.value });
            pwNextBtn.textContent = 'Next';
            if (error) {
                window.InigoToast?.show('Current password is incorrect.', true);
                pwNextBtn.disabled = false;
                pwCurrentInput?.focus();
                return;
            }
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
            if (!window.confirm('Are you sure you want to save this new password?')) return;

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

    // PayMongo return parameters only identify which pending walk-in to
    // recheck. A signed provider webhook updates settlement; the UI asks the
    // acknowledgment RPC for that verified state and never trusts the URL.
    const walkinReturnUrl = new URL(window.location.href);
    const walkinReturnKind = walkinReturnUrl.searchParams.get('walkin_checkout');
    if (walkinReturnKind) {
        const orderId = walkinReturnUrl.searchParams.get('order');
        walkinReturnUrl.searchParams.delete('walkin_checkout');
        walkinReturnUrl.searchParams.delete('order');
        window.history.replaceState({}, document.title,
            `${walkinReturnUrl.pathname}${walkinReturnUrl.search}${walkinReturnUrl.hash}`);

        if (!orderId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId) || !window.sb) {
            window.InigoToast?.show('Could not identify the walk-in order returned from checkout.', true);
        } else if (walkinReturnKind === 'cancel') {
            window.InigoToast?.show('PayMongo checkout was cancelled. The order remains pending until checkout expires or payment is confirmed.', true);
        } else if (walkinReturnKind === 'return') {
            setActivePanel('walkin');
            const confirmed = await showWalkinAcknowledgment(orderId);
            if (confirmed) window.InigoToast?.show('PayMongo confirmed payment. The acknowledgment is ready to print or download.');
            else window.InigoToast?.show('Payment is still processing. No paid acknowledgment was issued; check again shortly.', true);
        }

        refreshBookingOverview();
        refreshCourtSchedule();
        refreshTransactions();
        refreshStaffNotifications();
    }
});
