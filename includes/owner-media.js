/* Owner Media Manager. All edits remain in the dialog until Save. */
(function () {
    'use strict';

    const grid = document.querySelector('[data-admin-slides]');
    const modal = document.querySelector('[data-admin-slide-modal]');
    const dialog = document.querySelector('[data-admin-slide-dialog]');
    const editor = document.querySelector('[data-admin-slide-editor]');
    const addButton = document.querySelector('[data-admin-slide-add]');
    if (!grid || !modal || !dialog || !editor || !window.sb) return;

    const placeholder = '../assets/landing/featured-tournament-placeholder.png';
    let slides = [];
    let activeDraft = null;
    let previousFocus = null;
    let touchDrag = null;

    const escape = (value) => window.escapeHtml ? window.escapeHtml(String(value ?? '')) : String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const toast = (message, error) => window.InigoToast?.show(message, Boolean(error));
    const confirm = (options) => window.InigoOwnerUI?.confirm
        ? window.InigoOwnerUI.confirm(options)
        : Promise.resolve(window.confirm(`${options.title}\n\n${options.message}`));
    const recordActivity = (title, detail) => window.InigoOwnerUI?.recordActivity?.(title, 'media', detail);

    function safeImage(url) {
        if (typeof url !== 'string' || !url.trim()) return '';
        try {
            const parsed = new URL(url, window.location.href);
            return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
        } catch { return ''; }
    }

    function imageMarkup(url, title, isPlaceholder) {
        const safeUrl = safeImage(url);
        if (safeUrl) return `<img src="${escape(safeUrl)}" alt="${escape(title || 'Slideshow photo')}"${isPlaceholder ? ' data-media-placeholder' : ''}>`;
        return `<img src="${placeholder}" alt="Generic sports equipment placeholder" data-media-placeholder>`;
    }

    function renderCard(slide, index) {
        const title = slide.title || 'Untitled slide';
        return `<article class="admin-slide-card owner-media-card" data-media-card data-slide-id="${escape(slide.id)}" tabindex="0" aria-label="${escape(title)}. Use Alt plus arrow keys to reorder.">
            <div class="admin-slide-thumb">${imageMarkup(slide.image_url, title, !slide.image_url)}<span class="admin-slide-badge">Slide ${index + 1}</span></div>
            <div class="admin-slide-body"><strong class="owner-media-card-title">${escape(title)}</strong><span class="admin-slide-caption">${slide.is_published === false ? 'Draft' : 'Published'}</span><button type="button" class="admin-btn-chip-primary" data-media-edit="${escape(slide.id)}">Edit slide</button></div>
        </article>`;
    }

    function render() {
        grid.innerHTML = slides.length ? slides.map(renderCard).join('') : '<p class="owner-media-empty">No slides yet. Add a slide to prepare featured content.</p>';
        const count = document.querySelector('[data-admin-slides-sub]');
        if (count) count.textContent = `${slides.length} slide${slides.length === 1 ? '' : 's'}`;
        grid.querySelectorAll('[data-media-edit]').forEach((button) => button.addEventListener('click', () => openEditor(button.dataset.mediaEdit)));
        wireDrag();
    }

    async function load() {
        grid.setAttribute('aria-busy', 'true');
        const { data, error } = await window.sb.from('event')
            .select('id, title, meta, tag, image_url, display_order, is_published, created_at')
            .order('display_order', { ascending: true }).order('created_at', { ascending: true });
        grid.removeAttribute('aria-busy');
        if (error) {
            console.error('[owner-media] unable to load slides', error);
            grid.innerHTML = '<p class="owner-media-empty" role="alert">Could not load slides. Refresh and try again.</p>';
            return;
        }
        slides = Array.isArray(data) ? data : [];
        render();
    }

    function formMarkup(slide, isNew) {
        const image = slide.image_url || '';
        return `<form class="owner-media-form" data-media-form novalidate>
            <div class="owner-media-preview-wrap"><div class="owner-media-preview" data-media-preview>${imageMarkup(image, slide.title || 'Featured slide', !image)}</div><button type="button" class="owner-photo-choice owner-media-replace" data-media-replace><span data-media-replace-label>${isNew ? 'Choose photo' : 'Replace photo'}</span></button><input class="admin-visually-hidden" type="file" accept="image/*" data-media-file><p class="owner-media-crop-hint">Choose an image, adjust the 16:9 crop, then save to stage it.</p></div>
            <div class="owner-media-fields">
                <label class="admin-form-group"><span class="admin-form-label">Title</span><input required maxlength="120" type="text" class="admin-input" data-media-title value="${escape(slide.title || '')}"></label>
                <label class="admin-form-group"><span class="admin-form-label">Caption</span><textarea maxlength="500" class="admin-input owner-media-textarea" data-media-caption>${escape(slide.meta || '')}</textarea></label>
                <label class="admin-form-group"><span class="admin-form-label">Tag <span class="admin-form-label-hint">(optional)</span></span><input maxlength="80" type="text" class="admin-input" data-media-tag value="${escape(slide.tag || '')}"></label>
                <div class="admin-slide-publish-row"><span>Published</span><button type="button" class="admin-switch${slide.is_published !== false ? ' is-on' : ''}" data-media-published aria-label="Toggle published" aria-pressed="${slide.is_published !== false}"></button><span class="admin-form-hint">${isNew ? 'New slides start as drafts.' : 'Changes publish only after you save.'}</span></div>
            </div>
            <div class="owner-media-actions">${isNew ? '' : '<button type="button" class="admin-btn-chip-danger" data-media-remove>Remove</button>'}<button type="submit" class="admin-btn-save" data-media-save>Save</button></div>
        </form>`;
    }

    function getValues() {
        return {
            title: editor.querySelector('[data-media-title]').value.trim(),
            meta: editor.querySelector('[data-media-caption]').value.trim(),
            tag: editor.querySelector('[data-media-tag]').value.trim(),
            is_published: editor.querySelector('[data-media-published]').getAttribute('aria-pressed') === 'true',
            file: activeDraft?.croppedFile || null,
        };
    }

    function hasChanges() {
        if (!activeDraft) return false;
        const values = getValues();
        return Boolean(values.file) || values.title !== activeDraft.original.title || values.meta !== (activeDraft.original.meta || '') || values.tag !== (activeDraft.original.tag || '') || values.is_published !== (activeDraft.original.is_published !== false);
    }

    async function closeEditor(force) {
        if (!force && hasChanges()) {
            const accepted = await confirm({ title: 'Discard slide changes?', message: 'Your unsaved slide details and selected photo will be lost.', confirmLabel: 'Discard changes', danger: true });
            if (!accepted) return;
        }
        if (activeDraft?.previewUrl) URL.revokeObjectURL(activeDraft.previewUrl);
        modal.hidden = true;
        modal.removeAttribute('data-open');
        editor.replaceChildren();
        activeDraft = null;
        previousFocus?.focus?.();
    }

    function openEditor(id) {
        const source = id ? slides.find((slide) => String(slide.id) === String(id)) : null;
        if (id && !source) return;
        const original = source ? { ...source } : { id: null, title: '', meta: '', tag: '', image_url: '', is_published: false };
        activeDraft = { original, isNew: !source, croppedFile: null, previewUrl: null };
        previousFocus = document.activeElement;
        const heading = document.querySelector('[data-admin-slide-modal-title]');
        if (heading) heading.textContent = source ? 'Edit slide' : 'Add slide';
        editor.innerHTML = formMarkup(original, !source);
        modal.hidden = false;
        modal.setAttribute('data-open', '');
        dialog.focus();
        wireForm();
    }

    function wireForm() {
        const form = editor.querySelector('[data-media-form]');
        const file = form.querySelector('[data-media-file]');
        const trigger = form.querySelector('[data-media-replace]');
        const published = form.querySelector('[data-media-published]');
        trigger.addEventListener('click', () => file.click());
        file.addEventListener('change', async () => {
            const next = file.files?.[0];
            if (!next) return;
            if (!next.type || !next.type.startsWith('image/')) {
                file.value = '';
                toast('Choose an image file.', true);
                return;
            }
            file.value = '';
            trigger.disabled = true;
            const label = trigger.querySelector('[data-media-replace-label]');
            if (label) label.textContent = 'Opening crop…';
            try {
                if (!window.InigoImageTools?.openCropEditor) throw new Error('The photo crop tool is unavailable.');
                const cropped = await window.InigoImageTools.openCropEditor(next, { aspect: 16 / 9, maxW: 1800, maxH: 1012, quality: 0.88 });
                if (!cropped || !activeDraft) return;
                const staged = new File([cropped], 'slideshow-photo.jpg', { type: 'image/jpeg' });
                if (activeDraft.previewUrl) URL.revokeObjectURL(activeDraft.previewUrl);
                const objectUrl = URL.createObjectURL(staged);
                activeDraft.croppedFile = staged;
                activeDraft.previewUrl = objectUrl;
                const preview = form.querySelector('[data-media-preview]');
                const img = document.createElement('img');
                img.src = objectUrl;
                img.alt = 'Cropped slideshow photo preview';
                img.dataset.objectUrl = objectUrl;
                preview.replaceChildren(img);
                if (label) label.textContent = 'Replace photo';
            } catch (error) {
                toast(error.message || 'Could not crop this photo. Choose another image and try again.', true);
            } finally {
                trigger.disabled = false;
                if (label && label.textContent === 'Opening crop…') label.textContent = activeDraft?.croppedFile || !activeDraft?.isNew ? 'Replace photo' : 'Choose photo';
                trigger.focus();
            }
        });
        published.addEventListener('click', () => {
            const next = published.getAttribute('aria-pressed') !== 'true';
            published.setAttribute('aria-pressed', String(next));
            published.classList.toggle('is-on', next);
        });
        form.querySelector('[data-media-remove]')?.addEventListener('click', removeActiveSlide);
        form.addEventListener('submit', saveActiveSlide);
    }

    function extractStoragePath(url) {
        try {
            const parsed = new URL(url);
            if (parsed.origin !== new URL(window.SUPABASE_URL).origin) return null;
            const marker = '/storage/v1/object/public/media/';
            const index = parsed.pathname.indexOf(marker);
            return index < 0 ? null : decodeURIComponent(parsed.pathname.slice(index + marker.length));
        } catch { return null; }
    }

    async function removeIfUnused(url) {
        const path = extractStoragePath(url);
        if (!path) return;
        try {
            const { data: referenced, error } = await window.sb.rpc('admin_is_media_url_referenced', { p_url: url });
            if (error || referenced !== false) return;
            await window.sb.storage.from('media').remove([path]);
        } catch (error) { console.warn('[owner-media] old photo cleanup skipped', error); }
    }

    async function uploadDraftPhoto(file, slideId) {
        if (!window.InigoImageTools?.downscaleImageToBlob) throw new Error('Image upload tools are unavailable.');
        const blob = await window.InigoImageTools.downscaleImageToBlob(file, { maxW: 1800, maxH: 1200, quality: 0.88 });
        const path = `slides/${slideId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
        const { error: uploadError } = await window.sb.storage.from('media').upload(path, blob, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false });
        if (uploadError) throw uploadError;
        const { data } = window.sb.storage.from('media').getPublicUrl(path);
        if (!data?.publicUrl) {
            await window.sb.storage.from('media').remove([path]);
            throw new Error('Could not create a public photo URL.');
        }
        return { path, url: data.publicUrl };
    }

    async function saveActiveSlide(event) {
        event.preventDefault();
        if (!activeDraft) return;
        const values = getValues();
        if (!values.title) { toast('Add a title before saving.', true); editor.querySelector('[data-media-title]').focus(); return; }
        const button = editor.querySelector('[data-media-save]');
        const wasNew = activeDraft.isNew;
        button.disabled = true;
        button.textContent = 'Saving…';
        let createdId = activeDraft.original.id;
        let uploadedPath = null;
        let uploadedUrl = null;
        const previousPhoto = activeDraft.original.image_url;
        try {
            let imageUrl = previousPhoto || null;
            if (values.file) {
                const uploaded = await uploadDraftPhoto(values.file, createdId || crypto.randomUUID());
                uploadedPath = uploaded.path;
                uploadedUrl = uploaded.url;
                imageUrl = uploadedUrl;
            }
            const payload = { title: values.title, meta: values.meta || null, tag: values.tag || null, is_published: values.is_published, image_url: imageUrl };
            if (!activeDraft.isNew) {
                const { data, error } = await window.sb.from('event').update(payload).eq('id', createdId).select('id').maybeSingle();
                if (error) throw error;
                if (!data?.id) throw new Error('This slide changed or is no longer available. Reload the page and try again.');
            } else {
                const maxOrder = slides.reduce((max, slide) => Math.max(max, Number(slide.display_order) || 0), 0);
                const { data, error } = await window.sb.from('event').insert({ ...payload, display_order: maxOrder + 1 }).select('id').single();
                if (error) throw error;
                createdId = data.id;
            }
            await closeEditor(true);
            if (previousPhoto && uploadedUrl) await removeIfUnused(previousPhoto);
            toast(wasNew ? 'Slide saved.' : 'Slide changes saved.');
            recordActivity(wasNew ? 'Added a slideshow slide' : 'Updated a slideshow slide', values.title);
            await load();
        } catch (error) {
            if (uploadedUrl) await removeIfUnused(uploadedUrl);
            console.error('[owner-media] save failed', error);
            toast(error?.message || 'Could not save the slide. Your draft is still open.', true);
        } finally {
            if (button.isConnected) { button.disabled = false; button.textContent = 'Save'; }
        }
    }

    async function removeActiveSlide() {
        if (!activeDraft || activeDraft.isNew) return;
        const slide = activeDraft.original;
        const accepted = await confirm({ title: 'Remove slide?', message: `“${slide.title || 'Untitled slide'}” will be removed from the slideshow. This cannot be undone.`, confirmLabel: 'Remove slide', danger: true });
        if (!accepted) return;
        const button = editor.querySelector('[data-media-remove]');
        button.disabled = true;
        const { data, error } = await window.sb.from('event').delete().eq('id', slide.id).select('id').maybeSingle();
        if (error) { button.disabled = false; toast(error.message || 'Could not remove the slide.', true); return; }
        if (!data?.id) { button.disabled = false; toast('This slide changed or is no longer available. Reload the page and try again.', true); return; }
        await closeEditor(true);
        await removeIfUnused(slide.image_url);
        recordActivity('Removed a slideshow slide', slide.title || 'Untitled slide');
        toast('Slide removed.');
        await load();
    }

    async function reorder(nextSlides, originSlides) {
        grid.setAttribute('aria-busy', 'true');
        const result = await window.sb.rpc('admin_reorder_slides', {
            p_ids: nextSlides.map((slide) => slide.id),
            p_expected_ids: originSlides.map((slide) => slide.id),
        });
        grid.removeAttribute('aria-busy');
        if (result.error) {
            slides = originSlides;
            render();
            toast(result.error.message || 'Could not reorder slides. The original order has been restored.', true);
            return false;
        }
        slides = nextSlides.map((slide, index) => ({ ...slide, display_order: index + 1 }));
        render();
        recordActivity('Reordered slideshow slides', `${slides.length} slides`);
        return true;
    }

    function wireDrag() {
        const cards = [...grid.querySelectorAll('[data-media-card]')];
        cards.forEach((card) => {
            card.draggable = true;
            card.addEventListener('dragstart', (event) => {
                if (event.target.closest('button')) { event.preventDefault(); return; }
                card.classList.add('is-dragging');
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', card.dataset.slideId);
            });
            card.addEventListener('dragend', () => card.classList.remove('is-dragging'));
            card.addEventListener('dragover', (event) => event.preventDefault());
            card.addEventListener('drop', async (event) => {
                event.preventDefault();
                const fromId = event.dataTransfer.getData('text/plain');
                const toId = card.dataset.slideId;
                if (!fromId || fromId === toId) return;
                const origin = [...slides];
                const next = [...slides];
                const from = next.findIndex((slide) => String(slide.id) === fromId);
                const to = next.findIndex((slide) => String(slide.id) === toId);
                if (from < 0 || to < 0) return;
                next.splice(to, 0, next.splice(from, 1)[0]);
                slides = next;
                render();
                await reorder(next, origin);
            });
            card.addEventListener('keydown', async (event) => {
                if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                event.preventDefault();
                const origin = [...slides];
                const from = slides.findIndex((slide) => String(slide.id) === card.dataset.slideId);
                const to = from + (event.key === 'ArrowUp' ? -1 : 1);
                if (to < 0 || to >= slides.length) return;
                const next = [...slides];
                next.splice(to, 0, next.splice(from, 1)[0]);
                slides = next;
                render();
                grid.querySelector(`[data-slide-id="${CSS.escape(String(origin[from].id))}"]`)?.focus();
                await reorder(next, origin);
            });
            card.addEventListener('pointerdown', (event) => {
                if (event.pointerType !== 'touch' || event.target.closest('button')) return;
                const startX = event.clientX;
                const startY = event.clientY;
                const id = card.dataset.slideId;
                touchDrag = { id, timer: window.setTimeout(() => {
                    card.classList.add('is-touch-dragging');
                    touchDrag.active = true;
                }, 360), startX, startY, active: false };
            });
            card.addEventListener('pointermove', (event) => {
                if (!touchDrag || touchDrag.id !== card.dataset.slideId) return;
                if (!touchDrag.active && (Math.abs(event.clientX - touchDrag.startX) > 12 || Math.abs(event.clientY - touchDrag.startY) > 12)) {
                    clearTimeout(touchDrag.timer);
                    touchDrag = null;
                    return;
                }
                if (!touchDrag.active) return;
                event.preventDefault();
                const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-media-card]');
                cards.forEach((item) => item.classList.toggle('is-drop-target', item === target));
            });
            card.addEventListener('pointerup', async (event) => {
                if (!touchDrag || touchDrag.id !== card.dataset.slideId) return;
                clearTimeout(touchDrag.timer);
                const wasActive = touchDrag.active;
                touchDrag = null;
                cards.forEach((item) => item.classList.remove('is-touch-dragging', 'is-drop-target'));
                if (!wasActive) return;
                const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-media-card]');
                if (!target || target.dataset.slideId === card.dataset.slideId) return;
                const origin = [...slides];
                const next = [...slides];
                const from = next.findIndex((slide) => String(slide.id) === card.dataset.slideId);
                const to = next.findIndex((slide) => String(slide.id) === target.dataset.slideId);
                next.splice(to, 0, next.splice(from, 1)[0]);
                slides = next;
                render();
                await reorder(next, origin);
            });
        });
    }

    addButton?.addEventListener('click', () => openEditor(null));
    modal.querySelectorAll('[data-admin-slide-modal-close]').forEach((button) => button.addEventListener('click', () => closeEditor(false)));
    modal.addEventListener('click', (event) => { if (event.target === modal) closeEditor(false); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !modal.hidden) { event.preventDefault(); closeEditor(false); } });
    load();
})();
