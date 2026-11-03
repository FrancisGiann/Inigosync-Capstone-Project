// Loaded after the onboarding markup so authGuard's profile-ready event cannot
// race listener registration.
(() => {
    const form = document.querySelector('[data-staff-onboarding-content]');
    const loading = document.querySelector('[data-staff-onboarding-loading]');
    const errorEl = document.querySelector('[data-staff-onboarding-error]');
    const submit = document.querySelector('[data-staff-onboarding-submit]');
    const back = document.querySelector('[data-staff-onboarding-back]');
    const footer = document.querySelector('[data-staff-onboarding-footer]');
    const saving = document.querySelector('[data-staff-onboarding-saving]');
    const savingText = saving?.querySelector('[data-staff-onboarding-saving-text]');
    const stepLabel = document.querySelector('[data-staff-onboarding-step-label]');
    const progress = document.querySelector('[data-staff-onboarding-progress]');
    const themeButton = document.querySelector('[data-staff-onboarding-theme]');
    const birthdate = document.querySelector('#staffSetupBirthdate');
    const retryButton = document.querySelector('[data-staff-onboarding-retry]');
    const successPanel = document.querySelector('[data-staff-onboarding-success]');
    const password = document.querySelector('#staffSetupPassword');
    const confirmPassword = document.querySelector('#staffSetupConfirm');
    const mobile = document.querySelector('#staffSetupMobile');
    const phoneStatus = document.querySelector('[data-staff-onboarding-phone-status]');
    const emergencyMobile = document.querySelector('#staffSetupEmergencyNumber');
    const emergencyStatus = document.querySelector('[data-staff-onboarding-emergency-status]');
    const privacyCheckbox = document.querySelector('[data-staff-onboarding-privacy-checkbox]');
    const privacyModal = document.querySelector('[data-staff-onboarding-privacy-modal]');
    const privacyOpen = document.querySelector('[data-staff-onboarding-open-privacy]');
    if (!form || !submit) return;

    const steps = ['password', 'name', 'personal', 'contact'];
    let step = 'password';
    let passwordForCompletion = '';
    let isSaving = false;
    let completionSucceeded = false;
    let staffUserId = '';
    let unresolvedPassword = '';
    let phoneRevision = 0;
    let phoneTimer = 0;
    let phoneCache = null;
    let emergencyRevision = 0;
    let emergencyTimer = 0;
    let emergencyCache = null;
    let previousFocus = null;
    const pendingPasswordKey = () => staffUserId ? `inigosync:staff-onboarding-password-pending:${staffUserId}` : '';
    const pendingPasswordWindowMs = 10 * 60 * 1000;
    function hasPendingPasswordAttempt() {
        try {
            const key = pendingPasswordKey();
            if (!key) return false;
            const startedAt = Number(window.localStorage.getItem(key));
            if (!Number.isFinite(startedAt) || startedAt <= 0) return false;
            if (Date.now() - startedAt < pendingPasswordWindowMs) return true;
            window.localStorage.removeItem(key);
        } catch (_) { /* storage may be disabled */ }
        return false;
    }
    function markPendingPasswordAttempt() {
        try { if (pendingPasswordKey()) window.localStorage.setItem(pendingPasswordKey(), String(Date.now())); }
        catch (_) { /* storage may be disabled */ }
    }
    function clearPendingPasswordAttempt() {
        try { if (pendingPasswordKey()) window.localStorage.removeItem(pendingPasswordKey()); }
        catch (_) { /* storage may be disabled */ }
    }

    const withTimeout = (promise, message, ms = 15000) => new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(message)), ms);
        Promise.resolve(promise).then(
            value => { window.clearTimeout(timer); resolve(value); },
            error => { window.clearTimeout(timer); reject(error); }
        );
    });

    const setThemeButtonLabel = () => {
        const isDark = document.documentElement.dataset.theme !== 'light';
        const nextTheme = isDark ? 'light' : 'dark';
        if (!themeButton) return;
        themeButton.setAttribute('aria-label', `Switch to ${nextTheme} theme`);
        themeButton.setAttribute('title', `Switch to ${nextTheme} theme`);
        themeButton.setAttribute('aria-pressed', String(!isDark));
        themeButton.querySelectorAll('.sun-circle, .sun-line').forEach(part => { part.style.display = isDark ? '' : 'none'; });
        const moon = themeButton.querySelector('.moon-path');
        if (moon) moon.style.display = isDark ? 'none' : '';
    };
    themeButton?.addEventListener('click', () => window.ThemeController?.toggle());
    document.addEventListener('themechange', setThemeButtonLabel);
    setThemeButtonLabel();

    const todayInManila = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    const adultBirthdateCutoff = `${Number(todayInManila.slice(0, 4)) - 18}${todayInManila.slice(4)}`;
    if (birthdate) birthdate.max = adultBirthdateCutoff;

    function showStep(nextStep) {
        step = nextStep;
        form.querySelectorAll('[data-staff-onboarding-step]').forEach(section => { section.hidden = section.dataset.staffOnboardingStep !== step; });
        const index = steps.indexOf(step);
        if (stepLabel) stepLabel.textContent = `Step ${index + 1} of ${steps.length}`;
        if (progress) {
            progress.setAttribute('aria-valuenow', String(index + 1));
            progress.firstElementChild.style.width = `${((index + 1) / steps.length) * 100}%`;
        }
        if (back) back.hidden = index === 0;
        submit.textContent = index === steps.length - 1 ? 'Finish setup' : 'Continue';
        errorEl.textContent = '';
        form.querySelector(`[data-staff-onboarding-step="${step}"] h1`)?.focus({ preventScroll: true });
    }

    function setSaving(active) {
        isSaving = active;
        submit.disabled = active;
        if (back) back.disabled = active;
        if (footer) footer.hidden = active;
        if (saving) saving.hidden = !active;
        if (active && savingText) savingText.textContent = 'Saving your password and profile securely…';
        if (active) errorEl.textContent = '';
        if (active) window.InigoLoading?.show('Saving your password and profile securely…');
        else window.InigoLoading?.hide();
    }

    document.addEventListener('inigosync:profile-ready', event => {
        staffUserId = event.detail?.id || '';
        if (loading) loading.hidden = true;
        if (retryButton) retryButton.hidden = true;
        form.hidden = false;
        showStep('password');
        password?.focus({ preventScroll: true });
    }, { once: true });
    retryButton?.addEventListener('click', () => window.location.reload());
    submit.addEventListener('click', () => {
        if (completionSucceeded) window.location.replace(new URL('staff_dashboard.html', window.location.href).toString());
    });

    function passwordRules(value) {
        return {
            length: value.length >= 8 && value.length <= 15,
            case: /[A-Z]/.test(value) && /[a-z]/.test(value),
            number: /[0-9]/.test(value),
            special: /[ !"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(value),
        };
    }
    function paintPasswordRules() {
        const rules = passwordRules(password?.value || '');
        Object.entries(rules).forEach(([key, valid]) => {
            const item = form.querySelector(`[data-password-rule="${key}"]`);
            if (item) item.dataset.valid = String(valid);
        });
    }
    password?.addEventListener('input', paintPasswordRules);

    function paintPhone(message, state = '') {
        if (!phoneStatus) return;
        phoneStatus.textContent = message;
        phoneStatus.dataset.state = state;
        mobile?.setAttribute('aria-invalid', String(state === 'invalid' || state === 'in_use'));
        if (state !== 'invalid' && state !== 'in_use') mobile?.removeAttribute('aria-invalid');
    }

    async function checkMobile(force = false, expectedRevision = phoneRevision) {
        const raw = mobile?.value.trim() || '';
        if (!raw) { phoneCache = null; paintPhone(''); return true; }
        const parsed = window.validatePhMobile?.(raw);
        if (!parsed?.valid) { phoneCache = null; paintPhone(parsed?.message || 'Enter a valid Philippine mobile number.', 'invalid'); return false; }
        if (!force && phoneCache?.phone === parsed.normalized && Date.now() - phoneCache.at < 30000) {
            paintPhone(phoneCache.message, phoneCache.state);
            return phoneCache.state === 'available';
        }
        if (!window.sb || !window.SUPABASE_URL) { paintPhone('Phone validation is unavailable. Try again.', 'error'); return false; }
        paintPhone('Checking availability…', 'checking');
        mobile?.setAttribute('aria-busy', 'true');
        try {
            const { data: { session } = {} } = await withTimeout(window.sb.auth.getSession(), 'Your session check took too long. Please try again.');
            if (!session?.access_token) throw new Error('Your session expired. Sign in again.');
            const controller = new AbortController();
            const timer = window.setTimeout(() => controller.abort(), 8000);
            let response;
            try {
                response = await fetch(`${window.SUPABASE_URL}/functions/v1/validate-contact-phone`, {
                    method: 'POST', signal: controller.signal,
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                    body: JSON.stringify({ phone: parsed.normalized, purpose: 'contact' }),
                });
            } finally { window.clearTimeout(timer); }
            const result = await response.json().catch(() => ({}));
            if (expectedRevision !== phoneRevision || mobile.value.trim() !== raw) return false;
            if (!response.ok || result.valid !== true) {
                if (result.reason === 'in_use') {
                    phoneCache = { phone: parsed.normalized, state: 'in_use', message: 'This number is already in use.', at: Date.now() };
                    paintPhone(phoneCache.message, 'in_use');
                } else if (result.reason === 'invalid') {
                    phoneCache = { phone: parsed.normalized, state: 'invalid', message: 'Enter a valid Philippine mobile number.', at: Date.now() };
                    paintPhone(phoneCache.message, 'invalid');
                } else throw new Error(result.message || 'Phone availability is temporarily unavailable.');
                return false;
            }
            phoneCache = { phone: parsed.normalized, state: 'available', message: 'Valid and available.', at: Date.now(), normalized: result.normalized };
            paintPhone(phoneCache.message, 'available');
            return true;
        } catch (error) {
            if (expectedRevision === phoneRevision && mobile?.value.trim() === raw) paintPhone(error?.message || 'Phone availability is temporarily unavailable.', 'error');
            return false;
        } finally {
            if (expectedRevision === phoneRevision) mobile?.removeAttribute('aria-busy');
        }
    }
    mobile?.addEventListener('input', () => {
        phoneRevision++;
        phoneCache = null;
        window.clearTimeout(phoneTimer);
        if (!mobile.value.trim()) { paintPhone(''); return; }
        const parsed = window.validatePhMobile?.(mobile.value);
        if (!parsed?.valid) { paintPhone(parsed?.message || 'Enter a valid Philippine mobile number.', 'invalid'); return; }
        paintPhone('');
        phoneTimer = window.setTimeout(() => { if (step === 'contact') checkMobile(false); }, 600);
    });
    mobile?.addEventListener('blur', () => { window.clearTimeout(phoneTimer); if (step === 'contact' && mobile.value.trim()) checkMobile(false); });

    function paintEmergency(message, state = '') {
        if (!emergencyStatus) return;
        emergencyStatus.textContent = message;
        emergencyStatus.dataset.state = state;
        if (state === 'invalid') emergencyMobile?.setAttribute('aria-invalid', 'true');
        else emergencyMobile?.removeAttribute('aria-invalid');
    }
    async function checkEmergency(force = false, expectedRevision = emergencyRevision) {
        const raw = emergencyMobile?.value.trim() || '';
        if (!raw) { emergencyCache = null; paintEmergency(''); return true; }
        const parsed = window.validatePhMobile?.(raw);
        if (!parsed?.valid) { emergencyCache = null; paintEmergency(parsed?.message || 'Enter a valid Philippine mobile number.', 'invalid'); return false; }
        if (!force && emergencyCache?.phone === parsed.normalized && Date.now() - emergencyCache.at < 30000) {
            paintEmergency(emergencyCache.message, emergencyCache.state);
            return true;
        }
        if (!window.sb || !window.SUPABASE_URL) { paintEmergency('Phone validation is unavailable. Try again.', 'error'); return false; }
        paintEmergency('Checking number…', 'checking');
        emergencyMobile?.setAttribute('aria-busy', 'true');
        try {
            const { data: { session } = {} } = await withTimeout(window.sb.auth.getSession(), 'Your session check took too long. Please try again.');
            if (!session?.access_token) throw new Error('Your session expired. Sign in again.');
            const controller = new AbortController();
            const timer = window.setTimeout(() => controller.abort(), 8000);
            let response;
            try {
                response = await fetch(`${window.SUPABASE_URL}/functions/v1/validate-contact-phone`, {
                    method: 'POST', signal: controller.signal,
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                    body: JSON.stringify({ phone: parsed.normalized, purpose: 'emergency' }),
                });
            } finally { window.clearTimeout(timer); }
            const result = await response.json().catch(() => ({}));
            if (expectedRevision !== emergencyRevision || emergencyMobile.value.trim() !== raw) return false;
            if (!response.ok || result.valid !== true) throw new Error(result.message || 'Validate your emergency contact number before finishing setup.');
            const inUse = result.available === false;
            emergencyCache = {
                phone: parsed.normalized, normalized: result.normalized, at: Date.now(),
                state: inUse ? 'in_use' : 'available',
                message: inUse ? 'This number is already on file; it can still be used as an emergency contact.' : 'Valid and available.',
            };
            paintEmergency(emergencyCache.message, emergencyCache.state);
            return true;
        } catch (error) {
            if (expectedRevision === emergencyRevision && emergencyMobile?.value.trim() === raw) paintEmergency(error?.message || 'Phone validation is temporarily unavailable.', 'error');
            return false;
        } finally {
            if (expectedRevision === emergencyRevision) emergencyMobile?.removeAttribute('aria-busy');
        }
    }
    emergencyMobile?.addEventListener('input', () => {
        emergencyRevision++;
        emergencyCache = null;
        window.clearTimeout(emergencyTimer);
        if (!emergencyMobile.value.trim()) { paintEmergency(''); return; }
        const parsed = window.validatePhMobile?.(emergencyMobile.value);
        if (!parsed?.valid) { paintEmergency(parsed?.message || 'Enter a valid Philippine mobile number.', 'invalid'); return; }
        paintEmergency('');
        emergencyTimer = window.setTimeout(() => { if (step === 'contact') checkEmergency(false); }, 600);
    });
    emergencyMobile?.addEventListener('blur', () => { window.clearTimeout(emergencyTimer); if (step === 'contact' && emergencyMobile.value.trim()) checkEmergency(false); });

    function closePrivacy(agreed = false) {
        if (!privacyModal) return;
        privacyModal.hidden = true;
        if (privacyCheckbox && !agreed) privacyCheckbox.checked = false;
        previousFocus?.focus?.({ preventScroll: true });
    }
    function syncPrivacyTheme() {
        try {
            const policyRoot = privacyModal.querySelector('iframe')?.contentDocument?.documentElement;
            if (policyRoot) policyRoot.dataset.theme = document.documentElement.dataset.theme;
        } catch (_) { /* The linked policy remains readable if embedded elsewhere. */ }
    }
    privacyModal?.querySelector('iframe')?.addEventListener('load', syncPrivacyTheme);
    function openPrivacy(trigger) {
        previousFocus = trigger || privacyOpen;
        privacyModal.hidden = false;
        syncPrivacyTheme();
        privacyModal.querySelector('[data-privacy-disagree]')?.focus();
    }
    privacyOpen?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openPrivacy(privacyOpen);
    });
    privacyCheckbox?.addEventListener('click', event => {
        event.preventDefault();
        openPrivacy(privacyCheckbox);
    });
    privacyModal?.querySelectorAll('[data-privacy-disagree]').forEach(button => button.addEventListener('click', () => closePrivacy(false)));
    privacyModal?.querySelector('[data-privacy-agree]')?.addEventListener('click', () => {
        if (privacyCheckbox) privacyCheckbox.checked = true;
        closePrivacy(true);
    });
    privacyModal?.addEventListener('click', event => { if (event.target === privacyModal) closePrivacy(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && privacyModal && !privacyModal.hidden) closePrivacy(); });

    back?.addEventListener('click', () => {
        if (isSaving) return;
        showStep(steps[Math.max(0, steps.indexOf(step) - 1)]);
    });

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (isSaving || completionSucceeded) return;
        errorEl.textContent = '';

        if (step === 'password') {
            paintPasswordRules();
            const entered = password?.value || '';
            const rules = passwordRules(entered);
            if (Object.values(rules).some(valid => !valid)) {
                errorEl.textContent = 'Your new password must meet every listed requirement.';
                password?.focus();
                return;
            }
            if (entered !== confirmPassword?.value) {
                errorEl.textContent = 'The passwords do not match.';
                confirmPassword?.focus();
                return;
            }
            // Keep the selected password only in this page's memory until the
            // final submission. No Auth update or browser storage occurs here.
            passwordForCompletion = entered;
            showStep('name');
            document.querySelector('#staffSetupFirstName')?.focus({ preventScroll: true });
            return;
        }

        const values = new FormData(form);
        if (step === 'name') {
            const first = String(values.get('first_name') || '').trim().replace(/\s+/g, ' ');
            const middle = String(values.get('middle_name') || '').trim().replace(/\s+/g, ' ');
            const last = String(values.get('last_name') || '').trim().replace(/\s+/g, ' ');
            const name = [first, middle, last].filter(Boolean).join(' ');
            if (!first || !last) {
                errorEl.textContent = 'Enter your first and last name.';
                document.querySelector(!first ? '#staffSetupFirstName' : '#staffSetupLastName')?.focus();
                return;
            }
            if (first.length > 80 || middle.length > 80 || last.length > 80 || name.length > 120) {
                errorEl.textContent = 'Your name is too long. Please shorten it and try again.';
                document.querySelector('#staffSetupLastName')?.focus();
                return;
            }
            showStep('personal');
            document.querySelector('#staffSetupBirthdate')?.focus({ preventScroll: true });
            return;
        }

        if (step === 'personal') {
            const birthdateValue = String(values.get('birthdate') || '');
            if (!birthdateValue) { errorEl.textContent = 'Enter your birthdate.'; birthdate?.focus(); return; }
            if (birthdateValue > adultBirthdateCutoff || birthdateValue < '1900-01-01') {
                errorEl.textContent = 'Staff members must be at least 18 years old.';
                birthdate?.focus();
                return;
            }
            if (!['Male', 'Female', 'Prefer not to say'].includes(String(values.get('gender') || ''))) {
                errorEl.textContent = 'Choose your gender or select “Prefer not to say”.';
                document.querySelector('#staffSetupGender')?.focus();
                return;
            }
            if (!['Single', 'Married', 'Separated', 'Widowed', 'Prefer not to say'].includes(String(values.get('civil_status') || ''))) {
                errorEl.textContent = 'Choose your civil status.';
                document.querySelector('#staffSetupCivilStatus')?.focus();
                return;
            }
            if (!String(values.get('address') || '').trim()) { errorEl.textContent = 'Enter your address.'; document.querySelector('#staffSetupAddress')?.focus(); return; }
            showStep('contact');
            if (mobile?.value.trim()) checkMobile(false);
            return;
        }

        if (!privacyCheckbox?.checked) {
            errorEl.textContent = 'Read and agree to the Privacy Policy before finishing setup.';
            privacyCheckbox?.focus();
            return;
        }
        if (!passwordForCompletion) {
            showStep('password');
            errorEl.textContent = 'For your security, enter your password again to continue.';
            password?.focus();
            return;
        }
        const contactRaw = String(values.get('contact_num') || '').trim();
        const contactCheck = contactRaw ? window.validatePhMobile?.(contactRaw) : null;
        if (contactRaw && !contactCheck?.valid) {
            errorEl.textContent = contactCheck?.message || 'Enter a valid Philippine mobile number.';
            mobile?.focus();
            return;
        }
        const emergencyRaw = String(values.get('emergency_contact_number') || '').trim();
        const emergencyCheck = emergencyRaw ? window.validatePhMobile?.(emergencyRaw) : null;
        if (emergencyRaw && !emergencyCheck?.valid) {
            errorEl.textContent = 'Enter a valid Philippine emergency contact mobile number.';
            document.querySelector('#staffSetupEmergencyNumber')?.focus();
            return;
        }
        if (!window.sb || !window.SUPABASE_URL) { errorEl.textContent = 'Staff setup is temporarily unavailable. Reload and try again.'; return; }

        let contactNum = '';
        let emergencyNumber = '';

        setSaving(true);
        try {
            const { data: { session } = {}, error: sessionError } = await withTimeout(window.sb.auth.getSession(), 'Your session check took too long. Please try again.');
            if (sessionError || !session?.access_token) throw new Error('Your session expired. Sign in again to finish staff setup.');
            if (contactRaw) {
                if (!await checkMobile(true)) throw new Error('Validate a unique mobile number, or leave it blank.');
                contactNum = phoneCache?.normalized || '';
            }
            if (emergencyRaw) {
                const response = await withTimeout(fetch(`${window.SUPABASE_URL}/functions/v1/validate-contact-phone`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                    body: JSON.stringify({ phone: emergencyCheck.normalized, purpose: 'emergency' }),
                }), 'Validating the emergency contact took too long. Please try again.');
                const result = await response.json().catch(() => ({}));
                if (!response.ok || result.valid !== true) throw new Error(result.message || 'Validate your emergency contact number before finishing setup.');
                emergencyNumber = result.normalized;
            }
            if (unresolvedPassword && passwordForCompletion !== unresolvedPassword) {
                throw new Error('The previous password save may still be finishing. Retry with the same new password before choosing another one.');
            }
            const pendingAttempt = hasPendingPasswordAttempt();
            let passwordError = null;
            if (!pendingAttempt) {
                markPendingPasswordAttempt();
                try {
                    const result = await withTimeout(window.sb.auth.updateUser({ password: passwordForCompletion }), 'Saving your password took too long. Retry with the same new password.');
                    passwordError = result.error;
                } catch (error) {
                    if (error?.message?.includes('took too long')) unresolvedPassword = passwordForCompletion;
                    else clearPendingPasswordAttempt();
                    throw error;
                }
                if (passwordError && passwordError.code !== 'same_password') {
                    clearPendingPasswordAttempt();
                    throw new Error('Your new password could not be saved. Please try again.');
                }
            }
            if (pendingAttempt || passwordError?.code === 'same_password') {
                const { data: { session: verifiedSession } = {}, error: verifySessionError } = await withTimeout(window.sb.auth.getSession(), 'Your session check took too long. Please try again.');
                if (verifySessionError || !verifiedSession?.user?.id || !verifiedSession.user.email) throw new Error('Your session expired. Sign in again and retry staff setup.');
                const matchesAccount = await withTimeout(window.InigoPasswordVerifier?.verifyCurrentPassword({
                    email: verifiedSession.user.email,
                    password: passwordForCompletion,
                    userId: verifiedSession.user.id,
                }), 'Checking your saved password took too long. Please try again.');
                if (matchesAccount !== true) throw new Error('A previous password save may still be finishing. Retry with that same password shortly.');
            }
            const response = await withTimeout(fetch(`${window.SUPABASE_URL}/functions/v1/complete-staff-onboarding`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                body: JSON.stringify({
                    first_name: String(values.get('first_name') || '').trim().replace(/\s+/g, ' '),
                    middle_name: String(values.get('middle_name') || '').trim().replace(/\s+/g, ' '),
                    last_name: String(values.get('last_name') || '').trim().replace(/\s+/g, ' '),
                    contact_num: contactNum,
                    birthdate: values.get('birthdate'),
                    address: String(values.get('address') || '').trim(),
                    gender: values.get('gender'),
                    civil_status: values.get('civil_status'),
                    emergency_contact_name: values.get('emergency_contact_name'),
                    emergency_contact_number: emergencyNumber,
                    privacy_policy_accepted: privacyCheckbox.checked,
                    password: passwordForCompletion,
                }),
            }), 'Saving setup took too long. Retry with the same password and details.');
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || 'Your details could not be saved. Please try again.');
            setSaving(false);
            clearPendingPasswordAttempt();
            unresolvedPassword = '';
            passwordForCompletion = '';
            password.value = '';
            confirmPassword.value = '';
            completionSucceeded = true;
            form.querySelectorAll('[data-staff-onboarding-step]').forEach(section => { section.hidden = true; });
            const stepMeta = form.querySelector('[data-staff-onboarding-step-meta]');
            if (stepMeta) stepMeta.hidden = true;
            if (successPanel) successPanel.hidden = false;
            if (back) back.hidden = true;
            submit.type = 'button';
            submit.textContent = 'Go to dashboard';
        } catch (error) {
            setSaving(false);
            errorEl.textContent = error?.message || 'Your setup could not be saved. Please try again.';
        }
    });
})();
