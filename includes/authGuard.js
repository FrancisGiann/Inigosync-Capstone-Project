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
    const onboardingPath = '../Pages/staff_onboarding.html';

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

    // This server check must precede even the role/profile query. A valid
    // password/OAuth token without its email proof can read only the narrow
    // AAL1 bootstrap paths configured in the database pre-request guard.
    try {
        const mfa = await window.InigoEmailMfa?.check?.({ activity: true });
        if (mfa?.verified !== true) {
            goToLogin('email_verification_required');
            return;
        }
    } catch (error) {
        console.error('[authGuard] email session proof could not be checked', error);
        goToLogin('email_verification_unavailable');
        return;
    }

    const profileColumns = 'id, role, full_name, email, status, contact_num, position, avatar_url';
    const onboardingColumn = 'onboarding_complete';
    const isMissingOnboardingColumn = error => {
        const message = String(error?.message || '').toLowerCase();
        return ['42703', 'PGRST204'].includes(String(error?.code || ''))
            && message.includes(onboardingColumn)
            && /(column|schema cache|could not find)/.test(message);
    };
    let { data: profile, error } = await window.sb
        .from('profiles')
        .select(`${profileColumns}, ${onboardingColumn}`)
        .eq('id', session.user.id)
        .single();

    // Keep existing customer/admin accounts usable during staggered deploys:
    // this newer onboarding column may not exist in the live schema yet.
    // Only legacy active staff retain the access they had before this
    // migration; pending staff remain behind the onboarding gate below.
    if (error && isMissingOnboardingColumn(error)) {
        ({ data: profile, error } = await window.sb
            .from('profiles')
            .select(profileColumns)
            .eq('id', session.user.id)
            .single());
    }

    if (error || !profile || profile.status === 'disabled') {
        await window.sb.auth.signOut();
        goToLogin();
        return;
    }

    // Before the onboarding migration, active staff were already approved
    // through the legacy staff flow. Preserve that access when the column is
    // genuinely absent; pending staff still go through onboarding. Server
    // role/status policies remain authoritative for all protected data.
    const legacyActiveStaff = profile.role === 'staff'
        && !Object.prototype.hasOwnProperty.call(profile, onboardingColumn)
        && profile.status === 'active';

    if (profile.role !== 'customer') {
        try { sessionStorage.removeItem('inigosync:landing-booking-draft:v1'); } catch (_) { /* storage may be disabled */ }
    }

    const isStaffOnboardingPage = document.body.hasAttribute('data-staff-onboarding-page');
    if (profile.role === 'staff' && profile.onboarding_complete !== true && !legacyActiveStaff && !isStaffOnboardingPage) {
        window.location.replace(new URL(onboardingPath, window.location.href).toString());
        return;
    }
    if (isStaffOnboardingPage && (profile.role !== 'staff' || profile.onboarding_complete === true || legacyActiveStaff)) {
        window.location.replace(new URL(dashboardByRole[profile.role] || '../index.html', window.location.href).toString());
        return;
    }

    if (requiredRole && profile.role !== requiredRole) {
        const redirectUrl = dashboardByRole[profile.role];
        window.location.assign(new URL(redirectUrl || '../index.html', window.location.href).toString());
        return;
    }

    // Keep the server-side seven-day inactivity window aligned with real
    // user activity. This throttled check also refreshes the trusted-device
    // expiry when the browser has a remembered-device secret.
    let lastEmailProofActivityAt = Date.now();
    let emailProofTouchInFlight = false;
    const touchEmailProof = async () => {
        const now = Date.now();
        if (emailProofTouchInFlight || now - lastEmailProofActivityAt < 4 * 60 * 1000) return;
        lastEmailProofActivityAt = now;
        emailProofTouchInFlight = true;
        try {
            const result = await window.InigoEmailMfa.check({ activity: true });
            if (result?.verified !== true) goToLogin('email_verification_required');
        } catch (error) {
            console.error('[authGuard] email session activity could not be refreshed', error);
            goToLogin('email_verification_unavailable');
        } finally { emailProofTouchInFlight = false; }
    };
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(type => {
        document.addEventListener(type, touchEmailProof, { passive: true });
    });

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
        // A browser close cannot be observed reliably. Record only sign-out
        // actions the app handles, while the authenticated JWT is still valid.
        if (typeof window.sb.rpc === 'function') {
            try {
                const eventReason = reason === 'idle' ? 'idle_timeout'
                    : reason === 'superseded' ? 'session_replaced' : 'app_logout';
                const eventResult = await Promise.race([
                    window.sb.rpc('record_account_session_event', { p_kind: 'sign_out', p_reason: eventReason }),
                    new Promise(resolve => window.setTimeout(resolve, 1200)),
                ]);
                if (eventResult?.error) throw eventResult.error;
            } catch (error) {
                console.warn('[authGuard] account sign-out event was not recorded', error);
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

    let logoutDialog = null;
    let logoutDialogOpener = null;
    let logoutConfirmed = false;
    let logoutPreviousBodyOverflow = '';

    function closeLogoutDialog() {
        if (!logoutDialog || logoutConfirmed) return;
        logoutDialog.hidden = true;
        logoutDialog.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = logoutPreviousBodyOverflow;
        document.removeEventListener('keydown', handleLogoutDialogKeydown);
        logoutDialogOpener?.focus();
        logoutDialogOpener = null;
    }

    function handleLogoutDialogKeydown(event) {
        if (!logoutDialog || logoutDialog.hidden) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            closeLogoutDialog();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...logoutDialog.querySelectorAll('button:not([disabled])')];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!logoutDialog.contains(document.activeElement)) {
            event.preventDefault();
            first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function ensureLogoutDialog() {
        if (logoutDialog) return logoutDialog;
        const overlay = document.createElement('div');
        overlay.className = 'inigosync-logout-overlay';
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
        overlay.innerHTML = `
            <section class="inigosync-logout-dialog" role="dialog" aria-modal="true"
                aria-labelledby="inigosync-logout-title" aria-describedby="inigosync-logout-message" tabindex="-1">
                <button type="button" class="inigosync-logout-close" aria-label="Close logout confirmation">&times;</button>
                <h2 id="inigosync-logout-title">Log out?</h2>
                <p id="inigosync-logout-message">Are you sure you want to log out of your account?</p>
                <div class="inigosync-logout-actions">
                    <button type="button" class="inigosync-logout-cancel">Cancel</button>
                    <button type="button" class="inigosync-logout-confirm">Log Out</button>
                </div>
            </section>`;
        const style = document.createElement('style');
        style.textContent = `
            .inigosync-logout-overlay { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; padding: 20px; background: rgba(15, 18, 22, .58); }
            .inigosync-logout-overlay[hidden] { display: none; }
            .inigosync-logout-dialog { position: relative; box-sizing: border-box; width: min(100%, 420px); padding: 30px; border: 1px solid var(--color-line, #e5e7eb); border-radius: 18px; background: var(--color-bg-card, #fff); color: var(--color-ink, #202124); box-shadow: 0 22px 70px rgba(0, 0, 0, .24); }
            .inigosync-logout-dialog h2 { margin: 0 34px 10px 0; font: inherit; font-size: 1.35rem; font-weight: 700; }
            .inigosync-logout-dialog p { margin: 0; line-height: 1.55; color: var(--color-ink-dim, #60646c); }
            .inigosync-logout-close { position: absolute; top: 14px; right: 14px; width: 36px; height: 36px; border: 0; border-radius: 50%; background: transparent; color: inherit; font-size: 25px; cursor: pointer; }
            .inigosync-logout-close:hover, .inigosync-logout-close:focus-visible { background: rgba(127, 127, 127, .14); }
            .inigosync-logout-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 26px; }
            .inigosync-logout-actions button { min-height: 42px; padding: 0 18px; border: 1px solid var(--color-line, #d7d9dc); border-radius: 10px; background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
            .inigosync-logout-actions .inigosync-logout-confirm { border-color: var(--color-primary, #FF6115); background: var(--color-primary, #FF6115); color: #14110d; }
            .inigosync-logout-actions .inigosync-logout-confirm:hover { border-color: var(--color-primary-dim, #D4410A); background: var(--color-primary-dim, #D4410A); color: #fff; }
            .inigosync-logout-dialog button:focus-visible { outline: 3px solid var(--color-primary, #FF6115); outline-offset: 2px; }
            @media (prefers-reduced-motion: no-preference) { .inigosync-logout-dialog { animation: inigosync-logout-enter .16s ease-out; } @keyframes inigosync-logout-enter { from { opacity: 0; transform: translateY(5px) scale(.99); } to { opacity: 1; transform: none; } } }
        `;
        document.head.appendChild(style);
        document.body.appendChild(overlay);
        logoutDialog = overlay;

        const cancel = overlay.querySelector('.inigosync-logout-cancel');
        const confirm = overlay.querySelector('.inigosync-logout-confirm');
        overlay.querySelector('.inigosync-logout-close').addEventListener('click', closeLogoutDialog);
        cancel.addEventListener('click', closeLogoutDialog);
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeLogoutDialog();
        });
        confirm.addEventListener('click', async () => {
            if (logoutConfirmed || signOutInProgress) return;
            logoutConfirmed = true;
            confirm.disabled = true;
            cancel.disabled = true;
            overlay.querySelector('.inigosync-logout-close').disabled = true;
            document.removeEventListener('keydown', handleLogoutDialogKeydown);
            await signOutAndGoToLogin();
        });
        return overlay;
    }

    function openLogoutDialog(opener) {
        if (signOutInProgress || logoutConfirmed) return;
        const overlay = ensureLogoutDialog();
        logoutDialogOpener = opener;
        overlay.hidden = false;
        overlay.setAttribute('aria-hidden', 'false');
        logoutPreviousBodyOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        document.addEventListener('keydown', handleLogoutDialogKeydown);
        overlay.querySelector('.inigosync-logout-cancel').focus();
    }

    document.querySelectorAll('[data-dash-logout], [data-staff-logout], [data-admin-logout]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            openLogoutDialog(btn);
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
