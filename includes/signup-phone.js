// Optional post-confirmation format/type validation for a new customer's
// contact number. The authenticated Edge Function validates it with Abstract
// and stores a one-use proof consumed by the profiles update trigger.
(() => {
    let cancel = () => {};

    function reasonMessage(reason) {
        if (reason === 'not_mobile') return 'Enter a Philippine mobile number.';
        if (reason === 'inactive') return 'The provider reports that this number is not active.';
        if (reason === 'status_unknown') return 'The provider could not confirm the number status. Try again later.';
        return 'Enter a valid Philippine mobile number.';
    }

    async function edgeErrorMessage(error) {
        const context = error?.context;
        if (context && typeof context.clone === 'function') {
            try {
                const body = await context.clone().json();
                if (body?.message) return body.message;
            } catch (_) { /* Keep the SDK's safe fallback below. */ }
        }
        return error?.message || 'Phone validation is temporarily unavailable. You can continue without a number.';
    }

    window.InigoSignupPhone = {
        cancel: () => cancel(),
        verify({ phone, userId }) {
            return new Promise(resolve => {
                const form = document.querySelector('[data-auth-panel="phone"]');
                const validate = form?.querySelector('[data-signup-phone-validate]');
                const skip = form?.querySelector('[data-signup-phone-skip]');
                const status = form?.querySelector('[data-signup-phone-status]');
                const number = form?.querySelector('[data-signup-phone-number]');
                if (!form || !validate || !skip || !status || !number) {
                    resolve('skipped');
                    return;
                }

                let active = true;
                let busy = false;
                let saved = false;
                const handlers = new AbortController();
                number.value = phone || '';
                status.textContent = '';
                validate.disabled = false;
                validate.textContent = 'Validate and save';
                skip.disabled = false;
                skip.textContent = 'Continue without a number';

                function finish(result) {
                    if (!active) return;
                    active = false;
                    handlers.abort();
                    cancel = () => {};
                    resolve(result);
                }
                function showError(message) {
                    status.textContent = '';
                    if (window.InigoAuthNotice?.showError) window.InigoAuthNotice.showError(message);
                    else status.textContent = message;
                }
                cancel = () => finish('cancelled');

                form.addEventListener('submit', async event => {
                    event.preventDefault();
                    if (!active || busy || saved) return;
                    const check = window.validatePhMobile?.(phone || '');
                    if (!check?.valid) {
                        showError(check?.message || 'Enter a valid Philippine mobile number.');
                        return;
                    }
                    if (!window.sb?.functions || !userId) {
                        showError('Phone validation is unavailable. You can continue without a number.');
                        return;
                    }

                    busy = true;
                    validate.disabled = skip.disabled = true;
                    validate.textContent = 'Validating…';
                    status.textContent = 'Checking Philippine format, mobile type, and active status…';
                    try {
                        const { data, error } = await window.sb.functions.invoke('validate-contact-phone', {
                            body: { phone: check.normalized },
                        });
                        if (!active) return;
                        if (error) throw new Error(await edgeErrorMessage(error));
                        if (data?.valid !== true) {
                            showError(reasonMessage(data?.reason));
                            return;
                        }
                        if (data.phone_type !== 'mobile' || !/^\+639\d{9}$/.test(data.normalized || '')
                            || data.normalized !== `+63${check.normalized.slice(1)}`) {
                            showError('The provider returned an unsupported validation result. Try again later.');
                            return;
                        }

                        const { data: savedProfile, error: saveError } = await window.sb.from('profiles')
                            .update({ contact_num: data.normalized })
                            .eq('id', userId)
                            .select('id')
                            .single();
                        if (!active) return;
                        if (saveError || !savedProfile) throw saveError || new Error('The number could not be saved.');

                        saved = true;
                        validate.textContent = 'Validated and saved';
                        status.textContent = 'Validated as an active Philippine mobile number. This does not confirm ownership or guarantee reachability.';
                        skip.textContent = 'Continue';
                    } catch (error) {
                        if (active) showError(error.message || 'Phone validation is temporarily unavailable. You can continue without a number.');
                    } finally {
                        if (active) {
                            busy = false;
                            validate.disabled = saved;
                            skip.disabled = false;
                            if (!saved) validate.textContent = 'Validate and save';
                        }
                    }
                }, { signal: handlers.signal });

                skip.addEventListener('click', () => {
                    if (!busy) finish(saved ? 'validated' : 'skipped');
                }, { signal: handlers.signal });
                validate.focus();
            });
        },
    };
})();
