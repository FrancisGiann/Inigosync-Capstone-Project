// Owner dashboard booking trends chart. Calendar buckets use the
// business timezone, Asia/Manila, regardless of the owner's device timezone.

let bookingChart = null;
let currentChartRange = 'week';
let CHART_DATA = {
    week: { labels: [], values: [], total: 0, unit: 'bookings per day · this calendar week' },
    month: { labels: [], values: [], total: 0, unit: 'bookings per day · this month' },
    year: { labels: [], values: [], total: 0, unit: 'bookings per month · this year' },
};

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
    const weekValues = weekKeys.map((key, index) => {
        const bucket = week[index];
        const isFuture = Date.UTC(bucket.year, bucket.month - 1, bucket.day) > todayUtc;
        return isFuture ? 0 : rows.filter(row => rowManilaDate(row) === key).length;
    });
    const monthValues = monthKeys.map((key, index) => index + 1 > today.day ? 0 : rows.filter(row => rowManilaDate(row) === key).length);
    const yearValues = Array.from({ length: 12 }, (_, i) => i > today.month - 1 ? 0 : rows.filter(row => {
        const parsed = new Date(row.time_date);
        if (Number.isNaN(parsed.getTime())) return false;
        const parts = manilaParts(parsed);
        return parts.year === today.year && parts.month === i + 1;
    }).length);
    const total = values => values.reduce((sum, value) => sum + value, 0);
    CHART_DATA = {
        week: { labels: weekLabels, values: weekValues, total: total(weekValues), unit: rangeCaption('week') },
        month: { labels: monthLabels, values: monthValues, total: total(monthValues), unit: rangeCaption('month') },
        year: { labels: yearLabels, values: yearValues, total: total(yearValues), unit: rangeCaption('year') },
    };
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
    if (!window.sb) return;
    const year = manilaParts(new Date()).year;
    const yearStart = manilaYearStartIso(year);
    const weekStart = manilaCalendarWeekStartIso();
    const yearEnd = manilaYearStartIso(year + 1);
    let rows;
    if (weekStart < yearStart) {
        // Keep each call within admin_booking_overview's 366-day limit:
        // fetch only the prior-year fragment plus the current calendar year.
        const [priorWeek, currentYear] = await Promise.all([
            window.sb.rpc('admin_booking_overview', { p_from_at: weekStart, p_to_at: yearStart }),
            window.sb.rpc('admin_booking_overview', { p_from_at: yearStart, p_to_at: yearEnd }),
        ]);
        if (priorWeek.error || currentYear.error || !priorWeek.data || !currentYear.data) {
            console.error('[admin-chart] failed to load reservations', priorWeek.error || currentYear.error);
            return;
        }
        rows = [...priorWeek.data, ...currentYear.data];
    } else {
        const { data, error } = await window.sb.rpc('admin_booking_overview', {
            p_from_at: yearStart, p_to_at: yearEnd,
        });
        if (error || !data) {
            console.error('[admin-chart] failed to load reservations', error);
            return;
        }
        rows = data;
    }
    if (!rows) {
        console.error('[admin-chart] failed to load reservations');
        return;
    }
    aggregateBookingRows(rows);
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
    const source = CHART_DATA[currentChartRange];
    const unit = document.querySelector('[data-admin-chart-unit]');
    const total = document.querySelector('[data-admin-chart-total]');
    if (unit) unit.textContent = source.unit;
    if (total) total.textContent = source.total;
    document.querySelectorAll('[data-admin-chart-range]').forEach(button => button.classList.toggle('is-active', button.dataset.adminChartRange === currentChartRange));
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
        return;
    }
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
        await loadChartData();
        setChartRange(currentChartRange);
    }
    document.addEventListener('inigosync:profile-ready', refreshChartData);
    if (window.inigosyncProfile) refreshChartData();
});
