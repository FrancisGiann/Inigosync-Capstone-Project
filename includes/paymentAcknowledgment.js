// Shared, snapshot-only payment acknowledgment rendering for customer and
// staff booking and walk-in receipt paths.
(function () {
    'use strict';

    const TIME_ZONE = 'Asia/Manila';

    function escape(value) {
        if (typeof window.escapeHtml === 'function') return window.escapeHtml(String(value));
        return String(value).replace(/[&<>"']/g, (character) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        })[character]);
    }

    function money(major, minor) {
        const value = major !== null && major !== undefined && major !== ''
            ? Number(major)
            : (minor !== null && minor !== undefined && minor !== '' ? Number(minor) / 100 : NaN);
        return Number.isFinite(value)
            ? `₱${value.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : '—';
    }

    function dateTime(value, options) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return new Intl.DateTimeFormat('en-PH', { timeZone: TIME_ZONE, ...options }).format(date);
    }

    function durationMinutes(item) {
        const explicit = Number(item.duration_minutes);
        if (Number.isFinite(explicit) && explicit > 0) return explicit;
        const start = new Date(item.starts_at).getTime();
        const end = new Date(item.ends_at).getTime();
        return Number.isFinite(start) && Number.isFinite(end) && end > start
            ? Math.round((end - start) / 60000) : null;
    }

    function paymentMethod(value) {
        const method = String(value || '').toLowerCase().replace(/[_\s-]+/g, '');
        if (method === 'cash') return 'Cash';
        if (['online', 'paymongo', 'paymongoqr', 'card', 'gcash', 'maya'].includes(method)) return 'Online';
        return '';
    }

    function paymentStatus(acknowledgment) {
        const status = String(acknowledgment.payment_status || '').toLowerCase().replace(/[\s-]+/g, '_');
        const remaining = acknowledgment.remaining_balance_minor ?? acknowledgment.remaining_minor;
        const hasRemaining = remaining !== null && remaining !== undefined && Number(remaining) > 0;
        if (hasRemaining || ['down_payment', 'deposit', 'partially_paid', 'partially_settled'].includes(status)) return 'Down Payment';
        if (['paid', 'succeeded', 'completed', 'confirmed'].includes(status)) return 'Paid';
        return '';
    }

    function renderItem(item, itemReferenceLabel = '') {
        const court = item.court || item.unit || '';
        const place = [
            item.sport ? `<div class="payment-ack-item-field"><span>Sport:</span><strong>${escape(item.sport)}</strong></div>` : '',
            court ? `<div class="payment-ack-item-field"><span>Court:</span><strong>${escape(court)}</strong></div>` : '',
            item.unit && item.court && item.unit !== item.court
                ? `<div class="payment-ack-item-field"><span>Unit:</span><strong>${escape(item.unit)}</strong></div>` : '',
        ].filter(Boolean).join('') || '<strong class="payment-ack-place">Court access</strong>';
        const day = dateTime(item.starts_at, { dateStyle: 'medium' });
        const from = dateTime(item.starts_at, { timeStyle: 'short' });
        const to = dateTime(item.ends_at, { timeStyle: 'short' });
        const schedule = [day, from && to ? `${from}–${to}` : ''].filter(Boolean).join(' · ');
        const minutes = durationMinutes(item);
        const durationText = minutes
            ? `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)} hr${Math.floor(minutes / 60) === 1 ? '' : 's'}` : ''}${minutes % 60 ? `${Math.floor(minutes / 60) ? ' ' : ''}${minutes % 60} min` : ''}`
            : '';
        const rate = item.rate_minor !== null && item.rate_minor !== undefined && Number.isFinite(Number(item.rate_minor))
            ? money(null, item.rate_minor) : '';
        const basis = item.rate_unit === '/set' ? 'per set' : (item.rate_unit === '/hr' ? 'per hour' : '');
        const quantity = Number(item.rate_quantity);
        const billableQuantity = item.rate_unit === '/hr'
            ? Number(item.billable_quantity)
            : quantity;
        const quantityText = Number.isFinite(billableQuantity) && billableQuantity > 0
            ? Number.isInteger(billableQuantity) ? String(billableQuantity) : billableQuantity.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
            : '';
        const rateLine = basis && quantityText
            ? `${quantityText} ${item.rate_unit === '/set' ? 'sets' : 'hrs'} × ${rate || 'Rate unavailable'} ${basis}`
            : (durationText ? `Duration: ${escape(durationText)} · Rate unavailable` : 'Rate unavailable');
        const visitId = itemReferenceLabel && item.reservation_id !== null && item.reservation_id !== undefined
            ? `<span>${escape(itemReferenceLabel)} #${escape(item.reservation_id)}</span>` : '';
        return `<section class="payment-ack-item">
            <div class="payment-ack-place">${place}</div>
            ${visitId}
            ${schedule ? `<span>${escape(schedule)}</span>` : ''}
            ${durationText && rateLine && !rateLine.startsWith('Duration:') ? `<span>Duration: ${escape(durationText)}</span>` : ''}
            ${rateLine ? `<span>${rateLine}</span>` : ''}
            <span class="payment-ack-item-amount">Item amount <strong>${escape(money(item.subtotal, item.subtotal_minor))}</strong></span>
        </section>`;
    }

    function render(acknowledgment, options = {}) {
        if (!acknowledgment || typeof acknowledgment !== 'object') return '';
        const items = Array.isArray(acknowledgment.items) ? acknowledgment.items : [];
        const sourceLabel = options.sourceLabel || options.referenceLabel || '';
        const itemReferenceLabel = options.itemReferenceLabel || '';
        const sourceId = options.sourceId !== null && options.sourceId !== undefined ? String(options.sourceId) : '';
        const transactionId = options.transactionId ?? acknowledgment.transaction_id;
        const idLines = [
            sourceLabel && sourceId ? `<div class="payment-ack-meta-row"><span>${escape(sourceLabel)}</span><strong>#${escape(sourceId)}</strong></div>` : '',
            transactionId !== null && transactionId !== undefined && String(transactionId) !== ''
                ? `<div class="payment-ack-meta-row"><span>Transaction ID</span><strong>${escape(transactionId)}</strong></div>` : '',
            acknowledgment.receipt_number || acknowledgment.receipt_id
                ? `<div class="payment-ack-meta-row"><span>Acknowledgment ID</span><strong>${escape(acknowledgment.receipt_number || acknowledgment.receipt_id)}</strong></div>` : '',
        ].filter(Boolean).join('');
        const issued = dateTime(acknowledgment.issued_at, { dateStyle: 'medium', timeStyle: 'short' });
        const method = paymentMethod(acknowledgment.payment_method);
        const status = paymentStatus(acknowledgment);
        const customer = acknowledgment.customer_name ? `<div class="payment-ack-meta-row"><span>Customer</span><strong>${escape(acknowledgment.customer_name)}</strong></div>` : '';
        const subtotal = money(acknowledgment.subtotal, acknowledgment.subtotal_minor);
        const bookingTotalValue = acknowledgment.court_subtotal ?? acknowledgment.court_subtotal_minor;
        const hasBookingTotal = bookingTotalValue !== null && bookingTotalValue !== undefined && bookingTotalValue !== '';
        const bookingTotal = money(acknowledgment.court_subtotal, acknowledgment.court_subtotal_minor);
        const remainingValue = acknowledgment.remaining_balance ?? acknowledgment.remaining_balance_minor ?? acknowledgment.remaining_minor;
        const hasRemaining = remainingValue !== null && remainingValue !== undefined && remainingValue !== '';
        const remaining = money(acknowledgment.remaining_balance,
            acknowledgment.remaining_balance_minor ?? acknowledgment.remaining_minor);
        const fee = money(acknowledgment.fee, acknowledgment.fee_minor);
        const total = money(acknowledgment.total, acknowledgment.gross_minor);
        return `<article class="payment-ack-card" data-payment-ack-card ${options.cardAttributes || ''}>
            <header class="payment-ack-heading">
                <strong>InigoSync</strong>
                <span>(Inigos Sports Center)</span>
                <b>PAYMENT ACKNOWLEDGEMENT</b>
            </header>
            <div class="payment-ack-rule"></div>
            <div class="payment-ack-meta">
                ${idLines}
                ${issued ? `<div class="payment-ack-meta-row"><span>Payment date</span><strong>${escape(issued)}</strong></div>` : ''}
                ${customer}
                ${method ? `<div class="payment-ack-meta-row"><span>Payment method</span><strong>${method}</strong></div>` : ''}
                ${status ? `<div class="payment-ack-meta-row"><span>Payment status</span><strong>${status}</strong></div>` : ''}
            </div>
            <div class="payment-ack-rule"></div>
            <div class="payment-ack-items">${items.length ? items.map(item => renderItem(item, itemReferenceLabel)).join('') : '<p>Saved item details are unavailable.</p>'}</div>
            <div class="payment-ack-rule"></div>
            <div class="payment-ack-totals">
                ${hasBookingTotal ? `<div class="payment-ack-meta-row"><span>Booking total</span><strong>${escape(bookingTotal)}</strong></div>` : ''}
                <div class="payment-ack-meta-row"><span>Subtotal (this payment)</span><strong>${escape(subtotal)}</strong></div>
                ${hasRemaining ? `<div class="payment-ack-meta-row"><span>Remaining balance</span><strong>${escape(remaining)}</strong></div>` : ''}
                <div class="payment-ack-meta-row"><span>Processing fee</span><strong>${escape(fee)}</strong></div>
                <div class="payment-ack-total"><span>TOTAL PAID</span><strong>${escape(total)}</strong></div>
            </div>
            <div class="payment-ack-rule"></div>
            <p class="payment-ack-thanks">Thank you for visiting Inigos Sports Center!</p>
            <p class="payment-ack-disclaimer">NOT AN OFFICIAL RECEIPT<br><span>Payment acknowledgement only. This document is not a tax invoice or official receipt.</span></p>
            ${options.actionsHtml ? `<div class="payment-ack-actions">${options.actionsHtml}</div>` : ''}
        </article>`;
    }

    function print(card) {
        if (!card || !document.body) return false;
        const root = document.createElement('div');
        root.className = 'payment-ack-print-root payment-ack-measuring';
        const clone = card.cloneNode(true);
        clone.querySelectorAll('.payment-ack-actions').forEach((element) => element.remove());
        root.appendChild(clone);
        document.body.appendChild(root);
        // Measure the actual print-styled receipt and set a valid, explicit
        // page height. `80mm auto` is invalid CSS Paged Media syntax.
        const measuredHeightPx = clone.getBoundingClientRect().height;
        const measuredHeightMm = measuredHeightPx * 25.4 / 96;
        const pageHeightMm = Math.max(40, Math.ceil(measuredHeightMm + 6));
        const pageStyle = document.createElement('style');
        pageStyle.dataset.paymentAckPageSize = '';
        document.head.appendChild(pageStyle);
        let pageRuleInserted = false;
        try {
            pageStyle.sheet.insertRule(`@page { size: 80mm ${pageHeightMm}mm; margin: 2mm; }`, 0);
            pageRuleInserted = pageStyle.sheet.cssRules[0]?.type === CSSRule.PAGE_RULE
                && pageStyle.sheet.cssRules[0].style.getPropertyValue('size').trim() === `80mm ${pageHeightMm}mm`;
        } catch { /* The valid `auto` page-size fallback remains available. */ }
        pageStyle.dataset.paymentAckPageSizeApplied = String(pageRuleInserted);
        root.classList.remove('payment-ack-measuring');
        document.body.classList.add('payment-ack-printing');
        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            root.remove();
            pageStyle.remove();
            document.body.classList.remove('payment-ack-printing');
            window.removeEventListener('afterprint', cleanup);
        };
        window.addEventListener('afterprint', cleanup, { once: true });
        window.setTimeout(cleanup, 60000);
        window.print();
        return true;
    }

    window.InigoPaymentAcknowledgment = { render, print, money, paymentMethod, paymentStatus };
})();
