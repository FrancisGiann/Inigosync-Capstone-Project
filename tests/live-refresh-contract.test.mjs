import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const staff = await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8');
const customer = await readFile(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
const owner = await readFile(new URL('../includes/owner_dashboard.js', import.meta.url), 'utf8');

test('staff transaction records refresh on panel entry and poll only while visible', () => {
    assert.match(staff, /if \(name === 'transactions'\) refreshTransactions\(\)/);
    assert.match(staff, /function isTransactionsPanelVisible\(\)[\s\S]*?visibilityState === 'visible'[\s\S]*?data-staff-panel="transactions"/);
    assert.match(staff, /window\.setInterval\(\(\) => \{\s*if \(isTransactionsPanelVisible\(\)\) refreshTransactions\(\);\s*\}, 15000\)/);
    assert.match(staff, /if \(isOverviewVisible\(\)\) \{[\s\S]*?refreshBookingOverview\(\);[\s\S]*?\}, 15000\)/);
    assert.match(staff, /let transactionRefreshGeneration = 0/);
    assert.match(staff, /let transactionRefreshInFlight = false/);
    assert.match(staff, /let transactionRefreshPending = false/);
});

test('customer bookings and receipts refresh on entry and poll only while either panel is active', () => {
    assert.match(customer, /function isCustomerBookingsPanelVisible\(\)[\s\S]*?data-dash-panel="bookings"[\s\S]*?data-dash-panel="receipts"/);
    assert.match(customer, /if \(name === 'bookings' \|\| name === 'receipts'\) \{\s*refreshMyBookings/);
    assert.match(customer, /window\.setInterval\(\(\) => \{\s*if \(isCustomerBookingsPanelVisible\(\)\) refreshMyBookings\(\);\s*\}, 30000\)/);
    assert.match(customer, /let bookingFetchGeneration = 0/);
});

test('owner booking and income summaries refresh on visible overview and protect summary requests', () => {
    assert.match(owner, /function isOwnerOverviewVisible\(\)[\s\S]*?data-admin-panel="overview"/);
    assert.match(owner, /window\.setInterval\(refreshVisibleOwnerOverview, 30000\)/);
    assert.match(owner, /refreshOverviewStats\(\);\s*refreshOwnerIncome\(\);/);
    assert.match(owner, /let adminStatsRequest = 0/);
});
