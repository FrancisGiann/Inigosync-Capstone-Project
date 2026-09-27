// IñigoSync — Shared client-side image processing helpers.
// Revision A1 (implementation_plan.md, decisions A5/A9/A6).
//
// Two consumers, two different needs:
//   - downscaleImageToDataUrl(file, {size, quality}) — center-cropped SQUARE
//     JPEG returned as a data: URL, for the two dashboards' profile-photo
//     avatar pipeline (stored directly in profiles.avatar_url — no Storage
//     bucket needed for this one). This is the exact algorithm
//     includes/Dashboard.js's downscaleImageToAvatarDataUrl() already used
//     (R4-4) — that function now just calls this one (see its own comment),
//     so behaviour for the customer dashboard is byte-identical to before
//     this file existed. Validation here matches that original function's
//     own inline checks (any `image/*` type, <= 5 MB) rather than the
//     stricter list below, specifically so moving it here changes nothing
//     about what a customer/owner can pick as an avatar.
//   - downscaleImageToBlob(file, {maxW, maxH, quality}) — aspect-FIT (never
//     cropped, never upscaled) JPEG Blob, for the owner dashboard's Media
//     Manager slideshow and Court Listings photo uploads (A5/A6), which go
//     to the new public Storage bucket `media`
//     (database/schema/015_media_bucket.sql). That bucket's own
//     `allowed_mime_types` is the server-side backstop; the stricter
//     jpeg/png/webp check here is the client-side half of the same rule
//     (implementation_plan.md's security requirements — never rely on the
//     client check alone, but don't make the user wait for a round trip to
//     find out their file type is rejected either).
//
// No build step; plain <script src>, attaches to window like every other
// includes/*.js file. Must load before includes/Dashboard.js and
// includes/owner_dashboard.js (see the <script> order in
// Pages/user_dashboard.html / Pages/owner_dashboard.html).
(function () {
    const MAX_RAW_BYTES = 5 * 1024 * 1024; // Default raw-file ceiling; court cropping may opt into 10 MB.
    const STRICT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

    // `strict` true → only jpeg/png/webp (Media Manager/Court photo path,
    // A5/A6). `strict` false → any image/* (avatar path, unchanged from the
    // pre-existing customer dashboard behaviour this file now centralizes).
    function assertValidImageFile(file, strict, maxRawBytes = MAX_RAW_BYTES) {
        if (!file) throw new Error('No file selected.');
        const type = file.type || '';
        const typeOk = strict ? STRICT_TYPES.includes(type) : type.startsWith('image/');
        if (!typeOk) {
            throw new Error(strict ? 'Please choose a JPEG, PNG, or WEBP image.' : 'Please choose an image file.');
        }
        if (file.size > maxRawBytes) {
            throw new Error(`That image is too large — please choose one under ${maxRawBytes / (1024 * 1024)} MB.`);
        }
    }

    function loadImage(file) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const objectUrl = URL.createObjectURL(file);
            img.onload = () => {
                URL.revokeObjectURL(objectUrl);
                resolve(img);
            };
            img.onerror = () => {
                URL.revokeObjectURL(objectUrl);
                reject(new Error('Could not read the selected image.'));
            };
            img.src = objectUrl;
        });
    }

    // Center-cropped SQUARE data URL — ported verbatim from
    // includes/Dashboard.js's original downscaleImageToAvatarDataUrl()
    // (R4-4): the crop SOURCE square is the smaller of the image's own
    // width/height, centered, so a portrait or landscape photo both crop to
    // their visual center instead of being squashed to fit.
    //
    // S4 (Revision A1 fix) — EXIF orientation (e.g. a phone photo shot in
    // portrait but stored upright-pixels + a "rotate" tag) is honoured by
    // <img>/drawImage on Chrome 81+, Safari 13.4+, and Firefox 26+: img's
    // naturalWidth/naturalHeight and everything drawImage() reads below
    // already reflect the correct upright orientation on those engines, no
    // extra correction code needed here. Older browsers ignore the tag and
    // may render/crop a rotated photo (accepted) — downscaleImageToBlob()
    // below reads the same img and inherits this identically.
    async function downscaleImageToDataUrl(file, { size = 256, quality = 0.82 } = {}) {
        assertValidImageFile(file, false);
        const img = await loadImage(file);

        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        const cropSize = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - cropSize) / 2;
        const sy = (img.naturalHeight - cropSize) / 2;
        ctx.drawImage(img, sx, sy, cropSize, cropSize, 0, 0, size, size);

        return canvas.toDataURL('image/jpeg', quality);
    }

    // Aspect-FIT (letterboxed, never cropped) downscale to a Blob, capped at
    // maxW×maxH and never upscaling a smaller source image — for Media
    // Manager slides and Court Listings photos (A5/A6), which are uploaded
    // to the `media` Storage bucket as real files rather than stored as a
    // data: URL (a 1600×900 JPEG is far too large for a `text` column, and
    // Storage is exactly what buckets are for).
    async function downscaleImageToBlob(file, { maxW = 1600, maxH = 900, quality = 0.85 } = {}) {
        assertValidImageFile(file, true);
        const img = await loadImage(file);

        const scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (blob) resolve(blob);
                else reject(new Error('Could not process that image.'));
            }, 'image/jpeg', quality);
        });
    }

    // ------------------------------------------------------------------
    // Crop editor — Revision A2 (implementation_plan.md, decision B6). A
    // small vanilla pan/zoom crop dialog, currently used by the owner
    // dashboard's Court modal (includes/owner_dashboard.js) for Cover/
    // per-unit photos, but living here — like every other image helper in
    // this file — so any future consumer on either dashboard gets it for
    // free with no extra <link>/<script>.
    //
    // openCropEditor(file, { aspect, maxW, maxH, quality }) → Promise that
    // resolves to a cropped/resized JPEG Blob, or `null` if the user backs
    // out (Cancel, the backdrop, the × button, or Esc). It DOES reject
    // (readable Error, via assertValidImageFile's own two checks) for an
    // invalid file — wrong type or over the caller's raw-file limit (5 MB by
    // default) — before any UI is shown; an
    // `async function` body means that throw becomes a rejected Promise
    // automatically, so callers can `await` either helper the same way.
    //
    // The overlay markup + its own CSS are injected into <body>/<head>
    // ONCE, lazily, on the first call, and reused for every call after —
    // each call attaches its own listeners and removes them all again in
    // cleanup() before resolving, so repeated opens never stack duplicate
    // handlers on the shared DOM nodes.
    // ------------------------------------------------------------------
    let cropOverlayEl = null;
    let cropStylesInjected = false;

    function clamp(n, min, max) {
        return Math.min(max, Math.max(min, n));
    }

    function ensureCropEditorDom() {
        if (cropOverlayEl) return cropOverlayEl;

        if (!cropStylesInjected) {
            const style = document.createElement('style');
            style.textContent = `
.itools-crop-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(10,8,6,.72);opacity:0;transition:opacity .2s ease;}
.itools-crop-overlay[data-open]{opacity:1;}
.itools-crop-overlay[hidden]{display:none;}
.itools-crop-modal{position:relative;width:min(480px,100%);background:#1c1712;color:#f4efe6;border-radius:16px;padding:22px;box-shadow:0 24px 60px rgba(0,0,0,.5);font-family:Arial,Helvetica,sans-serif;}
.itools-crop-modal h3{margin:0 0 14px;font-size:1.05rem;font-weight:700;padding-right:30px;}
.itools-crop-close{position:absolute;top:16px;right:16px;width:30px;height:30px;border-radius:50%;border:1px solid rgba(244,239,230,.25);background:transparent;color:inherit;cursor:pointer;font-size:15px;line-height:1;}
.itools-crop-close:hover{border-color:#FF6115;}
.itools-crop-frame-wrap{display:flex;justify-content:center;margin-bottom:16px;}
.itools-crop-frame{position:relative;width:min(100%,420px);aspect-ratio:16/10;overflow:hidden;border-radius:10px;background:#000;touch-action:none;cursor:grab;}
.itools-crop-frame.is-dragging{cursor:grabbing;}
.itools-crop-frame img{position:absolute;top:0;left:0;transform-origin:top left;user-select:none;-webkit-user-drag:none;pointer-events:none;max-width:none;max-height:none;}
.itools-crop-controls{display:flex;align-items:center;gap:12px;margin-bottom:8px;}
.itools-crop-controls label{font-size:.8rem;opacity:.8;flex-shrink:0;}
.itools-crop-controls input[type=range]{flex:1;}
.itools-crop-hint{font-size:.75rem;opacity:.65;margin:0 0 18px;}
.itools-crop-actions{display:flex;justify-content:flex-end;gap:10px;}
.itools-crop-actions button{padding:10px 20px;border-radius:999px;border:1px solid rgba(244,239,230,.25);background:transparent;color:inherit;font-weight:700;font-size:.85rem;cursor:pointer;}
.itools-crop-actions button:hover{border-color:#FF6115;}
.itools-crop-actions .itools-crop-apply{background:#FF6115;border-color:#FF6115;color:#14110d;}
@media (prefers-reduced-motion: reduce){.itools-crop-overlay{transition:none;}}
            `;
            document.head.appendChild(style);
            cropStylesInjected = true;
        }

        const overlay = document.createElement('div');
        overlay.className = 'itools-crop-overlay';
        overlay.hidden = true;
        overlay.innerHTML = `
            <div class="itools-crop-modal" role="dialog" aria-modal="true" aria-label="Adjust photo" tabindex="-1">
                <button type="button" class="itools-crop-close" aria-label="Cancel">&#10005;</button>
                <h3>Adjust photo</h3>
                <div class="itools-crop-frame-wrap">
                    <div class="itools-crop-frame"></div>
                </div>
                <div class="itools-crop-controls">
                    <label>Zoom</label>
                    <input type="range" class="itools-crop-zoom" min="1" max="4" step="0.01" value="1">
                </div>
                <p class="itools-crop-hint">Drag the photo to reposition it, and use the slider to zoom.</p>
                <div class="itools-crop-actions">
                    <button type="button" class="itools-crop-cancel">Cancel</button>
                    <button type="button" class="itools-crop-apply">Apply</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        cropOverlayEl = overlay;
        return overlay;
    }

    async function openCropEditor(file, { aspect = 16 / 10, maxW = 1600, maxH = 1000, quality = 0.85, maxRawBytes = MAX_RAW_BYTES } = {}) {
        assertValidImageFile(file, true, maxRawBytes);
        const img = await loadImage(file);

        return new Promise((resolve) => {
            const overlay = ensureCropEditorDom();
            const modal = overlay.querySelector('.itools-crop-modal');
            const frame = overlay.querySelector('.itools-crop-frame');
            const zoomInput = overlay.querySelector('.itools-crop-zoom');
            const closeBtn = overlay.querySelector('.itools-crop-close');
            const cancelBtn = overlay.querySelector('.itools-crop-cancel');
            const applyBtn = overlay.querySelector('.itools-crop-apply');

            frame.style.aspectRatio = String(aspect);
            frame.innerHTML = '';
            img.className = '';
            img.draggable = false;
            img.alt = '';
            frame.appendChild(img);

            let baseScale = 1;
            let zoom = 1;
            let offsetX = 0;
            let offsetY = 0;
            let frameW = 0;
            let frameH = 0;
            let settled = false;

            function scale() { return baseScale * zoom; }

            // "Image can never leave the frame uncovered" — offsetX/Y (the
            // image's top-left corner relative to the frame's) is clamped
            // so the scaled image's right/bottom edge never lands inside
            // the frame, in either axis.
            function clampOffsets() {
                const w = img.naturalWidth * scale();
                const h = img.naturalHeight * scale();
                const minX = Math.min(0, frameW - w);
                const minY = Math.min(0, frameH - h);
                offsetX = clamp(offsetX, minX, 0);
                offsetY = clamp(offsetY, minY, 0);
            }

            function applyTransform() {
                img.style.width = `${img.naturalWidth * scale()}px`;
                img.style.height = `${img.naturalHeight * scale()}px`;
                img.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
            }

            function layout() {
                const rect = frame.getBoundingClientRect();
                if (!rect.width || !rect.height) return;
                frameW = rect.width;
                frameH = rect.height;
                // baseScale = the smallest scale that still fully COVERS
                // the frame (the classic "background-size: cover" formula)
                // — zoom (>= 1) only ever scales up from there, so the
                // frame can never be left uncovered.
                baseScale = Math.max(frameW / img.naturalWidth, frameH / img.naturalHeight);
                const w = img.naturalWidth * scale();
                const h = img.naturalHeight * scale();
                offsetX = (frameW - w) / 2;
                offsetY = (frameH - h) / 2;
                clampOffsets();
                applyTransform();
            }

            function onZoomInput() {
                zoom = Number(zoomInput.value) || 1;
                clampOffsets();
                applyTransform();
            }

            // Pointer Events cover mouse AND touch with one listener set;
            // `touch-action: none` on the frame (set in the injected CSS
            // above) stops the browser from also scrolling the page while
            // a touch drag is in progress.
            let dragging = false;
            let dragStartX = 0;
            let dragStartY = 0;
            let dragOriginX = 0;
            let dragOriginY = 0;

            function onPointerDown(e) {
                dragging = true;
                frame.classList.add('is-dragging');
                dragStartX = e.clientX;
                dragStartY = e.clientY;
                dragOriginX = offsetX;
                dragOriginY = offsetY;
                if (frame.setPointerCapture) {
                    try { frame.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
                }
            }
            function onPointerMove(e) {
                if (!dragging) return;
                offsetX = dragOriginX + (e.clientX - dragStartX);
                offsetY = dragOriginY + (e.clientY - dragStartY);
                clampOffsets();
                applyTransform();
            }
            function onPointerUp() {
                dragging = false;
                frame.classList.remove('is-dragging');
            }

            function onKeydown(e) {
                // Capture-phase + stopPropagation: the crop editor sits on top of a host
                // modal (the owner's court modal) that ALSO closes on Escape at the
                // document level — without this, one keypress would close both.
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
            }

            function onCancel() { finish(null); }

            function onApply() {
                const sx = clamp(-offsetX / scale(), 0, img.naturalWidth);
                const sy = clamp(-offsetY / scale(), 0, img.naturalHeight);
                const sw = Math.min(frameW / scale(), img.naturalWidth - sx);
                const sh = Math.min(frameH / scale(), img.naturalHeight - sy);

                let outW = maxW;
                let outH = Math.round(maxW / aspect);
                if (outH > maxH) {
                    outH = maxH;
                    outW = Math.round(maxH * aspect);
                }

                const canvas = document.createElement('canvas');
                canvas.width = outW;
                canvas.height = outH;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
                canvas.toBlob((blob) => finish(blob || null), 'image/jpeg', quality);
            }

            let backdropMouseDownOnSelf = false;
            function onBackdropMouseDown(e) { backdropMouseDownOnSelf = e.target === overlay; }
            function onBackdropClick(e) {
                if (e.target === overlay && backdropMouseDownOnSelf) finish(null);
                backdropMouseDownOnSelf = false;
            }

            function cleanup() {
                overlay.removeAttribute('data-open');
                window.setTimeout(() => { overlay.hidden = true; }, 200);
                window.removeEventListener('resize', layout);
                frame.removeEventListener('pointerdown', onPointerDown);
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', onPointerUp);
                zoomInput.removeEventListener('input', onZoomInput);
                closeBtn.removeEventListener('click', onCancel);
                cancelBtn.removeEventListener('click', onCancel);
                applyBtn.removeEventListener('click', onApply);
                document.removeEventListener('keydown', onKeydown, true);
                overlay.removeEventListener('mousedown', onBackdropMouseDown);
                overlay.removeEventListener('click', onBackdropClick);
            }

            function finish(result) {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(result);
            }

            zoomInput.value = '1';
            zoom = 1;

            overlay.hidden = false;
            // Force a synchronous layout flush so the frame has real
            // dimensions before layout() measures it, and so the
            // hidden->visible state commits before [data-open] flips
            // opacity to 1 — same trick the dashboards' own modals use.
            void overlay.offsetWidth;
            overlay.setAttribute('data-open', '');
            layout();
            modal.focus();

            window.addEventListener('resize', layout);
            frame.addEventListener('pointerdown', onPointerDown);
            window.addEventListener('pointermove', onPointerMove);
            window.addEventListener('pointerup', onPointerUp);
            zoomInput.addEventListener('input', onZoomInput);
            closeBtn.addEventListener('click', onCancel);
            cancelBtn.addEventListener('click', onCancel);
            applyBtn.addEventListener('click', onApply);
            document.addEventListener('keydown', onKeydown, true);
            overlay.addEventListener('mousedown', onBackdropMouseDown);
            overlay.addEventListener('click', onBackdropClick);
        });
    }

    window.InigoImageTools = { downscaleImageToDataUrl, downscaleImageToBlob, openCropEditor };
})();
