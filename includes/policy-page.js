// Policy page theme icon and direction-aware header behavior.
(function () {
    const header = document.querySelector('.policy-header');
    const toggle = document.querySelector('[data-theme-toggle]');

    function syncTheme(theme) {
        if (!toggle) return;
        const isLight = theme === 'light';
        toggle.setAttribute('aria-pressed', String(isLight));
        toggle.querySelectorAll('.sun-circle, .sun-line').forEach((part) => {
            part.style.display = isLight ? 'none' : '';
        });
        const moon = toggle.querySelector('.moon-path');
        if (moon) moon.style.display = isLight ? '' : 'none';
    }

    if (toggle) {
        toggle.addEventListener('click', () => window.ThemeController?.toggle());
        document.addEventListener('themechange', (event) => syncTheme(event.detail.theme));
        syncTheme(document.documentElement.getAttribute('data-theme') || 'dark');
    }

    if (!header) return;
    let previousY = Math.max(0, window.scrollY);
    let directionAnchor = previousY;
    let previousDirection = 0;
    let pending = false;

    function syncHeader() {
        pending = false;
        const y = Math.max(0, window.scrollY);
        const delta = y - previousY;
        const direction = Math.sign(delta);
        if (direction && direction !== previousDirection) {
            directionAnchor = previousY;
            previousDirection = direction;
        }
        const hasKeyboardFocus = header.querySelector(':focus-visible');
        if (y < 96 || hasKeyboardFocus) header.classList.remove('is-hidden');
        else if (direction < 0 && directionAnchor - y >= 12) header.classList.remove('is-hidden');
        else if (direction > 0 && y - directionAnchor >= 12) header.classList.add('is-hidden');
        previousY = y;
    }

    window.addEventListener('scroll', () => {
        if (!pending) {
            pending = true;
            window.requestAnimationFrame(syncHeader);
        }
    }, { passive: true });
    header.addEventListener('focusin', () => header.classList.remove('is-hidden'));
    header.addEventListener('focusout', () => window.requestAnimationFrame(syncHeader));
})();
