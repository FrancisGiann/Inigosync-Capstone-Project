// Owner dashboard booking trends chart. Calendar buckets use the
// business timezone, Asia/Manila, regardless of the owner's device timezone.

let bookingChart = null;
let currentChartRange = 'week';
let chartDataAvailable = false;
let chartDataState = 'idle';
let chartRequestId = 0;
const ADMIN_STATUS_LABELS = { booked: 'Booked', completed: 'Completed', no_show: 'No-show' };
let CHART_DATA = {
    week: { labels: [], periods: [], values: [], total: 0, unit: 'bookings per day · this calendar week' },
    month: { labels: [], periods: [], values: [], total: 0, unit: 'bookings per month · this calendar year' },
    year: { labels: [], periods: [], values: [], total: 0, unit: 'bookings per year · this calendar decade' },
};
const chartRangeNames = { week: 'Weekly', month: 'Monthly', year: 'Yearly' };

function bookingTakeaway(source, range) {
    if (!source || source.total === 0) return 'No bookings this period.';
    const busiest = Math.max(...source.values);
    const periods = source.labels.filter((_, index) => source.values[index] === busiest);
    const unit = range === 'month' ? 'month' : range === 'year' ? 'year' : 'day';
    const label = periods.length > 3
        ? `${periods.length} ${unit}s tied`
        : periods.length === 2
            ? periods.join(' and ')
            : periods.length === 3
                ? `${periods[0]}, ${periods[1]} + ${periods[2]}`
                : periods[0];
    return `Busiest ${unit}${periods.length === 1 ? '' : 's'}: ${label} · ${periods.length === 1 ? `${busiest} booking${busiest === 1 ? '' : 's'}` : `${busiest} each`}.`;
}

function bookingChartAccessibleLabel(source, range) {
    const period = { week: 'this week', month: 'this calendar year', year: 'this calendar decade' }[range];
    return `Booking trends for ${period}: ${source.total} booking${source.total === 1 ? '' : 's'}. ${bookingTakeaway(source, range)}`;
}

const manilaParts = (date) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
};
const pad2 = value => String(value).padStart(2, '0');
const dateKey = (year, month, day) => `${year}-${pad2(month)}-${pad2(day)}`;
const rowManilaDate = row => {
    const parsed = new Date(row.time_date);
    if (Number.isNaN(parsed.getTime())) return '';
    const parts = manilaParts(parsed);
    return dateKey(parts.year, parts.month, parts.day);
};
const rangeCaption = range => ({
    week: 'bookings per day · this calendar week',
    month: 'bookings per month · this calendar year',
    year: 'bookings per year · this calendar decade',
})[range];

function bookingStatus(row) {
    if (row.auto_cancelled_at || ['no_show', 'unattended'].includes(row.status)) return 'no_show';
    if (row.status === 'completed') return 'completed';
    if (row.status === 'confirmed' && Number(row.amount_paid) > 0) return 'booked';
    return null;
}

function aggregateBookingRows(rows) {
    const today = manilaParts(new Date());
    const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
    const mondayUtc = todayUtc - ((new Date(todayUtc).getUTCDay() + 6) % 7) * 86400000;
    const week = Array.from({ length: 7 }, (_, i) => new Date(mondayUtc + i * 86400000))
        .map(d => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }));
    const currentYearMonths = Array.from({ length: 12 }, (_, i) => ({ year: today.year, month: i + 1 }));
    const decadeStart = Math.floor(today.year / 10) * 10;
    const decadeYears = Array.from({ length: 10 }, (_, i) => decadeStart + i);
    const weekLabels = week.map(d => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(new Date(Date.UTC(d.year, d.month - 1, d.day))));
    const monthLabels = currentYearMonths.map(d => new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(d.year, d.month - 1, 1))));
    const yearLabels = decadeYears.map(String);
    const weekKeys = week.map(d => dateKey(d.year, d.month, d.day));
    const dateFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
    const weekPeriods = week.map(d => dateFormatter.format(new Date(Date.UTC(d.year, d.month - 1, d.day))));
    const monthPeriods = currentYearMonths.map(d => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long' }).format(new Date(Date.UTC(d.year, d.month - 1, 1))));
    const yearPeriods = decadeYears.map(String);
    const eligibleRows = rows.filter(row => bookingStatus(row));
    const weekValues = weekKeys.map(key => eligibleRows.filter(row => rowManilaDate(row) === key).length);
    const monthValues = currentYearMonths.map(({ year, month }) => eligibleRows.filter(row => {
        const parsed = new Date(row.time_date);
        if (Number.isNaN(parsed.getTime())) return false;
        const parts = manilaParts(parsed);
        return parts.year === year && parts.month === month;
    }).length);
    const yearValues = decadeYears.map(year => eligibleRows.filter(row => {
        const parsed = new Date(row.time_date);
        return !Number.isNaN(parsed.getTime()) && manilaParts(parsed).year === year;
    }).length);
    const total = values => values.reduce((sum, value) => sum + value, 0);
    const status = rows => {
        const counts = { booked: 0, completed: 0, no_show: 0 };
        rows.forEach(row => { const key = bookingStatus(row); if (key) counts[key]++; });
        return counts;
    };
    CHART_DATA = {
        week: { labels: weekLabels, periods: weekPeriods, values: weekValues, total: total(weekValues), status: status(eligibleRows.filter(row => weekKeys.includes(rowManilaDate(row)))), unit: rangeCaption('week') },
        month: { labels: monthLabels, periods: monthPeriods, values: monthValues, total: total(monthValues), status: status(eligibleRows.filter(row => {
            const parsed = new Date(row.time_date); if (Number.isNaN(parsed.getTime())) return false;
            return manilaParts(parsed).year === today.year;
        })), unit: rangeCaption('month') },
        year: { labels: yearLabels, periods: yearPeriods, values: yearValues, total: total(yearValues), status: status(eligibleRows.filter(row => {
            const parsed = new Date(row.time_date); if (Number.isNaN(parsed.getTime())) return false;
            const rowYear = manilaParts(parsed).year;
            return rowYear >= decadeStart && rowYear < decadeStart + 10;
        })), unit: rangeCaption('year') },
    };
}

function buildStatusReport(source) {
    const counts = source.status;
    const keys = Object.keys(ADMIN_STATUS_LABELS);
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (!total) return { counts, total, summary: 'No bookings this period.' };
    const highest = Math.max(...keys.map(key => counts[key]));
    const leaders = keys.filter(key => counts[key] === highest);
    const onlyStatus = leaders.length === 1 && counts[leaders[0]] === total ? leaders[0] : null;
    const allStatusText = {
        booked: total === 1 ? 'This booking is confirmed.' : `All ${total} bookings are confirmed.`,
        completed: total === 1 ? 'This booking is complete.' : `All ${total} bookings are complete.`,
        no_show: total === 1 ? 'This booking was a no-show.' : `All ${total} bookings were no-shows.`,
    };
    const summary = onlyStatus
        ? allStatusText[onlyStatus]
        : leaders.length > 1
            ? 'Even split across the top statuses.'
            : `Most: ${ADMIN_STATUS_LABELS[leaders[0]]}.`;
    return { counts, total, summary };
}

function renderStatusReport(source) {
    const root = document.querySelector('[data-admin-status-breakdown]');
    if (!root) return;
    const report = buildStatusReport(source);
    const { counts, total, summary } = report;
    let angle = 0;
    let previousGap = 0;
    const pieColors = { booked: 'var(--color-court-green)', completed: 'var(--color-ink-faint)', no_show: 'var(--color-primary)' };
    const pieSlices = Object.keys(ADMIN_STATUS_LABELS).filter(key => counts[key] > 0).flatMap((key, index, activeKeys) => {
        const start = angle;
        const extent = counts[key] / total * 360;
        angle += extent;
        const fillStart = start + previousGap / 2;
        const nextKey = activeKeys[index + 1];
        const nextExtent = nextKey ? counts[nextKey] / total * 360 : 0;
        // Skip a seam when either side is too small, preserving narrow but
        // nonzero categories instead of stealing most of their pie area.
        const gap = nextKey && extent >= 4 && nextExtent >= 4 ? 2 : 0;
        const fillEnd = angle - gap / 2;
        const slices = [`${pieColors[key]} ${fillStart}deg ${fillEnd}deg`];
        if (gap) slices.push(`var(--color-bg-card) ${fillEnd}deg ${angle + gap / 2}deg`);
        previousGap = gap;
        return slices;
    });
    const label = total ? `Booking status distribution: ${Object.keys(ADMIN_STATUS_LABELS).map(key => `${ADMIN_STATUS_LABELS[key]} ${counts[key]}`).join(', ')}.` : 'No bookings this period.';
    root.innerHTML = `
        <div class="admin-status-pie${total ? '' : ' is-empty'}" role="img" aria-label="${label}"${total ? ` data-status-counts="${Object.keys(ADMIN_STATUS_LABELS).map(key => counts[key]).join(',')}" style="background: conic-gradient(${pieSlices.join(', ')});"` : ''}>${total ? '<span class="admin-status-pie-tooltip" data-pie-tooltip role="tooltip" hidden></span>' : '<span>No bookings</span>'}</div>
        <div class="admin-status-details">
            <div class="admin-status-summary"><div class="admin-status-total"><strong>${total}</strong><span>booking${total === 1 ? '' : 's'}</span></div></div>
            <div class="admin-status-counts" aria-label="Booking counts by status">
                ${Object.keys(ADMIN_STATUS_LABELS).map(key => `<div class="admin-status-count admin-status-count-${key.replace('_', '-')}"><span class="admin-status-dot admin-status-dot-${key.replace('_', '-')}" aria-hidden="true"></span><span class="admin-status-count-label">${ADMIN_STATUS_LABELS[key]}</span><strong>${counts[key]}</strong></div>`).join('')}
            </div>
        </div>
        <p class="admin-status-takeaway" aria-live="polite">${summary}</p>`;
    const pie = root.querySelector?.('.admin-status-pie[data-status-counts]');
    pie?.addEventListener('pointermove', updatePieHover);
    pie?.addEventListener('pointerleave', hidePieHover);
}

function updatePieHover(event) {
    const pie = event.target.closest?.('.admin-status-pie[data-status-counts]');
    if (!pie) return;
    const tooltip = pie.querySelector('[data-pie-tooltip]');
    const bounds = pie.getBoundingClientRect();
    const x = event.clientX - (bounds.left + bounds.width / 2);
    const y = event.clientY - (bounds.top + bounds.height / 2);
    const angle = (Math.atan2(y, x) * 180 / Math.PI + 450) % 360;
    const counts = pie.dataset.statusCounts.split(',').map(Number);
    const keys = Object.keys(ADMIN_STATUS_LABELS);
    const total = counts.reduce((sum, count) => sum + count, 0);
    let cursor = 0;
    let previousGap = 0;
    let index = -1;
    const activeKeys = keys.filter((_, keyIndex) => counts[keyIndex] > 0);
    counts.forEach((count, countIndex) => {
        if (!count || index >= 0) return;
        const start = cursor;
        const extent = count / total * 360;
        const end = start + extent;
        const fillStart = start + previousGap / 2;
        const activePosition = activeKeys.indexOf(keys[countIndex]);
        const nextKey = activeKeys[activePosition + 1];
        const nextExtent = nextKey ? counts[keys.indexOf(nextKey)] / total * 360 : 0;
        // Match the 2° conic-gradient separator used between sufficiently
        // wide slices; the card-colored seam has no status to report.
        const gap = nextExtent && extent >= 4 && nextExtent >= 4 ? 2 : 0;
        const fillEnd = end - gap / 2;
        if (angle >= fillStart && angle < fillEnd) index = countIndex;
        cursor = end;
        previousGap = gap;
    });
    if (!tooltip) return;
    if (index < 0) {
        tooltip.hidden = true;
        return;
    }
    const sharePercent = Math.round(counts[index] / total * 100);
    tooltip.textContent = `${ADMIN_STATUS_LABELS[keys[index]]}: ${counts[index]} booking${counts[index] === 1 ? '' : 's'} (${sharePercent}%)`;
    tooltip.hidden = false;
    const offset = 14;
    tooltip.style.left = `${Math.max(8, Math.min(event.clientX + offset, window.innerWidth - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(event.clientY + offset, window.innerHeight - tooltip.offsetHeight - 8))}px`;
}

function hidePieHover(event) {
    const pie = event.target.closest?.('.admin-status-pie');
    const tooltip = pie?.querySelector('[data-pie-tooltip]');
    if (tooltip) tooltip.hidden = true;
}

function buildBookingReport(range, now = new Date()) {
    const source = CHART_DATA[range];
    if (!chartDataAvailable || !source || !source.periods.length || source.periods.length !== source.values.length) return null;
    const today = manilaParts(now);
    let periodLabel;
    if (range === 'week') {
        periodLabel = `${source.periods[0]} – ${source.periods[6]}`;
    } else if (range === 'month') {
        periodLabel = `Calendar year ${today.year}`;
    } else {
        periodLabel = `Calendar decade ${source.periods[0]}–${source.periods[source.periods.length - 1]}`;
    }
    return {
        title: 'Booking Report',
        rangeName: chartRangeNames[range],
        periodLabel,
        generatedDate: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' })
            .format(new Date(Date.UTC(today.year, today.month - 1, today.day))),
        total: source.total,
        status: buildStatusReport(source),
        takeaway: bookingTakeaway(source, range),
        scopeNote: 'Includes paid confirmed, completed, and no-show reservations (including automatically canceled no-shows). Pending and canceled reservations are excluded. Future paid confirmed reservations count in their scheduled calendar period.',
        barMeaning: range === 'week' ? 'Each bar shows bookings on one day.' : range === 'month' ? 'Each bar shows bookings in one month.' : 'Each bar shows bookings in one year.',
        rows: source.periods.map((period, index) => ({
            period,
            bookings: source.values[index],
        })),
    };
}

function setChartDataState(state) {
    chartDataState = state;
    chartDataAvailable = state === 'ready';
    updateExportControls();
    const unit = typeof document !== 'undefined' ? document.querySelector?.('[data-admin-chart-unit]') : null;
    const total = typeof document !== 'undefined' ? document.querySelector?.('[data-admin-chart-total]') : null;
    if (!chartDataAvailable) {
        if (unit) unit.textContent = state === 'loading' ? 'Loading booking data…' : state === 'error' ? 'Booking data is unavailable right now.' : 'Booking data has not loaded.';
        if (total) total.textContent = '—';
        const takeaway = typeof document !== 'undefined' ? document.querySelector?.('[data-admin-chart-takeaway]') : null;
        if (takeaway) takeaway.textContent = state === 'loading'
            ? 'Loading booking data…'
            : state === 'error'
                ? 'Booking data is unavailable.'
                : 'Booking data has not loaded.';
        const status = typeof document !== 'undefined' ? document.querySelector?.('[data-admin-status-breakdown]') : null;
        if (status) status.innerHTML = `<p class="admin-form-hint">${state === 'error' ? 'Booking data is unavailable right now.' : 'Loading booking data…'}</p>`;
        const canvas = typeof document !== 'undefined' ? document.getElementById?.('adminBookingChart') : null;
        if (canvas) {
            canvas.setAttribute('role', 'img');
            canvas.setAttribute('aria-label', state === 'loading' ? 'Booking trends; loading booking data.' : state === 'error' ? 'Booking trends; booking data is unavailable.' : 'Booking trends; booking data has not loaded.');
        }
        if (bookingChart) {
            bookingChart.data.labels = [];
            bookingChart.data.datasets[0].data = [];
            bookingChart.update();
        }
    }
}

function updateExportControls() {
    if (typeof document === 'undefined') return;
    const button = document.querySelector?.('[data-admin-chart-export-toggle]');
    if (button) button.disabled = !chartDataAvailable || chartExportBusy;
    document.querySelectorAll?.('[data-admin-chart-export]').forEach(choice => { choice.disabled = !chartDataAvailable || chartExportBusy; });
}

let chartExportBusy = false;

function exportBookingReport(format) {
    chartExportBusy = true;
    const toggle = document.querySelector?.('[data-admin-chart-export-toggle]');
    if (toggle) {
        toggle.dataset.originalLabel = toggle.dataset.originalLabel || toggle.textContent;
        toggle.textContent = 'Exporting…';
        toggle.setAttribute('aria-busy', 'true');
    }
    updateExportControls();
    try {
        return performBookingReportExport(format);
    } catch (error) {
        console.error('[admin-chart] failed to export booking report', error);
        showExportError(`${format === 'xlsx' ? 'Excel' : 'PDF'} export failed. Please try again.`);
        return false;
    } finally {
        chartExportBusy = false;
        if (toggle) {
            toggle.textContent = toggle.dataset.originalLabel || 'Export';
            toggle.removeAttribute('aria-busy');
        }
        updateExportControls();
    }
}

function performBookingReportExport(format) {
    if (!chartDataAvailable) return false;
    const report = buildBookingReport(currentChartRange);
    if (!report) return false;
    const today = manilaParts(new Date());
    const filename = `booking-report-${currentChartRange}-${dateKey(today.year, today.month, today.day)}`;
    if (format === 'xlsx') {
        if (!window.XLSX?.utils || typeof window.XLSX.writeFile !== 'function') {
            showExportError('Excel export is unavailable because its report library did not load.');
            return false;
        }
        const sheet = window.XLSX.utils.aoa_to_sheet([
            [report.title], ['Range', report.rangeName], ['Period', report.periodLabel], ['Total eligible bookings', report.total],
            ['Takeaway', report.takeaway], [report.barMeaning], ['Included reservations', report.scopeNote], ['Generated (Manila)', report.generatedDate], [],
            ['Period', 'Bookings'], ...report.rows.map(row => [row.period, row.bookings]),
            [], ['Booking status', 'Count'], ...Object.keys(ADMIN_STATUS_LABELS).map(key => [ADMIN_STATUS_LABELS[key], report.status.counts[key]]),
            ['Total eligible bookings', report.status.total], ['Status takeaway', report.status.summary],
        ]);
        sheet['!cols'] = [{ wch: 28 }, { wch: 16 }];
        const book = window.XLSX.utils.book_new();
        window.XLSX.utils.book_append_sheet(book, sheet, 'Booking Trends');
        window.XLSX.writeFile(book, `${filename}.xlsx`);
        return true;
    }
    if (format === 'pdf') {
        const JsPDF = window.jspdf?.jsPDF;
        if (typeof JsPDF !== 'function') {
            showExportError('PDF export is unavailable because its report library did not load.');
            return false;
        }
        const pdf = new JsPDF({ unit: 'mm', format: 'a4' });
        pdf.setFontSize(16); pdf.text(report.title, 16, 18);
        pdf.setFontSize(10); pdf.text(`${report.rangeName} - ${report.periodLabel.replace(/–/g, '-')}`, 16, 26);
        pdf.text(`Total eligible bookings: ${report.total}`, 16, 32);
        const takeawayLines = pdf.splitTextToSize(report.takeaway, 176);
        pdf.text(takeawayLines, 16, 39);
        const meaningLines = pdf.splitTextToSize(report.barMeaning, 176);
        pdf.text(meaningLines, 16, 39 + takeawayLines.length * 5 + 2);
        const generatedY = 39 + (takeawayLines.length + meaningLines.length) * 5 + 4;
        pdf.text(`Generated ${report.generatedDate} (Asia/Manila)`, 16, generatedY);
        const scopeLines = pdf.splitTextToSize(report.scopeNote, 176);
        pdf.text(scopeLines, 16, generatedY + 6);
        let y = generatedY + 6 + scopeLines.length * 5 + 9;
        pdf.setFontSize(10); pdf.setFont(undefined, 'bold');
        pdf.text('Period', 16, y); pdf.text('Bookings', 170, y, { align: 'right' });
        pdf.setFont(undefined, 'normal');
        y += 7;
        report.rows.forEach(row => {
            if (y > 275) {
                pdf.addPage(); y = 18;
                pdf.setFont(undefined, 'bold');
                pdf.text('Period', 16, y); pdf.text('Bookings', 170, y, { align: 'right' });
                pdf.setFont(undefined, 'normal'); y += 7;
            }
            pdf.text(row.period, 16, y); pdf.text(String(row.bookings), 170, y, { align: 'right' });
            y += 7;
        });
        y += 5;
        if (y > 270) { pdf.addPage(); y = 18; }
        pdf.setFont(undefined, 'bold'); pdf.text('Booking status', 16, y); pdf.text('Count', 170, y, { align: 'right' });
        pdf.setFont(undefined, 'normal'); y += 7;
        Object.keys(ADMIN_STATUS_LABELS).forEach(key => { pdf.text(ADMIN_STATUS_LABELS[key], 16, y); pdf.text(String(report.status.counts[key]), 170, y, { align: 'right' }); y += 7; });
        pdf.setFont(undefined, 'bold'); pdf.text(`Total eligible bookings: ${report.status.total}`, 16, y); y += 7;
        pdf.setFont(undefined, 'normal');
        const statusLines = pdf.splitTextToSize(report.status.summary, 176);
        if (y + statusLines.length * 5 > 285) { pdf.addPage(); y = 18; }
        pdf.text(statusLines, 16, y);
        pdf.save(`${filename}.pdf`);
        return true;
    }
    return false;
}

function showExportError(message) {
    const status = document.querySelector('[data-admin-chart-export-status]');
    if (status) status.textContent = message;
}

function manilaYearStartIso(year) {
    // Manila has UTC+08:00 with no daylight-saving transition.
    return new Date(Date.UTC(year, 0, 1) - 8 * 60 * 60 * 1000).toISOString();
}

function manilaYearEndIso(year) {
    return manilaYearStartIso(year + 1);
}

function manilaCalendarWeekStartIso(date = new Date()) {
    const parts = manilaParts(date);
    const todayUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
    const mondayUtc = todayUtc - ((new Date(todayUtc).getUTCDay() + 6) % 7) * 86400000;
    return new Date(mondayUtc - 8 * 60 * 60 * 1000).toISOString();
}

async function loadChartData() {
    const request = ++chartRequestId;
    if (!window.sb) { setChartDataState('error'); return false; }
    setChartDataState('loading');
    const year = manilaParts(new Date()).year;
    const decadeStart = Math.floor(year / 10) * 10;
    const decadeEnd = decadeStart + 10;
    const decadeStartIso = manilaYearStartIso(decadeStart);
    const decadeEndIso = manilaYearStartIso(decadeEnd);
    const weekStart = manilaCalendarWeekStartIso();
    const weekEnd = new Date(Date.parse(weekStart) + 7 * 86400000).toISOString();
    // Fetch ten calendar years in bounded annual segments, plus any adjacent
    // fragment needed to complete the current Manila calendar week. Exact,
    // abutting endpoints match the RPC's [from, to) filters.
    const segments = [];
    if (weekStart < decadeStartIso) segments.push([weekStart, decadeStartIso]);
    for (let segmentYear = decadeStart; segmentYear < decadeEnd; segmentYear++) {
        segments.push([manilaYearStartIso(segmentYear), manilaYearEndIso(segmentYear)]);
    }
    if (weekEnd > decadeEndIso) segments.push([decadeEndIso, weekEnd]);
    let results;
    try {
        results = await Promise.all(segments.map(([from, to]) => window.sb.rpc('admin_booking_overview', {
            p_from_at: from, p_to_at: to,
        })));
    } catch (error) {
        console.error('[admin-chart] failed to load reservations', error);
        if (request !== chartRequestId) return false;
        setChartDataState('error');
        return false;
    }
    if (request !== chartRequestId) return false;
    const failedResult = results.find(result => !result || result.error || !Array.isArray(result.data));
    if (failedResult) {
        console.error('[admin-chart] failed to load reservations', failedResult?.error);
        setChartDataState('error');
        return false;
    }
    const seenRows = new Set();
    const rows = results.flatMap(result => result.data).filter(row => {
        // The RPC returns source + id; use both so online and walk-in IDs do
        // not collide. The fallback keeps malformed duplicate rows harmless.
        const key = row?.source != null && row?.id != null
            ? `${row.source}:${row.id}`
            : JSON.stringify(row);
        if (seenRows.has(key)) return false;
        seenRows.add(key);
        return true;
    });
    if (request !== chartRequestId) return false;
    if (!Array.isArray(rows)) {
        console.error('[admin-chart] failed to load reservations');
        setChartDataState('error');
        return false;
    }
    aggregateBookingRows(rows);
    setChartDataState('ready');
    return true;
}

function getThemeColors() {
    const style = getComputedStyle(document.documentElement);
    return {
        ink: style.getPropertyValue('--color-ink').trim(),
        inkFaint: style.getPropertyValue('--color-ink-faint').trim(),
        line: style.getPropertyValue('--color-line').trim(),
        primary: style.getPropertyValue('--color-primary').trim(),
        primaryDim: style.getPropertyValue('--color-primary-dim').trim(),
        bgCard: style.getPropertyValue('--color-bg-card').trim(),
    };
}

function baseOptions(colors) {
    return {
        responsive: true, maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: { backgroundColor: colors.bgCard, borderColor: colors.line, borderWidth: 1, titleColor: colors.ink, bodyColor: colors.ink, padding: 10, cornerRadius: 8, caretSize: 4, displayColors: false },
        },
        scales: {
            x: { grid: { display: false }, border: { display: false }, ticks: { color: colors.inkFaint, font: { size: 11 }, maxRotation: 0, autoSkip: true } },
            y: { beginAtZero: true, border: { display: false }, grid: { color: colors.line, drawTicks: false }, ticks: { color: colors.inkFaint, font: { size: 11 }, precision: 0 } },
        },
    };
}

function renderChartMeta() {
    document.querySelectorAll('[data-admin-chart-range]').forEach(button => {
        const active = button.dataset.adminChartRange === currentChartRange;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    if (!chartDataAvailable) {
        const unit = document.querySelector('[data-admin-chart-unit]');
        if (unit && chartDataState === 'idle') unit.textContent = 'Booking data has not loaded.';
        return;
    }
    const source = CHART_DATA[currentChartRange];
    const unit = document.querySelector('[data-admin-chart-unit]');
    const total = document.querySelector('[data-admin-chart-total]');
    if (unit) unit.textContent = source.unit;
    if (total) total.textContent = source.total;
    const takeaway = document.querySelector('[data-admin-chart-takeaway]');
    const chartSummary = bookingTakeaway(source, currentChartRange);
    if (takeaway) takeaway.textContent = chartSummary;
    const canvas = document.getElementById('adminBookingChart');
    if (canvas) {
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', bookingChartAccessibleLabel(source, currentChartRange));
    }
    renderStatusReport(source);
    updateExportControls();
}

function setChartRange(range) {
    if (!CHART_DATA[range]) return;
    currentChartRange = range;
    renderChartMeta();
    if (!bookingChart) return;
    const source = CHART_DATA[range];
    bookingChart.data.labels = source.labels;
    bookingChart.data.datasets[0].data = source.values;
    bookingChart.update();
}

document.addEventListener('DOMContentLoaded', () => {
    if (typeof Chart === 'undefined') {
        console.warn('[admin-chart] Chart.js failed to load from the CDN.');
        setChartDataState('error');
        return;
    }
    setChartDataState('idle');
    const colors = getThemeColors();
    Chart.defaults.font.family = "'Inter', 'Segoe UI', sans-serif";
    Chart.defaults.color = colors.inkFaint;

    const bookingCanvas = document.getElementById('adminBookingChart');
    if (bookingCanvas) {
        const source = CHART_DATA[currentChartRange];
        bookingChart = new Chart(bookingCanvas, { type: 'bar', data: { labels: source.labels, datasets: [{ label: 'Bookings', data: source.values, backgroundColor: colors.primary, hoverBackgroundColor: colors.primaryDim, borderRadius: 6, maxBarThickness: 42 }] }, options: baseOptions(colors) });
    }
    renderChartMeta();
    document.querySelectorAll('[data-admin-chart-range]').forEach(button => button.addEventListener('click', () => setChartRange(button.dataset.adminChartRange)));
    const exportToggle = document.querySelector('[data-admin-chart-export-toggle]');
    const exportMenu = document.querySelector('[data-admin-chart-export-menu]');
    const closeExportMenu = ({ restoreFocus = false } = {}) => {
        if (!exportMenu || !exportToggle) return;
        exportMenu.hidden = true;
        exportToggle.setAttribute('aria-expanded', 'false');
        if (restoreFocus) exportToggle.focus();
    };
    if (exportToggle && exportMenu) {
        exportToggle.addEventListener('click', () => {
            const open = exportMenu.hidden;
            exportMenu.hidden = !open;
            exportToggle.setAttribute('aria-expanded', String(open));
            if (open) exportMenu.querySelector('[data-admin-chart-export]:not(:disabled)')?.focus();
        });
        exportMenu.addEventListener('click', event => {
            const choice = event.target.closest('[data-admin-chart-export]');
            if (!choice || choice.disabled) return;
            closeExportMenu({ restoreFocus: true });
            showExportError('');
            exportBookingReport(choice.dataset.adminChartExport);
        });
        exportMenu.addEventListener('keydown', event => {
            const choices = [...exportMenu.querySelectorAll('[data-admin-chart-export]:not(:disabled)')];
            const index = choices.indexOf(document.activeElement);
            let next = null;
            if (event.key === 'Escape') { event.preventDefault(); closeExportMenu({ restoreFocus: true }); }
            else if (event.key === 'ArrowDown') next = choices[(index + 1) % choices.length];
            else if (event.key === 'ArrowUp') next = choices[(index - 1 + choices.length) % choices.length];
            else if (event.key === 'Home') next = choices[0];
            else if (event.key === 'End') next = choices.at(-1);
            if (next) { event.preventDefault(); next.focus(); }
        });
        document.addEventListener('pointerdown', event => {
            if (!exportMenu.hidden && !event.target.closest('[data-admin-chart-export-wrap]')) closeExportMenu();
        });
        document.addEventListener('focusin', event => {
            if (!exportMenu.hidden && !event.target.closest('[data-admin-chart-export-wrap]')) closeExportMenu();
        });
    }

    function paintTheme() {
        const theme = getThemeColors();
        if (bookingChart) {
            bookingChart.data.datasets[0].backgroundColor = theme.primary;
            bookingChart.data.datasets[0].hoverBackgroundColor = theme.primaryDim;
            bookingChart.options.plugins.tooltip.backgroundColor = theme.bgCard;
            bookingChart.options.plugins.tooltip.borderColor = theme.line;
            bookingChart.options.plugins.tooltip.titleColor = theme.ink;
            bookingChart.options.plugins.tooltip.bodyColor = theme.ink;
            bookingChart.options.scales.x.ticks.color = theme.inkFaint;
            bookingChart.options.scales.y.grid.color = theme.line;
            bookingChart.options.scales.y.ticks.color = theme.inkFaint;
            bookingChart.update();
        }
    }
    document.addEventListener('themechange', paintTheme);

    async function refreshChartData() {
        if (await loadChartData()) setChartRange(currentChartRange);
    }
    document.addEventListener('inigosync:profile-ready', refreshChartData);
    if (window.inigosyncProfile) refreshChartData();
});
