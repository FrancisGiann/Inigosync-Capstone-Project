// IñigoSync — Philippine mobile number validation.
//
// The spec (docs/SPEC_scope_and_limitations.md — Account Settings: "updating
// registered mobile numbers... include validation features to ensure secure
// updates") requires this on both signup and Account Settings. Both live in
// different files (includes/auth.js and includes/Dashboard.js), so the rule
// lives here once instead of two copies that could quietly drift apart —
// same reasoning as the shared includes/escape.js helper.
//
// Accepted formats: local `09XXXXXXXXX` (11 digits) and international
// `+639XXXXXXXXX`. Spaces/dashes are stripped first, since every mobile
// placeholder in this app shows "09XX XXX XXXX" — rejecting exactly the
// format the UI hints at would be a broken experience, not stricter
// validation.
//
// Plain <script src>, no ES modules — attaches to window. Load this before
// includes/auth.js and includes/Dashboard.js.
(function () {
    const LOCAL_PATTERN = /^09\d{9}$/;
    const INTL_PATTERN = /^\+639\d{9}$/;

    function stripSeparators(raw) {
        return String(raw || '').trim().replace(/[\s-]/g, '');
    }

    // Returns { valid, normalized, message }. normalized is always the
    // local 09XXXXXXXXX form for UI/Edge-function input. The Edge Function
    // returns the canonical +639… value stored after provider validation.
    function validatePhMobile(raw) {
        const cleaned = stripSeparators(raw);

        if (!cleaned) {
            return { valid: false, normalized: null, message: 'Mobile number is required.' };
        }
        if (LOCAL_PATTERN.test(cleaned)) {
            return { valid: true, normalized: cleaned, message: null };
        }
        if (INTL_PATTERN.test(cleaned)) {
            return { valid: true, normalized: `0${cleaned.slice(3)}`, message: null };
        }
        return {
            valid: false,
            normalized: null,
            message: 'Enter a valid PH mobile number, e.g. 09171234567 or +639171234567.',
        };
    }

    window.validatePhMobile = validatePhMobile;
})();
