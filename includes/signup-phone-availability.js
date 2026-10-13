// Public signup phone lookup. The RPC returns a boolean-like state only and
// enforces shared and per-IP limits; it never returns profile data.
document.addEventListener('DOMContentLoaded', () => {
    const form = document.querySelector('[data-auth-panel="signup"]');
    if (!form) return;
    const field = form.querySelector('[name="mobile"]');
    const status = form.querySelector('[data-signup-phone-availability-status]');
    if (!field || !status) return;

    let revision = 0, timer, pending = null;
    const value = () => field.value.trim();
    const active = () => form.classList.contains('is-active')
        && form.querySelector('[data-signup-step="2"]')?.classList.contains('is-active');
    function paint(text, state = '') {
        status.textContent = text;
        status.dataset.state = state;
        field.dataset.phoneAvailability = state;
    }

    async function check() {
        const phone = value(), version = revision;
        if (!phone) { paint(''); return false; }
        const parsed = window.validatePhMobile?.(phone);
        if (!parsed?.valid) { paint('Enter a complete mobile number.', 'invalid'); return false; }
        if (pending?.phone === parsed.normalized && pending.version === version) return pending.promise;

        paint('Checking…', 'checking');
        field.setAttribute('aria-busy', 'true');
        const promise = (async () => {
            const abort = new AbortController();
            const timeout = setTimeout(() => abort.abort(), 8000);
            try {
                if (!window.sb) throw new Error('Unavailable');
                const e164 = `+63${parsed.normalized.slice(1)}`;
                const { data, error } = await window.sb.rpc('signup_phone_availability', { phone_e164: e164 }).abortSignal(abort.signal);
                if (version !== revision || value() !== phone) return false;
                if (error) throw error;
                if (!['in_use', 'available', 'rate_limited', 'invalid'].includes(data)) throw new Error('Unexpected response');
                const messages = {
                    in_use: ['Existing', 'in_use'],
                    available: ['Not found', 'available'],
                    rate_limited: ['Wait 1 min', 'rate_limited'],
                    invalid: ['Enter a complete mobile number.', 'invalid'],
                };
                const [text, state] = messages[data];
                paint(text, state);
                field.setAttribute('aria-invalid', String(data === 'invalid'));
                return data === 'available';
            } catch (_) {
                if (version === revision && value() === phone) paint('Try again', 'error');
                return false;
            } finally {
                clearTimeout(timeout);
                if (version === revision) field.removeAttribute('aria-busy');
                if (pending?.promise === promise) pending = null;
            }
        })();
        pending = { phone: parsed.normalized, version, promise };
        return promise;
    }

    field.addEventListener('input', () => {
        revision++;
        field.removeAttribute('aria-invalid');
        field.removeAttribute('aria-busy');
        clearTimeout(timer);
        const phone = value();
        if (!phone) { paint(''); return; }
        if (phone.length < 11) { paint(''); return; }
        timer = setTimeout(() => { if (active()) check(); }, 600);
    });
    field.addEventListener('blur', () => { clearTimeout(timer); if (active()) check(); });
    form.addEventListener('reset', () => {
        revision++;
        clearTimeout(timer);
        paint('');
        field.removeAttribute('aria-busy');
        field.removeAttribute('aria-invalid');
    });
    window.InigoSignupPhoneAvailability = { check };
});
