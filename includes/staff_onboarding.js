document.addEventListener('DOMContentLoaded', () => {
    const form = document.querySelector('[data-staff-onboarding-form]');
    const content = document.querySelector('[data-staff-onboarding-content]');
    const loading = document.querySelector('[data-staff-onboarding-loading]');
    const errorEl = document.querySelector('[data-staff-onboarding-error]');
    const submit = document.querySelector('[data-staff-onboarding-submit]');
    const birthdate = document.querySelector('#staffSetupBirthdate');
    if (!form || !content || !submit) return;

    if (birthdate) {
        birthdate.max = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(new Date());
    }

    document.addEventListener('inigosync:profile-ready', () => {
        if (loading) loading.hidden = true;
        content.style.display = 'block';
    }, { once: true });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (errorEl) errorEl.textContent = '';
        const values = new FormData(form);
        const password = String(values.get('password') || '');
        const confirm = String(values.get('confirm_password') || '');
        const fullName = String(values.get('full_name') || '').trim();
        const special = /[ !"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(password);
        if (!fullName) { if (errorEl) errorEl.textContent = 'Enter your full name.'; return; }
        if (password.length < 8 || password.length > 15 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !special) {
            if (errorEl) errorEl.textContent = 'Your new password must meet every listed requirement.';
            return;
        }
        if (password !== confirm) { if (errorEl) errorEl.textContent = 'The passwords do not match.'; return; }
        if (!window.sb || !window.SUPABASE_URL) {
            if (errorEl) errorEl.textContent = 'Staff setup is temporarily unavailable. Reload and try again.';
            return;
        }

        submit.disabled = true;
        submit.textContent = 'Saving your details…';
        try {
            // Change Auth password first. The server independently checks this
            // password and rejects the stored temporary password.
            const { error: passwordError } = await window.sb.auth.updateUser({ password });
            if (passwordError) throw new Error('Your new password could not be saved. Please try again.');
            const { data: { session } } = await window.sb.auth.getSession();
            if (!session) throw new Error('Your session expired. Sign in again with your new password.');

            const response = await fetch(`${window.SUPABASE_URL}/functions/v1/complete-staff-onboarding`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                body: JSON.stringify({
                    full_name: fullName,
                    birthdate: values.get('birthdate'),
                    address: values.get('address'),
                    gender: values.get('gender'),
                    emergency_contact_name: values.get('emergency_contact_name'),
                    password,
                }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || 'Your details could not be saved. Please try again.');
            window.location.replace(new URL('staff_dashboard.html', window.location.href).toString());
        } catch (error) {
            if (errorEl) errorEl.textContent = error?.message || 'Your details could not be saved. Please try again.';
            submit.disabled = false;
            submit.textContent = 'Save and continue';
        }
    });
});
