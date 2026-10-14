/* Shared pagination calculations for staff tables. */
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

    function pageNumbers(page, pageCount) {
        if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
        return [1, ...(page > 3 ? ['gap'] : []),
            ...Array.from({ length: 3 }, (_, index) => page - 1 + index).filter((value) => value > 1 && value < pageCount),
            ...(page < pageCount - 2 ? ['gap'] : []), pageCount];
    }

    return { PAGE_SIZE, paginateRows, pageNumbers };
}));
