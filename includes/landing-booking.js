// Guest booking drafts use public court data and local opening-hour defaults.
// Selections stay in this tab's browser storage until sign-in; this never creates a reservation.
(function () {
    const HANDOFF_KEY = 'inigosync:landing-booking-draft:v1';
    const root = document.querySelector('[data-landing-booking-modal]');
    if (!root) return;

    const dateInput = root.querySelector('[data-landing-book-date]');
    const status = root.querySelector('[data-landing-book-status]');
    const slots = root.querySelector('[data-landing-book-slots]');
    const continueButton = root.querySelector('[data-landing-book-continue]');
    const summaryCourt = root.querySelector('[data-booking-summary-court]');
    const summaryDate = root.querySelector('[data-booking-summary-date]');
    const summaryTime = root.querySelector('[data-booking-summary-time]');
    const summaryTotal = root.querySelector('[data-booking-summary-total]');
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

    function validRestoredDraft(payload) {
        const ageMs = Date.now() - Number(payload?.createdAt);
        if (payload?.version !== 1 || !Array.isArray(payload.items) || payload.items.length !== 1
            || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 24 * 60 * 60 * 1000) return false;
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
            if (window.InigoBookingSlots.groupConsecutiveHours(item.hours).length !== 1) return false;
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
            sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ version: 1, items: draftItems.slice(0, 1), createdAt: draftCreatedAt }));
            return true;
        } catch (error) {
            setStatus('This browser could not save your booking in this tab. Please try again.', true);
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

    function renderSummary() {
        if (summaryCourt) summaryCourt.textContent = [activeListing?.name, selectedUnit?.label].filter(Boolean).join(' · ') || 'Select a court';
        if (summaryDate) summaryDate.textContent = dateInput.value
            ? new Date(`${dateInput.value}T00:00:00`).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
            : 'Choose a date';
        const hours = [...selectedHours].sort((a, b) => a - b);
        const ranges = window.InigoBookingSlots.groupConsecutiveHours(hours);
        if (summaryTime) summaryTime.textContent = !hours.length ? 'Select hours'
            : ranges.length !== 1 ? 'Choose consecutive hours'
                : `${window.InigoBusinessHours.formatHourRangeLabelShort(hours[0]).split('–')[0].trim()} – ${window.InigoBusinessHours.formatHourRangeLabelShort(hours[hours.length - 1]).split('–').at(-1).trim()}`;
        const dayRate = selectedUnit?.rateDay;
        const nightRate = selectedUnit?.rateNight;
        const unitRate = selectedUnit?.rateUnit || activeListing?.rateUnit || '/hr';
        let hourlyRate = null;
        if (unitRate === '/hr') {
            if (typeof dayRate === 'number' && Number.isFinite(dayRate)
                && (typeof nightRate !== 'number' || nightRate === dayRate)) hourlyRate = dayRate;
            else if (typeof dayRate !== 'number' && typeof nightRate !== 'number'
                && typeof activeListing?.rate === 'number' && Number.isFinite(activeListing.rate)) hourlyRate = activeListing.rate;
        }
        if (summaryTotal) summaryTotal.textContent = hourlyRate !== null && hours.length
            ? `₱${(hourlyRate * hours.length).toLocaleString('en-PH', { maximumFractionDigits: 2 })} estimated`
            : 'Confirmed after sign in';
    }

    function renderSlots() {
        if (!slots) return;
        renderSummary();
        continueButton.disabled = true;
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
        const available = hours.filter((hour) =>
            new Date(window.InigoBookingSlots.localDateHourToIso(dateInput.value, hour)).getTime() >= Date.now());
        selectedHours = new Set([...selectedHours].filter((hour) => available.includes(hour)));
        slots.innerHTML = hours.map((hour) => {
            const isPast = new Date(window.InigoBookingSlots.localDateHourToIso(dateInput.value, hour)).getTime() < Date.now();
            const disabled = isPast;
            const selected = selectedHours.has(hour);
            const label = window.InigoBusinessHours.formatHourRangeLabelShort(hour);
            const time = `<span class="landing-booking-slot-time">${window.escapeHtml(label)}</span>`;
            const state = isPast ? '<span class="landing-booking-slot-state">Passed</span>' : '';
            return `<button type="button" class="landing-booking-slot" data-landing-slot="${hour}" aria-pressed="${selected}"${disabled ? ' disabled' : ''}>${time}${state}</button>`;
        }).join('') || '<p>No bookable hours are configured for this date.</p>';
        const selectedCount = selectedHours.size;
        const oneRange = window.InigoBookingSlots.groupConsecutiveHours([...selectedHours]).length === 1;
        setStatus(selectedCount && !oneRange ? 'Choose consecutive hours for one court booking.'
            : selectedCount ? `${selectedCount} provisional hour${selectedCount === 1 ? '' : 's'} selected. Live availability is checked after sign in.`
            : 'Provisional hours only. Live availability and date-specific closures are checked after sign in.');
        continueButton.disabled = !selectedCount || !oneRange;
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
        renderSummary();
        refreshAvailability();
    }

    function closeBookingPopup(restoreCourtFocus = true) {
        if (restoreCourtFocus) document.querySelector('[data-court-viewer-close]')?.click();
        else {
            root.hidden = true;
            document.body?.classList.remove('landing-booking-open');
        }
    }

    function continueToAuth() {
        if (!draftItems.length || !persistDraftItems()) return;
        document.dispatchEvent(new CustomEvent('inigo:landing-booking-auth'));
        document.querySelector('[data-auth-open="login"]')?.click();
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
    continueButton?.addEventListener('click', async () => {
        if (continueButton.disabled || !activeListing || !window.InigoCourtsData) return;
        const wantedHours = [...selectedHours].sort((a, b) => a - b);
        await refreshAvailability(true, true);
        if (!rules || window.InigoBookingSlots.groupConsecutiveHours(wantedHours).length !== 1 || wantedHours.some((hour) => !selectedHours.has(hour)
            || new Date(window.InigoBookingSlots.localDateHourToIso(dateInput.value, hour)).getTime() < Date.now())) {
            setStatus('Choose one consecutive time range on a valid date before continuing.', true);
            return;
        }
        const listing = (window.__landingBookableCourts || []).find((court) => activeListing.slug
            ? court.slug === activeListing.slug : court.name === activeListing.name);
        const unit = selectedUnit;
        if (!listing?.id || !unit?.id) {
            setStatus('This court needs verified inventory before it can be booked.', true);
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
        draftItems = [newItem];
        persistDraftItems();
        continueToAuth();
    });
    document.addEventListener('inigo:landing-court-selection', (event) => {
        viewerSelection = event.detail || null;
        activeCourt = viewerSelection?.court || null;
        activeListing = viewerSelection?.listing || null;
        dateInput.min = today();
        if (!dateInput.value || dateInput.value < dateInput.min) dateInput.value = dateInput.min;
        updateListing();
        renderSummary();
    });
    root.querySelector('[data-landing-book-cancel]')?.addEventListener('click', () => closeBookingPopup());
    document.addEventListener('inigo:landing-court-open', (event) => { activeCourt = event.detail?.court || null; });
    document.addEventListener('inigo:landing-booking-auth', () => {
        closeBookingPopup(false);
    });
    document.addEventListener('inigo:landing-courts-data-ready', (event) => {
        window.__landingBookableCourts = event.detail?.courts || [];
        if (activeCourt) updateListing();
    });

    window.InigoCourtsData?.getCourts().then((courts) => {
        window.__landingBookableCourts = courts || [];
        document.dispatchEvent(new CustomEvent('inigo:landing-courts-data-ready', { detail: { courts: window.__landingBookableCourts } }));
    }).catch((error) => console.warn('[landing booking] court inventory could not be loaded', error));
})();
