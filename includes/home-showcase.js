// Live event carousel. Published Supabase rows remain the source of truth.
document.addEventListener('DOMContentLoaded', () => {
    const hero = document.querySelector('[data-home-showcase]');
    if (!hero || !window.InigoContent) return;
    const media = hero.querySelector('[data-home-media]');
    const copy = hero.querySelector('[data-home-copy-stack]');
    const dots = hero.querySelector('[data-home-dots]');
    const pause = hero.querySelector('[data-home-pause]');
    const previous = hero.querySelector('[data-home-prev]');
    const next = hero.querySelector('[data-home-next]');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const hover = matchMedia('(hover: hover)');
    const { escapeHtml, formatEventMeta } = window.InigoContent;
    let rows = [], index = 0, timer = null, paused = false, refreshId = 0;
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
        if (paused || reduced.matches || document.hidden || rows.length < 2 || hero.contains(document.activeElement) || (hover.matches && hero.matches(':hover'))) return;
        timer = setInterval(() => show(index + 1), 5000);
    }
    function show(next) {
        if (!rows.length) return;
        index = (next + rows.length) % rows.length;
        hero.querySelectorAll('[data-home-slide]').forEach(el => {
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
    function placeholder(i, note = 'Photo placeholder') {
        return '<div class="hero-media-slot" data-home-slide="' + i + '"><span class="hero-photo-placeholder">Original venue photo<small>' + note + '</small></span></div>';
    }
    function render() {
        media.innerHTML = rows.map((row, i) => {
            const src = window.InigoVisuals.venuePhoto(row.imageUrl);
            return src ? '<div class="hero-media-slide" data-home-slide="' + i + '"><img class="hero-media-backdrop" src="' + escapeHtml(src) + '" alt="" aria-hidden="true" loading="' + (i ? 'lazy' : 'eager') + '"><img class="hero-media-img" src="' + escapeHtml(src) + '" alt="' + escapeHtml(row.title) + '" loading="' + (i ? 'lazy' : 'eager') + '"></div>' : placeholder(i);
        }).join('');
        media.querySelectorAll('.hero-media-img').forEach(img => img.addEventListener('error', () => {
            const slide = img.closest('[data-home-slide]');
            const template = document.createElement('template');
            template.innerHTML = placeholder(slide.dataset.homeSlide, 'Photo temporarily unavailable');
            const slot = template.content.firstElementChild;
            slot.classList.toggle('is-active', slide.classList.contains('is-active'));
            slot.setAttribute('aria-hidden', slide.getAttribute('aria-hidden'));
            slide.replaceWith(slot);
        }, {once:true}));
        copy.innerHTML = rows.map((row, i) => '<div class="hero-copy" data-home-slide="' + i + '"><span class="hero-tag">' + escapeHtml(row.tag || 'At Iñigos') + '</span><h2 class="hero-title">' + escapeHtml(row.title) + '</h2><p class="hero-meta">' + escapeHtml(formatEventMeta(row)) + '</p></div>').join('');
        dots.innerHTML = rows.map((row, i) => '<button type="button" class="hero-dot" data-home-slide-dot="' + i + '" aria-label="Show ' + escapeHtml(row.title) + '"></button>').join('');
        show(Math.min(index, rows.length - 1));
        sync();
    }
    function message(text, retry = false) {
        rows = []; stop();
        media.innerHTML = '<div class="hero-media-slot is-active"></div>';
        copy.innerHTML = '<div class="hero-copy is-active"><span class="hero-tag">Iñigos Sports Center</span><h2 class="hero-title">Make time to play.</h2><p class="hero-meta">' + text + '</p>' + (retry ? '<button type="button" class="hero-pause" data-events-retry>Retry events</button>' : '') + '</div>';
        dots.replaceChildren(); sync();
    }
    async function refresh(force = false) {
        const request = ++refreshId;
        try {
            const updated = await window.InigoContent.getEvents({ force });
            if (request !== refreshId) return;
            if (!updated.length) { message('There are no published events at the moment. Explore the courts below.'); return; }
            const previous = rows[index]?.title;
            rows = updated;
            index = Math.max(0, rows.findIndex(row => row.title === previous));
            render();
        } catch { if (request === refreshId) message('Events could not be loaded. Please try again.', true); }
    }
    dots.addEventListener('click', event => { const button = event.target.closest('[data-home-slide-dot]'); if (button) show(Number(button.dataset.homeSlideDot)); });
    previous.addEventListener('click', () => show(index - 1));
    next.addEventListener('click', () => show(index + 1));
    copy.addEventListener('click', event => { if (event.target.closest('[data-events-retry]')) refresh(true); });
    pause.addEventListener('click', () => { paused = !paused; sync(); start(); });
    hero.addEventListener('mouseenter', stop);
    hero.addEventListener('mouseleave', start);
    hero.addEventListener('focusin', stop);
    hero.addEventListener('focusout', () => setTimeout(start, 0));
    hero.addEventListener('keydown', event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); show(index + (event.key === 'ArrowRight' ? 1 : -1)); }
    });
    hero.addEventListener('touchstart', event => { const t=event.changedTouches[0]; touch={x:t.clientX,y:t.clientY}; }, {passive:true});
    hero.addEventListener('touchend', event => {
        if (!touch) return;
        const t=event.changedTouches[0], dx=touch.x-t.clientX, dy=touch.y-t.clientY;
        if (Math.abs(dx)>50 && Math.abs(dx)>Math.abs(dy)) show(index + (dx>0 ? 1 : -1));
        touch=null;
    }, {passive:true});
    reduced.addEventListener('change', () => { sync(); start(); });
    document.addEventListener('visibilitychange', () => { stop(); if (!document.hidden) refresh(true); });
    message('Loading the latest from Iñigos…');
    refresh();
});
