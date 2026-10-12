// Exact-address signup lookup. No account identifiers, roles or profile data returned.
document.addEventListener('DOMContentLoaded', () => {
    const form = document.querySelector('[data-auth-panel="signup"]');
    if (!form) return;
    const field = form.querySelector('[name="email"]');
    const status = form.querySelector('[data-signup-email-status]');
    // Common providers are useful only as typo references. Other domains are
    // left alone: an unfamiliar domain may be valid, and availability does
    // not tell us whether an inbox exists or can receive mail.
    const commonDomains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'];
    let revision = 0, timer, pending = null, cached = null;
    const value = () => field.value.trim().toLowerCase();
    function likelyProviderTypo(email) {
        const domain = email.slice(email.lastIndexOf('@') + 1);
        for (const common of commonDomains) {
            if (domain === common) continue;
            let i = 0, j = 0, edits = 0;
            while (i < domain.length && j < common.length) {
                if (domain[i] === common[j]) { i++; j++; continue; }
                if (++edits > 1) break;
                if (domain.length > common.length) i++;
                else if (common.length > domain.length) j++;
                else { i++; j++; }
            }
            edits += (domain.length - i) + (common.length - j);
            if (edits <= 1) return true;
        }
        return false;
    }
    function paint(text, state = '') {
        status.textContent = text;
        status.dataset.state = state;
        field.dataset.availability = state;
    }
    async function check({ force = false } = {}) {
        const email = value(), version = revision;
        if (!email || field.validity.typeMismatch) return false;
        if (likelyProviderTypo(email)) {
            if (version === revision && value() === email) {
                paint('Check email spelling', 'check_spelling');
                field.setAttribute('aria-invalid', 'true');
            }
            return false;
        }
        if (!force && cached?.email === email && Date.now() - cached.time < 30000) return cached.available;
        if (pending?.email === email && pending.version === version) return pending.promise;
        paint('Checking…', 'checking');
        field.setAttribute('aria-busy', 'true');
        const promise = (async () => {
            await Promise.resolve();
            const abort = new AbortController();
            const timeout = setTimeout(() => abort.abort(), 8000);
            try {
                if (!window.sb) throw new Error('Unavailable');
                const { data, error } = await window.sb.rpc('signup_email_availability', { email_address: email }).abortSignal(abort.signal);
                if (version !== revision || value() !== email) return false;
                if (error) throw error;
                const messages = {
                    available: 'Available',
                    taken: 'Not available',
                    rate_limited: 'Wait 1 min',
                    invalid: 'Invalid email'
                };
                if (!messages[data]) throw new Error('Unexpected response');
                paint(messages[data], data);
                field.setAttribute('aria-invalid', String(data === 'taken' || data === 'invalid'));
                if (data === 'available' || data === 'taken') cached = { email, available: data === 'available', time: Date.now() };
                return data === 'available';
            } catch (_) {
                if (version === revision && value() === email) {
                    paint('Try again', 'error');
                }
                return false;
            } finally {
                clearTimeout(timeout);
                if (version === revision) field.removeAttribute('aria-busy');
                if (pending?.promise === promise) pending = null;
            }
        })();
        pending = { email, version, promise };
        return promise;
    }
    field.addEventListener('input', () => {
        revision++; cached = null;
        field.removeAttribute('aria-invalid'); field.removeAttribute('aria-busy');
        paint(''); clearTimeout(timer);
        timer = setTimeout(() => { if (form.classList.contains('is-active')) check(); }, 600);
    });
    field.addEventListener('blur', () => { clearTimeout(timer); if (form.classList.contains('is-active')) check(); });
    form.addEventListener('reset', () => { revision++; cached = null; clearTimeout(timer); paint(''); field.removeAttribute('aria-busy'); field.removeAttribute('aria-invalid'); });
    window.InigoSignupEmail = { check };
});
