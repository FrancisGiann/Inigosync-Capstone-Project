// Google is the only review source displayed on the landing page.
document.addEventListener('DOMContentLoaded', () => {
    const host = document.querySelector('[data-google-reviews]');
    const fallback = document.querySelector('[data-google-reviews-fallback]');
    if (!host || !fallback) return;

    const id = window.InigoGoogleReviews?.widgetId;
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        fallback.hidden = false;
        return;
    }

    const widget = document.createElement('div');
    widget.className = 'elfsight-app-' + id;
    widget.setAttribute('data-elfsight-app-lazy', '');
    host.append(widget);
    host.hidden = false;

    let rendered = false;
    let scriptLoaded = false;
    let inView = false;
    let timeout;
    const hasContent = () => widget.textContent.trim() || widget.children.length > 0 || widget.shadowRoot?.childNodes.length;
    const observer = new MutationObserver(() => {
        if (hasContent()) { rendered = true; clearTimeout(timeout); observer.disconnect(); }
    });
    observer.observe(widget, { childList: true, subtree: true, characterData: true });
    const unavailable = () => {
        if (rendered || hasContent()) return;
        observer.disconnect();
        host.hidden = true;
        fallback.hidden = false;
    };
    const armTimeout = () => {
        if (scriptLoaded && !rendered && !timeout) timeout = setTimeout(unavailable, 8000);
    };
    if ('IntersectionObserver' in window) {
        const visible = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) { inView = true; armTimeout(); visible.disconnect(); }
        });
        visible.observe(host);
    }
    const script = document.createElement('script');
    script.src = 'https://elfsightcdn.com/platform.js';
    script.async = true;
    script.addEventListener('error', unavailable, { once: true });
    script.addEventListener('load', () => {
        scriptLoaded = true;
        if (!('IntersectionObserver' in window) || inView || host.getBoundingClientRect().top < innerHeight) armTimeout();
    }, { once: true });
    document.head.append(script);
});
