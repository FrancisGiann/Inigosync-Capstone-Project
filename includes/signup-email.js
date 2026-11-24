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
    const UNVERIFIED_SIGNUPS_KEY = 'inigosync-unverified-signups';
    const UNVERIFIED_TTL_MS = 24 * 60 * 60 * 1000;
    const unverifiedMemory = new Map();

    function normalizeEmail(raw) {
        return String(raw || '').trim().toLowerCase();
    }

    function emailKey(raw) {
        const normalized = normalizeEmail(raw);
        if (!normalized) return '';
        let hash = 0x811c9dc5;
        for (let i = 0; i < normalized.length; i += 1) {
            hash ^= normalized.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(36);
    }

    function readUnverifiedMap() {
        const now = Date.now();
        const result = {};
        unverifiedMemory.forEach((entry, key) => {
            if (entry && now - entry.updatedAt < UNVERIFIED_TTL_MS) result[key] = entry;
            else unverifiedMemory.delete(key);
        });
        try {
            const parsed = JSON.parse(localStorage.getItem(UNVERIFIED_SIGNUPS_KEY) || '{}');
            if (parsed && typeof parsed === 'object') {
                Object.entries(parsed).forEach(([key, entry]) => {
                    if (entry && typeof entry === 'object' && now - Number(entry.updatedAt || 0) < UNVERIFIED_TTL_MS) {
                        result[key] = { userId: String(entry.userId || ''), updatedAt: Number(entry.updatedAt) };
                        unverifiedMemory.set(key, result[key]);
                    }
                });
            }
        } catch (_) { /* restricted storage falls back to in-memory map */ }
        return result;
    }

    function writeUnverifiedMap(map) {
        try {
            localStorage.setItem(UNVERIFIED_SIGNUPS_KEY, JSON.stringify(map));
        } catch (_) { /* restricted storage falls back to in-memory map */ }
    }

    function markUnverified(email, userId = '') {
        const normalized = normalizeEmail(email);
        const key = emailKey(normalized);
        if (!key) return;
        const map = readUnverifiedMap();
        const entry = { userId: String(userId || map[key]?.userId || ''), updatedAt: Date.now() };
        map[key] = entry;
        unverifiedMemory.set(key, entry);
        writeUnverifiedMap(map);
        if (cached?.email === normalized) cached = null;
    }

    function clearUnverified(email) {
        const normalized = normalizeEmail(email);
        const key = emailKey(normalized);
        if (!key) return;
        const map = readUnverifiedMap();
        delete map[key];
        unverifiedMemory.delete(key);
        writeUnverifiedMap(map);
        if (cached?.email === normalized) cached = null;
    }

    function isUnverified(email) {
        const key = emailKey(email);
        if (!key) return false;
        const map = readUnverifiedMap();
        return Boolean(map[key]);
    }

    function getUnverifiedUserId(email) {
        const key = emailKey(email);
        if (!key) return '';
        const map = readUnverifiedMap();
        return map[key]?.userId || '';
    }

    function likelyProviderTypo(email) {
        const domain = email.slice(email.lastIndexOf('@') + 1);
        for (const common of commonDomains) {
            if (domain === common) continue;
            if (domain.length === common.length) {
                const mismatch = [];
                for (let index = 0; index < domain.length; index++) {
                    if (domain[index] !== common[index]) mismatch.push(index);
                }
                if (mismatch.length === 2 && mismatch[1] === mismatch[0] + 1
                    && domain[mismatch[0]] === common[mismatch[1]]
                    && domain[mismatch[1]] === common[mismatch[0]]) return `${email.slice(0, email.lastIndexOf('@') + 1)}${common}`;
            }
            let i = 0, j = 0, edits = 0;
            while (i < domain.length && j < common.length) {
                if (domain[i] === common[j]) { i++; j++; continue; }
                if (++edits > 1) break;
                if (domain.length > common.length) i++;
                else if (common.length > domain.length) j++;
                else { i++; j++; }
            }
            edits += (domain.length - i) + (common.length - j);
            if (edits <= 1) return `${email.slice(0, email.lastIndexOf('@') + 1)}${common}`;
        }
        return null;
    }
    function paint(text, state = '') {
        status.textContent = text;
        status.dataset.state = state;
        delete status.dataset.suggestion;
        field.dataset.availability = state;
    }
    async function check({ force = false } = {}) {
        const email = value(), version = revision;
        if (!email || field.validity.typeMismatch) return false;
        const suggestedEmail = likelyProviderTypo(email);
        if (suggestedEmail) {
            if (version === revision && value() === email) {
                paint('Check email spelling', 'check_spelling');
                status.dataset.suggestion = suggestedEmail;
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
                const effectiveData = (data === 'taken' && isUnverified(email)) ? 'available' : data;
                const messages = {
                    available: 'Available',
                    taken: 'Not available',
                    rate_limited: 'Wait 1 min',
                    invalid: 'Invalid email'
                };
                if (!messages[effectiveData]) throw new Error('Unexpected response');
                paint(messages[effectiveData], effectiveData);
                field.setAttribute('aria-invalid', String(effectiveData === 'taken' || effectiveData === 'invalid'));
                if (effectiveData === 'available' || effectiveData === 'taken') cached = { email, available: effectiveData === 'available', time: Date.now() };
                return effectiveData === 'available';
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
    window.InigoSignupEmail = {
        check,
        markUnverified,
        clearUnverified,
        isUnverified,
        getUnverifiedUserId
    };
});
