import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dashboard = await readFile(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../Pages/user_dashboard.html', import.meta.url), 'utf8');

test('availability photo caption uses the selected unit rate and preserves unit context', () => {
    const availability = dashboard.slice(dashboard.indexOf('async function refreshOverviewAvailability()'), dashboard.indexOf('function renderOverviewAvailabilityUnits('));

    assert.match(availability, /const selectedUnit = selectedEntry\?\.unit/);
    assert.match(availability, /const dayRate = selectedUnit\?\.rateDay/);
    assert.match(availability, /const nightRate = selectedUnit\?\.rateNight/);
    assert.match(availability, /Rate to be confirmed/);
    assert.match(availability, /Number\.isFinite\(value\) && value >= 0/);
    assert.match(availability, /window\.escapeHtml\(rateCaption\)/);
    assert.match(availability, /alt="\$\{window\.escapeHtml\(selectedUnit\?\.label \|\| court\.name\)\}"/);
    assert.match(dashboard, /availabilityUnitSelect\?\.addEventListener\('change', refreshOverviewAvailability\)/);
    assert.match(html, /<label[^>]*for="dashAvailabilityUnit">Court number<\/label>[\s\S]*?<select[^>]*data-dash-availability-unit/);
});
