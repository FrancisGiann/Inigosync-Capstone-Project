/* Shared pagination and transaction date matching for staff tables. */
(function (root, factory) {
    const pagination = factory();
    if (typeof module === 'object' && module.exports) module.exports = pagination;
    else root.InigoStaffPagination = pagination;
}(typeof globalThis === 'object' ? globalThis : this, function () {
    const PAGE_SIZE = 10;

    function paginateRows(rows, requestedPage, pageSize = PAGE_SIZE) {
        const items = Array.isArray(rows) ? rows : [];
        const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : PAGE_SIZE;
        const pageCount = Math.max(1, Math.ceil(items.length / size));
        const page = Math.min(Math.max(Math.floor(Number(requestedPage) || 1), 1), pageCount);
        const start = (page - 1) * size;
        return { page, pageCount, pageSize: size, start, rows: items.slice(start, start + size) };
    }

    function pageNumbers(page, pageCount, maxVisible) {
        if (maxVisible === 3) {
            const count = Math.max(1, Math.floor(Number(pageCount) || 1));
            const current = Math.min(Math.max(Math.floor(Number(page) || 1), 1), count);
            const start = Math.min(Math.max(current - 1, 1), Math.max(1, count - 2));
            const end = Math.min(count, start + 2);
            return [
                ...(start > 1 ? ['gap'] : []),
                ...Array.from({ length: end - start + 1 }, (_, index) => start + index),
                ...(end < count ? ['gap'] : []),
            ];
        }
        if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
        return [1, ...(page > 3 ? ['gap'] : []),
            ...Array.from({ length: 3 }, (_, index) => page - 1 + index).filter((value) => value > 1 && value < pageCount),
            ...(page < pageCount - 2 ? ['gap'] : []), pageCount];
    }

    function transactionMatchesDates(row, paymentDate, visitDate, dateFor) {
        if (typeof dateFor !== 'function') return false;
        const dateOf = (value) => {
            if (!value) return '';
            const instant = new Date(value);
            return Number.isFinite(instant.getTime()) ? dateFor(instant) : '';
        };
        if (paymentDate && dateOf(row?.created_at) !== paymentDate) return false;
        if (!visitDate) return true;
        const visits = Array.isArray(row?.visits) ? row.visits : [];
        return visits.some((visit) => dateOf(visit?.starts_at) === visitDate);
    }

    return { PAGE_SIZE, paginateRows, pageNumbers, transactionMatchesDates };
}));
