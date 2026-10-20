// Use only the published rating, comment, and date; omit customer names.
document.addEventListener('DOMContentLoaded', () => {
    const grid = document.querySelector('[data-onsite-review-grid]');
    const status = document.querySelector('[data-onsite-reviews-status]');
    if (!grid || !status) return;

    const finish = (message) => {
        grid.setAttribute('aria-busy', 'false');
        status.textContent = message;
        status.hidden = !message;
    };

    const showPlaceholder = () => {
        const card = document.createElement('article');
        card.className = 'testimonial-card onsite-review-placeholder';

        const title = document.createElement('strong');
        title.textContent = 'No featured reviews yet';

        const description = document.createElement('p');
        description.className = 'testimonial-quote';
        description.textContent = 'Selected customer reviews will appear here after the owner chooses them.';

        card.append(title, description);
        grid.replaceChildren(card);
        finish('');
    };

    const makeReviewCard = (review) => {
        const card = document.createElement('article');
        card.className = 'testimonial-card';

        const header = document.createElement('div');
        header.className = 'onsite-review-head';

        const name = document.createElement('strong');
        name.textContent = 'Verified customer';

        const rating = Number(review.rating);
        const stars = document.createElement('span');
        stars.className = 'onsite-review-stars';
        stars.setAttribute('aria-label', `${rating} out of 5 stars`);
        stars.textContent = `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}`;
        header.append(name, stars);

        const quote = document.createElement('p');
        quote.className = 'testimonial-quote';
        quote.textContent = review.comment || 'No written comment.';
        card.append(header, quote);

        if (review.created_at) {
            const date = new Date(review.created_at);
            if (!Number.isNaN(date.getTime())) {
                const time = document.createElement('time');
                time.className = 'onsite-review-date';
                time.dateTime = date.toISOString();
                time.textContent = date.toLocaleDateString();
                card.append(time);
            }
        }
        return card;
    };

    (async () => {
        try {
            if (!window.sb) throw new Error('Database client unavailable');
            const { data, error } = await window.sb.from('public_featured_booking_reviews')
                .select('rating,comment,created_at,display_order')
                .order('display_order', { ascending: true });
            if (error) throw error;

            const reviews = (data || []).filter((review) => {
                const rating = Number(review.rating);
                return Number.isInteger(rating) && rating >= 1 && rating <= 5;
            });
            if (!reviews.length) {
                showPlaceholder();
                return;
            }

            grid.replaceChildren(...reviews.map(makeReviewCard));
            finish('');
        } catch (error) {
            console.error('[landing] public reviews could not be loaded', error);
            finish('Customer reviews are temporarily unavailable.');
        }
    })();
});
