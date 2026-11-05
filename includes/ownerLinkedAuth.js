// Password broker for secondary verified email aliases. Passwords are sent
// only to the Edge Function over TLS; this module never persists them.
(function () {
    async function invoke(action, body = {}) {
        if (!window.sb?.functions?.invoke) throw new Error('Linked account sign-in is temporarily unavailable.');
        const { data, error } = await window.sb.functions.invoke('owner-linked-auth', { body: { action, ...body } });
        if (error) {
            let message = error.message || 'Linked account sign-in is temporarily unavailable.';
            const status = Number(error.context?.status) || 0;
            try {
                const response = error.context;
                const payload = response && typeof response.json === 'function' ? await response.json() : null;
                if (payload?.message) message = payload.message;
            } catch (_) { /* use the SDK message */ }
            const linkedError = new Error(message);
            linkedError.status = status;
            throw linkedError;
        }
        if (!data || data.error) throw new Error(data?.message || 'Linked email sign-in is temporarily unavailable.');
        return data;
    }

    window.InigoOwnerLinkedAuth = Object.freeze({
        invoke,
        login(email, password) { return invoke('login', { email, password }); },
        beginLoginCode(brokerTicket) { return invoke('begin-login-code', { broker_ticket: brokerTicket }); },
        resendLoginCode() { return invoke('resend-login-code'); },
        verifyLoginCode(challengeId, code) { return invoke('verify-login-code', { challenge_id: challengeId, code }); },
    });
})();
