// Pure client-side filters for the unified customer payment acknowledgment list.
(function () {
    function filterAcknowledgments(entries, { source = 'all', idQuery = '', paymentDate = '' } = {}, paymentDateKey = value => value) {
        const query = String(idQuery || '').trim().toLowerCase();
        return (Array.isArray(entries) ? entries : []).filter(entry => {
            const sourceMatches = source === 'all' || entry.source === source;
            const ids = Array.isArray(entry.searchIds) ? entry.searchIds : [];
            const idMatches = !query || ids.some(id => String(id).toLowerCase().includes(query));
            const dateMatches = !paymentDate || paymentDateKey(entry.acknowledgment?.issued_at) === paymentDate;
            return sourceMatches && idMatches && dateMatches;
        });
    }

    window.InigoCustomerReceipts = { filterAcknowledgments };
})();
