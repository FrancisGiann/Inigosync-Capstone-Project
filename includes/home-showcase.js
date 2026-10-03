// Live event carousel. Published Supabase rows remain the source of truth.
document.addEventListener('DOMContentLoaded', () => {
    const featured = document.querySelector('[data-home-showcase]');
    if (!featured || !window.InigoContent) return;
    const media = featured.querySelector('[data-home-media]');
    const copy = featured.querySelector('[data-home-copy-stack]');
    const dots = featured.querySelector('[data-home-dots]');
    const pause = featured.querySelector('[data-home-pause]');
    const previous = featured.querySelector('[data-home-prev]');
    const next = featured.querySelector('[data-home-next]');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const hover = matchMedia('(hover: hover)');
    const { escapeHtml, formatEventMeta } = window.InigoContent;
    let rows = [], index = 0, timer = null, paused = false, refreshId = 0;
    let animationTimer = null, finishAnimation = null, queuedShow = [];
    let touch = null;
    function stop() { clearInterval(timer); timer = null; }
    function sync() {
        const stopped = paused || reduced.matches;
        pause.hidden = rows.length < 2;
        previous.hidden = next.hidden = rows.length < 2;
        pause.disabled = reduced.matches;
        pause.textContent = stopped ? 'Play' : 'Pause';
        pause.setAttribute('aria-label', stopped ? 'Play slideshow' : 'Pause slideshow');
        pause.setAttribute('aria-pressed', String(stopped));
        copy.setAttribute('aria-live', stopped || rows.length < 2 ? 'polite' : 'off');
    }
    function start() {
        stop();
        if (paused || reduced.matches || document.hidden || rows.length < 2 || featured.contains(document.activeElement) || (hover.matches && featured.matches(':hover'))) return;
        timer = setInterval(() => show(index + 1, 1), 5000);
    }
    function playQueuedShow() {
        if (animationTimer || !queuedShow.length) return;
        const queued = queuedShow.shift();
        show(queued.direction ? index + queued.direction : queued.next, queued.direction);
    }
    function resetAnimation(discardQueue = true) {
        clearTimeout(animationTimer);
        animationTimer = null;
        finishAnimation = null;
        if (discardQueue) queuedShow = [];
        if (rows.length) paintGallery();
        while (!discardQueue && queuedShow.length) {
            const queued = queuedShow.shift();
            show(queued.direction ? index + queued.direction : queued.next, queued.direction);
        }
    }
    function show(next, direction = 0) {
        if (!rows.length) return;
        next = (next + rows.length) % rows.length;
        if (animationTimer) {
            if (direction) queuedShow.push({ direction });
            else queuedShow = [{ next, direction: 0 }];
            return;
        }
        const changed = next !== index;
        let animating = false;
        if (direction && !reduced.matches && !document.hidden && rows.length > 1 && changed) animating = animateGallery(next, direction);
        index = next;
        if (!animating && (changed || !media.querySelector('.featured-frame-center'))) paintGallery();
        copy.querySelectorAll('[data-home-slide]').forEach(el => {
            const active = Number(el.dataset.homeSlide) === index;
            el.classList.toggle('is-active', active);
            el.setAttribute('aria-hidden', String(!active));
        });
        dots.querySelectorAll('button').forEach((el, i) => {
            el.classList.toggle('is-active', i === index);
            el.setAttribute('aria-current', String(i === index));
        });
        start();
    }
    function placeholder(i, position, note = 'Photo placeholder') {
        return '<div class="featured-frame featured-frame-' + position + ' is-placeholder" data-home-slide="' + i + '" data-home-position="' + position + '" aria-hidden="true"><span class="hero-photo-placeholder">Original venue photo<small>' + note + '</small></span></div>';
    }
    function frameMarkup(row, i, position) {
        const src = window.InigoVisuals.venuePhoto(row.imageUrl);
        if (!src) return placeholder(i, position);
        return '<div class="featured-frame featured-frame-' + position + '" data-home-slide="' + i + '" data-home-position="' + position + '" aria-hidden="' + (position !== 'center') + '"><img class="featured-frame-img" src="' + escapeHtml(src) + '" alt="' + escapeHtml(row.title) + '" loading="lazy"></div>';
    }
    function paintGallery() {
        if (!rows.length) return;
        if (rows.length === 1) media.innerHTML = frameMarkup(rows[index], index, 'center');
        else media.innerHTML = [
            frameMarkup(rows[(index - 1 + rows.length) % rows.length], (index - 1 + rows.length) % rows.length, 'previous'),
            frameMarkup(rows[index], index, 'center'),
            frameMarkup(rows[(index + 1) % rows.length], (index + 1) % rows.length, 'next')
        ].join('');
    }
    function animateGallery(nextIndex, direction) {
        const oldPrevious = media.querySelector('.featured-frame-previous');
        const center = media.querySelector('.featured-frame-center');
        const incoming = media.querySelector(direction > 0 ? '.featured-frame-next' : '.featured-frame-previous');
        const oldNext = media.querySelector('.featured-frame-next');
        if (!center || !incoming || !oldPrevious || !oldNext) return false;

        const exiting = direction > 0 ? oldPrevious : oldNext;
        exiting.classList.add(direction > 0 ? 'featured-frame-exit-left' : 'featured-frame-exit-right');
        exiting.setAttribute('aria-hidden', 'true');
        center.classList.remove('featured-frame-center');
        center.classList.add(direction > 0 ? 'featured-frame-previous' : 'featured-frame-next');
        incoming.classList.remove(direction > 0 ? 'featured-frame-next' : 'featured-frame-previous');
        incoming.classList.add('featured-frame-center');
        incoming.setAttribute('aria-hidden', 'false');

        const sidePosition = direction > 0 ? 'next' : 'previous';
        const sideIndex = direction > 0
            ? (nextIndex + 1) % rows.length
            : (nextIndex - 1 + rows.length) % rows.length;
        media.insertAdjacentHTML('beforeend', frameMarkup(rows[sideIndex], sideIndex, sidePosition));

        const finish = () => {
            if (finishAnimation !== finish) return;
            finishAnimation = null;
            clearTimeout(animationTimer);
            animationTimer = null;
            paintGallery();
            playQueuedShow();
        };
        finishAnimation = finish;
        animationTimer = setTimeout(finish, 700);
        incoming.addEventListener('transitionend', event => {
            if (event.propertyName === 'transform') finish();
        }, { once: true });
        return true;
    }
    function render() {
        copy.innerHTML = rows.map((row, i) => '<div class="hero-copy" data-home-slide="' + i + '"><span class="hero-tag">' + escapeHtml(row.tag || 'At Iñigos') + '</span><h2 class="hero-title">' + escapeHtml(row.title) + '</h2><p class="hero-meta">' + escapeHtml(formatEventMeta(row)) + '</p></div>').join('');
        dots.innerHTML = rows.map((row, i) => '<button type="button" class="hero-dot" data-home-slide-dot="' + i + '" aria-label="Show ' + escapeHtml(row.title) + '"></button>').join('');
        show(Math.min(index, rows.length - 1));
        sync();
    }
    function message(text, retry = false) {
        resetAnimation();
        rows = []; stop();
        media.innerHTML = '<div class="featured-empty-media" aria-hidden="true"></div>';
        copy.innerHTML = '<div class="hero-copy is-active"><span class="hero-tag">Iñigos Sports Center</span><h2 class="hero-title">Make time to play.</h2><p class="hero-meta">' + text + '</p>' + (retry ? '<button type="button" class="hero-pause" data-events-retry>Retry events</button>' : '') + '</div>';
        dots.replaceChildren(); sync();
    }
    async function refresh(force = false) {
        const request = ++refreshId;
        try {
            const updated = await window.InigoContent.getEvents({ force });
            if (request !== refreshId) return;
            if (!updated.length) { message('There are no published events at the moment. Explore the courts below.'); return; }
            resetAnimation();
            const previous = rows[index]?.title;
            rows = updated;
            index = Math.max(0, rows.findIndex(row => row.title === previous));
            render();
        } catch { if (request === refreshId) message('Events could not be loaded. Please try again.', true); }
    }
    dots.addEventListener('click', event => { const button = event.target.closest('[data-home-slide-dot]'); if (button) show(Number(button.dataset.homeSlideDot)); });
    previous.addEventListener('click', () => show(index - 1, -1));
    next.addEventListener('click', () => show(index + 1, 1));
    copy.addEventListener('click', event => { if (event.target.closest('[data-events-retry]')) refresh(true); });
    pause.addEventListener('click', () => { paused = !paused; sync(); start(); });
    media.addEventListener('error', event => {
        const img = event.target.closest('.featured-frame-img');
        if (!img) return;
        const frame = img.closest('[data-home-slide]');
        const template = document.createElement('template');
        template.innerHTML = placeholder(frame.dataset.homeSlide, frame.dataset.homePosition, 'Photo temporarily unavailable');
        frame.replaceWith(template.content.firstElementChild);
    }, true);
    featured.addEventListener('mouseenter', stop);
    featured.addEventListener('mouseleave', start);
    featured.addEventListener('focusin', stop);
    featured.addEventListener('focusout', () => setTimeout(start, 0));
    featured.addEventListener('keydown', event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const direction = event.key === 'ArrowRight' ? 1 : -1; show(index + direction, direction); }
    });
    featured.addEventListener('touchstart', event => { const t=event.changedTouches[0]; touch={x:t.clientX,y:t.clientY}; }, {passive:true});
    featured.addEventListener('touchend', event => {
        if (!touch) return;
        const t=event.changedTouches[0], dx=touch.x-t.clientX, dy=touch.y-t.clientY;
        if (Math.abs(dx)>50 && Math.abs(dx)>Math.abs(dy)) { const direction = dx > 0 ? 1 : -1; show(index + direction, direction); }
        touch=null;
    }, {passive:true});
    reduced.addEventListener('change', () => {
        if (reduced.matches) resetAnimation(false);
        sync(); start();
    });
    document.addEventListener('visibilitychange', () => {
        stop();
        if (document.hidden) resetAnimation(false);
        else refresh(true);
    });
    message('Loading the latest from Iñigos…');
    refresh();
});
