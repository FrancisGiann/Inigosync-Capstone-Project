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

    function receiptReference(entry) {
        return String(entry?.acknowledgment?.receipt_number || entry?.acknowledgment?.receipt_id || entry?.cardKey || '');
    }

    function receiptAmount(entry) {
        const acknowledgment = entry?.acknowledgment || {};
        const amount = acknowledgment.total !== null && acknowledgment.total !== undefined && acknowledgment.total !== ''
            ? Number(acknowledgment.total)
            : (acknowledgment.gross_minor !== null && acknowledgment.gross_minor !== undefined && acknowledgment.gross_minor !== ''
                ? Number(acknowledgment.gross_minor) / 100 : NaN);
        return Number.isFinite(amount) ? amount : null;
    }

    function sortAcknowledgments(entries, order = 'newest') {
        const direction = ['oldest', 'receipt-asc', 'amount-asc'].includes(order) ? 1 : -1;
        return (Array.isArray(entries) ? entries : []).map((entry, index) => ({ entry, index })).sort((left, right) => {
            let comparison = 0;

            if (order === 'receipt-asc' || order === 'receipt-desc') {
                const leftReference = receiptReference(left.entry);
                const rightReference = receiptReference(right.entry);
                if (!!leftReference !== !!rightReference) return leftReference ? -1 : 1;
                comparison = leftReference.localeCompare(rightReference, undefined, { numeric: true, sensitivity: 'base' }) * direction;
            } else if (order === 'amount-asc' || order === 'amount-desc') {
                const leftAmount = receiptAmount(left.entry);
                const rightAmount = receiptAmount(right.entry);
                if ((leftAmount !== null) !== (rightAmount !== null)) return leftAmount !== null ? -1 : 1;
                if (leftAmount !== null && rightAmount !== null) comparison = (leftAmount - rightAmount) * direction;
            } else {
                const leftDate = Date.parse(left.entry?.acknowledgment?.issued_at || '');
                const rightDate = Date.parse(right.entry?.acknowledgment?.issued_at || '');
                const leftHasDate = Number.isFinite(leftDate);
                const rightHasDate = Number.isFinite(rightDate);
                if (leftHasDate !== rightHasDate) return leftHasDate ? -1 : 1;
                if (leftHasDate && leftDate !== rightDate) comparison = direction * (leftDate - rightDate);
            }

            if (comparison) return comparison;
            const referenceOrder = receiptReference(left.entry).localeCompare(receiptReference(right.entry), undefined,
                { numeric: true, sensitivity: 'base' });
            return referenceOrder || left.index - right.index;
        }).map(item => item.entry);
    }

    window.InigoCustomerReceipts = { filterAcknowledgments, sortAcknowledgments };
})();
