// Pure helpers for the customer dashboard's Upcoming reservations preview.
// Ownership is enforced by the caller's customer_id-filtered Supabase query;
// these helpers only select future, active booking rows and page them.
(function attachDashboardUpcoming(window) {
    function selectUpcomingReservations(bookings, now = Date.now()) {
        return (bookings || [])
            .filter((booking) => ['pending', 'confirmed'].includes(String(booking.status || '').toLowerCase())
                && Number.isFinite(new Date(booking.time_date).getTime())
                && new Date(booking.time_date).getTime() > now)
            .sort((a, b) => new Date(a.time_date).getTime() - new Date(b.time_date).getTime());
    }

    function nextVisibleCount(current, total, increment = 5) {
        return Math.min(current + increment, total);
    }

    window.InigoDashboardUpcoming = Object.freeze({ selectUpcomingReservations, nextVisibleCount });
})(window);
