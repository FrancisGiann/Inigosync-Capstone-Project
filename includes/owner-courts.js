/* Owner Court Listings editor. All edits remain local until admin_save_sport succeeds. */
(function () {
    'use strict';

    document.addEventListener('DOMContentLoaded', () => {
        const root = document.querySelector('[data-admin-panel="courts"]');
        const overlay = document.querySelector('[data-ioc-editor-overlay]');
        if (!root || !overlay || !window.sb) return;

        const list = root.querySelector('[data-ioc-list]');
        const editor = overlay.querySelector('[data-ioc-editor]');
        const unitHost = editor.querySelector('[data-ioc-units]');
        const title = editor.querySelector('[data-ioc-title]');
        const $ = (selector, scope = editor) => scope.querySelector(selector);
        const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
        const toast = (message, error = false) => window.InigoToast?.show(message, error);
        const confirm = async (opts) => {
            const result = await window.InigoOwnerUI?.confirm?.(opts);
            return result === true;
        };
        const activity = (name, detail) => window.InigoOwnerUI?.recordActivity?.(name, 'courts', detail);
        const state = { filter: 'all', search: '', courts: [], draft: null, returnFocus: null, scrollTop: 0, barHidden: false, saving: false };

        const slugify = (value) => String(value || '').trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `sport-${Date.now()}`;
        const unitNoun = (kind) => ({ courts: 'Court', lanes: 'Lane', tables: 'Table' })[kind] || 'Court';
        const isSafeImage = (url) => typeof url === 'string' && /^https:\/\//i.test(url);
        const timeToManilaInput = (value) => {
            if (!value) return '';
            const date = new Date(value);
            if (Number.isNaN(date.valueOf())) return '';
            const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
            const out = Object.fromEntries(parts.map((part) => [part.type, part.value]));
            return `${out.year}-${out.month}-${out.day}T${out.hour}:${out.minute}`;
        };
        const manilaInputToISO = (value) => {
            if (!value) return null;
            const date = new Date(`${value}:00+08:00`);
            return Number.isNaN(date.valueOf()) ? null : date.toISOString();
        };
        const defaultResources = () => [];

        async function loadListings() {
            list.innerHTML = '<p class="ioc-empty">Loading sports…</p>';
            try {
                const { data, error } = await window.sb.from('court').select('id,sport_id,slug,name,quantity,unit,description,image_url,is_active,display_order,sport(id,name,slug)').order('display_order').order('name');
                if (error) throw error;
                state.courts = Array.isArray(data) ? data : [];
                renderListings();
            } catch (error) {
                list.innerHTML = '<p class="ioc-empty ioc-error">Could not load sports. Check your connection and try again.</p><button class="ioc-button ioc-button-secondary" type="button" data-ioc-retry>Try again</button>';
                list.querySelector('[data-ioc-retry]')?.addEventListener('click', loadListings);
                console.error('[owner-courts] Could not load court listings', error);
            }
        }

        function renderListings() {
            const rows = state.courts.filter((court) => {
                const active = court.is_active !== false;
                const matchesFilter = state.filter === 'all' || (state.filter === 'active' ? active : !active);
                const haystack = `${court.name || ''} ${court.description || ''} ${court.sport?.name || ''}`.toLocaleLowerCase();
                return matchesFilter && (!state.search || haystack.includes(state.search));
            });
            if (!rows.length) {
                list.innerHTML = `<div class="ioc-empty-state"><strong>${state.search ? 'No matching sports' : state.filter === 'archived' ? 'No archived sports' : 'No sports yet'}</strong><p>${state.search ? 'Try another search.' : 'Add a sport listing to get started.'}</p></div>`;
                return;
            }
            list.innerHTML = rows.map((court) => {
                const active = court.is_active !== false;
                const image = isSafeImage(court.image_url) ? `<img src="${esc(court.image_url)}" alt="" loading="lazy">` : `<span class="ioc-listing-placeholder" aria-hidden="true">${esc((court.name || 'S').slice(0, 2).toUpperCase())}</span>`;
                return `<article class="ioc-listing-card"><div class="ioc-listing-photo">${image}</div><div class="ioc-listing-main"><div class="ioc-listing-heading"><div><span class="ioc-status ${active ? 'is-active' : 'is-archived'}">${active ? 'Active' : 'Archived'}</span><h3>${esc(court.name)}</h3></div><span class="ioc-listing-count">${Number(court.quantity) || 0} ${esc(court.unit || 'courts')}</span></div><p>${esc(court.description || 'No description added')}</p><div class="ioc-listing-meta"><span>${esc(court.sport?.name || 'Sport listing')}</span><span>Updated in one editor</span></div></div><div class="ioc-listing-actions"><button class="ioc-button ioc-button-secondary" type="button" data-ioc-edit="${esc(court.id)}">Edit sport</button>${active ? '' : `<button class="ioc-button ioc-button-danger-outline" type="button" data-ioc-delete="${esc(court.id)}">Delete</button>`}</div></article>`;
            }).join('');
            list.querySelectorAll('[data-ioc-edit]').forEach((button) => button.addEventListener('click', () => openEditor(button.dataset.iocEdit)));
            list.querySelectorAll('[data-ioc-delete]').forEach((button) => button.addEventListener('click', () => deleteListing(button.dataset.iocDelete)));
        }

        function normalizeEditor(data) {
            if (!data || !Array.isArray(data.units) || (data.listing !== null && typeof data.listing !== 'object')) throw new Error('The sport editor returned incomplete data.');
            return {
                version: Number(data.version) || 0,
                listing: { ...(data.listing || {}), id: data.listing?.id || null, name: data.listing?.name || '', slug: data.listing?.slug || '', unit: data.listing?.unit || 'courts', description: data.listing?.description || '', image_url: data.listing?.image_url || null, is_active: data.listing?.is_active !== false },
                units: data.units.map((unit) => ({
                    id: unit.id || null, label: String(unit.label || ''), photo_url: unit.photo_url || null,
                    photo_file: null, rate_day: unit.rate_day == null ? '' : String(unit.rate_day), rate_night: unit.rate_night == null ? '' : String(unit.rate_night),
                    rate_unit: unit.rate_unit || '/hr', resource_ids: Array.isArray(unit.resource_ids) ? unit.resource_ids.slice() : [],
                    resource_search: '', resource_expanded: false, resource_open: false,
                    maintenance: Array.isArray(unit.maintenance) ? unit.maintenance.map((period) => ({ id: period.id || null, start_at: period.start_at || '', end_at: period.end_at || '', note: period.note || '', publish_at: period.publish_at || null })) : [],
                })),
                resources: Array.isArray(data.resources) ? data.resources.map((resource) => ({ ...resource, id: String(resource.id), name: String(resource.name || 'Court space'), sport_names: Array.isArray(resource.sport_names) && resource.sport_names.length ? resource.sport_names.map(String) : [String(resource.sport_name || resource.sport?.name || 'Other spaces')] })) : [],
                cutoff: data.cutoff || null,
                cover_file: null,
                dirty: false,
            };
        }

        async function getEditor(courtId) {
            const { data, error } = await window.sb.rpc('admin_get_sport_editor', { p_court_id: courtId || null });
            if (error) throw error;
            return normalizeEditor(data);
        }

        async function openEditor(courtId = null) {
            state.returnFocus = document.activeElement;
            title.textContent = courtId ? 'Edit Sport' : 'Add Sport';
            editor.dataset.mode = courtId ? 'edit' : 'add';
            editor.querySelector('[data-ioc-archive]').hidden = !courtId;
            try {
                state.draft = await getEditor(courtId);
                // Keep the original references even when a unit is staged for removal.
                state.draft.originalUnitPhotoUrls = state.draft.units.map((unit) => unit.photo_url).filter(Boolean);
                editor.querySelector('[data-ioc-archive]').textContent = state.draft.listing.is_active ? 'Archive Sport' : 'Restore Sport';
                fillEditor();
                overlay.hidden = false;
                void overlay.offsetWidth;
                overlay.setAttribute('data-open', '');
                editor.focus();
            } catch (error) {
                toast(error.message || 'Could not load this sport editor.', true);
                console.error('[owner-courts] Could not load editor', error);
            }
        }

        function markDirty() { if (state.draft) state.draft.dirty = true; }
        function fillEditor() {
            const draft = state.draft;
            // The former editor had one global resource search/list after all
            // units. Connections are now managed per unit so this duplicate
            // section is intentionally hidden without requiring a markup edit.
            editor.querySelector('[aria-labelledby="iocConnectionsTitle"]')?.setAttribute('hidden', '');
            $('[data-ioc-name]').value = draft.listing.name || '';
            $('[data-ioc-description]').value = draft.listing.description || '';
            $('[data-ioc-unit-kind]').value = ['courts', 'lanes', 'tables'].includes(draft.listing.unit) ? draft.listing.unit : 'courts';
            $('[data-ioc-new-unit-label]').value = '';
            $('[data-ioc-cover-file]').value = '';
            updateCoverPreview();
            renderUnits();
            editor.querySelector('[data-ioc-save]').disabled = false;
            editor.querySelector('.ioc-editor-scroll').scrollTop = 0;
            state.scrollTop = 0;
            setSavebarVisible(true);
        }

        function imageMarkup(url, alt = '') {
            return isSafeImage(url) ? `<img src="${esc(url)}" alt="${esc(alt)}">` : '<span>No photo selected</span>';
        }
        function updateCoverPreview() {
            const holder = $('[data-ioc-cover-preview]');
            holder.innerHTML = state.draft.cover_file ? '' : imageMarkup(state.draft.listing.image_url, 'Sport cover');
            if (state.draft.cover_file) {
                const img = document.createElement('img'); img.alt = 'Sport cover preview';
                const url = URL.createObjectURL(state.draft.cover_file);
                img.onload = img.onerror = () => URL.revokeObjectURL(url);
                img.src = url; holder.replaceChildren(img);
            }
        }

        function updateUnitPhotoPreview(unit, index) {
            if (!unit.photo_file) return;
            const holder = editor.querySelector(`[data-ioc-unit-preview="${index}"]`);
            if (!holder) return;
            const img = document.createElement('img'); img.alt = `${unit.label} photo preview`;
            const url = URL.createObjectURL(unit.photo_file);
            img.onload = img.onerror = () => URL.revokeObjectURL(url);
            img.src = url; holder.replaceChildren(img);
        }

        function renderUnits() {
            const units = state.draft.units;
            $('[data-ioc-unit-count]').textContent = `${units.length} ${units.length === 1 ? 'unit' : 'units'}`;
            if (!units.length) { unitHost.innerHTML = '<p class="ioc-empty">Add at least one unit to make this sport bookable.</p>'; return; }
            unitHost.innerHTML = units.map((unit, index) => {
                const preview = unit.photo_file ? '' : imageMarkup(unit.photo_url, `${unit.label} photo`);
                return `<article class="ioc-unit-card" data-ioc-unit="${index}"><header class="ioc-unit-head"><div><span class="ioc-eyebrow">Unit ${index + 1}</span><h4>${esc(unit.label || `${unitNoun($('[data-ioc-unit-kind]').value)} ${index + 1}`)}</h4></div><button type="button" class="ioc-text-danger" data-ioc-remove-unit="${index}">Remove unit</button></header>
                    <div class="ioc-unit-top"><label class="ioc-field"><span>Unit label</span><input class="admin-input" maxlength="80" value="${esc(unit.label)}" data-ioc-unit-label="${index}"></label><div class="ioc-unit-photo"><div class="ioc-unit-preview" data-ioc-unit-preview="${index}">${preview}</div><label class="ioc-button ioc-button-secondary" for="ioc-unit-photo-${index}">Choose unit photo</label><input class="ioc-file-input" id="ioc-unit-photo-${index}" type="file" accept="image/jpeg,image/png,image/webp" data-ioc-unit-file="${index}"></div></div>
                    <div class="ioc-rate-grid ${unit.rate_unit === '/set' ? 'is-per-set' : ''}" data-ioc-rate-grid="${index}"><label class="ioc-field"><span data-ioc-day-label="${index}">${unit.rate_unit === '/set' ? 'Price per set' : 'Day rate'}</span><input class="admin-input" type="number" min="0" step="0.01" value="${esc(unit.rate_day)}" placeholder="Not set" data-ioc-rate-day="${index}"><small data-ioc-set-hint="${index}" ${unit.rate_unit === '/set' ? '' : 'hidden'}>One set reserves one 60-minute slot.</small></label><label class="ioc-field" data-ioc-night-field="${index}" ${unit.rate_unit === '/set' ? 'hidden' : ''}><span>Night rate</span><input class="admin-input" type="number" min="0" step="0.01" value="${esc(unit.rate_night)}" placeholder="Same as day" data-ioc-rate-night="${index}"></label><label class="ioc-field"><span>Rate basis</span><select class="admin-select" data-ioc-rate-unit="${index}"><option value="/hr" ${unit.rate_unit === '/hr' ? 'selected' : ''}>Per hour</option><option value="/set" ${unit.rate_unit === '/set' ? 'selected' : ''}>Per set (60 minutes)</option></select></label></div>
                    <div class="ioc-unit-connections"><div class="ioc-subhead"><strong>Availability connections</strong><span data-ioc-connection-count="${index}"></span></div><label class="ioc-field ioc-resource-search"><span>Search shared spaces</span><input class="admin-input" type="search" maxlength="100" placeholder="Search by sport or space name…" value="${esc(unit.resource_search)}" data-ioc-resource-search="${index}"></label><div class="ioc-resource-selected" data-ioc-resource-selected="${index}"></div><details class="ioc-resource-details" data-ioc-resource-details="${index}" ${unit.resource_open ? 'open' : ''}><summary>Choose shared spaces</summary><div class="ioc-connection-list" data-ioc-unit-resources="${index}"></div></details></div>
                    <div class="ioc-maintenance"><div class="ioc-subhead"><strong>Scheduled maintenance</strong><button type="button" class="ioc-link-button" data-ioc-add-maintenance="${index}">+ Add period</button></div><div data-ioc-maintenance-list="${index}"></div></div>
                </article>`;
            }).join('');
            units.forEach(updateUnitPhotoPreview);
            unitHost.querySelectorAll('[data-ioc-remove-unit]').forEach((button) => button.addEventListener('click', async () => {
                const index = Number(button.dataset.iocRemoveUnit); const unit = state.draft.units[index];
            const okay = await confirm({ title: 'Remove this unit?', message: `“${unit.label}” will be removed when you save. Units with booking history cannot be removed.`, confirmLabel: 'Remove unit', danger: true });
                if (!okay) return;
                state.draft.units.splice(index, 1); markDirty(); renderUnits();
            }));
            unitHost.querySelectorAll('[data-ioc-unit-label]').forEach((input) => input.addEventListener('input', () => { state.draft.units[Number(input.dataset.iocUnitLabel)].label = input.value; markDirty(); input.closest('.ioc-unit-card').querySelector('h4').textContent = input.value || 'Unit'; }));
            unitHost.querySelectorAll('[data-ioc-rate-day]').forEach((input) => input.addEventListener('input', () => { state.draft.units[Number(input.dataset.iocRateDay)].rate_day = input.value; markDirty(); }));
            unitHost.querySelectorAll('[data-ioc-rate-night]').forEach((input) => input.addEventListener('input', () => { state.draft.units[Number(input.dataset.iocRateNight)].rate_night = input.value; markDirty(); }));
            unitHost.querySelectorAll('[data-ioc-rate-unit]').forEach((input) => input.addEventListener('change', () => {
                const index = Number(input.dataset.iocRateUnit); const unit = state.draft.units[index];
                unit.rate_unit = input.value;
                if (unit.rate_unit === '/set') unit.rate_night = '';
                updateRateFields(index); markDirty();
            }));
            unitHost.querySelectorAll('[data-ioc-unit-file]').forEach((input) => input.addEventListener('change', async () => {
                const draft = state.draft;
                const unit = draft?.units[Number(input.dataset.iocUnitFile)]; const file = input.files?.[0]; input.value = '';
                if (!file || !unit) return;
                try {
                    const cropped = await cropDraftPhoto(file);
                    if (!cropped || state.draft !== draft || !draft.units.includes(unit)) return;
                    unit.photo_file = cropped; markDirty();
                    updateUnitPhotoPreview(unit, draft.units.indexOf(unit));
                } catch (error) { toast(error.message || 'Could not prepare this unit photo.', true); }
            }));
            unitHost.querySelectorAll('[data-ioc-add-maintenance]').forEach((button) => button.addEventListener('click', () => {
                const index = Number(button.dataset.iocAddMaintenance); state.draft.units[index].maintenance.push({ id: null, start_at: '', end_at: '', note: '', publish_at: null }); markDirty(); renderUnits();
            }));
            renderResourceGroups(); renderMaintenance();
        }

        async function cropDraftPhoto(file) {
            if (!window.InigoImageTools?.openCropEditor) throw new Error('The photo crop tool is unavailable. Refresh and try again.');
            const blob = await window.InigoImageTools.openCropEditor(file, { aspect: 16 / 9, maxW: 1600, maxH: 900, quality: 0.85, maxRawBytes: 10 * 1024 * 1024 });
            if (!blob) return null;
            if (blob.size > 5 * 1024 * 1024) throw new Error('The cropped photo is too large. Try a different image.');
            return new File([blob], 'court-photo.jpg', { type: 'image/jpeg' });
        }

        function updateRateFields(index) {
            const unit = state.draft?.units[index]; const card = unitHost.querySelector(`[data-ioc-unit="${index}"]`);
            if (!unit || !card) return;
            const perSet = unit.rate_unit === '/set';
            card.querySelector(`[data-ioc-rate-grid="${index}"]`)?.classList.toggle('is-per-set', perSet);
            const dayLabel = card.querySelector(`[data-ioc-day-label="${index}"]`);
            if (dayLabel) dayLabel.textContent = perSet ? 'Price per set' : 'Day rate';
            const setHint = card.querySelector(`[data-ioc-set-hint="${index}"]`);
            if (setHint) setHint.hidden = !perSet;
            const nightField = card.querySelector(`[data-ioc-night-field="${index}"]`);
            if (nightField) nightField.hidden = perSet;
            const nightInput = card.querySelector(`[data-ioc-rate-night="${index}"]`);
            if (nightInput && perSet) nightInput.value = '';
        }
        function resourceLabel(resource) {
            return String(resource?.name || 'Shared space');
        }
        function updateResourceSummary(index) {
            const unit = state.draft?.units[index]; if (!unit) return;
            const selected = unit.resource_ids.map((id) => state.draft.resources.find((resource) => String(resource.id) === String(id)) || { id, name: 'Previously selected space' });
            const count = editor.querySelector(`[data-ioc-connection-count="${index}"]`);
            const summary = editor.querySelector(`[data-ioc-resource-selected="${index}"]`);
            if (count) count.textContent = `${selected.length} selected`;
            if (summary) {
                if (!selected.length) summary.textContent = 'No spaces selected yet.';
                else {
                    const shown = selected.slice(0, 3).map(resourceLabel);
                    const more = selected.length - shown.length;
                    summary.textContent = `Selected: ${shown.join(', ')}${more ? ` + ${more} more` : ''}`;
                }
            }
        }
        function renderResourceOptions(index, restoreFocusId = null, focusMoreButton = false) {
            const unit = state.draft?.units[index]; const target = editor.querySelector(`[data-ioc-unit-resources="${index}"]`);
            if (!unit || !target) return;
            const selectedIds = new Set(unit.resource_ids.map(String));
            const selected = unit.resource_ids.map((id) => state.draft.resources.find((resource) => String(resource.id) === String(id)) || { id, name: 'Previously selected space', sport_names: [] });
            const query = unit.resource_search.trim().toLocaleLowerCase();
            const matching = state.draft.resources.filter((resource) => !selectedIds.has(String(resource.id)) && `${resource.name} ${(resource.sport_names || []).join(' ')}`.toLocaleLowerCase().includes(query));
            const visible = unit.resource_expanded ? matching : matching.slice(0, 6);
            const option = (resource) => `<label class="ioc-resource-option"><input type="checkbox" value="${esc(resource.id)}" ${selectedIds.has(String(resource.id)) ? 'checked' : ''} data-ioc-resource="${index}"><span>${esc(resource.name)}${resource.sport_names?.length ? `<small>${esc(resource.sport_names.join(' · '))}</small>` : ''}</span></label>`;
            const empty = '<span class="ioc-muted">No matching shared spaces.</span>';
            target.innerHTML = `${selected.length ? `<fieldset class="ioc-resource-group ioc-resource-group-selected"><legend>Selected spaces</legend>${selected.map(option).join('')}</fieldset>` : ''}${visible.length ? `<fieldset class="ioc-resource-group"><legend>Available spaces${query ? ' matching search' : ''}</legend>${visible.map(option).join('')}</fieldset>` : (!selected.length ? empty : query ? '<span class="ioc-muted">No additional matching spaces.</span>' : '')}${matching.length > 6 ? `<button type="button" class="ioc-load-resources" data-ioc-load-resources="${index}">${unit.resource_expanded ? 'Show fewer spaces' : `Show ${matching.length - 6} more spaces`}</button>` : ''}`;
            target.querySelectorAll('[data-ioc-resource]').forEach((checkbox) => checkbox.addEventListener('change', () => {
                const unitDraft = state.draft.units[index]; const id = checkbox.value;
                if (checkbox.checked && !unitDraft.resource_ids.some((current) => String(current) === id)) unitDraft.resource_ids.push(id);
                else if (!checkbox.checked) unitDraft.resource_ids = unitDraft.resource_ids.filter((current) => String(current) !== id);
                markDirty(); updateResourceSummary(index); renderResourceOptions(index, id);
            }));
            target.querySelector('[data-ioc-load-resources]')?.addEventListener('click', (event) => {
                unit.resource_expanded = !unit.resource_expanded; renderResourceOptions(index, null, true);
            });
            if (restoreFocusId !== null) {
                const checkbox = [...target.querySelectorAll('[data-ioc-resource]')].find((input) => input.value === String(restoreFocusId));
                checkbox?.focus();
            } else if (focusMoreButton) target.querySelector('[data-ioc-load-resources]')?.focus();
        }
        function renderResourceGroups() {
            if (!state.draft) return;
            state.draft.units.forEach((unit, index) => {
                const target = editor.querySelector(`[data-ioc-unit-resources="${index}"]`); if (!target) return;
                updateResourceSummary(index);
                const search = editor.querySelector(`[data-ioc-resource-search="${index}"]`);
                search?.addEventListener('input', () => {
                    unit.resource_search = search.value;
                    unit.resource_expanded = false;
                    const details = editor.querySelector(`[data-ioc-resource-details="${index}"]`);
                    if (unit.resource_search.trim()) { unit.resource_open = true; details.open = true; }
                    renderResourceOptions(index);
                });
                const details = editor.querySelector(`[data-ioc-resource-details="${index}"]`);
                details?.addEventListener('toggle', () => { unit.resource_open = details.open; });
                renderResourceOptions(index);
            });
        }
        function renderMaintenance() {
            state.draft.units.forEach((unit, index) => {
                const target = editor.querySelector(`[data-ioc-maintenance-list="${index}"]`); if (!target) return;
                target.innerHTML = unit.maintenance.length ? unit.maintenance.map((period, periodIndex) => `<div class="ioc-maintenance-row" data-ioc-maintenance="${index}:${periodIndex}"><label class="ioc-field"><span>Starts · Manila time</span><input class="admin-input" type="datetime-local" value="${esc(period.start_input ?? timeToManilaInput(period.start_at))}" data-ioc-maint-start="${index}:${periodIndex}"></label><label class="ioc-field"><span>Ends · Manila time</span><input class="admin-input" type="datetime-local" value="${esc(period.end_input ?? timeToManilaInput(period.end_at))}" data-ioc-maint-end="${index}:${periodIndex}"></label><label class="ioc-field"><span>Notice publication · Manila time</span><input class="admin-input" type="datetime-local" value="${esc(period.publish_input ?? timeToManilaInput(period.publish_at))}" aria-label="Maintenance notice publication time" data-ioc-maint-publish="${index}:${periodIndex}"><small>Leave blank to notify customers and staff immediately.</small></label><label class="ioc-field"><span>Note</span><input class="admin-input" maxlength="160" value="${esc(period.note)}" placeholder="Optional" data-ioc-maint-note="${index}:${periodIndex}"></label><button type="button" class="ioc-text-danger" data-ioc-remove-maintenance="${index}:${periodIndex}">Remove</button></div>`).join('') : '<p class="ioc-muted">No maintenance scheduled.</p>';
                target.querySelectorAll('[data-ioc-maint-start],[data-ioc-maint-end],[data-ioc-maint-publish],[data-ioc-maint-note]').forEach((input) => input.addEventListener('input', () => {
                    const key = ['iocMaintStart', 'iocMaintEnd', 'iocMaintPublish', 'iocMaintNote'].find(name => input.dataset[name] !== undefined);
                    const [u, p] = input.dataset[key].split(':'); const period = state.draft.units[Number(u)].maintenance[Number(p)];
                    if (key === 'iocMaintStart') period.start_input = input.value;
                    else if (key === 'iocMaintEnd') period.end_input = input.value;
                    else if (key === 'iocMaintPublish') period.publish_input = input.value;
                    else period.note = input.value;
                    markDirty();
                }));
                target.querySelectorAll('[data-ioc-remove-maintenance]').forEach((button) => button.addEventListener('click', () => {
                    const [u, p] = button.dataset.iocRemoveMaintenance.split(':'); state.draft.units[Number(u)].maintenance.splice(Number(p), 1); markDirty(); renderMaintenance();
                }));
            });
        }

        function addUnit() {
            const kind = $('[data-ioc-unit-kind]').value; const labelInput = $('[data-ioc-new-unit-label]');
            const label = labelInput.value.trim() || `${unitNoun(kind)} ${state.draft.units.length + 1}`;
            if (state.draft.units.some((unit) => unit.label.toLocaleLowerCase() === label.toLocaleLowerCase())) { toast('Each unit needs a unique label.', true); labelInput.focus(); return; }
            state.draft.listing.unit = kind;
            const perSetSport = /bowling|duckpin|ten[ -]?pin/i.test(`${$('[data-ioc-name]').value} ${state.draft.listing.slug}`);
            state.draft.units.push({ id: null, label, photo_url: null, photo_file: null, rate_day: '', rate_night: '', rate_unit: perSetSport ? '/set' : '/hr', resource_ids: defaultResources(), resource_search: '', resource_expanded: false, resource_open: false, maintenance: [] });
            labelInput.value = ''; markDirty(); renderUnits();
            unitHost.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        }

        function uploadPath(file, prefix) {
            const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
            return `courts/${slugify(state.draft.listing.name)}/${prefix}-${crypto.randomUUID()}.${extension}`;
        }
        async function uploadDraftImage(file, prefix) {
            const path = uploadPath(file, prefix);
            const { data, error } = await window.sb.storage.from('media').upload(path, file, { upsert: false, contentType: file.type, cacheControl: '3600' });
            if (error) throw error;
            const { data: publicData } = window.sb.storage.from('media').getPublicUrl(data.path);
            if (!publicData?.publicUrl) {
                await window.sb.storage.from('media').remove([data.path]);
                throw new Error('Could not create a public photo URL.');
            }
            return publicData.publicUrl;
        }
        function storagePathFromUrl(url) {
            try { const parsed = new URL(url); if (parsed.origin !== new URL(window.SUPABASE_URL).origin) return null; const marker = '/storage/v1/object/public/media/'; const at = parsed.pathname.indexOf(marker); return at >= 0 ? decodeURIComponent(parsed.pathname.slice(at + marker.length)) : null; } catch (_) { return null; }
        }
        async function isPhotoStillReferenced(url) {
            if (!url) return true;
            // Ordinary SELECT cannot see archived inventory under its RLS policy.
            // Only a privileged, read-only owner check can prove a media URL unused.
            try {
                const { data, error } = await window.sb.rpc('admin_is_media_url_referenced', { p_url: url });
                if (error || typeof data !== 'boolean') return true;
                return data;
            } catch (_) { return true; }
        }
        async function removeUnreferencedPhoto(url) {
            if (!isSafeImage(url) || await isPhotoStillReferenced(url)) return;
            const path = storagePathFromUrl(url); if (!path) return;
            try { const { error } = await window.sb.storage.from('media').remove([path]); if (error) console.warn('[owner-courts] Could not remove unused photo', error); }
            catch (error) { console.warn('[owner-courts] Could not remove unused photo', error); }
        }

        function buildPayload(uploaded) {
            const draft = state.draft;
            const units = draft.units.map((unit, index) => {
                const inputStart = unit.maintenance.map((p) => p.start_input ?? timeToManilaInput(p.start_at));
                const inputEnd = unit.maintenance.map((p) => p.end_input ?? timeToManilaInput(p.end_at));
                const maintenance = unit.maintenance.map((period, periodIndex) => {
                    const start = manilaInputToISO(inputStart[periodIndex]); const end = manilaInputToISO(inputEnd[periodIndex]);
                    if (!start || !end || new Date(start) >= new Date(end)) throw new Error(`Check the maintenance dates for ${unit.label}. End time must be after start time.`);
                    const publicationInput = period.publish_input !== undefined ? period.publish_input : timeToManilaInput(period.publish_at);
                    const publishAt = publicationInput ? manilaInputToISO(publicationInput) : null;
                    if (publicationInput && !publishAt) throw new Error(`Check the notice publication time for ${unit.label}.`);
                    return { id: period.id, start_at: start, end_at: end, note: period.note.trim() || null, publish_at: publishAt };
                });
                const day = unit.rate_day === '' ? null : Number(unit.rate_day); const night = unit.rate_night === '' ? null : Number(unit.rate_night);
                if ((day !== null && (!Number.isFinite(day) || day < 0)) || (unit.rate_unit !== '/set' && night !== null && (!Number.isFinite(night) || night < 0))) throw new Error(`Enter a valid non-negative rate for ${unit.label}.`);
                return { id: unit.id, label: unit.label.trim(), photo_url: uploaded.get(`unit:${index}`) || unit.photo_url || null, rate_day: day, rate_night: unit.rate_unit === '/set' ? null : night, rate_unit: unit.rate_unit, resource_ids: unit.resource_ids, maintenance };
            });
            if (units.some((unit) => !unit.label)) throw new Error('Every court, lane, or table needs a label.');
            if (!units.length) throw new Error('Add at least one bookable unit.');
            const folded = units.map((unit) => unit.label.toLocaleLowerCase()); if (new Set(folded).size !== folded.length) throw new Error('Unit labels must be unique.');
            const name = $('[data-ioc-name]').value.trim(); if (!name) throw new Error('Enter a sport name.');
            return { court_id: draft.listing.id || null, expected_version: draft.version, slug: draft.listing.slug || slugify(name), name, description: $('[data-ioc-description]').value.trim() || null, unit: $('[data-ioc-unit-kind]').value, image_url: uploaded.get('cover') || draft.listing.image_url || null, is_active: draft.listing.is_active, units };
        }

        async function save() {
            if (!state.draft || state.saving) return;
            let payload;
            try { payload = buildPayload(new Map()); } catch (error) { toast(error.message, true); return; }
            const okay = await confirm({ title: 'Save sport changes?', message: 'This saves the sport details, unit rates, photos, shared spaces, and maintenance periods together.', confirmLabel: 'Save Changes' });
            if (!okay) return;
            const button = editor.querySelector('[data-ioc-save]'); state.saving = true; button.disabled = true; button.textContent = 'Saving…';
            const newlyUploaded = [];
            try {
                const uploaded = new Map();
                if (state.draft.cover_file) { const url = await uploadDraftImage(state.draft.cover_file, 'cover'); uploaded.set('cover', url); newlyUploaded.push(url); }
                for (let index = 0; index < state.draft.units.length; index++) {
                    const unit = state.draft.units[index]; if (!unit.photo_file) continue;
                    const url = await uploadDraftImage(unit.photo_file, `unit-${unit.id || index + 1}`); uploaded.set(`unit:${index}`, url); newlyUploaded.push(url);
                }
                payload = buildPayload(uploaded);
                const oldUrls = [state.draft.listing.image_url, ...state.draft.originalUnitPhotoUrls].filter(Boolean);
                const { data, error } = await window.sb.rpc('admin_save_sport', { p_payload: payload });
                if (error) throw error;
                if (!data?.court_id || !Number.isFinite(Number(data.version))) throw new Error('The server did not confirm the saved sport. Refresh and check before trying again.');
                const kept = new Set([payload.image_url, ...payload.units.map((unit) => unit.photo_url)].filter(Boolean));
                await Promise.all(oldUrls.filter((url) => !kept.has(url)).map(removeUnreferencedPhoto));
                toast('Sport changes saved.'); activity(payload.court_id ? 'Sport updated' : 'Sport added', `${payload.name} · ${payload.units.length} ${payload.unit}`);
                window.InigoCourtsData?.invalidateCourts?.();
                state.draft = null; closeEditor(true); await loadListings();
            } catch (error) {
                await Promise.all(newlyUploaded.map(removeUnreferencedPhoto));
                toast(error.message || 'Could not save sport changes. Your draft is still open.', true);
                console.error('[owner-courts] Save failed; draft retained', error);
            } finally { state.saving = false; button.disabled = false; button.textContent = 'Save Changes'; }
        }

        async function archiveListing() {
            if (!state.draft?.listing.id) return;
            if (state.draft.dirty) { toast('Save or discard your edits before changing the listing status.', true); return; }
            const restore = !state.draft.listing.is_active;
            const okay = await confirm({ title: `${restore ? 'Restore' : 'Archive'} this sport?`, message: restore ? 'The sport and its available units will appear as active again.' : 'The sport will stop appearing as active. Existing booking history is preserved.', confirmLabel: restore ? 'Restore Sport' : 'Archive Sport', danger: !restore });
            if (!okay) return;
            const button = editor.querySelector('[data-ioc-archive]'); button.disabled = true;
            try {
                const payload = buildPayload(new Map()); payload.is_active = restore;
                const { error } = await window.sb.rpc('admin_save_sport', { p_payload: payload }); if (error) throw error;
                toast(restore ? 'Sport restored.' : 'Sport archived.'); activity(restore ? 'Sport restored' : 'Sport archived', payload.name); window.InigoCourtsData?.invalidateCourts?.(); closeEditor(true); await loadListings();
            } catch (error) { toast(error.message || `Could not ${restore ? 'restore' : 'archive'} this sport.`, true); }
            finally { button.disabled = false; }
        }
        async function deleteListing(courtId) {
            const court = state.courts.find((item) => String(item.id) === String(courtId)); if (!court) return;
            const okay = await confirm({ title: 'Delete archived sport?', message: `Permanently delete “${court.name}” and its unused units? Sports with online or walk-in booking history cannot be deleted.`, confirmLabel: 'Delete sport', danger: true });
            if (!okay) return;
            try {
                const snapshot = await getEditor(courtId);
                const urls = [snapshot.listing.image_url, ...snapshot.units.map((unit) => unit.photo_url)].filter(Boolean);
                const { error } = await window.sb.rpc('admin_delete_sport', { p_court_id: courtId, p_expected_version: snapshot.version }); if (error) throw error;
                await Promise.all(urls.map(removeUnreferencedPhoto));
                toast('Sport deleted.'); activity('Sport deleted', court.name); window.InigoCourtsData?.invalidateCourts?.(); await loadListings();
            } catch (error) { toast(error.message || 'Could not delete this sport.', true); }
        }

        function setSavebarVisible(visible, explicit = false) {
            const dock = editor.querySelector('[data-ioc-action-dock]');
            const bar = editor.querySelector('[data-ioc-savebar]');
            const reveal = editor.querySelector('[data-ioc-reveal]');
            if (!visible && !explicit && bar.contains(document.activeElement)) return;
            state.barHidden = !visible;
            dock.classList.toggle('is-collapsed', !visible);
            bar.classList.toggle('is-hidden', !visible);
            bar.inert = !visible;
            bar.setAttribute('aria-hidden', String(!visible));
            reveal.hidden = visible;
            reveal.setAttribute('aria-expanded', String(visible));
            if (!visible && explicit) reveal.focus();
        }
        function closeEditor(force = false) {
            if (!force && state.draft?.dirty) {
                confirm({ title: 'Discard unsaved changes?', message: 'Your sport, unit, photo, connection, and maintenance edits will be lost.', confirmLabel: 'Discard changes', danger: true }).then((okay) => { if (okay) closeEditor(true); }); return;
            }
            overlay.removeAttribute('data-open'); window.setTimeout(() => { overlay.hidden = true; }, 180); state.draft = null;
            if (state.returnFocus?.isConnected) state.returnFocus.focus(); state.returnFocus = null;
        }

        // Cutoff uses the guarded compare-and-set owner RPC from the backend migration.
        const cutoffDisplay = root.querySelector('[data-ioc-cutoff-display]');
        const cutoffOverlay = document.querySelector('[data-ioc-cutoff-overlay]');
        const cutoffInput = cutoffOverlay.querySelector('[data-ioc-cutoff-input]');
        let cutoffOld = null;
        async function loadCutoff() {
            try {
                const { data, error } = await window.sb.from('app_settings').select('night_rate_starts_at').eq('id', true).maybeSingle();
                if (error) throw error; cutoffOld = data?.night_rate_starts_at || null;
                const val = cutoffOld ? String(cutoffOld).slice(0, 5) : null; cutoffDisplay.textContent = val || 'not set'; cutoffInput.value = val || '';
            } catch (error) { cutoffDisplay.textContent = 'unavailable'; console.error('[owner-courts] Could not load cutoff', error); }
        }
        let cutoffReturnFocus = null;
        root.querySelector('[data-ioc-cutoff-edit]').addEventListener('click', () => { cutoffReturnFocus = document.activeElement; cutoffOverlay.hidden = false; void cutoffOverlay.offsetWidth; cutoffOverlay.setAttribute('data-open', ''); cutoffOverlay.querySelector('[data-ioc-cutoff-dialog]').focus(); });
        const closeCutoff = () => { cutoffOverlay.removeAttribute('data-open'); window.setTimeout(() => cutoffOverlay.hidden = true, 180); if (cutoffReturnFocus?.isConnected) cutoffReturnFocus.focus(); cutoffReturnFocus = null; };
        cutoffOverlay.querySelectorAll('[data-ioc-cutoff-close]').forEach((button) => button.addEventListener('click', closeCutoff));
        cutoffOverlay.querySelector('[data-ioc-cutoff-save]').addEventListener('click', async () => {
            const button = cutoffOverlay.querySelector('[data-ioc-cutoff-save]'); button.disabled = true;
            try {
                const value = cutoffInput.value || null;
                const { error } = await window.sb.rpc('admin_set_night_rate_cutoff', { p_expected_cutoff: cutoffOld, p_cutoff: value }); if (error) throw error;
                cutoffOld = value ? `${value}:00` : null; cutoffDisplay.textContent = value || 'not set'; closeCutoff(); toast('Night rate cutoff saved.'); activity('Night rate cutoff updated', value ? `${value} · Asia/Manila` : 'Cleared');
            } catch (error) { toast(error.message || 'Could not save the cutoff.', true); }
            finally { button.disabled = false; }
        });

        root.querySelector('[data-ioc-add]').addEventListener('click', () => openEditor(null));
        root.querySelectorAll('[data-ioc-filter]').forEach((button) => button.addEventListener('click', () => {
            root.querySelectorAll('[data-ioc-filter]').forEach((tab) => { const active = tab === button; tab.classList.toggle('is-active', active); tab.setAttribute('aria-pressed', String(active)); });
            state.filter = button.dataset.iocFilter; renderListings();
        }));
        root.querySelector('[data-ioc-search]').addEventListener('input', (event) => { state.search = event.target.value.trim().toLocaleLowerCase(); renderListings(); });
        editor.querySelector('[data-ioc-add-unit]').addEventListener('click', addUnit);
        editor.querySelector('[data-ioc-unit-kind]').addEventListener('change', () => { state.draft.listing.unit = $('[data-ioc-unit-kind]').value; markDirty(); });
        editor.querySelector('[data-ioc-new-unit-label]').addEventListener('input', markDirty);
        editor.querySelector('[data-ioc-name]').addEventListener('input', markDirty);
        editor.querySelector('[data-ioc-description]').addEventListener('input', markDirty);
        editor.querySelector('[data-ioc-cover-file]').addEventListener('change', async (event) => {
            const draft = state.draft; const file = event.target.files?.[0]; event.target.value = '';
            if (!file || !draft) return;
            try {
                const cropped = await cropDraftPhoto(file);
                if (!cropped || state.draft !== draft) return;
                draft.cover_file = cropped; markDirty(); updateCoverPreview();
            } catch (error) { toast(error.message || 'Could not prepare this cover photo.', true); }
        });
        editor.querySelector('[data-ioc-save]').addEventListener('click', save);
        editor.querySelector('[data-ioc-cancel]').addEventListener('click', () => closeEditor());
        editor.querySelector('[data-ioc-close]').addEventListener('click', () => closeEditor());
        editor.querySelector('[data-ioc-archive]').addEventListener('click', archiveListing);
        editor.querySelector('[data-ioc-reveal]').addEventListener('click', () => { setSavebarVisible(true, true); editor.querySelector('[data-ioc-save]')?.focus(); });
        editor.querySelector('[data-ioc-hide]').addEventListener('click', () => setSavebarVisible(false, true));
        editor.querySelector('[data-ioc-savebar]').addEventListener('focusin', () => setSavebarVisible(true));
        editor.querySelector('.ioc-editor-scroll').addEventListener('scroll', (event) => {
            const top = event.currentTarget.scrollTop; if (top > state.scrollTop + 4) setSavebarVisible(true); else if (top < state.scrollTop - 4) setSavebarVisible(false); state.scrollTop = top;
        }, { passive: true });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !overlay.hidden && document.querySelector('.itools-crop-overlay:not([hidden])') === null) closeEditor();
            if (event.key === 'Escape' && !cutoffOverlay.hidden) closeCutoff();
        });
        overlay.addEventListener('mousedown', (event) => { overlay.dataset.downBackdrop = String(event.target === overlay); });
        overlay.addEventListener('click', (event) => { if (event.target === overlay && overlay.dataset.downBackdrop === 'true') closeEditor(); overlay.dataset.downBackdrop = 'false'; });

        window.InigoOwnerCourts = { refresh: loadListings };
        loadListings(); loadCutoff();
    });
})();
