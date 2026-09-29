// IñigoSync — Login / Sign up / OTP Verify / Admin modal controller
// Handles: opening the modal from any [data-auth-open] trigger,
// closing via backdrop/close button/Escape, switching between
// the Log In, Sign Up, Verify (OTP), and Admin panels, and password
// show/hide toggles.
//
// Note: the Admin panel is login-only — the Log In / Sign Up tab bar is
// automatically hidden whenever the Admin or Verify panel is active. The
// Verify panel has no tab of its own and is only reached programmatically.
// ONE panel serves all three code flows, switched by `otpPurpose`: after
// Sign Up ('signup'), on a first log-in from an untrusted device ('login'),
// and after a password-reset request ('recovery'). Everything it owns — the
// six boxes, the countdown, the Resend button — is shared; only the heading,
// the back link, the verifyOtp() type and the follow-up action differ.
//
// Sign Up is a two-step flow (email + password → name/mobile/terms) that
// lives inside a single <form>: the steps are containers this file shows and
// hides, never separate forms, so FormData still collects every field in one
// go and the submit path below is the same one it always was. See the
// "Sign Up — stepped flow" section, and the password policy above it, which
// applies to Sign Up and Reset Password only — never to Log In.

document.addEventListener('DOMContentLoaded', () => {
    const overlay = document.querySelector('[data-auth-overlay]');
    if (!overlay) return;

    const modal = overlay.querySelector('.auth-modal');
    const authTabsEl = overlay.querySelector('[data-auth-tabs]');
    const tabs = overlay.querySelectorAll('[data-auth-tab]');
    // Descendant query, so the .auth-panel-stack wrapper that now holds the
    // Log In and Sign Up panels (see Pages/Index.html) is transparent here —
    // all six panels are still found, in document order.
    const panels = overlay.querySelectorAll('[data-auth-panel]');
    const panelStack = overlay.querySelector('[data-auth-panel-stack]');

    // Sign Up is a two-step flow inside that one <form> (see Pages/Index.html).
    // Queried here, at the top, rather than beside the step wiring further
    // down: setActivePanel() resets the flow, and setActivePanel already runs
    // during this setup function (recovery redirect / forced-sign-out notice),
    // so anything it touches has to be initialised before that point or it is
    // a temporal-dead-zone ReferenceError waiting for the right entry path.
    const signupForm = overlay.querySelector('[data-auth-panel="signup"]');
    const signupStepEls = signupForm ? Array.from(signupForm.querySelectorAll('[data-signup-step]')) : [];
    const signupIndicator = signupForm ? signupForm.querySelector('[data-signup-indicator]') : null;
    const signupDots = signupForm ? Array.from(signupForm.querySelectorAll('[data-signup-dot]')) : [];
    // Every [data-password-policy] block on the page (Sign Up step 1 and the
    // Reset Password panel), filled in by the wiring block further down.
    const passwordPolicyGroups = [];
    let signupStep = 1;

    let lastFocusedEl = null;
    let pendingSignupEmail = '';
    let pendingSignupPhone = '';
    let signupStepAdvancing = false;
    // Set while a password login is gated behind a first-login-per-device
    // OTP check (see gateOtpThenCompleteLogin below); null the rest of the
    // time, including throughout the post-signup verify flow.
    let pendingLoginOtp = null;
    // The address a password reset was just requested for, held while the
    // Verify panel collects the 6-digit recovery code (see the
    // mode === 'forgot' branch below). Empty the rest of the time.
    // Deliberately NOT cleared when the visitor backs out of the flow: every
    // read of it is gated on otpPurpose === 'recovery', and otpPurpose is
    // always set explicitly right before the Verify panel is shown, so a
    // leftover value can never be verified against by accident.
    let pendingRecoveryEmail = '';
    let recoveryLoginPanel = 'login';
    // Which verifyOtp() call — and which follow-up action — the Verify
    // panel's submit handler should perform: 'signup' (default, existing
    // post-sign-up behavior), 'login' (new-device gate) or 'recovery'
    // (password reset by emailed code). See setOtpPurpose() below, which
    // also relabels the reused panel's copy.
    let otpPurpose = 'signup';

    // Per-purpose copy for the ONE Verify panel all three flows share. A
    // table rather than nested ternaries because there are three cases now
    // and two strings each. `backTab` is written onto the back link's
    // data-auth-tab attribute, which the tab click handler reads at click
    // time — see setOtpPurpose().
    const OTP_PURPOSE_COPY = {
        signup: { heading: 'Verify your email', backTab: 'signup', backLabel: '← Back to sign up' },
        login: { heading: "Confirm it's you", backTab: 'login', backLabel: '← Back to log in' },
        // Back goes to Forgot, not Log In: the likeliest reason for backing
        // out here is a mistyped address, and that is the panel that fixes it.
        recovery: { heading: 'Reset your password', backTab: 'forgot', backLabel: '← Use a different email' }
    };

    // Timers for the short-lived toast setAuthNotice() renders further down.
    //
    // Declared HERE rather than beside setAuthNotice, and that is the whole
    // point of them being here: consumePendingAuthNotice() runs during this
    // same setup pass and calls setAuthNotice(), so while these two lived
    // ~1000 lines below that call they were read inside their temporal dead
    // zone and threw `ReferenceError: Cannot access 'authNoticeDismissTimer'
    // before initialization`. That threw out of the DOMContentLoaded handler
    // itself, so everything after it never ran — no close handler, no tab
    // switching, no submit handlers, no Google button. The modal was dead,
    // and only on the paths that reach that call (the authGuard.js
    // idle-timeout / superseded-session notice), which is why it went
    // unnoticed. See assertEarlySetupBindings() below, which is the guard
    // that keeps this from silently coming back.
    let authNoticeDismissTimer = null;
    let authNoticeHideTimer = null;

    // Whether the auth modal is currently open, for the focus trap in the
    // keydown handler below. Tracked as a flag rather than derived from
    // overlay[hidden], which is only cleared once the 250ms fade-out finishes:
    // closeModal() hands focus back to the trigger immediately, so a Tab
    // during that window must not be dragged back into a closing dialog. Same
    // shape, and same reasoning, as the Terms dialog's `termsIsOpen`.
    let authIsOpen = false;

    const DASHBOARD_BY_ROLE = {
        customer: 'user_dashboard.html',
        staff: 'staff_dashboard.html',
        admin: 'owner_dashboard.html'
    };

    // Per-user (not per-browser) localStorage markers — see this repo's
    // Phase 6 report for the full reasoning behind each:
    //   trusted-device : has this account completed a full login on this
    //                    browser before? Skips the new-device OTP gate.
    //                    Deliberately NEVER cleared on sign-out — that is
    //                    the point of "first login per device", not
    //                    "first login per session". Scoped per user id so
    //                    a device trusted for one account never lets a
    //                    different account on the same browser skip its
    //                    own first OTP.
    //   session-token   : this browser's current session id, for Single
    //                    Session enforcement. MUST match the identically
    //                    named literal in includes/authGuard.js, which
    //                    only ever reads it (this file is the only writer).
    const TRUSTED_DEVICE_STORAGE_PREFIX = 'inigosync-trusted-device:';
    const SESSION_TOKEN_STORAGE_PREFIX = 'inigosync-session-token:';
    // One-shot reason left behind by includes/authGuard.js right before it
    // forces a sign-out (idle timeout / superseded by another device) and
    // redirects here. MUST match the identically named literal there.
    const AUTH_NOTICE_STORAGE_KEY = 'inigosync-auth-notice';

    // Password-login brute-force throttle. Supabase also rate-limits the
    // token endpoint by IP; this tighter browser-side layer implements the
    // product rule: five consecutive invalid credential responses for one
    // email address trigger a one-minute cooldown. localStorage keeps the
    // cooldown in force across refreshes/tabs. The key contains only a small
    // deterministic hash, never the visitor's email address or password.
    const LOGIN_MAX_FAILURES = 5;
    const LOGIN_LOCKOUT_MS = 60 * 1000;
    const LOGIN_ATTEMPT_STORAGE_PREFIX = 'inigosync-login-attempts:';
    const loginAttemptMemory = new Map();
    let loginLockoutTimerId = null;

    function normalizeLoginEmail(value) {
        return String(value || '').trim().toLowerCase();
    }

    function loginIdentityHash(value) {
        const normalized = normalizeLoginEmail(value);
        let hash = 0x811c9dc5;
        for (let i = 0; i < normalized.length; i += 1) {
            hash ^= normalized.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(36);
    }

    function loginAttemptKey(email) {
        return LOGIN_ATTEMPT_STORAGE_PREFIX + loginIdentityHash(email);
    }

    function readLoginAttempt(email) {
        const key = loginAttemptKey(email);
        let raw = loginAttemptMemory.get(key) || null;
        try {
            raw = localStorage.getItem(key) || raw;
        } catch (_) {
            // Private/restricted storage still gets an in-memory cooldown.
        }

        try {
            const parsed = raw ? JSON.parse(raw) : {};
            const failures = Number.isInteger(parsed.failures) && parsed.failures > 0 ? parsed.failures : 0;
            const lockedUntil = Number.isFinite(parsed.lockedUntil) && parsed.lockedUntil > 0 ? parsed.lockedUntil : 0;
            if (lockedUntil && lockedUntil <= Date.now()) {
                clearLoginAttempts(email);
                return { failures: 0, lockedUntil: 0 };
            }
            return { failures, lockedUntil };
        } catch (_) {
            clearLoginAttempts(email);
            return { failures: 0, lockedUntil: 0 };
        }
    }

    function writeLoginAttempt(email, state) {
        const key = loginAttemptKey(email);
        const raw = JSON.stringify(state);
        loginAttemptMemory.set(key, raw);
        try {
            localStorage.setItem(key, raw);
        } catch (_) {
            // The in-memory copy above remains effective for this page load.
        }
    }

    function clearLoginAttempts(email) {
        const key = loginAttemptKey(email);
        loginAttemptMemory.delete(key);
        try {
            localStorage.removeItem(key);
        } catch (_) {
            // Nothing else to clear when storage is unavailable.
        }
    }

    function recordInvalidLogin(email) {
        const current = readLoginAttempt(email);
        const failures = Math.min(current.failures + 1, LOGIN_MAX_FAILURES);
        const lockedUntil = failures >= LOGIN_MAX_FAILURES ? Date.now() + LOGIN_LOCKOUT_MS : 0;
        const next = { failures, lockedUntil };
        writeLoginAttempt(email, next);
        return next;
    }

    function loginLockoutSeconds(email) {
        const { lockedUntil } = readLoginAttempt(email);
        return lockedUntil > Date.now() ? Math.ceil((lockedUntil - Date.now()) / 1000) : 0;
    }

    function formatLockoutTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    }

    function loginEmailForForm(form) {
        const fieldName = form.dataset.authPanel === 'admin' ? 'admin-email' : 'email';
        return normalizeLoginEmail(form.elements[fieldName]?.value);
    }

    function refreshLoginLockout(form) {
        if (!['login', 'admin'].includes(form.dataset.authPanel)) return false;
        const seconds = loginLockoutSeconds(loginEmailForForm(form));
        const status = form.querySelector('[data-login-lockout]');
        const submit = form.querySelector('button[type="submit"].auth-submit');
        const isLocked = seconds > 0;

        if (status) {
            status.hidden = !isLocked;
            status.textContent = isLocked
                ? `Too many incorrect attempts. Try again in ${formatLockoutTime(seconds)}.`
                : '';
        }
        if (submit && !submit.classList.contains('is-loading')) submit.disabled = isLocked;
        return isLocked;
    }

    function refreshAllLoginLockouts() {
        let hasLockout = false;
        panels.forEach((form) => { hasLockout = refreshLoginLockout(form) || hasLockout; });
        if (!hasLockout && loginLockoutTimerId) {
            window.clearInterval(loginLockoutTimerId);
            loginLockoutTimerId = null;
        }
        return hasLockout;
    }

    function startLoginLockoutCountdown() {
        refreshAllLoginLockouts();
        if (!loginLockoutTimerId) {
            loginLockoutTimerId = window.setInterval(refreshAllLoginLockouts, 1000);
        }
    }

    function isInvalidCredentialError(err) {
        return err?.code === 'invalid_credentials' || /invalid login credentials/i.test(err?.message || '');
    }

    // ------------------------------------------------------------------
    // Password policy — CREATION TIME ONLY.
    //
    // Enforced in the two places a password is chosen: Sign Up step 1 and
    // the Reset Password panel. Deliberately NOT enforced on Log In or
    // Admin login: accounts created before this rule existed have weaker
    // passwords and must keep signing in. Reset carries the same rule as
    // signup on purpose — otherwise "forgot password" would be a way to
    // set a password that signup itself would have refused.
    //
    // The minlength/maxlength attributes in Pages/Index.html mirror these
    // numbers, and the checklist in the modal renders these same rules,
    // but neither is trusted: checkPasswordPolicy() is re-run on submit
    // against the raw value, so nothing depends on the state of the UI.
    // ------------------------------------------------------------------
    const PASSWORD_MIN_LENGTH = 8;
    const PASSWORD_MAX_LENGTH = 15;
    // Printable ASCII that is neither a letter nor a digit. Spelled out as
    // an explicit set rather than /[^A-Za-z0-9]/ so the rule is
    // predictable: with the negated class, an accented letter typed on a
    // non-US keyboard would silently satisfy "1 special character".
    const PASSWORD_SPECIAL_PATTERN = /[ !"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
    const PASSWORD_RULES = [
        { id: 'length', test: (value) => value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH },
        { id: 'upper', test: (value) => /[A-Z]/.test(value) },
        { id: 'lower', test: (value) => /[a-z]/.test(value) },
        { id: 'number', test: (value) => /[0-9]/.test(value) },
        { id: 'special', test: (value) => PASSWORD_SPECIAL_PATTERN.test(value) }
    ];

    // Returns { valid, failed: [ruleId] }. Never throws, and treats a
    // missing/non-string value as an empty password rather than as valid.
    function checkPasswordPolicy(value) {
        const password = typeof value === 'string' ? value : '';
        const failed = PASSWORD_RULES.filter((rule) => !rule.test(password)).map((rule) => rule.id);
        return { valid: failed.length === 0, failed };
    }

    // Check the trusted profile before sending a login OTP or redirecting.
    // A rejected customer-login attempt must not sign out other devices.
    async function validateLoginAccount(allowedRoles) {
        const { data: { session } } = await window.sb.auth.getSession();
        if (!session) throw new Error('Sign-in failed. Please try again.');

        const { data: profile, error: profileError } = await window.sb
            .from('profiles')
            .select('role, status')
            .eq('id', session.user.id)
            .single();

        if (profileError || !profile) {
            await window.sb.auth.signOut({ scope: 'local' });
            throw new Error('Could not load your account. Please try again.');
        }

        if (profile.status === 'disabled') {
            await window.sb.auth.signOut({ scope: 'local' });
            throw new Error('This account has been disabled. Contact the front desk.');
        }

        if (!allowedRoles.includes(profile.role)) {
            await window.sb.auth.signOut({ scope: 'local' });
            const error = new Error(allowedRoles.includes('customer')
                ? 'This account belongs to an admin or staff member and cannot be used for customer login or sign-up. Choose “Log in as Admin”, or use a different Google account for customer access.'
                : 'This is a customer account. Please use the customer Log In tab instead of admin/staff login.');
            error.code = 'account_role_mismatch';
            throw error;
        }

        return { session, profile };
    }

    async function completeLogin(allowedRoles, verifySignupPhone = false) {
        const { session, profile } = await validateLoginAccount(allowedRoles);
        if (verifySignupPhone && pendingSignupPhone) {
            window.InigoLoading?.hide();
            setActivePanel('phone');
            const result = await window.InigoSignupPhone.verify({ phone: pendingSignupPhone, userId: session.user.id });
            if (result === 'cancelled') return;
            pendingSignupPhone = '';
        }

        // Single Session + device trust — both best-effort, and never
        // allowed to block a login that has already passed every check
        // above. See registerActiveSession()'s own comment for the
        // graceful-degradation contract this relies on when
        // database/schema/005_session_security.sql hasn't been run yet.
        await registerActiveSession(session.user.id);
        markDeviceTrusted(session.user.id);

        // This is an observed app sign-in, not a claim about when every Auth
        // session started. The database RPC attributes and deduplicates it
        // using the signed-in customer's JWT. Logging is best effort so an
        // activity-feed outage cannot lock a customer out of the dashboard.
        if (profile.role === 'customer' && typeof window.sb.rpc === 'function') {
            try {
                const eventResult = await Promise.race([
                    window.sb.rpc('record_customer_session_event', { p_kind: 'sign_in' }),
                    new Promise(resolve => window.setTimeout(resolve, 1800)),
                ]);
                if (eventResult?.error) throw eventResult.error;
            } catch (error) {
                console.warn('[auth] customer sign-in event was not recorded', error);
            }
        }

        closeModal();
        const redirectUrl = new URL(DASHBOARD_BY_ROLE[profile.role], window.location.href);
        window.location.assign(redirectUrl.toString());
    }

    // ------------------------------------------------------------------
    // Single Session (spec) — upsert this browser's session id as the
    // signed-in user's one active session, on every successful login of
    // every kind (customer, Google, admin/staff panel). Deliberately
    // swallows every failure (missing table, RLS, network) instead of
    // surfacing it: this is defense-in-depth layered on top of a login
    // that has already succeeded, never a precondition for one. On
    // failure, no local token is stored either, so
    // includes/authGuard.js's own periodic check later finds nothing to
    // compare against for this user and stays fully inert — see that
    // file's checkSessionSupersession() comment for the other half of
    // this contract.
    // ------------------------------------------------------------------
    async function registerActiveSession(userId) {
        if (!window.sb) return;

        const sessionToken = (window.crypto && typeof window.crypto.randomUUID === 'function')
            ? window.crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const nowIso = new Date().toISOString();

        try {
            const { error: upsertError } = await window.sb.from('active_session').upsert({
                user_id: userId,
                session_token: sessionToken,
                device_label: (navigator.userAgent || '').slice(0, 120),
                created_at: nowIso,
                last_seen_at: nowIso
            }, { onConflict: 'user_id' });

            // `active_session` not migrated yet (see
            // database/schema/005_session_security.sql), or some other
            // RLS/network issue — single-session enforcement silently
            // no-ops. Deliberately do NOT store a local token in this
            // case, so includes/authGuard.js also treats this device as
            // "not participating" instead of comparing against a table
            // that was never actually written.
            if (upsertError) return;

            localStorage.setItem(SESSION_TOKEN_STORAGE_PREFIX + userId, sessionToken);
        } catch (_) {
            // Never let this break login.
        }
    }

    // ------------------------------------------------------------------
    // First-login-per-device OTP gate (spec: Email Authentication, scoped
    // to first-login-per-device per the owner's decision — see
    // implementation_plan.md's D6 / "Owner decisions"). These two
    // functions are the only place trusted-device state is read/written.
    // ------------------------------------------------------------------
    function isDeviceTrusted(userId) {
        try {
            return localStorage.getItem(TRUSTED_DEVICE_STORAGE_PREFIX + userId) === '1';
        } catch (_) {
            // Can't remember anything — the safe default is to ask for an
            // OTP rather than silently skip it forever.
            return false;
        }
    }

    function markDeviceTrusted(userId) {
        try {
            localStorage.setItem(TRUSTED_DEVICE_STORAGE_PREFIX + userId, '1');
        } catch (_) {
            // Best-effort only — if storage is unavailable, this account
            // is simply asked for an OTP again next time too.
        }
    }

    // Relabels the reused Verify panel for whichever purpose it's
    // currently serving, so "Verify your email" / "← Back to sign up"
    // (correct right after Sign Up) don't show while this same panel is
    // instead gating a password login on a new device, or collecting the
    // code from a password-reset email.
    function setOtpPurpose(purpose) {
        otpPurpose = purpose;
        const copy = OTP_PURPOSE_COPY[purpose] || OTP_PURPOSE_COPY.signup;
        const heading = overlay.querySelector('[data-verify-heading]');
        if (heading) heading.textContent = copy.heading;
        const backLink = overlay.querySelector('[data-otp-back-link]');
        if (backLink) {
            const isAdminLogin = purpose === 'login' && pendingLoginOtp?.allowedRoles.includes('admin');
            backLink.dataset.authTab = isAdminLogin ? 'admin' : copy.backTab;
            backLink.textContent = isAdminLogin ? '← Back to admin login' : copy.backLabel;
        }
    }

    // Called right after a password sign-in succeeds (Log In or Admin
    // panel alike). A Supabase session already exists at this point —
    // signInWithPassword already fully established it — so this only
    // gates *completing the app-level login* (closing the modal and
    // redirecting into a dashboard), the same trust model the role gate
    // in completeLogin() above already relies on (sign back out and
    // refuse to proceed on failure). See this repo's Phase 6 report for
    // the accepted limitation that this does not stop someone with
    // devtools open from navigating straight to a dashboard URL using the
    // session that already exists before finishing this step.
    async function gateOtpThenCompleteLogin(user, allowedRoles, email) {
        await validateLoginAccount(allowedRoles);
        if (!user || isDeviceTrusted(user.id)) {
            await completeLogin(allowedRoles);
            return;
        }

        pendingLoginOtp = { userId: user.id, email, allowedRoles };
        setOtpPurpose('login');

        if (window.InigoLoading) window.InigoLoading.hide();

        const { error } = await window.sb.auth.signInWithOtp({
            email,
            options: { shouldCreateUser: false }
        });
        if (error) {
            pendingLoginOtp = null;
            throw error;
        }

        const emailLabel = overlay.querySelector('[data-verify-email]');
        if (emailLabel) emailLabel.textContent = email || 'your email';
        setActivePanel('verify');
        startOtpFlow();
        setAuthNotice('New device — enter the 6-digit code we emailed you to finish signing in.', false);
    }

    // ------------------------------------------------------------------
    // Early-setup binding guard  (regression guard for the TDZ defect)
    //
    // Everything below this line runs while the page is still being set up:
    // enterRecoveryMode() on a ?type=recovery return, and
    // consumePendingAuthNotice() on the authGuard.js forced-sign-out return.
    // Both reach openModal() / setActivePanel() / setAuthNotice(), and those
    // read module-scope `let`/`const` bindings. Reading one of those before
    // its declaration line has executed throws ReferenceError, and because
    // these calls sit directly in the DOMContentLoaded handler, that
    // ReferenceError aborts the entire rest of setup — the modal loses its
    // close handler, its tabs, its submit handlers and its Google button. It
    // only fires on those two entry paths, so ordinary loads look fine and
    // the breakage hides.
    //
    // This probe reads each of those bindings on EVERY load, so a declaration
    // that drifts back below this point stops being a silent, path-dependent
    // dead modal and becomes a console error on every single page load, in
    // every browser and every automated run. Each is read through its own
    // thunk so the message can name the binding that moved; a bare
    // `void [a, b]` would stop at the first one.
    //
    // `typeof` is deliberately not used to probe: on a `let` still in its
    // temporal dead zone `typeof` throws too, which is exactly the signal
    // wanted here — but it would make the intent read as a feature check.
    //
    // Keep this list in sync with what the early-setup calls actually touch.
    // Anything added to openModal / setActivePanel / setAuthNotice /
    // resetSignupFlow belongs here too.
    // ------------------------------------------------------------------
    function assertEarlySetupBindings() {
        const probes = [
            ['authNoticeDismissTimer', () => authNoticeDismissTimer],
            ['authNoticeHideTimer', () => authNoticeHideTimer],
            ['authIsOpen', () => authIsOpen],
            ['lastFocusedEl', () => lastFocusedEl],
            ['pendingLoginOtp', () => pendingLoginOtp],
            ['recoveryLoginPanel', () => recoveryLoginPanel],
            ['otpPurpose', () => otpPurpose],
            ['signupStep', () => signupStep],
            // resetSignupFlow() -> clearSignupStepErrors() reads this one
            // directly; it was already reached indirectly before the
            // increment-8 merge and was simply missing from the list.
            ['signupForm', () => signupForm],
            ['signupStepEls', () => signupStepEls],
            ['signupDots', () => signupDots],
            ['signupIndicator', () => signupIndicator],
            ['passwordPolicyGroups', () => passwordPolicyGroups],
            ['authTabsEl', () => authTabsEl],
            ['panelStack', () => panelStack],
            ['tabs', () => tabs],
            ['panels', () => panels],
            ['modal', () => modal]
        ];

        probes.forEach(([name, read]) => {
            try {
                read();
            } catch (err) {
                // Not rethrown: this guard exists to make the ordering break
                // visible, not to add a second way for setup to die.
                console.error(
                    `[auth.js] "${name}" is declared BELOW the early-setup calls that read it. ` +
                    'Move its declaration up into the top-level block beside `signupStep` / ' +
                    '`lastFocusedEl`. Until then the auth modal is dead (no close button, no ' +
                    'tabs, no submit, no Google button) on the password-recovery and ' +
                    'idle-logout entry paths.',
                    err
                );
            }
        });
    }

    assertEarlySetupBindings();

    // ------------------------------------------------------------------
    // Forgot / Reset password
    //
    // TWO ENTRY POINTS, ONE `reset` PANEL:
    //
    //   1. BY CODE (the normal path). Forgot → resetPasswordForEmail →
    //      the shared Verify panel with otpPurpose === 'recovery' →
    //      verifyOtp({ type: 'recovery' }) → this same `reset` panel. See
    //      the mode === 'forgot' and mode === 'verify' branches below.
    //      docs/email_templates/reset_password.html is code-based, so this
    //      is what a reset email sent today actually supports.
    //
    //   2. BY LINK (kept working, deliberately). Supabase redirects the
    //      visitor back here after they click a recovery link, with
    //      `type=recovery` in the URL and a short-lived (but real) session
    //      already established. Reset emails already in flight, and any
    //      future link-bearing template, still land here.
    //
    // The link path is checked directly against the URL — not only via the
    // PASSWORD_RECOVERY auth event below — because the Supabase client's
    // own URL parsing can finish before this script gets a chance to
    // subscribe to that event; missing it would silently drop the visitor
    // into the auto-redirect further down instead of letting them set a
    // new password. See the mode === 'reset' submit handler below for
    // where the new password is actually set, in both cases.
    // ------------------------------------------------------------------
    const isRecoveryRedirect = /type=recovery/.test(window.location.hash) || /type=recovery/.test(window.location.search);
    let recoveryHandled = false;

    // ------------------------------------------------------------------
    // Staff invite — reuses this same `reset` panel.
    //
    // Owner Dashboard → Staff Management → Add New Staff calls the
    // invite-staff Edge Function, which asks Supabase to send its "Invite
    // user" email (docs/email_templates/invite_staff.html). Its
    // {{ .ConfirmationURL }} lands back here exactly like a recovery link
    // does — same implicit flow, same short-lived (but real) session
    // already established from the URL before this script runs — just
    // `type=invite` instead of `type=recovery`. So this reuses
    // enterRecoveryMode()'s panel and the mode === 'reset' submit handler
    // below rather than building a second "set a password" screen, and is
    // detected the same direct-URL way for the same reason given above
    // (Supabase's own URL parsing can finish before this script gets a
    // chance to subscribe to onAuthStateChange).
    //
    // The one real behavioral difference: recovery signs back out and
    // returns to Log In, because nobody here knows which dashboard a
    // recovery link belongs to (see the mode === 'reset' handler). Invite
    // is always a brand-new staff account with a session already sitting
    // there ready to use, so it finishes straight into the dashboard
    // instead — see resetPurpose below and its `=== 'invite'` branch in
    // the mode === 'reset' handler.
    // ------------------------------------------------------------------
    const isInviteRedirect = /type=invite/.test(window.location.hash) || /type=invite/.test(window.location.search);
    let inviteHandled = false;

    // Per-purpose copy for the shared `reset` panel — same idea as
    // OTP_PURPOSE_COPY above, just for the one other panel that needs it.
    // Recovery's strings are exactly the markup's own defaults in
    // Pages/Index.html, so nothing calls setResetPurpose('recovery');
    // resetPurpose simply never leaves that default outside an invite link.
    const RESET_PURPOSE_COPY = {
        recovery: { heading: 'Set a new password', tagline: 'Choose a new password for your account.' },
        invite: { heading: 'Set your password', tagline: 'Welcome to IñigoSync — choose a password for your new staff account.' }
    };
    let resetPurpose = 'recovery';

    function setResetPurpose(purpose) {
        resetPurpose = purpose;
        const copy = RESET_PURPOSE_COPY[purpose] || RESET_PURPOSE_COPY.recovery;
        const heading = overlay.querySelector('[data-reset-heading]');
        if (heading) heading.textContent = copy.heading;
        const tagline = overlay.querySelector('[data-reset-tagline]');
        if (tagline) tagline.textContent = copy.tagline;
    }

    // Shown when the panel opens for an invite link Supabase already
    // rejected before this script ever got a session to work with — used
    // once already (the email opened/clicked twice) or past its 24-hour
    // expiry (docs/OWNER_ACTION_LIST.md item E6). A wrong/mismatched
    // password never reaches this message — the form validates both
    // locally before updateUser() is ever called.
    const INVITE_EXPIRED_MESSAGE = 'This invite link has expired or has already been used. Please ask the owner to re-send the invite from Staff Management.';

    // Where a recovery link should return the visitor to. Passed on every
    // resetPasswordForEmail call — the code path does not need it, but the
    // link path above does, and both must keep landing on the same page and
    // therefore the same `reset` panel. Requires the URL to be in Supabase's
    // Authentication → URL Configuration → Redirect URLs (see
    // docs/OWNER_ACTION_LIST.md item E).
    function recoveryRedirectTo() {
        return `${window.location.origin}${window.location.pathname}`;
    }

    function enterRecoveryMode() {
        if (recoveryHandled) return;
        recoveryHandled = true;
        if (window.InigoLoading) window.InigoLoading.hide();
        openModal('reset');
    }

    // See the "Staff invite" comment above isInviteRedirect for why this
    // mirrors enterRecoveryMode() rather than opening a different panel.
    function enterInviteMode() {
        if (inviteHandled) return;
        inviteHandled = true;
        if (window.InigoLoading) window.InigoLoading.hide();
        setResetPurpose('invite');
        openModal('reset');

        // Proactive expired/used-link check: a valid invite link already
        // has the session its own access_token just established, so
        // getSession() resolving empty here means updateUser() on submit
        // would fail anyway. Surface that now rather than only after the
        // visitor has already filled in a password — submitting anyway
        // still fails safely either way, via the shared catch block below.
        if (!window.sb) return;
        window.sb.auth.getSession().then(({ data: { session } }) => {
            if (!session) setAuthNotice(INVITE_EXPIRED_MESSAGE, true);
        });
    }

    if (window.sb) {
        window.sb.auth.onAuthStateChange((event) => {
            if (event === 'PASSWORD_RECOVERY') enterRecoveryMode();
            // Supabase has no separate "invite accepted" event — parsing a
            // `type=invite` URL fires the same SIGNED_IN a password login
            // would, so this is gated on the URL check too; an ordinary
            // login's SIGNED_IN, with no such URL, never reaches this.
            if (event === 'SIGNED_IN' && isInviteRedirect) enterInviteMode();
        });
    }

    if (isRecoveryRedirect) enterRecoveryMode();
    if (isInviteRedirect) enterInviteMode();

    // A forced sign-out from includes/authGuard.js (idle timeout, or this
    // account signing in on another device) leaves a one-shot reason
    // behind in sessionStorage before it redirects here — surface it with
    // the same notice mechanism (setAuthNotice) used everywhere else in
    // this modal. Never let it preempt an in-progress password-recovery or
    // invite flow, either of which takes priority above.
    const AUTH_NOTICE_MESSAGES = {
        idle: 'You were signed out after a period of inactivity. Please log in again.',
        superseded: 'You were signed out because your account was signed in on another device.'
    };

    function consumePendingAuthNotice() {
        let reason = null;
        try {
            reason = sessionStorage.getItem(AUTH_NOTICE_STORAGE_KEY);
            if (reason) sessionStorage.removeItem(AUTH_NOTICE_STORAGE_KEY);
        } catch (_) {
            return;
        }
        const message = reason && AUTH_NOTICE_MESSAGES[reason];
        if (!message) return;
        openModal('login');
        setAuthNotice(message, false);
    }

    if (!isRecoveryRedirect && !isInviteRedirect) consumePendingAuthNotice();

    // Google's OAuth flow is a full-page redirect away and back — there's no
    // in-page callback to hook into. So on every load of this page, check
    // whether a session already exists (true right after that redirect
    // returns) and route straight into the dashboard. Existing remembered
    // staff/admin sessions also resume on their own dashboard. A Google return
    // is an explicit login attempt, so its errors stay visible in the login
    // modal. Ordinary revisits still handle stale sessions quietly.
    //
    // The loading overlay should only appear for a genuine "just came back
    // from Google" trip — not for an ordinary revisit where a session
    // happens to already exist (e.g. the landing page is still open in a
    // tab) — otherwise every plain page load with a lingering session would
    // flash a full-page blur for no reason the visitor asked for.
    const isOauthReturn = sessionStorage.getItem('inigosync-oauth-pending') === '1';
    sessionStorage.removeItem('inigosync-oauth-pending');

    if (window.sb) {
        window.sb.auth.getSession().then(({ data: { session } }) => {
            // A recovery-link OR invite-link session must NOT auto-complete
            // a normal customer login — it exists only so mode === 'reset'
            // below can call updateUser(); routing it into completeLogin()
            // here would skip straight past "set a new password" and, for
            // an invite, also complete the login as the wrong role.
            if (!session || isRecoveryRedirect || recoveryHandled || isInviteRedirect || inviteHandled) return;
            // A password login awaiting its first-device code must not be
            // completed just because the visitor reloads the landing page.
            if (!isOauthReturn && !isDeviceTrusted(session.user.id)) return;
            if (isOauthReturn && window.InigoLoading) window.InigoLoading.show('Signing you in…');
            completeLogin(isOauthReturn ? ['customer'] : ['customer', 'staff', 'admin']).catch(error => {
                if (isOauthReturn) {
                    openModal('login');
                    const notice = overlay.querySelector('[data-auth-access-error]');
                    notice.textContent = friendlyAuthError(error);
                    notice.hidden = false;
                }
                if (window.InigoLoading) window.InigoLoading.hide();
            });
        });
    }

    function setActivePanel(name) {
        if (name === 'forgot') {
            const previousPanel = overlay.querySelector('[data-auth-panel].is-active');
            const previousName = previousPanel?.dataset.authPanel;
            if (previousName === 'admin' || previousName === 'login') {
                recoveryLoginPanel = previousName;
                const email = previousPanel.querySelector('input[type="email"]');
                const recoveryEmail = overlay.querySelector('[data-auth-panel="forgot"] input[name="email"]');
                if (recoveryEmail) recoveryEmail.value = email?.value.trim() || '';
            }
            const backLink = overlay.querySelector('[data-recovery-back]');
            if (backLink) {
                backLink.dataset.authTab = recoveryLoginPanel;
                backLink.textContent = recoveryLoginPanel === 'admin' ? '← Back to admin login' : '← Back to log in';
            }
        }
        // Switching to any panel OTHER than 'verify' while a login-OTP gate
        // is pending means the visitor backed out via the "← Back to log
        // in" link (or any other tab) instead of closing the modal —
        // closeModal() only catches the "closed the whole modal" case, so
        // this covers "switched panels within it" too. The real Supabase
        // session from the password sign-in that started the gate is still
        // active in this case; sign it back out here as well so it isn't
        // left authenticated-but-not-actually-"logged in".
        if (pendingLoginOtp && otpPurpose === 'login' && name !== 'verify') {
            window.sb.auth.signOut().catch(() => {});
            pendingLoginOtp = null;
        }

        tabs.forEach((tab) => {
            const isMatch = tab.dataset.authTab === name;
            tab.classList.toggle('is-active', isMatch);
            if (tab.getAttribute('role') === 'tab') {
                tab.setAttribute('aria-selected', String(isMatch));
            }
        });
        panels.forEach((panel) => {
            panel.classList.toggle('is-active', panel.dataset.authPanel === name);
        });

        // The stepped Sign Up flow always opens on step 1. Covers every way
        // back into it — reopening the modal, the Log In tab and back, or the
        // Verify panel's "← Back to sign up" — so nobody lands mid-flow on a
        // step with a stale error still showing under a field they cannot see.
        if (name === 'signup') resetSignupFlow();

        // Customers can switch between Log In / Sign Up, but Admin, Verify,
        // Forgot, and Reset are all one-off steps reached from elsewhere —
        // hide the tab bar while any of them is active.
        const isTabbedPanel = name === 'login' || name === 'signup';
        if (authTabsEl) {
            authTabsEl.hidden = !isTabbedPanel;
        }

        // Log In and Sign Up sit in one shared grid cell so the taller of the
        // two fixes the card height (see .auth-panel-stack in Style/Auth.css).
        // The inactive one is visibility:hidden, which means it still occupies
        // that cell — so while a one-off panel is showing, the whole wrapper
        // has to come out of flow or it would pad the card to sign-up height.
        if (panelStack) {
            panelStack.hidden = !isTabbedPanel;
        }
    }

    function openModal(panelName) {
        lastFocusedEl = document.activeElement;
        overlay.hidden = false;
        // Force reflow so the transition runs after removing [hidden]
        requestAnimationFrame(() => {
            overlay.setAttribute('data-open', '');
        });
        document.body.classList.add('auth-lock');
        authIsOpen = true;
        if (panelName) setActivePanel(panelName);

        // Clear every panel's form, not only the one being shown — a
        // trigger always opens straight to Log In (panelName is always
        // 'login' or 'reset', never 'signup'/'admin'), so resetting just the
        // active one would still leave a stale value (and, for Sign Up, a
        // checklist still showing old "met" ticks) sitting in another panel
        // for the next time someone tabs over to it. This is what let a
        // typed password survive a Close and a later Reopen — the field is
        // genuinely always empty on load, but never got cleared again after
        // that. Safe to do unconditionally here: every call site of
        // openModal() (a [data-auth-open] trigger, the recovery-/invite-link
        // redirect, the forced-signout notice) is a fresh "open the modal"
        // moment, never a tab switch or a mid-signup step change — those go
        // through setActivePanel() / setSignupStep() directly and never
        // reach this function, so a signup already in progress in an
        // ALREADY-open modal is never interrupted by this. form.reset()
        // fires no `input` event, so the password checklist (Sign Up step 1
        // / Reset) needs a manual resync afterwards — same pairing already
        // used after a successful password reset below.
        panels.forEach((panel) => panel.reset());
        syncPasswordRules();

        const activePanel = overlay.querySelector('.auth-form.is-active');
        const firstField = activePanel && activePanel.querySelector('input');
        if (firstField) firstField.focus();
    }

    function closeModal() {
        window.InigoSignupPhone?.cancel();
        if (pendingLoginOtp) {
            // Backing out of the new-device OTP gate without finishing it.
            // A real Supabase session already exists at this point (see
            // gateOtpThenCompleteLogin) — sign it back out so it isn't
            // left authenticated-but-not-actually-"logged in" from the
            // app's point of view. Fire-and-forget: the modal closes
            // regardless of whether this network call succeeds.
            window.sb.auth.signOut().catch(() => {});
            pendingLoginOtp = null;
        }
        authIsOpen = false;
        overlay.removeAttribute('data-open');
        document.body.classList.remove('auth-lock');
        window.setTimeout(() => {
            overlay.hidden = true;
        }, 250);
        if (lastFocusedEl) lastFocusedEl.focus();
    }

    // Open triggers (Book Now buttons, etc.)
    document.querySelectorAll('[data-auth-open]').forEach((trigger) => {
        trigger.addEventListener('click', (e) => {
            e.preventDefault();
            openModal(trigger.dataset.authOpen || 'login');
        });
    });

    // Close triggers
    overlay.querySelectorAll('[data-auth-close]').forEach((btn) => {
        btn.addEventListener('click', closeModal);
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });

    // ------------------------------------------------------------------
    // Focus trap — shared by the auth modal and the Terms dialog
    //
    // One implementation for both so the two dialogs behave identically and,
    // more importantly, cooperate: the keydown handler below routes Tab to
    // whichever dialog is on top, so the trap never has to know about
    // stacking. (includes/landingPage.js's court viewer is the same shape
    // again, gated on its own `isOpen`; only one of the three is ever open.)
    //
    // The focusable set is recomputed on EVERY Tab, never cached at open
    // time. That is not defensiveness — in this modal it is required. The Log
    // In / Sign Up panels share one grid cell and the sign-up steps share
    // another, and in both cases the inactive member stays laid out and is
    // merely `visibility: hidden`; the one-off panels (Verify / Admin /
    // Forgot / Reset), the tab bar and the whole panel stack go
    // `display: none`. So which controls are tabbable changes on every tab
    // switch and every Continue / Back, and a set captured at open time would
    // already be wrong by the first click.
    // ------------------------------------------------------------------
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    // FOCUSABLE matches on markup alone, which is not enough here: the
    // inactive panels and steps are still in the DOM and still match it. Both
    // checks are needed and neither subsumes the other —
    //   • `visibility: hidden` still generates boxes, so it has to be read off
    //     the computed style. visibility is inherited, so this correctly
    //     reports 'hidden' for a control inside a hidden panel or step.
    //   • `display: none` generates no boxes at all, and computed visibility
    //     on such an element still reads 'visible', so it is caught by the
    //     absence of client rects instead.
    // `[disabled]` is already excluded by the selector, which is what keeps the
    // OTP resend button out of the rotation while its countdown is running.
    function isRenderedFocusable(el) {
        if (el.getClientRects().length === 0) return false;
        return window.getComputedStyle(el).visibility !== 'hidden';
    }

    function focusablesWithin(container) {
        return Array.from(container.querySelectorAll(FOCUSABLE)).filter(isRenderedFocusable);
    }

    // Wraps Tab / Shift+Tab around `container`. `fallback` takes focus when
    // there is nothing focusable inside (the Terms dialog carries
    // tabindex="-1" for exactly that); pass null to just swallow the Tab.
    // An active element outside the container is pulled back in, which is what
    // recovers focus after the browser drops it to <body> — switching tabs
    // blurs whatever was focused in the panel that just became hidden.
    function trapTab(e, container, fallback) {
        const focusables = focusablesWithin(container);
        if (focusables.length === 0) {
            e.preventDefault();
            if (fallback) fallback.focus();
            return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;

        if (e.shiftKey && (active === first || active === container || !container.contains(active))) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && (active === last || !container.contains(active))) {
            e.preventDefault();
            first.focus();
        }
    }

    // ------------------------------------------------------------------
    // Terms & Conditions dialog
    //
    // The Sign Up checkbox's "Terms & Conditions" link used to open
    // Pages/terms.html in a new tab, which threw away a half-filled
    // registration form. It now opens an in-page dialog stacked on top of
    // this modal instead.
    //
    // The copy is NOT duplicated into the markup — a legal document with two
    // sources of truth is a defect waiting to happen. Pages/terms.html is
    // fetched once on first open, its .terms-content container is lifted out,
    // and the result is cached for the rest of the page's life. That page
    // stays exactly as it is: it is still linked from elsewhere, and it is
    // still this feature's fallback.
    //
    // Nesting contract with the auth modal (both are open at once):
    //   • Body scroll lock stays with the auth modal (body.auth-lock). This
    //     dialog never touches that class, so closing it cannot unlock the
    //     page behind a modal that is still open. Its own copy scrolls inside
    //     .auth-terms-body.
    //   • Escape and the Tab focus trap are taken over by this dialog while it
    //     is open (see the keydown handler below) and handed straight back on
    //     close, so Escape only ever closes the topmost dialog.
    //   • The auth overlay is marked aria-hidden while this is open, after
    //     focus has already moved into the dialog, so assistive tech sees one
    //     dialog at a time.
    // ------------------------------------------------------------------
    const TERMS_CLOSE_DELAY_MS = 250;

    const termsOverlay = document.querySelector('[data-terms-overlay]');
    const termsDialog = termsOverlay && termsOverlay.querySelector('[data-terms-dialog]');
    const termsBody = termsOverlay && termsOverlay.querySelector('[data-terms-body]');
    const termsLinks = overlay.querySelectorAll('[data-terms-open]');

    // Cached document fragment of the fetched terms copy, plus the one-way
    // latch that sends every later click straight to the plain-link fallback
    // once a fetch has failed.
    let termsFragment = null;
    let termsFetchFailed = false;
    let termsLastFocused = null;
    let termsHideTimer = null;
    // Tracked as a flag rather than derived from [hidden], which is only set
    // once the fade-out finishes: an Escape pressed during those 250ms belongs
    // to the auth modal underneath, not to a dialog already on its way out.
    // Same reasoning as the court viewer's own `isOpen` in landingPage.js.
    let termsIsOpen = false;

    function isTermsOpen() {
        return termsIsOpen;
    }

    // Fetches Pages/terms.html and resolves to a fragment of its
    // .terms-content children. Throws on anything that would leave the dialog
    // empty — network error, non-2xx, or a page whose structure no longer
    // matches — so the caller can fall back to opening the page in a tab.
    async function loadTermsFragment(sourceUrl) {
        if (termsFragment) return termsFragment;

        const response = await fetch(sourceUrl, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`terms.html responded ${response.status}`);

        // Parsed with DOMParser into an inert document — NOT matched with a
        // regex, and never handed to innerHTML. The nodes are then imported
        // into this document, so the browser's own parser is the only thing
        // that ever interprets the markup and no HTML string is re-parsed on
        // this side. This is same-origin, in-repo, developer-authored content
        // (Pages/terms.html), not user input, so there is nothing here for
        // escapeHtml to escape — escapeHtml exists for the opposite case,
        // untrusted values being interpolated into an HTML string.
        const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
        const source = parsed.querySelector('.terms-content');
        if (!source) throw new Error('terms.html has no .terms-content container');

        const imported = document.importNode(source, true);

        // Belt and braces. DOMParser output is inert and .terms-content holds
        // no scripts today, but nothing should be able to smuggle one in via
        // a later edit to that page.
        imported.querySelectorAll('script').forEach((el) => el.remove());

        // The dialog has its own sticky header carrying the title, so drop the
        // page's "Legal" eyebrow and its <h1> to avoid showing the heading
        // twice. Page furniture only — not one word of the policy text is
        // altered. Guarded: if terms.html ever loses them, nothing happens.
        imported.querySelectorAll('.eyebrow, .section-title').forEach((el) => el.remove());

        const fragment = document.createDocumentFragment();
        while (imported.firstChild) fragment.appendChild(imported.firstChild);

        termsFragment = fragment;
        return termsFragment;
    }

    // `returnFocusTo` is the element close() should hand focus back to — the
    // Terms link itself, passed explicitly rather than read off
    // document.activeElement. A mouse click on an <a> focuses it in Chrome but
    // not in every engine, and a programmatic .click() never does, so reading
    // the active element would sometimes drop focus to <body> on close.
    function openTermsDialog(returnFocusTo) {
        if (!termsOverlay || !termsDialog) return;

        termsLastFocused = returnFocusTo || document.activeElement;

        if (termsHideTimer) {
            window.clearTimeout(termsHideTimer);
            termsHideTimer = null;
        }

        termsOverlay.hidden = false;
        // Synchronous layout flush so the opacity:0 / display:flex state is
        // committed before [data-open] flips it — same reason as the court
        // viewer in includes/landingPage.js.
        void termsOverlay.offsetWidth;
        termsOverlay.setAttribute('data-open', '');
        termsIsOpen = true;

        // Focus first, aria-hidden second: marking an ancestor of the focused
        // element aria-hidden is exactly the bug this ordering avoids.
        termsDialog.focus();
        overlay.setAttribute('aria-hidden', 'true');
    }

    function closeTermsDialog() {
        if (!termsIsOpen) return;
        termsIsOpen = false;

        overlay.removeAttribute('aria-hidden');
        termsOverlay.removeAttribute('data-open');

        if (termsHideTimer) window.clearTimeout(termsHideTimer);
        termsHideTimer = window.setTimeout(() => {
            termsOverlay.hidden = true;
            termsHideTimer = null;
        }, TERMS_CLOSE_DELAY_MS);

        // Back to the link that opened this, with the sign-up form and every
        // value in it exactly as it was left — nothing is reset or re-rendered.
        if (termsLastFocused && typeof termsLastFocused.focus === 'function' && document.contains(termsLastFocused)) {
            termsLastFocused.focus();
        }
        termsLastFocused = null;
    }

    if (termsOverlay && termsDialog && termsBody) {
        termsOverlay.querySelectorAll('[data-terms-close]').forEach((el) => {
            el.addEventListener('click', closeTermsDialog);
        });

        termsLinks.forEach((link) => {
            link.addEventListener('click', async (e) => {
                // A previous attempt already failed: let the anchor's own
                // href/target="_blank" run, so the terms are still reachable.
                if (termsFetchFailed) return;

                e.preventDefault();

                try {
                    // link.href is the browser-resolved absolute URL, so this
                    // does not depend on where this script happens to live.
                    const fragment = await loadTermsFragment(link.href);
                    // Re-inserting the cached fragment moves its nodes, which
                    // empties it — so hand over a clone and keep the original.
                    termsBody.replaceChildren(fragment.cloneNode(true));
                    termsBody.scrollTop = 0;
                    openTermsDialog(link);
                } catch (err) {
                    // Never show an empty dialog. Fall back to the original
                    // new-tab behaviour and latch, so every later click skips
                    // straight to it.
                    console.warn('Terms dialog unavailable, opening terms.html in a new tab instead:', err);
                    termsFetchFailed = true;

                    // Deliberately NOT the 'noopener' feature string: with it,
                    // window.open returns null whether the popup opened or was
                    // blocked, so the blocked-popup branch below could not tell
                    // the two apart and fired on success. The opener reference
                    // is severed on the returned window instead — the anchor's
                    // own rel="noopener" does not cover a programmatic open.
                    const opened = window.open(link.href, '_blank');
                    if (opened) {
                        try {
                            opened.opener = null;
                        } catch (_) {
                            // Some engines refuse the assignment; the popup is
                            // our own same-origin page either way.
                        }
                    } else {
                        // Popup blocked — the click's user activation can lapse
                        // while the failing request is in flight. The next click
                        // is a fresh gesture and goes through the plain link
                        // above, which the blocker will not stop.
                        setAuthNotice('Could not open the Terms & Conditions here — tap the link again to open them in a new tab.', true);
                    }
                }
            });
        });
    }

    document.addEventListener('keydown', (e) => {
        // The Terms dialog stacks on top of this modal, so while it is open it
        // owns Escape and the Tab rotation and this modal ignores both.
        if (isTermsOpen()) {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeTermsDialog();
                return;
            }

            if (e.key !== 'Tab') return;

            // Terms owns the rotation while it is on top; the auth modal's own
            // trap below is skipped by this `return`, so the two never fight
            // over the same Tab. Handing it back is just this branch stopping
            // to apply once termsIsOpen flips.
            trapTab(e, termsDialog, termsDialog);
            return;
        }

        if (e.key === 'Escape' && !overlay.hidden) {
            closeModal();
            return;
        }

        // Focus trap for the auth modal itself. Scoped to .auth-modal — the
        // role="dialog" element — rather than the overlay, whose only other
        // child is the pointer-events:none toast. Gated on `authIsOpen`, not
        // on overlay[hidden], which lags the close by the 250ms fade-out;
        // during that window focus is already back on the trigger and must
        // stay there.
        if (e.key === 'Tab' && authIsOpen) {
            trapTab(e, modal || overlay, null);
        }
    });

    // Tab / inline switch links (Log In ↔ Sign Up ↔ Admin ↔ back to Log In)
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            setActivePanel(tab.dataset.authTab);
            if (tab.dataset.authTab === 'forgot' || tab.hasAttribute('data-recovery-back')) {
                overlay.querySelector('[data-auth-panel].is-active input')?.focus();
            }
        });
    });

    // Password visibility toggles
    function setPasswordToggleIcon(btn, isVisible) {
        const visibleIcon = `
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 12s3-6 10-6 10 6 10 6-3 6-10 6S2 12 2 12z"/>
                <circle cx="12" cy="12" r="3"/>
            </svg>`;

        const hiddenIcon = `
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 12s3-6 10-6 10 6 10 6-3 6-10 6S2 12 2 12z"/>
                <circle cx="12" cy="12" r="3"/>
                <path d="M4 4l16 16"/>
            </svg>`;

        btn.innerHTML = isVisible ? visibleIcon : hiddenIcon;
        btn.setAttribute('aria-label', isVisible ? 'Hide password' : 'Show password');
    }

    overlay.querySelectorAll('[data-toggle-password]').forEach((btn) => {
        const input = btn.previousElementSibling;
        if (!input) return;

        setPasswordToggleIcon(btn, input.type === 'text');

        btn.addEventListener('click', () => {
            const isHidden = input.type === 'password';
            input.type = isHidden ? 'text' : 'password';
            setPasswordToggleIcon(btn, input.type === 'text');
        });
    });

    // ------------------------------------------------------------------
    // Live password checklist
    //
    // Renders checkPasswordPolicy() into every [data-password-policy] block
    // (Sign Up step 1, Reset Password). Presentation only — the enforcement
    // is the checkPasswordPolicy() call in the submit handler, which reads
    // the input's value and never looks at these classes.
    // ------------------------------------------------------------------
    function renderPasswordRules(group) {
        const { failed } = checkPasswordPolicy(group.input.value);
        group.items.forEach((item) => {
            const isMet = !failed.includes(item.dataset.passwordRule);
            item.classList.toggle('is-met', isMet);
            const state = item.querySelector('[data-password-rule-state]');
            // Visually hidden, so the tick is not the only thing carrying
            // "met" — a screen reader reads the state with the rule.
            if (state) state.textContent = isMet ? 'met' : 'not met';
        });
    }

    function syncPasswordRules() {
        passwordPolicyGroups.forEach(renderPasswordRules);
    }

    overlay.querySelectorAll('[data-password-policy]').forEach((groupEl) => {
        const input = groupEl.querySelector('[data-password-input]');
        const list = groupEl.querySelector('[data-password-rules]');
        if (!input || !list) return;

        const group = { input, items: Array.from(list.querySelectorAll('[data-password-rule]')) };
        passwordPolicyGroups.push(group);
        input.addEventListener('input', () => renderPasswordRules(group));
        renderPasswordRules(group);
    });

    // ------------------------------------------------------------------
    // Sign Up — stepped flow
    //
    // One <form>, two step containers stacked in a single grid cell (see
    // Pages/Index.html and .auth-step-stack in Style/Auth.css). Nothing here
    // touches the fields' name attributes, adds/removes controls, or
    // disables anything — a disabled control is dropped from FormData —
    // so the submit handler still sees exactly the same payload it always
    // did, and the OTP hand-off after it is untouched.
    //
    // Step count is read from the DOM (signupStepEls) everywhere, never
    // written as a literal, which is why merging the old email-only and
    // password-only steps into one was a markup change rather than a rewrite.
    // ------------------------------------------------------------------
    // Deliberately stricter than <input type="email">, which accepts
    // "a@b". Not a full RFC 5322 grammar (nothing short of the server is),
    // just enough to stop an obviously unusable address being submitted.
    const SIGNUP_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    // A step reserves one inline error line per field that can fail on it:
    // step 1 has two (email, password), step 2 has a single shared line. The
    // per-field lines carry data-signup-error-for; the shared one does not,
    // and is the fallback for any field without a line of its own.
    function signupStepErrorEls(step) {
        if (!signupForm) return [];
        return Array.from(signupForm.querySelectorAll(`[data-signup-error="${step}"]`));
    }

    // Writes into the line that belongs to `field`, leaving the step's other
    // lines alone — so an email complaint and a password complaint can be on
    // screen at the same time, each under the field it is about.
    function setSignupStepError(step, message, field) {
        const els = signupStepErrorEls(step);
        if (!els.length) return;
        const target = (field && els.find((el) => el.dataset.signupErrorFor === field)) || els[0];
        target.textContent = message || '';
    }

    // Blanks every error line on `step`, or on every step when called with
    // no argument (the reset path).
    function clearSignupStepErrors(step) {
        if (!signupForm) return;
        const els = step === undefined
            ? signupForm.querySelectorAll('[data-signup-error]')
            : signupStepErrorEls(step);
        els.forEach((el) => { el.textContent = ''; });
    }

    function setSignupStep(step, options) {
        const total = signupStepEls.length;
        if (!total) return;

        signupStep = Math.min(Math.max(step, 1), total);

        signupStepEls.forEach((el) => {
            el.classList.toggle('is-active', Number(el.dataset.signupStep) === signupStep);
        });
        signupDots.forEach((dot) => {
            const index = Number(dot.dataset.signupDot);
            dot.classList.toggle('is-current', index === signupStep);
            dot.classList.toggle('is-done', index < signupStep);
        });
        if (signupIndicator) signupIndicator.textContent = `Step ${signupStep} of ${total}`;

        if (options && options.focus) {
            const field = signupStepEls[signupStep - 1].querySelector('input');
            if (field) field.focus();
        }
    }

    function resetSignupFlow() {
        clearSignupStepErrors();
        setSignupStep(1);
        // Values are intentionally left alone (nothing here resets the
        // form), so the checklist has to be re-rendered against whatever is
        // still in the password field rather than assuming it is empty.
        syncPasswordRules();
    }

    // Signup asks for the name in three boxes (Surname / First name /
    // Middle name) while public.profiles.full_name is, and stays, ONE text
    // column — read and written by all three dashboards and the seed data.
    // They are composed back into that single string here, in natural
    // reading order, so nothing downstream sees any difference.
    //
    // filter(Boolean) is what makes Middle name optional without leaving the
    // double space "First  Surname" a naive template produces, and the inner
    // replace collapses any run of whitespace typed inside one box (a
    // two-word surname pasted with a stray tab, say) down to one.
    function composeFullName(first, middle, last) {
        return [first, middle, last]
            .map((part) => String(part || '').trim().replace(/\s+/g, ' '))
            .filter(Boolean)
            .join(' ');
    }

    // Returns [] when the step's rules are satisfied, otherwise one
    // { step, field, message } per problem to render inline.
    //
    // Step 1 reports the email and the password INDEPENDENTLY — it owns two
    // fields and two error lines, and answering "your email is wrong" first
    // and "your password is wrong" only on the next Continue would make the
    // visitor pay for the merge twice. Step 2 still stops at the first
    // failure: every control on it shares one line, so a second message
    // there would only overwrite the first.
    function validateSignupStep(step) {
        if (!signupForm) return [];
        const fields = signupForm.elements;
        const issues = [];

        if (step === 1) {
            const value = (fields.email.value || '').trim();
            if (!value) {
                issues.push({ step: 1, field: 'email', message: 'Enter your email address.' });
            } else if (!fields.email.checkValidity() || !SIGNUP_EMAIL_PATTERN.test(value)) {
                issues.push({ step: 1, field: 'email', message: 'Enter a valid email address.' });
            }
            // The same creation-time policy the checklist renders and the
            // submit handler re-runs — this only decides whether Continue is
            // allowed to leave the step.
            if (!checkPasswordPolicy(fields.password.value).valid) {
                issues.push({ step: 1, field: 'password', message: 'Your password does not meet every requirement yet.' });
            }
            return issues;
        }

        if (step === 2) {
            // Surname and First name are required, Middle name is NOT: many
            // Filipino users legitimately have no middle name, and the single
            // "Full name" box these three replaced never asked for one
            // either. The markup carries the same split (`required` on two of
            // the three), so form.checkValidity() and this agree.
            if (!(fields.surname.value || '').trim()) {
                return [{ step: 2, field: 'surname', message: 'Enter your surname.' }];
            }
            if (!(fields.firstname.value || '').trim()) {
                return [{ step: 2, field: 'firstname', message: 'Enter your first name.' }];
            }
            // Same shared validator the submit handler runs before signUp —
            // called here only so the message lands inline on this step
            // instead of as a toast. The submit-side call stays exactly as
            // it was, since it is what normalises the number.
            // Guarded because this one runs OUTSIDE the submit handler's
            // try/catch: if includes/phoneValidation.js ever failed to load,
            // an unguarded call here would throw into a click handler and
            // dead-end the flow, where the submit-side call still surfaces it
            // as an error toast. Degrade to "let submit handle it".
            if (fields.mobile.value.trim() && typeof window.validatePhMobile === 'function') {
                const mobileCheck = window.validatePhMobile(fields.mobile.value);
                if (!mobileCheck.valid) return [{ step: 2, field: 'mobile', message: mobileCheck.message }];
            }
            if (!fields.terms.checked) {
                return [{ step: 2, field: 'terms', message: 'Please accept the Terms & Conditions to continue.' }];
            }
            return issues;
        }

        return issues;
    }

    // Submit-time gate: re-checks every step from the top, so a value that
    // was edited after its step was passed (or set straight on the DOM)
    // still cannot get through. Returns the offending step's issues (a
    // non-empty array), or null when every step passes.
    function firstInvalidSignupStep() {
        for (let step = 1; step <= signupStepEls.length; step += 1) {
            const issues = validateSignupStep(step);
            if (issues.length) return issues;
        }
        return null;
    }

    // Renders one step's issues into their own fields' error lines and puts
    // the cursor on the first field that actually failed — not on the step's
    // first input, which since the merge is the email box even when it was
    // the password that was rejected.
    function showSignupStepIssues(issues) {
        if (!issues || !issues.length) return;
        const step = issues[0].step;
        const stepEl = signupStepEls[step - 1];

        // Move focus BEFORE writing anything. focus() blurs whatever was
        // focused, and an <input> whose value changed while it held focus
        // fires `change` on the way out — which the per-field clear handler
        // below answers by blanking a line. Written the other way round, a
        // Create Account press with a filled-in mobile and an unticked Terms
        // box set the message and then immediately erased it.
        if (stepEl) {
            const named = issues[0].field ? stepEl.querySelector(`[name="${issues[0].field}"]`) : null;
            const target = named || stepEl.querySelector('input');
            if (target) target.focus();
        }

        clearSignupStepErrors(step);
        issues.forEach((issue) => setSignupStepError(issue.step, issue.message, issue.field));
    }

    async function advanceSignupStep() {
        if (signupStepAdvancing) return false;
        const issues = validateSignupStep(signupStep);
        if (issues.length) {
            showSignupStepIssues(issues);
            return false;
        }
        if (signupStep === 1) {
            signupStepAdvancing = true;
            const next = signupForm.querySelector('[data-signup-next]');
            next.disabled = true;
            try {
                const available = await window.InigoSignupEmail.check();
                if (!available || !signupForm.classList.contains('is-active') || !authIsOpen || signupStep !== 1) return false;
            } finally {
                signupStepAdvancing = false;
                next.disabled = false;
            }
        }
        clearSignupStepErrors(signupStep);
        setSignupStep(signupStep + 1, { focus: true });
        return true;
    }

    if (signupForm) {
        signupForm.querySelectorAll('[data-signup-next]').forEach((btn) => {
            btn.addEventListener('click', () => advanceSignupStep());
        });

        signupForm.querySelectorAll('[data-signup-back]').forEach((btn) => {
            btn.addEventListener('click', () => {
                clearSignupStepErrors(signupStep);
                setSignupStep(signupStep - 1, { focus: true });
            });
        });

        // Editing a field clears that FIELD's error, so a message never
        // outlives the value that caused it — and, on the merged step 1,
        // fixing the email does not also wipe a password complaint that is
        // still true. A control with no line of its own (the Terms checkbox)
        // falls back to its step's shared line, which is the old behaviour.
        signupStepEls.forEach((stepEl) => {
            const step = stepEl.dataset.signupStep;
            const clearOwn = (e) => setSignupStepError(step, '', e.target && e.target.name);
            stepEl.addEventListener('input', clearOwn);
            stepEl.addEventListener('change', clearOwn);
        });

        // Digits-only fields (the mobile number). Same filter the OTP boxes
        // further down use — strip everything but 0-9 on the way in — with a
        // cap read from the field's own maxlength (11: the local 09XXXXXXXXX
        // form window.validatePhMobile normalises to, which is what the
        // "09XX XXX XXXX" placeholder spells out) instead of the boxes' 1.
        //
        // The JS is the enforcement, not the attributes: inputmode only picks
        // a keypad, and maxlength truncates a paste BEFORE anything can
        // filter it — pasting "+63 917 123 4567" past maxlength alone leaves
        // "+63 917 123", which then filters down to a wrong 8-digit number.
        // Hence the paste handler below preempts it and does the stripping
        // first, exactly as the OTP boxes do.
        signupForm.querySelectorAll('[data-digits-only]').forEach((field) => {
            const maxDigits = field.maxLength > 0 ? field.maxLength : 11;
            const digitsOnly = (raw) => String(raw || '').replace(/[^0-9]/g, '');

            field.addEventListener('input', () => {
                const filtered = digitsOnly(field.value).slice(0, maxDigits);
                // Written back only when it actually differs: assigning
                // .value drops the caret to the end of the box, and every
                // accepted keystroke would otherwise pay that for nothing.
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

                // Assigning .value fires nothing, and the step's own 'input'
                // listener is what clears this field's inline error — so a
                // paste has to announce itself or a stale error outlives the
                // value that caused it.
                field.dispatchEvent(new Event('input', { bubbles: true }));
            });
        });

        setSignupStep(1);
    }

    // Rewrites raw Supabase Auth error text into copy a user can act on.
    // The rate-limit and email-not-confirmed cases are the ones that came up
    // while diagnosing the OTP email issue — Supabase's built-in mailer caps
    // out fast during repeated signups, and the raw messages ("429: email
    // rate limit exceeded") don't tell the user what to actually do.
    function friendlyAuthError(err) {
        const code = err?.code || '';
        const message = err?.message || '';

        if (code === 'over_email_send_rate_limit' || /rate limit/i.test(message)) {
            const waitMatch = message.match(/after (\d+) seconds/i);
            return waitMatch
                ? `Too many attempts — please wait ${waitMatch[1]}s and try again.`
                : 'Too many attempts — please wait a minute and try again.';
        }

        if (code === 'email_not_confirmed' || /email not confirmed/i.test(message)) {
            return 'Please verify your email before logging in — check your inbox to confirm your account.';
        }

        return message || 'Something went wrong. Please try again.';
    }

    // Keep both password-login panels in sync with the persisted per-email
    // cooldown. Changing the address immediately switches to that address's
    // own state; a lockout in another tab is reflected through `storage`.
    panels.forEach((form) => {
        if (!['login', 'admin'].includes(form.dataset.authPanel)) return;
        const emailFieldName = form.dataset.authPanel === 'admin' ? 'admin-email' : 'email';
        form.elements[emailFieldName]?.addEventListener('input', () => {
            if (refreshLoginLockout(form)) startLoginLockoutCountdown();
        });
    });
    window.addEventListener('storage', (event) => {
        if (event.key?.startsWith(LOGIN_ATTEMPT_STORAGE_PREFIX) && refreshAllLoginLockouts()) {
            startLoginLockoutCountdown();
        }
    });
    refreshAllLoginLockouts();

    // Wired to real Supabase Auth. Public signup always creates a customer
    // account (role is never client-settable — see the DB trigger); the
    // Admin panel logs into the same auth.users but only accepts an
    // account whose profiles.role is staff/admin.
    panels.forEach((form) => {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (form.dataset.authPanel === 'phone') return;
            overlay.querySelector('[data-auth-access-error]').hidden = true;

            // Sign Up's stepped flow owns its own validation, and has to run
            // before checkValidity() below rather than inside the mode ===
            // 'signup' branch further down. Two reasons:
            //   • Sign Up's only submit button is the one on its last step, so
            //     the browser routes Enter-from-any-field there and this
            //     handler is where an earlier step's Enter arrives. On step 1
            //     the later steps' required fields are still empty, and
            //     reportValidity() cannot show a bubble on a control that is
            //     not being rendered — it just logs "not focusable" and leaves
            //     the visitor with nothing.
            //   • On the last step, letting reportValidity() go first would
            //     answer an empty name or an unticked Terms box with a native
            //     bubble instead of the step's own inline message.
            if (form.dataset.authPanel === 'signup') {
                if (signupStep < signupStepEls.length) {
                    advanceSignupStep();
                    return;
                }

                // Last step: re-run every step's rules against the live field
                // values, independently of which step is showing and of what
                // the password checklist happens to be rendering. Anything
                // that fails sends the visitor back to the step that owns it
                // with the message inline, rather than posting a signup the
                // policy would have refused. showSignupStepIssues() does the
                // focusing, so setSignupStep() is called without it — it would
                // otherwise land on the step's first input rather than on the
                // field that was actually rejected.
                const invalidIssues = firstInvalidSignupStep();
                if (invalidIssues) {
                    setSignupStep(invalidIssues[0].step);
                    showSignupStepIssues(invalidIssues);
                    return;
                }
            }

            if (!form.checkValidity()) {
                form.reportValidity();
                return;
            }

            if (!window.sb) {
                setAuthNotice('Unable to reach the server right now. Please try again shortly.', true);
                return;
            }

            const mode = form.dataset.authPanel;
            const data = Object.fromEntries(new FormData(form));
            const loginEmail = mode === 'admin'
                ? normalizeLoginEmail(data['admin-email'])
                : (mode === 'login' ? normalizeLoginEmail(data.email) : '');
            if (loginEmail && refreshLoginLockout(form)) {
                startLoginLockoutCountdown();
                return;
            }
            if (mode === 'signup') {
                // Three inputs in, one full_name out — see composeFullName().
                // Done HERE, on the FormData snapshot, so it lands before the
                // mobile check and before signUp: everything downstream of
                // this line still reads the exact `data.fullname` shape it
                // always did, and the signUp payload is unchanged.
                data.fullname = composeFullName(data.firstname, data.middlename, data.surname);
            }
            // Sign Up carries two .auth-submit buttons — step 1's Continue
            // (type="button") and Create Account — and only the last is the
            // form's real submit control. Matching on type keeps setBusy()
            // disabling the button that was actually pressed, which is what
            // stops a double submit.
            const submitBtn = form.querySelector('button[type="submit"].auth-submit')
                || form.querySelector('.auth-submit');

            function setBusy(isBusy) {
                if (!submitBtn) return;
                submitBtn.disabled = isBusy;
                submitBtn.classList.toggle('is-loading', isBusy);
                if (!isBusy) refreshLoginLockout(form);
            }

            setAuthNotice('');
            setBusy(true);

            try {
                if (mode === 'login') {
                    window.InigoAuthStorage.setRememberSession(data.remember === 'on');
                    if (window.InigoLoading) window.InigoLoading.show('Signing you in…');
                    const { data: signInData, error } = await window.sb.auth.signInWithPassword({
                        email: data.email,
                        password: data.password
                    });
                    if (error) throw error;
                    clearLoginAttempts(loginEmail);
                    await gateOtpThenCompleteLogin(signInData.user, ['customer'], data.email);
                    return;
                }

                if (mode === 'signup') {
                    // Check the local input shape before signup. The actual
                    // provider format/type validation and profile write happen
                    // after email confirmation and an active profile exists.
                    const mobileCheck = data.mobile?.trim() ? window.validatePhMobile(data.mobile) : { valid: true, normalized: null };
                    if (!mobileCheck.valid) {
                        setAuthNotice(mobileCheck.message, true);
                        return;
                    }

                    if (window.InigoLoading) window.InigoLoading.show('Creating your account…');
                    const { data: signUpData, error } = await window.sb.auth.signUp({
                        email: data.email,
                        password: data.password,
                        options: {
                            data: {
                                full_name: data.fullname
                            }
                        }
                    });
                    if (window.InigoLoading) window.InigoLoading.hide();
                    if (error && ['user_already_exists', 'email_exists'].includes(error.code)) {
                        setSignupStep(1);
                        showSignupStepIssues([{ step: 1, field: 'email', message: 'This email is already registered. Log in or use a different email address.' }]);
                        return;
                    }
                    if (error) throw error;

                    // Supabase returns no error and no session for an email that's
                    // already registered — it just silently no-ops (anti-enumeration
                    // behavior) instead of throwing. An empty identities array is the
                    // one signal that distinguishes this from a genuine new signup.
                    if (signUpData.user && signUpData.user.identities && signUpData.user.identities.length === 0) {
                        setSignupStep(1);
                        showSignupStepIssues([{ step: 1, field: 'email', message: 'This email is already registered. Log in or use a different email address.' }]);
                        return;
                    }

                    pendingSignupPhone = mobileCheck.normalized || '';
                    if (signUpData.session) {
                        await completeLogin(['customer'], true);
                        return;
                    }

                    pendingSignupEmail = data.email;
                    setOtpPurpose('signup');
                    const emailLabel = overlay.querySelector('[data-verify-email]');
                    if (emailLabel) emailLabel.textContent = data.email || 'your email';
                    setActivePanel('verify');
                    startOtpFlow();
                    return;
                }

                if (mode === 'verify') {
                    const code = otpBoxes.map((box) => box.value).join('');

                    // First-login-per-device gate on a password login —
                    // reuses this same panel/boxes/resend flow, but verifies
                    // against Supabase's generic email-OTP type (sent via
                    // signInWithOtp in gateOtpThenCompleteLogin) rather than
                    // the signup-confirmation OTP below, and finishes by
                    // completing the login instead of redirecting straight
                    // to the customer dashboard.
                    if (otpPurpose === 'login') {
                        if (code.length !== 6 || !pendingLoginOtp) {
                            if (otpError) otpError.classList.add('is-visible');
                            return;
                        }

                        if (window.InigoLoading) window.InigoLoading.show('Verifying…');
                        const { error } = await window.sb.auth.verifyOtp({
                            email: pendingLoginOtp.email,
                            token: code,
                            type: 'email'
                        });

                        if (error) {
                            if (otpError) otpError.classList.add('is-visible');
                            throw error;
                        }

                        if (otpError) otpError.classList.remove('is-visible');
                        const allowedRoles = pendingLoginOtp.allowedRoles;
                        pendingLoginOtp = null;
                        await completeLogin(allowedRoles);
                        return;
                    }

                    // Password recovery by code — the other half of the
                    // mode === 'forgot' branch below. Same panel, same boxes,
                    // same Resend, but verified against Supabase's 'recovery'
                    // OTP type: that is what establishes the short-lived
                    // session updateUser() needs on the `reset` panel this
                    // hands over to. Finishing here does NOT log anybody in —
                    // mode === 'reset' signs that session back out once the
                    // new password is set.
                    if (otpPurpose === 'recovery') {
                        if (code.length !== 6 || !pendingRecoveryEmail) {
                            if (otpError) otpError.classList.add('is-visible');
                            return;
                        }

                        // verifyOtp({ type: 'recovery' }) fires the same
                        // PASSWORD_RECOVERY auth event an emailed link does,
                        // and it fires from inside the await below — before
                        // any line after it runs. Claim the flow here so
                        // enterRecoveryMode() does not also call openModal()
                        // on an already-open modal, which would overwrite
                        // lastFocusedEl with an OTP box that is about to be
                        // hidden (closing the modal would then drop focus to
                        // <body>). This branch owns the transition instead.
                        recoveryHandled = true;

                        if (window.InigoLoading) window.InigoLoading.show('Verifying…');
                        const { error } = await window.sb.auth.verifyOtp({
                            email: pendingRecoveryEmail,
                            token: code,
                            type: 'recovery'
                        });

                        if (error) {
                            // Stays on this panel deliberately: the boxes, the
                            // Resend button and the countdown are all still
                            // here, so a wrong or expired code is retryable in
                            // place rather than dumping the visitor back to
                            // the start of the flow. The throw is caught below
                            // and hides the loading overlay.
                            if (otpError) otpError.classList.add('is-visible');
                            throw error;
                        }

                        if (otpError) otpError.classList.remove('is-visible');
                        if (window.InigoLoading) window.InigoLoading.hide();
                        setActivePanel('reset');
                        // setActivePanel() has no focus policy of its own (see
                        // the increment-5 notes), so focus is moved here to
                        // match what the link path already does via
                        // openModal('reset') — both entry points arrive on
                        // this panel with the new-password field focused.
                        const newPasswordField = overlay.querySelector('[data-auth-panel="reset"] input');
                        if (newPasswordField) newPasswordField.focus();
                        setAuthNotice('Code confirmed — choose your new password.', false);
                        return;
                    }

                    if (code.length !== 6 || !pendingSignupEmail) {
                        if (otpError) otpError.classList.add('is-visible');
                        return;
                    }

                    if (window.InigoLoading) window.InigoLoading.show('Verifying…');
                    const { error } = await window.sb.auth.verifyOtp({
                        email: pendingSignupEmail,
                        token: code,
                        type: 'signup'
                    });

                    if (error) {
                        if (otpError) otpError.classList.add('is-visible');
                        throw error;
                    }

                    if (otpError) otpError.classList.remove('is-visible');
                    await completeLogin(['customer'], true);

                    return;
                }

                if (mode === 'admin') {
                    window.InigoAuthStorage.setRememberSession(data.remember === 'on');
                    if (window.InigoLoading) window.InigoLoading.show('Signing you in…');
                    const { data: signInData, error } = await window.sb.auth.signInWithPassword({
                        email: data['admin-email'],
                        password: data['admin-password']
                    });
                    if (error) throw error;
                    clearLoginAttempts(loginEmail);
                    await gateOtpThenCompleteLogin(signInData.user, ['staff', 'admin'], data['admin-email']);
                    return;
                }

                if (mode === 'forgot') {
                    // Deliberately vague success message regardless of
                    // whether the email is registered — resetPasswordForEmail
                    // itself doesn't error for an unknown email either, to
                    // avoid letting this form be used to enumerate accounts.
                    //
                    // The hand-off below is UNCONDITIONAL for the same
                    // reason: branching on whether an account exists is
                    // exactly the tell this form must not give. An
                    // unregistered address simply fails at the code step,
                    // with the same "that code didn't match" everyone else
                    // gets for a wrong code.
                    if (window.InigoLoading) window.InigoLoading.show('Sending your reset code…');
                    const { error } = await window.sb.auth.resetPasswordForEmail(data.email, {
                        redirectTo: recoveryRedirectTo()
                    });
                    if (error) throw error;
                    if (window.InigoLoading) window.InigoLoading.hide();

                    // Hand off to the SAME Verify panel that Sign Up and the
                    // new-device login gate use — same six boxes, same
                    // countdown, same Resend button. The reset email carries a
                    // 6-digit code (docs/email_templates/reset_password.html),
                    // and this is the only place in the UI it can be typed;
                    // without this the flow dead-ends here. The
                    // mode === 'verify' branch above then swaps in the `reset`
                    // panel once the code checks out.
                    pendingRecoveryEmail = data.email;
                    setOtpPurpose('recovery');
                    const emailLabel = overlay.querySelector('[data-verify-email]');
                    if (emailLabel) emailLabel.textContent = data.email || 'your email';
                    setActivePanel('verify');
                    startOtpFlow();
                    setAuthNotice("If that email is registered, we've sent a 6-digit reset code. Check your inbox.", false);
                    form.reset();
                    return;
                }

                if (mode === 'reset') {
                    const newPassword = data['new-password'];
                    const confirmPassword = data['confirm-password'];
                    // Same creation-time policy as Sign Up step 1, read
                    // straight off the submitted value — the checklist above
                    // the field is only a hint. Without this, password
                    // recovery would be a way to set a password signup rejects.
                    if (!checkPasswordPolicy(newPassword).valid) {
                        setAuthNotice(`Your new password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters and include an uppercase letter, a lowercase letter, a number and a special character.`, true);
                        return;
                    }
                    if (newPassword !== confirmPassword) {
                        setAuthNotice('Passwords do not match.', true);
                        return;
                    }
                    // Shown only AFTER the two local checks above: both of
                    // them `return` straight out of the try block, which the
                    // catch that hides this overlay never sees.
                    if (window.InigoLoading) window.InigoLoading.show(resetPurpose === 'invite' ? 'Setting your password…' : 'Updating your password…');
                    const { error } = await window.sb.auth.updateUser({ password: newPassword });
                    if (error) throw error;

                    if (resetPurpose === 'invite') {
                        // The invite link's session IS the new staff
                        // account's session — same trust model as a fresh
                        // sign-in (see the header comment above
                        // isInviteRedirect) — so finish exactly like one:
                        // completeLogin() reads profiles.role, registers
                        // the active_session single-session guard, and
                        // redirects into the matching dashboard. It also
                        // closes this modal itself, unlike the recovery
                        // branch below.
                        setAuthNotice('Password set — welcome aboard!', false);
                        if (window.InigoLoading) window.InigoLoading.show('Setting up your dashboard…');
                        await completeLogin(['staff']);
                        return;
                    }

                    // Sign out of the short-lived recovery session so the
                    // visitor logs back in fresh with the new password —
                    // simpler and safer than guessing which dashboard a
                    // recovery link belongs on (this modal serves customer,
                    // staff, and admin accounts alike).
                    await window.sb.auth.signOut();
                    if (window.InigoLoading) window.InigoLoading.hide();
                    form.reset();
                    // form.reset() fires no input event, so the checklist
                    // would otherwise stay ticked over an emptied field.
                    syncPasswordRules();
                    setActivePanel(recoveryLoginPanel);
                    overlay.querySelector('[data-auth-panel].is-active input')?.focus();
                    setAuthNotice('Password updated — please log in with your new password.', false);
                    return;
                }
            } catch (err) {
                if (window.InigoLoading) window.InigoLoading.hide();
                if (loginEmail && isInvalidCredentialError(err)) {
                    const attempt = recordInvalidLogin(loginEmail);
                    if (attempt.lockedUntil) {
                        startLoginLockoutCountdown();
                        setAuthNotice('Too many incorrect login attempts. Login is paused for 1 minute.', true);
                    } else {
                        const remaining = LOGIN_MAX_FAILURES - attempt.failures;
                        setAuthNotice(`Incorrect email or password. ${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} remaining before a 1-minute timeout.`, true);
                    }
                } else if (err.code === 'account_role_mismatch') {
                    const notice = overlay.querySelector('[data-auth-access-error]');
                    notice.textContent = friendlyAuthError(err);
                    notice.hidden = false;
                } else {
                    setAuthNotice(friendlyAuthError(err), true);
                }
            } finally {
                setBusy(false);
            }
        });
    });

    // ------------------------------------------------------------------
    // OTP verification UI (design/demo only — no real code is checked yet)
    // ------------------------------------------------------------------
    const otpBoxes = Array.from(overlay.querySelectorAll('[data-otp-box]'));
    const otpError = overlay.querySelector('[data-otp-error]');
    const otpResendBtn = overlay.querySelector('[data-otp-resend]');
    const otpTimerEl = overlay.querySelector('[data-otp-timer]');
    let otpTimerId = null;

    function startOtpFlow() {
        otpBoxes.forEach((box) => {
            box.value = '';
            box.classList.remove('is-filled');
        });
        if (otpError) otpError.classList.remove('is-visible');
        if (otpBoxes[0]) otpBoxes[0].focus();
        startResendCountdown(30);
    }

    function startResendCountdown(seconds) {
        if (otpTimerId) window.clearInterval(otpTimerId);
        let remaining = seconds;
        if (otpResendBtn) otpResendBtn.disabled = true;

        const tick = () => {
            if (otpTimerEl) otpTimerEl.textContent = `Resend available in ${remaining}s`;
            if (remaining <= 0) {
                window.clearInterval(otpTimerId);
                if (otpTimerEl) otpTimerEl.textContent = '';
                if (otpResendBtn) otpResendBtn.disabled = false;
                return;
            }
            remaining -= 1;
        };

        tick();
        otpTimerId = window.setInterval(tick, 1000);
    }

    otpBoxes.forEach((box, index) => {
        box.addEventListener('input', () => {
            box.value = box.value.replace(/[^0-9]/g, '').slice(0, 1);
            box.classList.toggle('is-filled', box.value.length === 1);
            if (box.value && otpBoxes[index + 1]) otpBoxes[index + 1].focus();
        });

        box.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !box.value && otpBoxes[index - 1]) {
                otpBoxes[index - 1].focus();
            }
        });

        box.addEventListener('paste', (e) => {
            const pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '');
            if (!pasted) return;
            e.preventDefault();
            pasted.split('').slice(0, otpBoxes.length).forEach((digit, i) => {
                if (otpBoxes[i]) {
                    otpBoxes[i].value = digit;
                    otpBoxes[i].classList.add('is-filled');
                }
            });
            const next = otpBoxes[Math.min(pasted.length, otpBoxes.length - 1)];
            if (next) next.focus();
        });
    });

    if (otpResendBtn) {
        otpResendBtn.addEventListener('click', async () => {
            if (!window.sb) return;

            // WHICH call re-sends a code depends on what this panel is
            // currently being used for, and they are not interchangeable:
            //   • login    → signInWithOtp, the same call the new-device gate
            //                made, served by the Magic Link template.
            //   • recovery → resetPasswordForEmail, NOT resend({ type:
            //                'signup' }). That would mint a signup-
            //                confirmation token, which verifyOtp({ type:
            //                'recovery' }) can never accept, and it would send
            //                the wrong email template as well.
            //   • signup   → resend({ type: 'signup' }), the original path.
            // Picked first, then performed by ONE show/disable/error block, so
            // the loading overlay cannot be left up on a path that forgot to
            // hide it.
            let resendCode;
            if (otpPurpose === 'login') {
                if (!pendingLoginOtp) return;
                resendCode = () => window.sb.auth.signInWithOtp({
                    email: pendingLoginOtp.email,
                    options: { shouldCreateUser: false }
                });
            } else if (otpPurpose === 'recovery') {
                if (!pendingRecoveryEmail) return;
                resendCode = () => window.sb.auth.resetPasswordForEmail(pendingRecoveryEmail, {
                    redirectTo: recoveryRedirectTo()
                });
            } else {
                if (!pendingSignupEmail) return;
                resendCode = () => window.sb.auth.resend({
                    type: 'signup',
                    email: pendingSignupEmail
                });
            }

            otpResendBtn.disabled = true;
            if (window.InigoLoading) window.InigoLoading.show('Sending a new code…');

            try {
                const { error } = await resendCode();
                if (error) throw error;
                startResendCountdown(30);
            } catch (err) {
                // Re-enabled rather than left dead, so a rate-limited or
                // failed resend can be retried once the wait is over.
                setAuthNotice(friendlyAuthError(err), true);
                otpResendBtn.disabled = false;
            } finally {
                if (window.InigoLoading) window.InigoLoading.hide();
            }
        });
    }

    // Short-lived toast: floats above the modal instead of sitting inline in
    // the form flow, and auto-dismisses on its own — no close button needed.
    //
    // `authNoticeDismissTimer` and `authNoticeHideTimer` used to be declared
    // here. They are now in the top-level declaration block at the head of
    // this function, because consumePendingAuthNotice() calls setAuthNotice()
    // during setup — i.e. long before this line runs. Do not move them back;
    // see assertEarlySetupBindings() for what breaks and how it is caught.

    function getAuthNoticeEl() {
        let notice = overlay.querySelector('[data-auth-notice]');
        if (!notice) {
            notice = document.createElement('p');
            notice.className = 'auth-status';
            notice.dataset.authNotice = '';
            notice.setAttribute('aria-live', 'polite');
            notice.hidden = true;
            overlay.appendChild(notice);
        }
        return notice;
    }

    function hideAuthNotice() {
        const notice = getAuthNoticeEl();
        notice.classList.remove('is-visible');
        if (authNoticeHideTimer) window.clearTimeout(authNoticeHideTimer);
        authNoticeHideTimer = window.setTimeout(() => {
            notice.hidden = true;
        }, 250);
    }

    function setAuthNotice(message, isError = false, duration = isError ? 5000 : 3500) {
        const notice = getAuthNoticeEl();
        if (authNoticeDismissTimer) {
            window.clearTimeout(authNoticeDismissTimer);
            authNoticeDismissTimer = null;
        }
        if (authNoticeHideTimer) {
            window.clearTimeout(authNoticeHideTimer);
            authNoticeHideTimer = null;
        }

        if (!message) {
            hideAuthNotice();
            return;
        }

        notice.hidden = false;
        notice.textContent = message;
        notice.classList.toggle('is-error', isError);
        requestAnimationFrame(() => notice.classList.add('is-visible'));

        authNoticeDismissTimer = window.setTimeout(hideAuthNotice, duration);
    }

    // ------------------------------------------------------------------
    // Google Sign-In / Sign-Up — via Supabase's native Google OAuth
    // provider (Authentication → Sign In / Providers → Google in the
    // Supabase dashboard). Customer accounts only — the Admin and Verify
    // panels stay credential-only on purpose, so no Google button is
    // rendered there. Clicking the button hands off to a full-page
    // redirect (Google, then back here); there is no in-page response to
    // handle, so the click handler only needs to cover the case where the
    // redirect itself fails to start.
    // ------------------------------------------------------------------
    overlay.querySelectorAll('[data-google-btn]').forEach((container) => {
        container.innerHTML = '';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'auth-google-button';
        // Google's official four-colour "G", 24×24 brand geometry, unmodified.
        // The previous paths here were hand-drawn approximations — the yellow
        // arc in particular swept the wrong way and overshot the mark. Google's
        // branding rules forbid recolouring, distorting, cropping or otherwise
        // restyling the mark, so these four `d`/`fill` pairs and the
        // `viewBox="0 0 24 24"` they are drawn against must stay verbatim.
        button.innerHTML = `
            <span class="auth-google-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"></path>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"></path>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"></path>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"></path>
                </svg>
            </span>
            <span>Login / Sign up with Google</span>
        `;

        button.addEventListener('click', async () => {
            if (!window.sb) {
                setAuthNotice('Unable to reach the server right now. Please try again shortly.', true);
                return;
            }

            overlay.querySelector('[data-auth-access-error]').hidden = true;
            button.disabled = true;
            button.classList.add('is-loading');
            if (window.InigoLoading) window.InigoLoading.show('Redirecting to Google…');
            sessionStorage.setItem('inigosync-oauth-pending', '1');

            const { error } = await window.sb.auth.signInWithOAuth({
                provider: 'google',
                options: { redirectTo: window.location.href, queryParams: { prompt: 'select_account' } }
            });

            if (error) {
                sessionStorage.removeItem('inigosync-oauth-pending');
                if (window.InigoLoading) window.InigoLoading.hide();
                setAuthNotice(friendlyAuthError(error), true);
                button.disabled = false;
                button.classList.remove('is-loading');
            }
            // On success the browser navigates away to Google, so there's
            // nothing further to do here — the redirect back is handled by
            // the session check at the top of this file.
        });

        container.appendChild(button);
    });
});
