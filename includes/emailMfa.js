// Email second-step session gate. The email code is verified by Supabase Auth,
// while the Edge Function binds that proof to the password/OAuth session that
// started this login. Browser storage is only a hint; the server hashes and
// validates the remembered-device secret before granting session access.
(function () {
    const DEVICE_SECRET_PREFIX = 'inigosync-email-mfa-device:v1:';

    function deviceStorageKey(userId) {
        return `${DEVICE_SECRET_PREFIX}${userId}`;
    }

    function getDeviceSecret(userId, createIfMissing) {
        if (!userId) return null;
        const key = deviceStorageKey(userId);
        try {
            const saved = localStorage.getItem(key);
            if (saved && /^[a-f0-9]{64}$/i.test(saved)) return saved;
            if (!createIfMissing) return null;
            const bytes = new Uint8Array(32);
            if (!window.crypto?.getRandomValues) throw new Error('Secure random values are unavailable.');
            window.crypto.getRandomValues(bytes);
            const secret = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
            localStorage.setItem(key, secret);
            return secret;
        } catch (_) {
            // If storage or secure randomness fails, MFA still works. The
            // browser simply cannot be remembered.
            return null;
        }
    }

    function clearDeviceSecret(userId) {
        if (!userId) return;
        try { localStorage.removeItem(deviceStorageKey(userId)); } catch (_) { /* best effort */ }
    }

    async function invoke(action, body) {
        if (!window.sb?.functions?.invoke) throw new Error('Email verification is temporarily unavailable. Please try again.');
        const { data, error } = await window.sb.functions.invoke('email-mfa', {
            body: { action, ...body }
        });
        if (error) {
            let message = error.message || 'Email verification is temporarily unavailable. Please try again.';
            try {
                const response = error.context;
                const payload = response && typeof response.json === 'function' ? await response.json() : null;
                if (payload?.message) message = payload.message;
            } catch (_) { /* use the SDK message */ }
            throw new Error(message);
        }
        if (!data || data.error) throw new Error(data?.message || 'Email verification is temporarily unavailable. Please try again.');
        return data;
    }

    window.InigoEmailMfa = Object.freeze({
        begin({ userId, remember }) {
            const deviceSecret = getDeviceSecret(userId, remember === true);
            return invoke('begin', { remember: remember === true, device_secret: deviceSecret });
        },
        verify({ challengeId, code, userId, remember }) {
            return invoke('verify', {
                challenge_id: challengeId,
                code,
                remember: remember === true,
                device_secret: remember === true ? getDeviceSecret(userId, true) : null
            });
        },
        async check({ activity = false } = {}) {
            const { data } = await window.sb?.auth?.getSession?.();
            const userId = data?.session?.user?.id;
            return invoke('check', {
                activity,
                device_secret: userId ? getDeviceSecret(userId, false) : null,
            });
        },
        revoke() { return invoke('revoke', {}); },
        clearDeviceSecret
    });
})();
