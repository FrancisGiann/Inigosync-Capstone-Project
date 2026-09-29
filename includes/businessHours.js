// IñigoSync — Shared operating-hours constants (Part 3, multi-hour booking —
// implementation_plan.md, "Multi-hour booking with availability checking").
// Updated by Revision 5 (implementation_plan.md, D1/D2) — see below.
//
// Before this file existed, the sports center's operating hours were three
// separate, hardcoded, and mutually inconsistent hour lists:
//   - Pages/user_dashboard.html's Step 2 slot buttons: 8 AM-8 PM, and — a
//     real bug — SKIPPED 12:00 PM entirely (12 of 13 possible hours only).
//   - includes/Dashboard.js's OVERVIEW_SLOT_HOURS (the Overview "Peek
//     slots" widget): 8 AM-8 PM, correctly including noon.
//   - includes/staff_dashboard.js's SCHEDULE_SLOTS (the Court Schedule
//     grid): 2-hour columns from 8 AM, its LAST column covering only
//     6 PM-8 PM — silently unable to ever show a booking in the 8 PM-9 PM
//     hour, because it assumed closing time was 8 PM, not 9 PM.
// Every consumer now reads OPEN_HOUR/CLOSE_HOUR from here instead, so
// there is exactly one place that says what the sports center's bookable
// hours are. There is no operating-hours row in `app_settings`
// (database/schema/007_app_settings.sql) or anywhere else in the live
// database — like that file's payment defaults, this is a hardcoded
// fallback the whole app agrees on until an admin-configurable setting
// exists for it.
//
// Revision 5, D1 (implementation_plan.md) — CLOSE_HOUR moves from 21 (9 PM)
// to 20 (8 PM), on the user's explicit instruction that the sports center's
// bookable window is 8:00 AM - 8:00 PM (12 whole-hour slots: 8-9, 9-10, …
// 7-8 PM), not 8:00 AM - 9:00 PM. Every consumer that already reads
// OPEN_HOUR/CLOSE_HOUR from here (the customer dashboard's Overview peek
// widget and Step 2 time pickers, the staff Court Schedule) picks this up
// automatically with no code change of their own — see each file's own
// comments for what one fewer bookable hour means there.
//
// This project ships plain <script src> tags (no build step, no ES
// modules), so this attaches to window, same as includes/courtsData.js and
// includes/appSettings.js. Load this after Config/supabaseClient.js (not
// actually required by this file, but keeps this project's <script> block
// ordering easy to reason about) and BEFORE includes/Dashboard.js and
// includes/staff_dashboard.js, both of which read window.InigoBusinessHours
// at parse time (top-level `const` hour lists), not just inside a later
// callback.
(function () {
    // 8:00 AM. The sports center's first bookable hour.
    const OPEN_HOUR = 8;
    // 8:00 PM (20:00). Exclusive — the LAST bookable hour STARTS at 7 PM
    // (hour 19) and ends here (Revision 5, D1 — implementation_plan.md;
    // was 21/9 PM before this revision). Never treat this as a valid start
    // hour.
    const CLOSE_HOUR = 20;
    const TIMEZONE = 'Asia/Manila';
    const DEFAULT_GRACE_MINUTES = 30;
    const CACHE_MS = 60 * 1000;
    const rulesByDate = new Map();

    function dateInManila(value = new Date()) {
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) throw new Error('Invalid booking date.');
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(date);
        const part = type => parts.find(item => item.type === type)?.value;
        return `${part('year')}-${part('month')}-${part('day')}`;
    }

    function normalizeRules(row, authoritative) {
        const source = Array.isArray(row) ? row[0] : row;
        const openHour = Number(source?.open_hour);
        const closeHour = Number(source?.close_hour);
        const graceMinutes = Number(source?.grace_minutes);
        const isClosed = source?.is_closed === true;
        return {
            openHour: Number.isInteger(openHour) && openHour >= 0 && openHour < 24 ? openHour : OPEN_HOUR,
            closeHour: Number.isInteger(closeHour) && closeHour > 0 && closeHour <= 24 ? closeHour : CLOSE_HOUR,
            isClosed,
            graceMinutes: Number.isInteger(graceMinutes) && graceMinutes >= 0 ? graceMinutes : DEFAULT_GRACE_MINUTES,
            timezone: source?.timezone || TIMEZONE,
            authoritative,
        };
    }

    // The server is authoritative for booking validation. This reader gives
    // all dashboards the same date-specific view, while retaining the prior
    // hours only when a pre-migration server cannot provide the RPC.
    async function getForDate(value = new Date(), { force = false } = {}) {
        const date = dateInManila(value);
        const cached = rulesByDate.get(date);
        if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.promise;
        const promise = (async () => {
            if (!window.sb || typeof window.sb.rpc !== 'function') return normalizeRules(null, false);
            try {
                const { data, error } = await window.sb.rpc('booking_rules_for_date', { p_date: date });
                if (error || !data) throw error || new Error('No booking rules returned.');
                return normalizeRules(data, true);
            } catch (error) {
                console.warn('[businessHours] using fallback hours', error);
                return normalizeRules(null, false);
            }
        })();
        rulesByDate.set(date, { at: Date.now(), promise });
        return promise;
    }

    function invalidateRules() { rulesByDate.clear(); }

    // "8:00 AM" / "6:00 PM" — the long form used by the customer dashboard
    // (Booking Step 2's From/To time pickers, the Overview peek widget).
    function formatHourLabel(hour) {
        const period = hour >= 12 ? 'PM' : 'AM';
        const hour12 = ((hour + 11) % 12) + 1;
        return `${hour12}:00 ${period}`;
    }

    // "8 AM" / "6 PM" — the short form used by the staff Court Schedule's
    // narrower time-column labels. Same period/hour12 math as
    // formatHourLabel above, just without the ":00".
    function formatHourLabelShort(hour) {
        const period = hour >= 12 ? 'PM' : 'AM';
        const hour12 = ((hour + 11) % 12) + 1;
        return `${hour12} ${period}`;
    }

    // "8:00 AM – 9:00 AM" (Revision 5, D2 — implementation_plan.md) — one
    // whole-hour slot's full start-to-end range, built from two
    // formatHourLabel() calls rather than a parallel implementation so the
    // two can never disagree on a single hour's own label. Used wherever a
    // slot/pill needs to read as a range instead of just its start time
    // (e.g. a future full-width slot listing) — the customer dashboard's
    // Overview peek strip uses the SHORT form below instead, since a range
    // this long doesn't fit a small pill.
    function formatHourRangeLabel(hour) {
        return `${formatHourLabel(hour)} – ${formatHourLabel(hour + 1)}`;
    }

    // "8–9 AM" / "11 AM–12 PM" / "7–8 PM" (Revision 5, D2) — the compact
    // range form the Overview peek strip's pills use (renderOverviewSlotPill()
    // in includes/Dashboard.js), replacing that widget's old single
    // start-time-only label. The period (AM/PM) is printed ONCE, after the
    // end hour, whenever both ends share it ("8–9 AM") — printing it twice
    // ("8 AM–9 AM") would be redundant in a label this narrow. The one
    // hour of the day that crosses noon (11 AM–12 PM) is the sole case
    // where the two ends DON'T share a period, so both get their own,
    // exactly like a normal range would read.
    function formatHourRangeLabelShort(hour) {
        const startPeriod = hour >= 12 ? 'PM' : 'AM';
        const startHour12 = ((hour + 11) % 12) + 1;
        const endHour = hour + 1;
        const endPeriod = endHour >= 12 ? 'PM' : 'AM';
        const endHour12 = ((endHour + 11) % 12) + 1;
        const startPart = startPeriod === endPeriod ? `${startHour12}` : `${startHour12} ${startPeriod}`;
        return `${startPart}–${endHour12} ${endPeriod}`;
    }

    // [OPEN_HOUR, CLOSE_HOUR) stepping by `step` (default 1, hourly).
    // includes/staff_dashboard.js's SCHEDULE_SLOTS calls this with step=2
    // for its 2-hour columns. Before Part 3 this was its own hardcoded
    // [8,10,12,14,16,18] array that assumed an 8 PM closing time; Part 3
    // briefly made it yield ONE MORE column (through hour 20) once
    // CLOSE_HOUR became 21/9 PM. Revision 5's D1 (implementation_plan.md)
    // returns CLOSE_HOUR to 20/8 PM on the user's explicit instruction, so
    // this is back to 6 columns ([8,10,12,14,16,18], last one covering
    // 6 PM-8 PM) — see that file's own comment for the full history.
    function hoursRange(step) {
        const stepSize = Number.isFinite(step) && step > 0 ? step : 1;
        const hours = [];
        for (let h = OPEN_HOUR; h < CLOSE_HOUR; h += stepSize) hours.push(h);
        return hours;
    }

    window.InigoBusinessHours = {
        OPEN_HOUR,
        CLOSE_HOUR,
        TIMEZONE,
        dateInManila,
        getForDate,
        invalidateRules,
        formatHourLabel,
        formatHourLabelShort,
        formatHourRangeLabel,
        formatHourRangeLabelShort,
        hoursRange,
    };
})();
