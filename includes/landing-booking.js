// Guest booking drafts use public court data and local opening-hour defaults.
// Selections stay in this tab's browser storage until sign-in; this never creates a reservation.
(function () {
    const HANDOFF_KEY = 'inigosync:landing-booking-draft:v1';
    const MAX_ITEMS = 8;
    const viewer = document.querySelector('[data-court-viewer]');
    const root = document.querySelector('[data-landing-booking-modal]');
    if (!viewer || !root) return;

    const dateInput = root.querySelector('[data-landing-book-date]');
    const status = root.querySelector('[data-landing-book-status]');
    const slots = root.querySelector('[data-landing-book-slots]');
    const addButton = root.querySelector('[data-landing-book-add]');
    const selectedCourt = root.querySelector('[data-landing-booking-selected-court]');
    const cart = document.querySelector('[data-landing-draft-cart]');
    const cartToggle = document.querySelector('[data-landing-draft-toggle]');
    const cartContent = document.querySelector('[data-landing-draft-content]');
    const cartItems = document.querySelector('[data-landing-draft-items]');
    const cartStatus = document.querySelector('[data-landing-draft-status]');
    const continueButton = document.querySelector('[data-landing-draft-continue]');
    const detailContinueButton = document.querySelector('[data-landing-draft-details-continue]');
    const detailsModal = document.querySelector('[data-landing-draft-details-modal]');
    const detailsDialog = detailsModal?.querySelector('[role="dialog"]');
    const detailsCount = document.querySelector('[data-landing-draft-details-count]');
    const detailsTotal = document.querySelector('[data-landing-draft-details-total]');
    const cartCount = document.querySelector('[data-landing-draft-count]');
    const cartTotal = document.querySelector('[data-landing-draft-total]');
    const cartPreview = document.querySelector('[data-landing-draft-preview]');
    let activeCourt = null;
    let activeListing = null;
    let activeUnits = [];
    let selectedUnit = null;
    let viewerSelection = null;
    let rules = null;
    let selectedHours = new Set();
    let draftItems = [];
    let draftCreatedAt = null;
    let refreshSeq = 0;
    let detailsReturnFocus = null;
    let cartExpanded = true;

    function setCartExpanded(expanded) {
        cartExpanded = expanded;
        if (!cart || !cartToggle || !cartContent) return;
        cart.dataset.collapsed = expanded ? 'false' : 'true';
        cartToggle.setAttribute('aria-expanded', String(expanded));
        cartToggle.setAttribute('aria-label', expanded ? 'Hide booking cart' : 'Show booking cart');
        cartToggle.querySelector('[aria-hidden="true"]').textContent = expanded ? '↓' : '↑';
        cartContent.inert = !expanded;
        cartContent.setAttribute('aria-hidden', String(!expanded));
    }

    function validRestoredDraft(payload) {
        const ageMs = Date.now() - Number(payload?.createdAt);
        if (payload?.version !== 1 || !Array.isArray(payload.items) || !payload.items.length
            || payload.items.length > MAX_ITEMS || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 24 * 60 * 60 * 1000) return false;
        let rangeCount = 0;
        for (const item of payload.items) {
            if (!item || typeof item.listingSlug !== 'string' || item.listingSlug.length > 120
                || typeof item.court !== 'string' || item.court.length > 160
                || typeof item.sport !== 'string' || item.sport.length > 120
                || typeof item.unit !== 'string' || item.unit.length > 160
                || typeof item.unitId !== 'string' || item.unitId.length > 80
                || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)
                || !Array.isArray(item.hours) || !item.hours.length || item.hours.length > 24
                || item.hours.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23)
                || (item.resourceIds !== undefined && (!Array.isArray(item.resourceIds) || item.resourceIds.length > 32
                    || item.resourceIds.some((id) => typeof id !== 'string' || id.length > 80)))) return false;
            const parsedDate = new Date(`${item.date}T00:00:00Z`);
            if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== item.date) return false;
            rangeCount += window.InigoBookingSlots.groupConsecutiveHours(item.hours).length;
            if (rangeCount > MAX_ITEMS) return false;
        }
        return true;
    }

    function restoreDraftItems() {
        try {
            const raw = sessionStorage.getItem(HANDOFF_KEY);
            if (!raw) return;
            const payload = JSON.parse(raw);
            if (!validRestoredDraft(payload)) {
                sessionStorage.removeItem(HANDOFF_KEY);
                return;
            }
            draftItems = payload.items.map((item) => ({ ...item, hours: [...new Set(item.hours)], resourceIds: item.resourceIds || [] }));
            draftCreatedAt = Number(payload.createdAt);
            cartStatus.textContent = 'Browser-only draft restored. No reservation or payment has been created.';
        } catch (error) {
            try { sessionStorage.removeItem(HANDOFF_KEY); } catch (_) { /* storage may be disabled */ }
            console.warn('[landing booking] could not restore the tab draft', error);
        }
    }

    function persistDraftItems() {
        if (!draftItems.length) {
            draftCreatedAt = null;
            try { sessionStorage.removeItem(HANDOFF_KEY); return true; } catch (_) { return false; }
        }
        draftCreatedAt = Date.now();
        try {
            sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ version: 1, items: draftItems.slice(0, MAX_ITEMS), createdAt: draftCreatedAt }));
            return true;
        } catch (error) {
            cartStatus.textContent = 'This browser could not save the draft in this tab. No reservation has been created.';
            console.warn('[landing booking] could not save the tab draft', error);
            return false;
        }
    }

    restoreDraftItems();

    function today() {
        return window.InigoBusinessHours?.dateInManila?.() || new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
    }

    function setStatus(message, isError = false) {
        if (!status) return;
        status.textContent = message;
        status.dataset.error = isError ? 'true' : 'false';
    }

    function renderSlots() {
        if (!slots) return;
        addButton.disabled = true;
        if (!activeListing || !dateInput.value) {
            slots.replaceChildren();
            setStatus('Choose a court and date to see provisional hours.');
            return;
        }
        if (!rules || !activeUnits.length) {
            slots.replaceChildren();
            setStatus('Verified court inventory is not available for this listing.', true);
            return;
        }
        const hours = window.InigoBusinessHours.hoursRange();
        const available = hours.filter((hour) => !isDraftHour(hour)
            && new Date(window.InigoBookingSlots.localDateHourToIso(dateInput.value, hour)).getTime() >= Date.now());
        selectedHours = new Set([...selectedHours].filter((hour) => available.includes(hour)));
        slots.innerHTML = hours.map((hour) => {
            const isPast = new Date(window.InigoBookingSlots.localDateHourToIso(dateInput.value, hour)).getTime() < Date.now();
            const inDraft = !isPast && isDraftHour(hour);
            const disabled = isPast || inDraft;
            const selected = selectedHours.has(hour);
            const label = window.InigoBusinessHours.formatHourRangeLabelShort(hour);
            const suffix = isPast ? ' · Passed' : inDraft ? ' · In draft cart' : '';
            return `<button type="button" class="landing-booking-slot" data-landing-slot="${hour}" aria-pressed="${selected}"${disabled ? ' disabled' : ''}>${window.escapeHtml(label + suffix)}</button>`;
        }).join('') || '<p>No bookable hours are configured for this date.</p>';
        const selectedCount = selectedHours.size;
        setStatus(selectedCount ? `${selectedCount} provisional hour${selectedCount === 1 ? '' : 's'} selected. Live availability is checked after sign in.`
            : 'Provisional hours only. Live availability and date-specific closures are checked after sign in.');
        addButton.disabled = !selectedCount;
    }

    async function refreshAvailability(_force = true, preserveSelection = false) {
        const seq = ++refreshSeq;
        if (!preserveSelection) selectedHours.clear();
        rules = window.InigoBusinessHours ? {
            openHour: window.InigoBusinessHours.OPEN_HOUR,
            closeHour: window.InigoBusinessHours.CLOSE_HOUR,
        } : null;
        renderSlots();
        if (!window.InigoBusinessHours || !window.InigoBookingSlots || !activeListing || !dateInput.value) return;
        if (seq === refreshSeq) renderSlots();
    }

    function updateListing() {
        activeListing = viewerSelection?.listing || activeCourt;
        const dataCourt = (window.__landingBookableCourts || []).find((court) => activeListing?.slug
            ? court.slug === activeListing.slug : court.name === activeListing?.name);
        const resolved = dataCourt && window.InigoCourtsData && !dataCourt.inventoryLoadFailed
            ? window.InigoCourtsData.resolveCourtUnits(dataCourt).units.filter((unit) => unit.id)
            : [];
        activeUnits = resolved;
        selectedUnit = resolved.find((unit) => viewerSelection?.unit?.id && unit.id === viewerSelection.unit.id)
            || resolved.find((unit) => viewerSelection?.unit?.label && unit.label === viewerSelection.unit.label)
            || resolved[viewerSelection?.unitIndex || 0] || null;
        if (!resolved.length || !selectedUnit) {
            setStatus('This listing has no verified bookable inventory yet.', true);
        }
        refreshAvailability();
    }

    function renderCart() {
        if (!cart || !cartItems) return;
        cart.hidden = draftItems.length === 0;
        const rangeCount = draftItems.reduce((count, item) => count + window.InigoBookingSlots.groupConsecutiveHours(item.hours).length, 0);
        const hasHourlyRate = (item) => item.rateUnit === '/hr' && item.rate !== null && item.rate !== undefined
            && item.rate !== '' && Number.isFinite(Number(item.rate));
        const estimate = draftItems.every(hasHourlyRate)
            ? draftItems.reduce((sum, item) => sum + Number(item.rate) * item.hours.length, 0)
            : null;
        const estimateLabel = estimate === null ? 'Rate TBA' : `₱${estimate.toLocaleString('en-PH', { maximumFractionDigits: 2 })}`;
        if (cartCount) cartCount.textContent = `${rangeCount} booking${rangeCount === 1 ? '' : 's'} selected`;
        if (cartTotal) cartTotal.textContent = estimateLabel;
        if (detailsCount) detailsCount.textContent = `${rangeCount} booking${rangeCount === 1 ? '' : 's'} in this browser-only draft`;
        if (detailsTotal) detailsTotal.textContent = estimateLabel;
        if (cartPreview) cartPreview.innerHTML = draftItems.slice(0, 2).map((item) => `<span>${window.escapeHtml(item.court)} · ${window.escapeHtml(item.unit)} · ${window.escapeHtml(item.date)}</span>`).join('')
            + (draftItems.length > 2 ? `<small>+ ${draftItems.length - 2} more</small>` : '');
        cartItems.innerHTML = draftItems.map((item, index) => `<li><span class="landing-draft-item"><strong>${window.escapeHtml(item.court)} · ${window.escapeHtml(item.unit)}</strong><span>${window.escapeHtml(item.date)} · ${window.escapeHtml(item.hours.map((hour) => window.InigoBusinessHours.formatHourRangeLabelShort(hour)).join(', '))}</span><small>${hasHourlyRate(item) ? `₱${(Number(item.rate) * item.hours.length).toLocaleString('en-PH', { maximumFractionDigits: 2 })} estimated` : 'Rate TBA'}</small></span><button type="button" class="landing-draft-remove" data-landing-draft-remove="${index}">Remove</button></li>`).join('');
        continueButton.disabled = draftItems.length === 0;
        if (detailContinueButton) detailContinueButton.disabled = draftItems.length === 0;
        if (!draftItems.length) cartStatus.textContent = '';
    }

    function closeDetails() {
        if (!detailsModal || detailsModal.hidden) return;
        detailsModal.hidden = true;
        document.body?.classList.remove('landing-draft-details-open');
        if (!document.querySelector('[data-auth-overlay][data-open]')) detailsReturnFocus?.focus?.();
        detailsReturnFocus = null;
    }

    function openDetails(invoker) {
        if (!detailsModal || !draftItems.length) return;
        detailsReturnFocus = invoker || document.activeElement;
        renderCart();
        detailsModal.hidden = false;
        document.body?.classList.add('landing-draft-details-open');
        detailsDialog?.focus();
    }

    function closeBookingPopup(restoreCourtFocus = true) {
        root.hidden = true;
        document.body?.classList.remove('landing-booking-open');
        if (restoreCourtFocus) document.dispatchEvent(new CustomEvent('inigo:landing-booking-close'));
    }

    function continueToAuth() {
        if (!draftItems.length || !persistDraftItems()) return;
        closeDetails();
        document.dispatchEvent(new CustomEvent('inigo:landing-booking-auth'));
        document.querySelector('[data-auth-open="login"]')?.click();
    }

    function cartConflict(item, existing) {
        if (item.date !== existing.date) return false;
        if (!item.hours.some((hour) => existing.hours.includes(hour))) return false;
        const resources = new Set(item.resourceIds || []);
        if (resources.size && (existing.resourceIds || []).some((id) => resources.has(id))) return true;
        if (resources.size && (existing.resourceIds || []).length) return false;
        if (item.listingSlug !== existing.listingSlug || item.unitId !== existing.unitId) return false;
        return true;
    }

    function isDraftHour(hour) {
        const unit = selectedUnit;
        if (!unit) return false;
        return draftItems.some((item) => cartConflict({
            listingSlug: activeListing?.slug,
            unitId: unit.id,
            resourceIds: unit.resourceIds || [],
            date: dateInput.value,
            hours: [hour],
        }, item));
    }

    dateInput?.addEventListener('change', () => {
        if (dateInput.value < today()) dateInput.value = today();
        refreshAvailability();
    });
    slots?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-landing-slot]');
        if (!button || button.disabled) return;
        const hour = Number(button.dataset.landingSlot);
        if (selectedHours.has(hour)) selectedHours.delete(hour); else selectedHours.add(hour);
        renderSlots();
    });
    addButton?.addEventListener('click', async () => {
        if (addButton.disabled || !activeListing || !window.InigoCourtsData) return;
        const wantedHours = [...selectedHours].sort((a, b) => a - b);
        await refreshAvailability(true, true);
        if (!rules || wantedHours.some((hour) => !selectedHours.has(hour)
            || new Date(window.InigoBookingSlots.localDateHourToIso(dateInput.value, hour)).getTime() < Date.now())) {
            setStatus('The selected date or hours are no longer valid. Choose the provisional hours again.', true);
            return;
        }
        const listing = (window.__landingBookableCourts || []).find((court) => activeListing.slug
            ? court.slug === activeListing.slug : court.name === activeListing.name);
        const unit = selectedUnit;
        if (!listing?.id || !unit?.id) {
            setStatus('This court needs verified inventory before it can be added to the booking cart.', true);
            return;
        }
        const newItem = {
            listingSlug: listing.slug,
            court: listing.name,
            sport: listing.sportName || listing.name,
            unit: unit.label,
            unitId: unit.id,
            resourceIds: unit.resourceIds || [],
            date: dateInput.value,
            hours: wantedHours,
            rate: listing.rate,
            rateUnit: listing.rateUnit || '/hr',
        };
        const runs = window.InigoBookingSlots.groupConsecutiveHours(wantedHours);
        if (draftItems.reduce((count, item) => count + window.InigoBookingSlots.groupConsecutiveHours(item.hours).length, 0) + runs.length > MAX_ITEMS) {
            setStatus('Your draft cart can include up to eight booking ranges.', true);
            return;
        }
        if (draftItems.some((item) => cartConflict(newItem, item))) {
            setStatus('A selected hour overlaps another draft on this court. Remove it or choose another time.', true);
            return;
        }
        draftItems.push(newItem);
        persistDraftItems();
        selectedHours.clear();
        renderSlots();
        renderCart();
        setCartExpanded(true);
        cartStatus.textContent = 'Browser-only draft. No reservation or payment has been created; live availability is checked after sign in.';
        root.hidden = true;
        document.body?.classList.remove('landing-booking-open');
        document.querySelector('[data-landing-draft-details]')?.focus();
    });
    cartItems?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-landing-draft-remove]');
        if (!button) return;
        draftItems.splice(Number(button.dataset.landingDraftRemove), 1);
        persistDraftItems();
        renderSlots();
        renderCart();
    });
    document.querySelector('[data-landing-draft-details]')?.addEventListener('click', (event) => openDetails(event.currentTarget));
    cartToggle?.addEventListener('click', () => setCartExpanded(!cartExpanded));
    document.querySelectorAll('[data-landing-draft-details-close]').forEach((button) => button.addEventListener('click', closeDetails));
    document.addEventListener('keydown', (event) => {
        if (detailsModal?.hidden || document.querySelector('[data-auth-overlay][data-open]')) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            closeDetails();
            return;
        }
        if (event.key !== 'Tab' || !detailsDialog) return;
        const focusable = [...detailsDialog.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')];
        if (!focusable.length) { event.preventDefault(); detailsDialog.focus(); return; }
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    document.querySelector('[data-landing-draft-clear]')?.addEventListener('click', () => {
        draftItems = [];
        persistDraftItems();
        renderSlots();
        renderCart();
    });
    continueButton?.addEventListener('click', continueToAuth);
    detailContinueButton?.addEventListener('click', continueToAuth);
    root.querySelector('[data-landing-book-back]')?.addEventListener('click', () => {
        closeBookingPopup(false);
        if (viewerSelection) document.dispatchEvent(new CustomEvent('inigo:landing-booking-back-to-court', { detail: viewerSelection }));
    });
    root.querySelectorAll('[data-landing-booking-close]').forEach((button) => button.addEventListener('click', () => {
        closeBookingPopup();
    }));
    document.addEventListener('inigo:landing-court-next', (event) => {
        viewerSelection = event.detail || null;
        activeCourt = viewerSelection?.court || null;
        activeListing = viewerSelection?.listing || null;
        dateInput.min = today();
        if (!dateInput.value || dateInput.value < dateInput.min) dateInput.value = dateInput.min;
        updateListing();
        selectedCourt.textContent = [activeListing?.name, viewerSelection?.unit?.label].filter(Boolean).join(' · ');
        root.hidden = false;
        document.body?.classList.add('landing-booking-open');
        root.querySelector('[data-landing-booking-dialog]')?.focus();
    });
    document.addEventListener('keydown', (event) => {
        if (root.hidden || document.querySelector('[data-landing-draft-details-modal]:not([hidden])')
            || document.querySelector('[data-auth-overlay][data-open]')) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            closeBookingPopup();
            return;
        }
        if (event.key !== 'Tab') return;
        const dialog = root.querySelector('[data-landing-booking-dialog]');
        const focusable = [...dialog.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')];
        if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    document.addEventListener('inigo:landing-court-open', (event) => { activeCourt = event.detail?.court || null; });
    document.addEventListener('inigo:landing-booking-auth', () => {
        root.hidden = true;
        document.body?.classList.remove('landing-booking-open');
    });
    document.addEventListener('inigo:landing-courts-data-ready', (event) => {
        window.__landingBookableCourts = event.detail?.courts || [];
        if (activeCourt) updateListing();
    });

    setCartExpanded(true);
    renderCart();
    window.InigoCourtsData?.getCourts().then((courts) => {
        window.__landingBookableCourts = courts || [];
        document.dispatchEvent(new CustomEvent('inigo:landing-courts-data-ready', { detail: { courts: window.__landingBookableCourts } }));
    }).catch((error) => console.warn('[landing booking] court inventory could not be loaded', error));
})();
