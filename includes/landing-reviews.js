// The landing page reads public reviews with only a first name and last initial for attribution.
document.addEventListener('DOMContentLoaded', () => {
    const grid = document.querySelector('[data-onsite-review-grid]');
    const status = document.querySelector('[data-onsite-reviews-status]');
    const allButton = document.querySelector('[data-review-all]');
    const ratingButtons = [...document.querySelectorAll('[data-review-rating]')];
    const previous = document.querySelector('[data-review-previous]');
    const next = document.querySelector('[data-review-next]');
    if (!grid || !status) return;

    const PAGE_SIZE = 12;
    const visibleCount = () => window.matchMedia('(max-width: 700px)').matches
        ? 1 : window.matchMedia('(max-width: 900px)').matches ? 2 : 3;
    let selectedRating = null;
    let featuredReviews = [];
    let reviews = [];
    let position = 0;
    let offset = 0;
    let hasMore = false;
    let browsing = false;
    let loading = false;
    let requestId = 0;

    const reviewDialog = document.createElement('dialog');
    reviewDialog.className = 'onsite-review-dialog';
    reviewDialog.setAttribute('aria-labelledby', 'onsite-review-dialog-title');
    const dialogContent = document.createElement('div');
    dialogContent.className = 'onsite-review-dialog-content';
    const dialogTitle = document.createElement('h2');
    dialogTitle.id = 'onsite-review-dialog-title';
    dialogTitle.textContent = 'Customer review';
    const dialogHeader = document.createElement('div');
    dialogHeader.className = 'onsite-review-dialog-header';
    const dialogRating = document.createElement('p');
    dialogRating.className = 'onsite-review-dialog-rating';
    const dialogQuote = document.createElement('p');
    dialogQuote.className = 'onsite-review-dialog-quote';
    const dialogClose = document.createElement('button');
    dialogClose.className = 'onsite-review-dialog-close';
    dialogClose.type = 'button';
    dialogClose.textContent = '×';
    dialogClose.setAttribute('aria-label', 'Close full review');
    dialogClose.title = 'Close';
    dialogClose.autofocus = true;
    dialogClose.addEventListener('click', () => reviewDialog.close());
    dialogHeader.append(dialogTitle, dialogClose);
    dialogContent.append(dialogHeader, dialogRating, dialogQuote);
    reviewDialog.append(dialogContent);
    document.body.append(reviewDialog);

    const setStatus = (message) => {
        status.textContent = message;
        status.hidden = !message;
    };
    const validReviews = (rows) => (rows || []).filter((review) => {
        if (!review || typeof review !== 'object') return false;
        const rating = Number(review.rating);
        return Number.isInteger(rating) && rating >= 1 && rating <= 5;
    });
    const reviewKey = (review) => `${Number(review.rating)}\u0000${review.comment || ''}\u0000${review.created_at || ''}`;
    const makePlaceholder = (titleText, descriptionText) => {
        const card = document.createElement('article');
        card.className = 'testimonial-card onsite-review-placeholder';
        const title = document.createElement('strong');
        title.textContent = titleText;
        const description = document.createElement('p');
        description.className = 'testimonial-quote';
        description.textContent = descriptionText;
        card.append(title, description);
        return card;
    };
    const makeReviewCard = (review) => {
        const card = document.createElement('article');
        card.className = 'testimonial-card';
        const sourceLabel = document.createElement('strong');
        sourceLabel.textContent = review.display_name || 'Customer';
        const rating = Number(review.rating);
        const stars = document.createElement('span');
        stars.className = 'onsite-review-stars';
        stars.setAttribute('aria-label', `${rating} out of 5 stars`);
        stars.textContent = `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}`;
        const quoteMark = document.createElement('span');
        quoteMark.className = 'onsite-review-quote-mark';
        quoteMark.setAttribute('aria-hidden', 'true');
        quoteMark.textContent = '“';
        const quote = document.createElement('p');
        quote.className = 'testimonial-quote';
        quote.textContent = typeof review.comment === 'string' && review.comment.trim() ? review.comment : 'No written comment.';
        const readMore = document.createElement('button');
        readMore.className = 'onsite-review-read-more';
        readMore.type = 'button';
        readMore.textContent = 'Read more';
        readMore.hidden = true;
        readMore.setAttribute('aria-haspopup', 'dialog');
        readMore.addEventListener('click', () => {
            dialogTitle.textContent = review.display_name || 'Customer';
            dialogRating.textContent = `${rating} out of 5 stars`;
            dialogQuote.textContent = quote.textContent;
            reviewDialog.showModal();
        });
        card.append(quoteMark, quote, readMore);
        const footer = document.createElement('div');
        footer.className = 'onsite-review-footer';
        footer.append(sourceLabel, stars);
        if (review.created_at) {
            const date = new Date(review.created_at);
            if (!Number.isNaN(date.getTime())) {
                const time = document.createElement('time');
                time.className = 'onsite-review-date';
                time.dateTime = date.toISOString();
                time.textContent = date.toLocaleDateString();
                footer.append(time);
            }
        }
        card.append(footer);
        window.requestAnimationFrame(() => {
            readMore.hidden = quote.scrollHeight <= quote.clientHeight + 1;
        });
        return card;
    };
    const updateNavigation = () => {
        const count = visibleCount();
        const atEnd = !hasMore && position + count >= reviews.length;
        if (previous) previous.disabled = loading || (position === 0 && (!browsing || Boolean(selectedRating)));
        if (next) next.disabled = loading || (browsing && atEnd);
        allButton?.classList.toggle('is-active', selectedRating === null);
        allButton?.setAttribute('aria-pressed', String(selectedRating === null));
        ratingButtons.forEach((button) => {
            const active = Number(button.dataset.reviewRating) === selectedRating;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    };
    const renderReviews = () => {
        const visible = reviews.slice(position, position + visibleCount());
        if (!visible.length) {
            const title = browsing ? 'No reviews found' : 'No featured reviews yet';
            const description = selectedRating
                ? `There are no public ${selectedRating}-star reviews yet.`
                : browsing
                    ? featuredReviews.length ? 'There are no additional public reviews beyond the featured picks.' : 'There are no public customer reviews yet.'
                    : 'There are no owner-selected reviews to show right now. Use the star ratings above to browse customer reviews.';
            grid.replaceChildren(makePlaceholder(title, description));
        } else {
            grid.replaceChildren(...visible.map(makeReviewCard));
        }
        updateNavigation();
    };
    const loadFeatured = async () => {
        const currentRequest = ++requestId;
        loading = true;
        grid.setAttribute('aria-busy', 'true');
        updateNavigation();
        setStatus('');
        try {
            if (!window.sb) throw new Error('Database client unavailable');
            const { data, error } = await window.sb.from('public_featured_customer_reviews')
                .select('rating,comment,is_sample,created_at,display_order,display_name')
                .order('display_order', { ascending: true });
            if (error) throw error;
            if (currentRequest !== requestId) return;
            featuredReviews = validReviews(data).slice(0, 3);
            reviews = featuredReviews;
            browsing = false;
            position = 0;
            hasMore = false;
            setStatus('');
            renderReviews();
        } catch (error) {
            if (currentRequest !== requestId) return;
            console.error('[landing] featured public reviews could not be loaded', error);
            featuredReviews = [];
            reviews = [];
            browsing = false;
            grid.replaceChildren();
            setStatus('Featured reviews are temporarily unavailable. Please try again later.');
        } finally {
            if (currentRequest === requestId) {
                loading = false;
                grid.setAttribute('aria-busy', 'false');
                updateNavigation();
            }
        }
    };
    const loadReviewPage = async (reset) => {
        if (loading && !reset) return;
        const currentRequest = ++requestId;
        if (reset) {
            reviews = [];
            position = 0;
            offset = 0;
            hasMore = true;
        }
        loading = true;
        browsing = true;
        grid.setAttribute('aria-busy', 'true');
        updateNavigation();
        setStatus('');
        window.InigoLoading?.show('Loading reviews…');
        try {
            if (!window.sb) throw new Error('Database client unavailable');
            let query = window.sb.from('public_customer_reviews').select('rating,comment,is_sample,created_at,display_name')
                .order('created_at', { ascending: false });
            if (selectedRating) query = query.eq('rating', selectedRating);
            const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1);
            if (error) throw error;
            if (currentRequest !== requestId) return;
            let incoming = validReviews(data);
            if (!selectedRating) {
                const featuredKeys = new Set(featuredReviews.map(reviewKey));
                incoming = incoming.filter(review => !featuredKeys.has(reviewKey(review)));
            }
            reviews.push(...incoming);
            offset += (data || []).length;
            hasMore = Boolean(data && data.length === PAGE_SIZE);
            if (position >= reviews.length && reviews.length) position = reviews.length - 1;
            setStatus('');
            renderReviews();
        } catch (error) {
            if (currentRequest !== requestId) return;
            console.error('[landing] public reviews could not be loaded', error);
            hasMore = false;
            setStatus('Reviews are temporarily unavailable. Please try again.');
            if (!reviews.length) renderReviews();
        } finally {
            if (currentRequest === requestId) {
                loading = false;
                grid.setAttribute('aria-busy', 'false');
                updateNavigation();
                window.InigoLoading?.hide();
            }
        }
    };
    const browse = async (rating = null) => {
        selectedRating = rating;
        browsing = true;
        await loadReviewPage(true);
    };
    const restoreFeatured = () => {
        ++requestId;
        selectedRating = null;
        browsing = false;
        reviews = featuredReviews;
        position = 0;
        offset = 0;
        hasMore = false;
        loading = false;
        setStatus('');
        window.InigoLoading?.hide();
        grid.setAttribute('aria-busy', 'false');
        renderReviews();
    };

    ratingButtons.forEach((button) => {
        const rating = Number(button.dataset.reviewRating);
        for (let index = 1; index <= 5; index += 1) {
            const star = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            star.setAttribute('viewBox', '0 0 20 20');
            star.setAttribute('aria-hidden', 'true');
            star.classList.add(index <= rating ? 'is-filled' : 'is-empty');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M10 1.6l2.55 5.17 5.7.83-4.12 4.02.97 5.68L10 14.62l-5.1 2.68.97-5.68L1.75 7.6l5.7-.83L10 1.6z');
            star.append(path);
            button.append(star);
        }
        button.addEventListener('click', () => {
            const rating = Number(button.dataset.reviewRating);
            if (selectedRating === rating) restoreFeatured();
            else browse(rating);
        });
    });
    allButton?.addEventListener('click', restoreFeatured);
    previous?.addEventListener('click', () => {
        if (loading) return;
        if (position > 0) {
            position -= 1;
            renderReviews();
        } else if (browsing && !selectedRating) restoreFeatured();
    });
    next?.addEventListener('click', async () => {
        if (loading) return;
        if (!browsing) {
            const count = visibleCount();
            if (position + count < featuredReviews.length) {
                position += 1;
                renderReviews();
                return;
            }
            await loadReviewPage(true);
            return;
        }
        const count = visibleCount();
        if (position + count < reviews.length) {
            position += 1;
            renderReviews();
        } else if (hasMore) {
            position = Math.max(0, reviews.length - count + 1);
            await loadReviewPage(false);
        }
    });
    window.addEventListener('resize', renderReviews, { passive: true });
    loadFeatured();
});
