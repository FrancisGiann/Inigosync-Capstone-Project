// Owner dashboard booking trends chart. Calendar buckets use the
// business timezone, Asia/Manila, regardless of the owner's device timezone.

let bookingChart = null;
let currentChartRange = 'week';
let chartDataAvailable = false;
let chartDataState = 'idle';
let CHART_DATA = {
    week: { labels: [], periods: [], values: [], total: 0, unit: 'bookings per day · this calendar week' },
    month: { labels: [], periods: [], values: [], total: 0, unit: 'bookings per day · this month' },
    year: { labels: [], periods: [], values: [], total: 0, unit: 'bookings per month · this year' },
};
const chartRangeNames = { week: 'Weekly', month: 'Monthly', year: 'Yearly' };

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
    month: 'bookings per day · this month',
    year: 'bookings per month · this year',
})[range];

function aggregateBookingRows(rows) {
    const today = manilaParts(new Date());
    const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
    const mondayUtc = todayUtc - ((new Date(todayUtc).getUTCDay() + 6) % 7) * 86400000;
    const week = Array.from({ length: 7 }, (_, i) => new Date(mondayUtc + i * 86400000))
        .map(d => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }));
    const monthDays = new Date(Date.UTC(today.year, today.month, 0)).getUTCDate();
    const month = Array.from({ length: monthDays }, (_, i) => ({ year: today.year, month: today.month, day: i + 1 }));
    const weekLabels = week.map(d => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(new Date(Date.UTC(d.year, d.month - 1, d.day))));
    const monthLabels = month.map(d => String(d.day));
    const yearLabels = Array.from({ length: 12 }, (_, i) => new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(today.year, i, 1))));
    const weekKeys = week.map(d => dateKey(d.year, d.month, d.day));
    const monthKeys = month.map(d => dateKey(d.year, d.month, d.day));
    const dateFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
    const monthFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long' });
    const weekPeriods = week.map(d => dateFormatter.format(new Date(Date.UTC(d.year, d.month - 1, d.day))));
    const monthPeriods = month.map(d => dateFormatter.format(new Date(Date.UTC(d.year, d.month - 1, d.day))));
    const yearPeriods = Array.from({ length: 12 }, (_, i) => monthFormatter.format(new Date(Date.UTC(today.year, i, 1))));
    const weekFuture = week.map(d => Date.UTC(d.year, d.month - 1, d.day) > todayUtc);
    const monthFuture = month.map(d => d.day > today.day);
    const yearFuture = Array.from({ length: 12 }, (_, i) => i > today.month - 1);
    const weekValues = weekKeys.map((key, index) => {
        return weekFuture[index] ? 0 : rows.filter(row => rowManilaDate(row) === key).length;
    });
    const monthValues = monthKeys.map((key, index) => monthFuture[index] ? 0 : rows.filter(row => rowManilaDate(row) === key).length);
    const yearValues = Array.from({ length: 12 }, (_, i) => yearFuture[i] ? 0 : rows.filter(row => {
        const parsed = new Date(row.time_date);
        if (Number.isNaN(parsed.getTime())) return false;
        const parts = manilaParts(parsed);
        return parts.year === today.year && parts.month === i + 1;
    }).length);
    const total = values => values.reduce((sum, value) => sum + value, 0);
    CHART_DATA = {
        week: { labels: weekLabels, periods: weekPeriods, future: weekFuture, values: weekValues, total: total(weekValues), unit: rangeCaption('week') },
        month: { labels: monthLabels, periods: monthPeriods, future: monthFuture, values: monthValues, total: total(monthValues), unit: rangeCaption('month') },
        year: { labels: yearLabels, periods: yearPeriods, future: yearFuture, values: yearValues, total: total(yearValues), unit: rangeCaption('year') },
    };
}

function buildBookingReport(range, now = new Date()) {
    const source = CHART_DATA[range];
    if (!chartDataAvailable || !source || !source.periods.length || source.periods.length !== source.values.length) return null;
    const today = manilaParts(now);
    let periodLabel;
    if (range === 'week') {
        periodLabel = `${source.periods[0]} – ${source.periods[6]}`;
    } else if (range === 'month') {
        periodLabel = `${source.periods[0]} – ${source.periods[source.periods.length - 1]}`;
    } else {
        const currentMonth = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' }).format(new Date(Date.UTC(today.year, today.month - 1, 1)));
        periodLabel = `January ${today.year} – ${currentMonth} ${today.year}`;
    }
    return {
        title: 'Booking Trends Report',
        rangeName: chartRangeNames[range],
        periodLabel,
        asOfDate: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' })
            .format(new Date(Date.UTC(today.year, today.month - 1, today.day))),
        total: source.total,
        rows: source.periods.map((period, index) => ({
            period: `${period}${source.future[index] ? ' (future)' : ''}`,
            bookings: source.values[index],
        })),
    };
}

function setChartDataState(state) {
    chartDataState = state;
    chartDataAvailable = state === 'ready';
    const exportButtons = typeof document !== 'undefined' ? document.querySelectorAll?.('[data-admin-chart-export]') : null;
    exportButtons?.forEach(button => { button.disabled = !chartDataAvailable; });
    const unit = typeof document !== 'undefined' ? document.querySelector?.('[data-admin-chart-unit]') : null;
    const total = typeof document !== 'undefined' ? document.querySelector?.('[data-admin-chart-total]') : null;
    if (!chartDataAvailable) {
        if (unit) unit.textContent = state === 'loading' ? 'Loading booking data…' : state === 'error' ? 'Booking data is unavailable right now.' : 'Booking data has not loaded.';
        if (total) total.textContent = '—';
        if (bookingChart) {
            bookingChart.data.labels = [];
            bookingChart.data.datasets[0].data = [];
            bookingChart.update();
        }
    }
}

function exportBookingReport(format) {
    try {
        return performBookingReportExport(format);
    } catch (error) {
        console.error('[admin-chart] failed to export booking report', error);
        showExportError(`${format === 'xlsx' ? 'Excel' : 'PDF'} export failed. Please try again.`);
        return false;
    }
}

function performBookingReportExport(format) {
    if (!chartDataAvailable) return false;
    const report = buildBookingReport(currentChartRange);
    if (!report) return false;
    const today = manilaParts(new Date());
    const filename = `booking-trends-${currentChartRange}-${dateKey(today.year, today.month, today.day)}`;
    if (format === 'xlsx') {
        if (!window.XLSX?.utils || typeof window.XLSX.writeFile !== 'function') {
            showExportError('Excel export is unavailable because its report library did not load.');
            return false;
        }
        const sheet = window.XLSX.utils.aoa_to_sheet([
            [report.title], ['Range', report.rangeName], ['Period', report.periodLabel], ['As of (Manila)', report.asOfDate], [],
            ['Period', 'Bookings'], ...report.rows.map(row => [row.period, row.bookings]),
            [], ['Total bookings', report.total],
        ]);
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
        pdf.text(`As of ${report.asOfDate} (Asia/Manila)`, 16, 31);
        pdf.setFontSize(10); pdf.setFont(undefined, 'bold');
        pdf.text('Period', 16, 41); pdf.text('Bookings', 170, 41, { align: 'right' });
        pdf.setFont(undefined, 'normal');
        let y = 48;
        report.rows.forEach(row => {
            if (y > 275) { pdf.addPage(); y = 18; }
            pdf.text(row.period, 16, y); pdf.text(String(row.bookings), 170, y, { align: 'right' });
            y += 7;
        });
        if (y > 275) { pdf.addPage(); y = 18; }
        pdf.setFont(undefined, 'bold');
        pdf.text(`Total bookings: ${report.total}`, 16, y + 3);
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

function manilaCalendarWeekStartIso(date = new Date()) {
    const parts = manilaParts(date);
    const todayUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
    const mondayUtc = todayUtc - ((new Date(todayUtc).getUTCDay() + 6) % 7) * 86400000;
    return new Date(mondayUtc - 8 * 60 * 60 * 1000).toISOString();
}

async function loadChartData() {
    if (!window.sb) { setChartDataState('error'); return false; }
    setChartDataState('loading');
    const year = manilaParts(new Date()).year;
    const yearStart = manilaYearStartIso(year);
    const weekStart = manilaCalendarWeekStartIso();
    const yearEnd = manilaYearStartIso(year + 1);
    let rows;
    if (weekStart < yearStart) {
        // Keep each call within admin_booking_overview's 366-day limit:
        // fetch only the prior-year fragment plus the current calendar year.
        let priorWeek; let currentYear;
        try {
            [priorWeek, currentYear] = await Promise.all([
                window.sb.rpc('admin_booking_overview', { p_from_at: weekStart, p_to_at: yearStart }),
                window.sb.rpc('admin_booking_overview', { p_from_at: yearStart, p_to_at: yearEnd }),
            ]);
        } catch (error) {
            console.error('[admin-chart] failed to load reservations', error);
            setChartDataState('error');
            return false;
        }
        if (!priorWeek || !currentYear || priorWeek.error || currentYear.error || !Array.isArray(priorWeek.data) || !Array.isArray(currentYear.data)) {
            console.error('[admin-chart] failed to load reservations', priorWeek?.error || currentYear?.error);
            setChartDataState('error');
            return false;
        }
        rows = [...priorWeek.data, ...currentYear.data];
    } else {
        let data; let error;
        try {
            ({ data, error } = await window.sb.rpc('admin_booking_overview', {
                p_from_at: yearStart, p_to_at: yearEnd,
            }));
        } catch (failure) {
            console.error('[admin-chart] failed to load reservations', failure);
            setChartDataState('error');
            return false;
        }
        if (error || !Array.isArray(data)) {
            console.error('[admin-chart] failed to load reservations', error);
            setChartDataState('error');
            return false;
        }
        rows = data;
    }
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
            tooltip: { backgroundColor: colors.bgCard, borderColor: colors.line, borderWidth: 1, titleColor: colors.ink, bodyColor: colors.ink, padding: 10, displayColors: false },
        },
        scales: {
            x: { grid: { display: false }, ticks: { color: colors.inkFaint, font: { size: 11 }, maxRotation: 0, autoSkip: true } },
            y: { beginAtZero: true, grid: { color: colors.line }, ticks: { color: colors.inkFaint, font: { size: 11 }, precision: 0 } },
        },
    };
}

function renderChartMeta() {
    if (!chartDataAvailable) {
        const unit = document.querySelector('[data-admin-chart-unit]');
        if (unit && chartDataState === 'idle') unit.textContent = 'Booking data has not loaded.';
        document.querySelectorAll('[data-admin-chart-range]').forEach(button => button.classList.toggle('is-active', button.dataset.adminChartRange === currentChartRange));
        return;
    }
    const source = CHART_DATA[currentChartRange];
    const unit = document.querySelector('[data-admin-chart-unit]');
    const total = document.querySelector('[data-admin-chart-total]');
    if (unit) unit.textContent = source.unit;
    if (total) total.textContent = source.total;
    document.querySelectorAll('[data-admin-chart-range]').forEach(button => button.classList.toggle('is-active', button.dataset.adminChartRange === currentChartRange));
    document.querySelectorAll('[data-admin-chart-export]').forEach(button => button.disabled = !chartDataAvailable);
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
    document.querySelectorAll('[data-admin-chart-export]').forEach(button => button.addEventListener('click', () => exportBookingReport(button.dataset.adminChartExport)));

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
