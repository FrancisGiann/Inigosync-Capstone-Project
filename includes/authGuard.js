// Session + role guard for the 3 dashboards, plus shared logout wiring.
// Reads the required role from <body data-required-role="customer|staff|admin">.
// Actual data access is still enforced server-side by RLS — this only avoids
// showing the wrong dashboard shell to a signed-in user of the wrong role.
//
// This file also owns the two client-side pieces of the Security Module
// spec that apply once a dashboard is open (docs/SPEC_scope_and_limitations.md):
//   A. Session Expiration — idle auto-logout (pure frontend, always on).
//   B. Single Session — one active device at a time (needs
//      database/schema/005_session_security.sql; silently no-ops until the
//      owner runs it — see checkSessionSupersession()'s header comment).
// Loaded by all three dashboard pages, so implementing both here covers
// every dashboard without touching any dashboard-specific file.
//
// Everything below lives inside the single DOMContentLoaded callback (as
// the original file already did) rather than at this script's top level —
// this project loads many plain <script src> files on the same page with
// no bundler and no modules, and top-level `const`/`let` in one script tag
// shares its scope with every other script tag on the same page: a
// same-named top-level `const` anywhere else would throw a page-breaking
// SyntaxError. Keeping every declaration inside this one function avoids
// that risk entirely.
document.addEventListener('DOMContentLoaded', async () => {
    // ========================================================================
    // A. Idle session expiration — constants
    // ========================================================================
    // 30 minutes of no real user activity signs the user out automatically; a
    // warning appears 2 minutes before that so there's a chance to stay signed
    // in. 30 minutes is generous enough not to interrupt someone reading a
    // booking summary or filling in a walk-in form, but short enough to matter
    // on a shared/front-desk device left unattended. Named constants (not
    // magic numbers) so these are easy to retune later.
    const IDLE_TIMEOUT_MS = 5 * 60 * 1000;        // inactivity duration that triggers sign-out
    const IDLE_WARNING_MS = 2 * 60 * 1000;         // show the "still there?" warning this long before sign-out
    const IDLE_CHECK_INTERVAL_MS = 15 * 1000;      // coarse clock re-check cadence
    const IDLE_ACTIVITY_THROTTLE_MS = 5 * 1000;    // min gap between activity timestamp writes (cheap on mousemove/scroll)
    const IDLE_ACTIVITY_EVENTS = ['pointerdown', 'mousemove', 'keydown', 'wheel', 'touchstart', 'scroll'];
    // Per-user (not per-browser) so two different accounts opened in the same
    // browser never share — or falsely inherit — each other's idle clock.
    const IDLE_ACTIVITY_STORAGE_PREFIX = 'inigosync-last-activity:';

    // ========================================================================
    // B. Single session — constants
    // ========================================================================
    const SESSION_CHECK_INTERVAL_MS = 60 * 1000; // how often to poll `active_session` while a dashboard tab is open
    // MUST match the identically-named literal in includes/auth.js's
    // registerActiveSession()/completeLogin() — this file only ever reads it.
    const SESSION_TOKEN_STORAGE_PREFIX = 'inigosync-session-token:';

    // One-shot reason handed across the redirect to the login page so
    // includes/auth.js can surface a clear "why was I signed out" message
    // using its own existing notice mechanism (setAuthNotice). MUST match the
    // identically-named literal read in includes/auth.js.
    const AUTH_NOTICE_STORAGE_KEY = 'inigosync-auth-notice';

    if (window.InigoLoading) window.InigoLoading.show('Loading your dashboard…');

    if (!window.sb) {
        console.error('[authGuard] Supabase client (window.sb) is not available.');
        return;
    }

    const requiredRole = document.body.dataset.requiredRole;
    const dashboardByRole = {
        customer: '../Pages/user_dashboard.html',
        staff: '../Pages/staff_dashboard.html',
        admin: '../Pages/owner_dashboard.html'
    };

    // `reason` (optional) is stashed in sessionStorage for includes/auth.js
    // to pick up on the landing page — see AUTH_NOTICE_STORAGE_KEY above.
    function goToLogin(reason) {
        if (reason) {
            try { sessionStorage.setItem(AUTH_NOTICE_STORAGE_KEY, reason); } catch (_) { /* ignore */ }
        }
        window.location.assign(new URL('../index.html', window.location.href).toString());
    }

    const { data: { session } } = await window.sb.auth.getSession();
    if (!session) {
        goToLogin();
        return;
    }

    const { data: profile, error } = await window.sb
        .from('profiles')
        .select('id, role, full_name, email, status, contact_num, position, avatar_url')
        .eq('id', session.user.id)
        .single();

    if (error || !profile || profile.status === 'disabled') {
        await window.sb.auth.signOut();
        goToLogin();
        return;
    }

    if (requiredRole && profile.role !== requiredRole) {
        const redirectUrl = dashboardByRole[profile.role];
        window.location.assign(new URL(redirectUrl || '../index.html', window.location.href).toString());
        return;
    }

    window.inigosyncProfile = profile;
    if (window.InigoLoading) window.InigoLoading.hide();
    document.documentElement.classList.remove('inigo-auth-pending');
    document.dispatchEvent(new CustomEvent('inigosync:profile-ready', { detail: profile }));

    // ------------------------------------------------------------------
    // Shared sign-out plumbing — used by idle timeout, single-session
    // supersession, and the manual "Log out" buttons alike, so every exit
    // path clears the timers below and (optionally) leaves a reason for
    // the login page.
    // ------------------------------------------------------------------
    let idleCheckIntervalId = null;
    let idleWarningTickId = null;
    let sessionCheckIntervalId = null;
    let signOutInProgress = false;

    function clearSessionSecurityTimers() {
        if (idleCheckIntervalId) { window.clearInterval(idleCheckIntervalId); idleCheckIntervalId = null; }
        if (idleWarningTickId) { window.clearInterval(idleWarningTickId); idleWarningTickId = null; }
        if (sessionCheckIntervalId) { window.clearInterval(sessionCheckIntervalId); sessionCheckIntervalId = null; }
        hideIdleWarning();
    }

    async function signOutAndGoToLogin(reason) {
        if (signOutInProgress) return;
        signOutInProgress = true;
        clearSessionSecurityTimers();
        // A browser close cannot be observed reliably. Record only exits the
        // app actually performs, while the customer JWT is still valid.
        if (profile.role === 'customer' && typeof window.sb.rpc === 'function') {
            try {
                const eventResult = await Promise.race([
                    window.sb.rpc('record_customer_session_event', { p_kind: 'sign_out' }),
                    new Promise(resolve => window.setTimeout(resolve, 1200)),
                ]);
                if (eventResult?.error) throw eventResult.error;
            } catch (error) {
                console.warn('[authGuard] customer sign-out event was not recorded', error);
            }
        }
        try {
            await window.sb.auth.signOut();
        } catch (_) {
            // Navigating away regardless — a failed signOut call shouldn't
            // trap the user on a dashboard they can no longer safely use.
        }
        goToLogin(reason);
    }

    async function logout() {
        await signOutAndGoToLogin();
    }

    document.querySelectorAll('[data-dash-logout], [data-staff-logout], [data-admin-logout]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            logout();
        });
    });

    // ==================================================================
    // A. Idle session expiration
    // ==================================================================
    // Self-contained inline-styled UI: Style/Auth.css (this file's other
    // owned stylesheet) isn't loaded on any dashboard page, and no
    // dashboard HTML/CSS file may be edited for this feature — see this
    // repo's Phase 6 report for why. CSS custom properties from
    // Style/LandingPage.css ARE loaded on every dashboard, so the colors
    // below stay on-theme (and follow light/dark switching) without
    // needing a stylesheet of their own.
    const activityStorageKey = IDLE_ACTIVITY_STORAGE_PREFIX + profile.id;
    let lastActivityWriteAt = 0;
    let idleWarningEl = null;
    let idleWarningTextEl = null;
    let idleWarningVisible = false;

    function getLastActivityAt() {
        try {
            const raw = localStorage.getItem(activityStorageKey);
            const parsed = raw ? parseInt(raw, 10) : NaN;
            if (Number.isFinite(parsed)) return parsed;
        } catch (_) {
            // localStorage unavailable — fall through to "just now" below,
            // which simply means the idle clock restarts every reload
            // instead of surviving one. Never throw over this.
        }
        return Date.now();
    }

    function recordActivity(force) {
        const now = Date.now();
        if (!force && now - lastActivityWriteAt < IDLE_ACTIVITY_THROTTLE_MS) return;
        lastActivityWriteAt = now;
        try { localStorage.setItem(activityStorageKey, String(now)); } catch (_) { /* best-effort only */ }
        if (idleWarningVisible) hideIdleWarning();
    }

    // Real activity always resets the clock. Deliberately does NOT include
    // tab-focus/visibility — those only trigger a re-check (checkIdle),
    // never a reset (recordActivity). If focus/visibility reset the clock,
    // simply restoring a suspended laptop and glancing at the tab would
    // always look like fresh activity, which would defeat the "survives
    // closing the lid" requirement entirely.
    IDLE_ACTIVITY_EVENTS.forEach((evt) => {
        window.addEventListener(evt, () => recordActivity(false), { passive: true, capture: true });
    });
    // Arriving at the dashboard counts as activity (also initializes the
    // stored timestamp on a first-ever visit, or overwrites a stale one
    // left over from a previous, unrelated idle-out on this browser).
    recordActivity(true);

    function ensureIdleWarningEl() {
        if (idleWarningEl) return idleWarningEl;

        idleWarningEl = document.createElement('div');
        idleWarningEl.setAttribute('role', 'alert');
        idleWarningEl.setAttribute('aria-live', 'assertive');
        Object.assign(idleWarningEl.style, {
            position: 'fixed',
            top: '28px',
            left: '50%',
            zIndex: '999',
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '14px',
            maxWidth: 'min(440px, calc(100vw - 32px))',
            margin: '0',
            padding: '14px 18px',
            borderRadius: '16px',
            background: 'var(--color-bg-elevated, #1c1712)',
            border: '1px solid var(--color-alert, #d6482f)',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.4)',
            color: 'var(--color-ink, #f4efe6)',
            fontFamily: 'var(--font-body, Inter, "Segoe UI", sans-serif)',
            fontSize: '0.88rem',
            fontWeight: '600',
            textAlign: 'left',
            opacity: '0',
            pointerEvents: 'none',
            transform: 'translate(-50%, -12px)',
            transition: 'opacity 0.25s ease, transform 0.25s ease'
        });

        idleWarningTextEl = document.createElement('span');
        idleWarningTextEl.style.flex = '1 1 auto';

        const stayBtn = document.createElement('button');
        stayBtn.type = 'button';
        stayBtn.textContent = 'Stay signed in';
        Object.assign(stayBtn.style, {
            flexShrink: '0',
            border: 'none',
            borderRadius: '999px',
            padding: '9px 18px',
            background: 'var(--color-primary, #FF6115)',
            color: '#14110d',
            fontFamily: 'inherit',
            fontWeight: '700',
            fontSize: '0.85rem',
            cursor: 'pointer'
        });
        stayBtn.addEventListener('click', () => recordActivity(true));

        idleWarningEl.appendChild(idleWarningTextEl);
        idleWarningEl.appendChild(stayBtn);
        document.body.appendChild(idleWarningEl);
        return idleWarningEl;
    }

    function showIdleWarning(remainingMs) {
        const el = ensureIdleWarningEl();
        const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
        const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
        const ss = String(totalSeconds % 60).padStart(2, '0');
        idleWarningTextEl.textContent = `You've been inactive. Signing out in ${mm}:${ss} unless you stay signed in.`;

        if (!idleWarningVisible) {
            idleWarningVisible = true;
            el.style.pointerEvents = 'auto';
            requestAnimationFrame(() => {
                el.style.opacity = '1';
                el.style.transform = 'translate(-50%, 0)';
            });
        }
    }

    function hideIdleWarning() {
        if (idleWarningTickId) { window.clearInterval(idleWarningTickId); idleWarningTickId = null; }
        if (!idleWarningVisible || !idleWarningEl) return;
        idleWarningVisible = false;
        idleWarningEl.style.opacity = '0';
        idleWarningEl.style.pointerEvents = 'none';
        idleWarningEl.style.transform = 'translate(-50%, -12px)';
    }

    // Timestamp-diffing, not a countdown timer — re-reads the persisted
    // last-activity value every call instead of decrementing an in-memory
    // counter, so a laptop suspended for longer than IDLE_TIMEOUT_MS still
    // signs out on the very next tick after it wakes, regardless of how
    // long it was asleep or whether any timers actually fired during that
    // time (they don't, while suspended).
    function checkIdle() {
        const elapsed = Date.now() - getLastActivityAt();

        if (elapsed >= IDLE_TIMEOUT_MS) {
            signOutAndGoToLogin('idle');
            return;
        }

        const remaining = IDLE_TIMEOUT_MS - elapsed;
        if (remaining <= IDLE_WARNING_MS) {
            showIdleWarning(remaining);
            if (!idleWarningTickId) idleWarningTickId = window.setInterval(checkIdle, 1000);
        } else {
            hideIdleWarning();
        }
    }

    idleCheckIntervalId = window.setInterval(checkIdle, IDLE_CHECK_INTERVAL_MS);

    // ==================================================================
    // B. Single session — supersession check
    // ==================================================================
    // If database/schema/005_session_security.sql has not been applied,
    // `active_session` does not exist. includes/auth.js's
    // registerActiveSession() already knows this and, on that failure,
    // deliberately never writes a local session token — so `localToken`
    // below is simply absent for every user, this function returns on its
    // very first line, and single-session enforcement is a complete no-op:
    // no query against the missing table is ever attempted from here, and
    // nothing about login or the dashboard can break because of it. Once
    // the table exists and a login has run at least once after that, a
    // local token is present and real comparisons begin.
    let sessionCheckInFlight = false;

    async function checkSessionSupersession() {
        if (sessionCheckInFlight) return;

        let localToken = null;
        try {
            localToken = localStorage.getItem(SESSION_TOKEN_STORAGE_PREFIX + profile.id);
        } catch (_) {
            return;
        }
        if (!localToken) return;

        sessionCheckInFlight = true;
        try {
            const { data, error: sessionError } = await window.sb
                .from('active_session')
                .select('session_token')
                .eq('user_id', profile.id)
                .maybeSingle();

            // Table missing, RLS denies, network hiccup, or no row yet —
            // never treat any of these as "you were superseded".
            if (sessionError || !data || !data.session_token) return;

            if (data.session_token !== localToken) {
                await signOutAndGoToLogin('superseded');
                return;
            }

            // Still the active session for this device — best-effort
            // heartbeat, failure ignored (never worth interrupting anyone
            // over a heartbeat write).
            window.sb.from('active_session')
                .update({ last_seen_at: new Date().toISOString() })
                .eq('user_id', profile.id)
                .eq('session_token', localToken)
                .then(() => {}, () => {});
        } catch (_) {
            // Never let this check throw / break the dashboard.
        } finally {
            sessionCheckInFlight = false;
        }
    }

    sessionCheckIntervalId = window.setInterval(checkSessionSupersession, SESSION_CHECK_INTERVAL_MS);
    // A short delay on the very first check avoids piling this request on
    // top of the dashboard's own initial data fetches at page boot.
    window.setTimeout(checkSessionSupersession, 3000);

    // "on focus" per spec — re-evaluate both idle and supersession the
    // moment this tab becomes the active one again (e.g. after switching
    // tabs, or restoring a suspended laptop), rather than waiting for the
    // next scheduled interval tick.
    window.addEventListener('focus', () => {
        checkIdle();
        checkSessionSupersession();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            checkIdle();
            checkSessionSupersession();
        }
    });
});
