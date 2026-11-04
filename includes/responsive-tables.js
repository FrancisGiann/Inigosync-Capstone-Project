/* Add mobile field labels to real record tables. Receipt, QR and schedule
   tables are intentionally omitted from the selector. */
(() => {
    const selector = 'table[data-responsive-cards]';

    function refreshTable(table) {
        const heads = [...table.querySelectorAll('thead tr')]
            .filter(row => !row.hidden && getComputedStyle(row).display !== 'none')
            .at(-1);
        if (!heads) return;
        const labels = [...heads.querySelectorAll('th, td')].map(cell => cell.textContent.trim());
        const hours = table.dataset.responsiveCards === 'hours';
        table.querySelectorAll('tbody tr').forEach(row => {
            const rowHeading = hours ? row.querySelector('th[scope="row"]')?.textContent.trim() : '';
            [...row.cells].forEach((cell, index) => {
                if (cell.hasAttribute('colspan')) return;
                const label = labels[index] || '';
                cell.dataset.mobileLabel = label;
                if (hours && rowHeading) cell.dataset.mobileRow = rowHeading;
            });
        });
    }

    document.querySelectorAll(selector).forEach(table => {
        refreshTable(table);
        const observer = new MutationObserver(() => refreshTable(table));
        observer.observe(table, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
    });
})();
