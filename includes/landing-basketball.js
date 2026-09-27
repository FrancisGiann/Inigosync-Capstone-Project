// Optional decoration: no layout space, input handlers, or perpetual render loop.
async function startBasketball() {
    let renderer;
    let model;
    let overlay;
    try {
        const [THREE, { GLTFLoader }] = await Promise.all([
            import('./vendor/three/three.module.min.js'),
            import('./vendor/three/GLTFLoader.js')
        ]);
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
        renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
        renderer.setClearColor(0, 0);
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(35, 1, .1, 20);
        camera.position.z = 4.1;
        const ambient = new THREE.HemisphereLight(0xffffff, 0x60432c, 2.2);
        const key = new THREE.DirectionalLight(0xfff1dd, 3);
        key.position.set(-3, 4, 5);
        scene.add(ambient, key);
        const gltf = await new GLTFLoader().loadAsync(new URL('../assets/models/basketball.glb', import.meta.url).href);
        model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const scale = 2 / Math.max(size.x, size.y, size.z);
        model.position.sub(box.getCenter(new THREE.Vector3()));
        const pivot = new THREE.Group();
        pivot.add(model);
        pivot.scale.setScalar(scale);
        scene.add(pivot);

        overlay = document.createElement('div');
        overlay.className = 'floating-basketball';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.append(renderer.domElement);
        document.body.append(overlay);
        const reduced = matchMedia('(prefers-reduced-motion: reduce)');
        const state = { progress: 0 };
        let frame = 0;
        let tween;
        function render() {
            frame = 0;
            if (document.hidden) return;
            const modal = document.body.classList.contains('landing-menu-open') || [...document.querySelectorAll('[aria-modal="true"], dialog[open]')].some(el => !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
            const footerBottom = document.querySelector('.footer-bottom');
            const footerRect = footerBottom?.getBoundingClientRect();
            const ballRect = overlay.getBoundingClientRect();
            const overFooterBottom = footerRect && footerRect.left < ballRect.right && footerRect.right > ballRect.left && footerRect.top < ballRect.bottom && footerRect.bottom > ballRect.top;
            overlay.classList.toggle('is-obscured', modal || overFooterBottom);
            const progress = reduced.matches ? 0 : state.progress;
            pivot.rotation.set(.15 + Math.sin(progress * Math.PI * 2) * .28, progress * Math.PI * 4, -.18);
            renderer.render(scene, camera);
        }
        function requestRender() { if (!frame) frame = requestAnimationFrame(render); }
        function resize() {
            renderer.setSize(overlay.clientWidth, overlay.clientHeight, false);
            requestRender();
        }
        function motion() {
            tween?.scrollTrigger?.kill();
            tween?.kill();
            state.progress = 0;
            if (!reduced.matches && window.gsap && window.ScrollTrigger) {
                gsap.registerPlugin(ScrollTrigger);
                tween = gsap.fromTo(state, { progress: 0 }, { progress: 1, ease: 'none', onUpdate: requestRender,
                    scrollTrigger: { start: 0, end: () => Math.max(1, document.documentElement.scrollHeight - innerHeight), scrub: .3, invalidateOnRefresh: true }
                });
            }
            requestRender();
        }
        function theme() {
            const dark = document.documentElement.dataset.theme === 'dark';
            ambient.intensity = dark ? 2.5 : 2.2;
            key.intensity = dark ? 3.5 : 3;
            requestRender();
        }
        const observer = new MutationObserver(records => {
            // Ignore renderer/GSAP inline transforms and our own visibility class.
            if (records.every(record => overlay.contains(record.target))) return;
            requestRender();
        });
        observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'class', 'open'] });
        const sizeObserver = new ResizeObserver(() => { tween?.scrollTrigger?.refresh(); resize(); });
        sizeObserver.observe(document.body);
        addEventListener('scroll', requestRender, { passive: true });
        addEventListener('resize', resize);
        document.addEventListener('visibilitychange', requestRender);
        document.addEventListener('themechange', theme);
        reduced.addEventListener('change', motion);
        renderer.domElement.addEventListener('webglcontextlost', () => { overlay.hidden = true; });
        resize(); theme(); motion();
    } catch (error) {
        // A failed optional asset must never interfere with booking or navigation.
        overlay?.remove();
        model?.traverse(node => { node.geometry?.dispose(); });
        renderer?.dispose();
        console.warn('Optional basketball decoration unavailable:', error.message);
    }
}

const schedule = () => {
    if ('requestIdleCallback' in window) requestIdleCallback(startBasketball, { timeout: 2000 });
    else setTimeout(startBasketball, 0);
};
if (document.readyState !== 'loading') schedule();
else document.addEventListener('DOMContentLoaded', schedule, { once: true });
