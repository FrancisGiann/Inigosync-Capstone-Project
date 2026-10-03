// IñigoSync landing page: published Supabase content, shared in-flight requests,
// decorative sport cards and an original-photo viewer with type/unit selection.
// Empty/error states never substitute demonstration records. Content refreshes
// when the tab becomes visible and court details refresh before the viewer opens.

// ============================================================================
// Escaping — the ONE place untrusted text is allowed to become HTML.
// ============================================================================
// Every court/event field below can come from Supabase, which
// staff/admin accounts can write to (see the RLS policies in
// database/schema/002_content_tables.sql). A court named
// `<img onerror=alert(1)>` must render as literal text, not run — so every
// interpolated value that reaches innerHTML goes through this first.
//
// The implementation now lives in the shared includes/escape.js (loaded
// before this file — see the <script> order in Pages/Index.html) so the
// dashboard controllers can reuse the exact same function instead of a
// second copy that could drift. This is just a local alias for brevity.
const escapeHtml = window.escapeHtml;

// ============================================================================
// Original-photo slots. Published database covers take precedence; the
// individually cropped sport covers are an honest local fallback until a
// shared database URL has been assigned to a listing.
const SPORT_MONOGRAM = {
    'basketball': 'BB',
    'badminton': 'BD',
    'lawn-tennis': 'LT',
    'pickleball': 'PB',
    'bowling': 'BW',
    'billiards': 'BL',
    'table-tennis': 'TT',
    'volleyball': 'VB',
};

function monogramFor(sportSlug, name) {
    if (sportSlug && SPORT_MONOGRAM[sportSlug]) return SPORT_MONOGRAM[sportSlug];
    const words = String(name || '?').split('—')[0].trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return (words[0] || '?').slice(0, 2).toUpperCase();
}

// Court cards and viewer photos share this slot. The Featured event gallery
// uses its own framed image treatment (see includes/home-showcase.js).
function renderMediaSlot({ imageUrl, alt, monogram }) {
    if (window.InigoVisuals) imageUrl = window.InigoVisuals.venuePhoto(imageUrl);
    const safeAlt = escapeHtml(alt || '');
    if (imageUrl) {
        return `<div class="media-slot has-image"><img src="${escapeHtml(imageUrl)}" alt="${safeAlt}" loading="lazy"></div>`;
    }
    return `<div class="media-slot is-placeholder" role="img" aria-label="Original ${safeAlt} photo not yet available"><span class="venue-photo-placeholder"><span>Original court photo</span><small>Photo placeholder · awaiting venue image</small></span></div>`;
}

// ============================================================================
// Date helpers
// ============================================================================


// `event.event_date` comes back from Supabase as a plain "YYYY-MM-DD"
// string. Appending a local T00:00:00 (rather than parsing the bare date
// string, which JS treats as UTC midnight) avoids it displaying as the
// previous day in timezones behind UTC.
function parseDbDate(value) {
    if (!value) return null;
    const d = new Date(`${value}T00:00:00`);
    return isNaN(d.getTime()) ? null : d;
}

function formatEventDate(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Composes the display line for an event's schedule in the Featured caption.
function formatEventMeta(ev) {
    return [formatEventDate(ev.eventDate), ev.meta].filter(Boolean).join(' · ');
}

// ============================================================================
// Courts: normalize published rows and preserve all variants for the viewer.
// `court.unit_images` — the OPTIONAL per-unit photo list added by
// database/schema/006_court_unit_images.sql, shaped
// [{"label": "Court 1", "image_url": "https://…"}, …].
//
// `public.court` is one row per SPORT, not per bookable unit: Badminton is a
// single row with quantity = 9 and exactly one image_url. This column is what
// lets the court viewer's combobox show a *different* photo for Court 1 vs
// Court 2 (resolveCourtUnits case 1 below).
//
// It is optional in the strongest sense: the column does not exist in the live
// database until the owner applies 006, and getCourts() asks for `select('*')`
// rather than naming columns, so `row.unit_images` is simply `undefined` until
// then. undefined, null, and a malformed value all normalize to [] here, and
// resolveCourtUnits() falls through to the sport's merged rows (Bowling) or to
// "Court N" derived from quantity — so the combobox already works today and
// upgrades in place the moment the owner fills this in.
function normalizeUnitImages(value, contextLabel) {
    if (value === null || value === undefined || value === '') return [];

    let parsed = value;
    // PostgREST returns jsonb already parsed. A string only turns up if the
    // JSON was stored by hand in a text column — parse it rather than
    // silently dropping the owner's data, but never assume it is valid.
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch (err) {
            console.warn('[IñigoSync] court "%s" has an unparseable unit_images value — ignoring it and deriving unit names instead.', contextLabel, err);
            return [];
        }
    }

    if (!Array.isArray(parsed)) {
        console.warn('[IñigoSync] court "%s" has a unit_images value that is not an array — ignoring it. Expected [{"label": "…", "image_url": "…"}].', contextLabel);
        return [];
    }

    return parsed
        .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
        .map((entry) => ({
            // Both fields are optional per entry: a blank label gets a derived
            // "Court N" in resolveCourtUnits, and a blank image_url renders the
            // same honest placeholder the rest of the page uses.
            label: (typeof entry.label === 'string' && entry.label.trim()) ? entry.label.trim() : null,
            imageUrl: (typeof entry.image_url === 'string' && entry.image_url.trim()) ? entry.image_url.trim() : null,
        }));
}

function normalizeCourtFromDb(row) {
    return {
        id: row.id,
        // The embedded sport(slug) is the real grouping key. If that embed
        // is ever missing for some reason, fall back to the court's own
        // slug with the duckpin/ten-pin suffix stripped — same trick
        // normalizeCourtFromFallback uses — so the merge below still finds
        // Bowling's two rows instead of silently splitting them apart.
        sportSlug: (row.sport && row.sport.slug) || String(row.slug || '').replace(/-duckpin$|-tenpin$/, '') || 'general',
        name: row.name || '',
        quantity: Number(row.quantity) || 0,
        unit: row.unit || 'courts',
        note: row.description || '',
        rate: (row.rate === null || row.rate === undefined) ? null : Number(row.rate),
        rateUnit: row.rate_unit || '/hr',
        imageUrl: row.image_url || null,
        // `rating` doesn't exist on `court` until the owner runs
        // database/schema/003_court_rating.sql — undefined and null both
        // mean "no rating yet", never rendered as a fake one (see
        // renderCourtCard below).
        rating: (row.rating === null || row.rating === undefined) ? null : Number(row.rating),
        // Same "column may not exist yet" story as `rating` — see
        // normalizeUnitImages and database/schema/006_court_unit_images.sql.
        unitImages: normalizeUnitImages(row.unit_images, row.slug || row.name),
        unitRates: [],
    };
}

function variantLabel(name) {
    const parts = String(name).split('—');
    return parts.length > 1 ? parts[1].trim() : name;
}

function mergeCourtsBySport(items) {
    const order = [];
    const groups = new Map();

    items.forEach((item) => {
        const key = item.sportSlug;
        if (!groups.has(key)) {
            groups.set(key, []);
            order.push(key);
        }
        groups.get(key).push(item);
    });

    return order.map((key) => {
        const group = groups.get(key);
        if (group.length === 1) return group[0];

        const totalQuantity = group.reduce((sum, c) => sum + c.quantity, 0);
        const note = group.map((c) => `${c.quantity} ${variantLabel(c.name).toLowerCase()}`).join(' · ');
        const baseName = group[0].name.split('—')[0].trim() || group[0].name;
        const withImage = group.find((c) => c.imageUrl);

        return {
            sportSlug: key,
            name: baseName,
            quantity: totalQuantity,
            unit: group[0].unit,
            note,
            rate: group.every(c => c.rate === group[0].rate && c.rateUnit === group[0].rateUnit) ? group[0].rate : null,
            hasVariantRates: !group.every(c => c.rate === group[0].rate && c.rateUnit === group[0].rateUnit),
            rateUnit: group[0].rateUnit,
            imageUrl: withImage ? withImage.imageUrl : null,
            rating: group.every((c) => c.rating === null || c.rating === undefined) ? null : group[0].rating,
            // Every row that went into this card, in DB order. The merge used
            // to throw these away; the court viewer needs them so Bowling can
            // offer "Duckpin" and "Ten-Pin" as two real options with their own
            // image_urls (resolveCourtUnits case 2). Nothing above changed —
            // the grid card and the court viewer's price block still read
            // exactly the same merged fields they did before.
            variants: group,
            // Concatenated so an owner who fills unit_images in on only ONE of
            // a merged sport's rows still lands in case 1. Each entry carries
            // its own owner-written label, so they stay distinguishable.
            unitImages: group.reduce((all, c) => all.concat(c.unitImages || []), []),
        };
    });
}

function formatUnitRate(amount, rateUnit) {
    return `₱${Number(amount).toLocaleString('en-PH', { maximumFractionDigits: 2 })}${rateUnit || '/hr'}`;
}

function unitRateText(unit) {
    const day = typeof unit?.rateDay === 'number' ? unit.rateDay : null;
    const night = typeof unit?.rateNight === 'number' ? unit.rateNight : null;
    const rateUnit = unit?.rateUnit || '/hr';
    if (day !== null && night !== null && day !== night) {
        const period = rateUnit === '/hr' ? ' per hour' : '';
        return `₱${day.toLocaleString('en-PH', { maximumFractionDigits: 2 })} day / ₱${night.toLocaleString('en-PH', { maximumFractionDigits: 2 })} night${period}`;
    }
    if (day !== null) return formatUnitRate(day, rateUnit);
    if (night !== null) return formatUnitRate(night, rateUnit);
    return null;
}

function applyCourtUnitRates(courts, rateRows) {
    const byCourt = new Map();
    (rateRows || []).forEach((row) => {
        const list = byCourt.get(row.court_id) || [];
        list.push({
            id: row.id,
            label: row.label,
            imageUrl: row.photo_url || null,
            rateDay: row.rate_day === null ? null : Number(row.rate_day),
            rateNight: row.rate_night === null ? null : Number(row.rate_night),
            rateUnit: row.rate_unit || '/hr',
        });
        byCourt.set(row.court_id, list);
    });

    courts.forEach((court) => {
        const variants = court.variants?.length ? court.variants : [court];
        variants.forEach((variant) => { variant.unitRates = byCourt.get(variant.id) || []; });
        const unitPhotos = variants.flatMap((variant) => variant.unitRates
            .filter((unit) => unit.imageUrl)
            .map((unit) => ({ label: unit.label, imageUrl: unit.imageUrl, id: unit.id })));
        // Prefer the stable unit inventory photo association; legacy positional
        // arrays remain a fallback for listings not yet edited in the portal.
        if (unitPhotos.length) court.unitImages = unitPhotos;
        const rates = variants.flatMap((variant) => variant.unitRates.flatMap((unit) => [
            ...(typeof unit.rateDay === 'number' ? [{ value: unit.rateDay, unit: unit.rateUnit }] : []),
            ...(typeof unit.rateNight === 'number' ? [{ value: unit.rateNight, unit: unit.rateUnit }] : []),
        ]));
        if (rates.length) {
            const rateUnit = rates[0].unit;
            const lowest = Math.min(...rates.map((rate) => rate.value));
            court.rateLabel = rates.some((rate) => rate.unit !== rateUnit)
                ? 'See rates by type'
                : `From ${formatUnitRate(lowest, rateUnit)}`;
        } else {
            court.rateLabel = court.rate === null ? null : formatUnitRate(court.rate, court.rateUnit);
        }
    });
    return courts;
}

// ============================================================================
// Per-unit photos preserve the full inventory even when only a few photos
// are uploaded. Bowling type is selected separately before resolving its lanes.
const UNIT_NOUN = {
    court: 'Court',
    courts: 'Court',
    lane: 'Lane',
    lanes: 'Lane',
    table: 'Table',
    tables: 'Table',
};

function unitNoun(unit) {
    const key = String(unit || '').trim().toLowerCase();
    if (UNIT_NOUN[key]) return UNIT_NOUN[key];
    // `unit` is free text as far as the DB is concerned and admin Court
    // Listings can write it, so an unknown noun ("bays") is possible. Drop a
    // trailing 's' and title-case it rather than falling back to a generic
    // "Unit 1" that tells the customer nothing.
    const word = key.replace(/s$/, '');
    if (!word) return 'Unit';
    return word.charAt(0).toUpperCase() + word.slice(1);
}

// Returns { pickerLabel, units } where units is [{ label, imageUrl }, …].
// A sport that resolves to fewer than two units gets no combobox at all —
// a one-item <select> is a dead control, not a choice.
function resolveCourtUnits(court) {
    const noun = unitNoun(court.unit);
    const photos = Array.isArray(court.unitImages) ? court.unitImages : [];
    const count = Math.max(0, Math.floor(Number(court.quantity) || 0));
    const units = Array.from({ length: count || Math.max(photos.length, 1) }, (_, i) => {
        // Partial uploads must not remove unphotographed lanes from the picker.
        const numbered = photos.find(entry => Number(entry.label?.match(/(\d+)\s*$/)?.[1]) === i + 1);
        const indexed = photos[i];
        const entry = numbered || (indexed && !/(\d+)\s*$/.test(indexed.label || '') ? indexed : null);
        const specific = Boolean(entry?.imageUrl);
        return {
            label: entry?.label || (count ? noun + ' ' + (i + 1) : null),
            imageUrl: entry?.imageUrl || court.imageUrl || null,
            specific,
        };
    });
    return { pickerLabel: 'Choose a ' + noun.toLowerCase(), units };
}

function normalizeEventFromDb(row) {
    return {
        sportSlug: (row.sport && row.sport.slug) || null,
        tag: row.tag || '',
        title: row.title || '',
        meta: row.meta || '',
        eventDate: parseDbDate(row.event_date),
        imageUrl: row.image_url || null,
    };
}

// Live published content, with shared in-flight requests.
const FETCH_TIMEOUT_MS = 10000;
const contentRequests = new Map();

// Empty published tables are genuinely empty. Failed requests are not demo data.
async function safeSelect(runQuery) {
    if (!window.sb) throw new Error('The content connection is unavailable. Please try again.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const { data, error } = await runQuery().abortSignal(controller.signal);
        if (error) throw error;
        return Array.isArray(data) ? data : [];
    } finally { clearTimeout(timer); }
}
function requestContent(key, force, fetchRows, normalize) {
    let entry = contentRequests.get(key);
    if (entry && (!force || !entry.settled)) return entry.promise;
    entry = { settled: false };
    entry.promise = safeSelect(fetchRows).then(normalize).catch(error => {
        if (contentRequests.get(key) === entry) contentRequests.delete(key);
        throw error;
    }).finally(() => { entry.settled = true; });
    contentRequests.set(key, entry);
    return entry.promise;
}
function getCourts({ force = false } = {}) {
    const courts = requestContent('courts', force, () => window.sb.from('court')
        .select('*, sport(slug, name)').eq('is_active', true).order('display_order'),
        rows => mergeCourtsBySport(rows.map(normalizeCourtFromDb)));
    const rates = requestContent('courtUnitRates', force, () => window.sb.from('court_unit_inventory')
        .select('id,court_id,label,photo_url,rate_day,rate_night,rate_unit')
        .eq('is_active', true).eq('inventory_verified', true), rows => rows)
        .catch((error) => {
            console.warn('[IñigoSync] Unit rates could not be loaded for the public court list; showing TBA until they can be refreshed.', error);
            return [];
        });
    return Promise.all([courts, rates]).then(([courtRows, rateRows]) => applyCourtUnitRates(courtRows, rateRows));
}
function getEvents({ force = false } = {}) {
    return requestContent('events', force, () => window.sb.from('event')
        .select('*, sport(slug, name)').eq('is_published', true).order('display_order'),
        rows => rows.map(normalizeEventFromDb));
}
// Exposed for includes/home-showcase.js, which loads after this file (see
// the <script> order in Pages/Index.html) and needs getEvents() + the same
// escaping/monogram helpers to drive the hero from the same event data
// instead of its own separate hardcoded slides.
window.InigoContent = {
    escapeHtml,
    monogramFor,
    formatEventDate,
    formatEventMeta,
    getCourts,
    getEvents,
};

// ============================================================================
// Card renderers
// ============================================================================
function renderCourtCard(court) {
    const monogram = monogramFor(court.sportSlug, court.name);
    const coverUrl = court.imageUrl || window.InigoVisuals?.sportCover(court.sportSlug) || null;
    const coverHtml = renderMediaSlot({ imageUrl: coverUrl, alt: court.name, monogram });

    // Prefer the verified per-unit rate schedule; listing-level legacy rates
    // remain a fallback for sports without a configured unit schedule.
    const rateHtml = court.rateLabel
        ? `<p class="court-rate">${escapeHtml(court.rateLabel)}</p>`
        : court.hasVariantRates
            ? '<p class="court-rate">See rates by type</p>'
            : court.rate !== null
                ? `<p class="court-rate">₱${escapeHtml(String(court.rate))}<span>${escapeHtml(court.rateUnit)}</span></p>`
                : `<p class="court-rate is-tba">Rate TBA</p>`;

    // Rating: `court.rating` only exists once the owner runs
    // database/schema/003_court_rating.sql, and only renders when a court
    // actually has one — omitted entirely otherwise, never a fake number.
    const ratingHtml = (court.rating !== null && court.rating !== undefined)
        ? `<p class="court-rating"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.9L22 9.6l-5.4 4.9L18 22l-6-3.6L6 22l1.4-7.5L2 9.6l7.1-.7z"/></svg>${escapeHtml(court.rating.toFixed(1))}<span>/ 5</span></p>`
        : '';

    // A real <button>, not an <article> with a click handler: that buys
    // keyboard activation (Enter/Space), focus order and the correct
    // screen-reader role for free, with no tabindex or role patching.
    // data-court-id carries the sport slug, which mergeCourtsBySport
    // guarantees is unique across the rendered list.
    return `
        <button type="button" class="court-card" data-court-id="${escapeHtml(court.sportSlug)}" aria-haspopup="dialog">
            ${coverHtml}
            <div class="court-card-body">
                <h3>${escapeHtml(court.name)}</h3>
                ${ratingHtml}
                <p class="court-count"><span class="court-count-value">${escapeHtml(String(court.quantity))}</span><span class="court-count-unit">${escapeHtml(court.unit)}</span></p>
                ${rateHtml}
                <span class="court-card-open">View court photos
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </span>
            </div>
        </button>
    `;
}

// ============================================================================
// Court viewer — ONE reusable modal for every court card.
//
// Court cards are real <button>s (see renderCourtCard), so activation by
// mouse, Enter and Space all arrive here as a plain click. The dialog:
//   • shows ONE unit's photo large — or, when that unit has no image_url (or
//     the URL fails to load), the same honest .media-slot placeholder the grid
//     uses plus a matching status line;
//   • offers a labelled <select> listing every individual court / lane / table
//     for that sport (resolveCourtUnits above), hidden entirely when a sport
//     resolves to a single unit. Changing it swaps the photo and the unit
//     label in place — the dialog stays open;
//   • closes on Escape, on a backdrop click and on the close button;
//   • moves focus into the dialog on open and back to the invoking card on
//     close, and traps Tab in between;
//   • locks body scroll while open (body.court-viewer-lock).
//
// Every value it injects is either set with textContent or escaped with
// escapeHtml first (D3) — including the unit labels, which come straight out
// of `court.unit_images` and are therefore owner-written free text. No image
// path is hardcoded anywhere — the photos are whatever `court.image_url` /
// `court.unit_images[].image_url` hold, which the owner sets through admin
// Court Listings and the SQL editor respectively (OQ1).
// ============================================================================
function createCourtViewer() {
    const root = document.querySelector('[data-court-viewer]');
    if (!root) return null;

    const dialog = root.querySelector('[data-court-viewer-dialog]');
    const mediaEl = root.querySelector('[data-court-viewer-media]');
    const titleEl = root.querySelector('[data-court-viewer-title]');
    const unitEl = root.querySelector('[data-court-viewer-unit]');
    const pickerEl = root.querySelector('[data-court-viewer-units]');
    const typePicker = root.querySelector('[data-court-viewer-types]');
    const typeSelect = root.querySelector('[data-court-viewer-type]');
    const pickerLabelEl = root.querySelector('[data-court-viewer-units-label]');
    const selectEl = root.querySelector('[data-court-viewer-select]');
    const noteEl = root.querySelector('[data-court-viewer-note]');
    // bookEl ("What you book") + rateEl together are the price block that
    // replaced the old #pricing section's rate sheet in the Courts+Pricing
    // merge — see the comment above it in Pages/Index.html. bookEl also
    // absorbed the dialog's old data-court-viewer-count line: that showed
    // the same quantity+unit with no label, which would have duplicated
    // this row.
    const bookEl = root.querySelector('[data-court-viewer-book]');
    const rateEl = root.querySelector('[data-court-viewer-rate]');
    const photoEl = root.querySelector('[data-court-viewer-photo-status]');
    const closeBtn = root.querySelector('[data-court-viewer-close]');
    const backdrop = root.querySelector('[data-court-viewer-backdrop]');

    if (!dialog || !mediaEl || !titleEl || !unitEl || !pickerEl
        || !pickerLabelEl || !selectEl || !noteEl || !bookEl || !rateEl || !photoEl) {
        console.error('[IñigoSync] #courtViewer markup is incomplete — court cards cannot open. Check Pages/Index.html.');
        return null;
    }

    // Matches the CSS opacity transition on .court-viewer; the same 250ms
    // includes/auth.js uses for its overlay.
    const CLOSE_DELAY_MS = 250;
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const PHOTO_STATUS_HAVE = 'Photo provided by Iñigos Sports Center.';
    const PHOTO_STATUS_NONE = 'Original venue photo coming soon.';
    const PHOTO_STATUS_BROKEN = 'This photo could not be loaded, so the placeholder is shown instead.';

    let lastFocused = null;
    let isOpen = false;
    let hideTimer = null;

    // Which sport is on screen, its resolved unit list, and a counter that
    // makes a late <img> error from a previously-selected unit a no-op
    // instead of letting it clobber whatever is showing now.
    let activeCourt = null;
    let activeVariant = null;
    let units = [];
    let mediaToken = 0;

    // Paints the media panel for one unit. An <img> that fails to load — a
    // typo'd or dead unit_images URL, which the owner types by hand — is
    // swapped for the same .media-slot placeholder the grid uses, so this
    // never shows a broken-image icon.
    function paintMedia(unit) {
        const token = ++mediaToken;
        const monogram = monogramFor(activeCourt.sportSlug, activeCourt.name);
        const alt = unit.specific && unit.label ? `${activeVariant.name} — ${unit.label}` : `${activeVariant.name} — general photo`;

        // renderMediaSlot escapes both the alt text and the image URL.
        const imageUrl = window.InigoVisuals ? window.InigoVisuals.venuePhoto(unit.imageUrl) : unit.imageUrl;
        mediaEl.innerHTML = renderMediaSlot({ imageUrl, alt, monogram });
        photoEl.textContent = imageUrl ? (unit.specific ? PHOTO_STATUS_HAVE : 'General ' + activeVariant.name + ' photo — not assigned to an individual ' + unitNoun(activeVariant.unit).toLowerCase() + '.') : PHOTO_STATUS_NONE;

        const img = mediaEl.querySelector('img');
        if (!img) return;

        img.addEventListener('error', () => {
            if (token !== mediaToken) return;
            mediaEl.innerHTML = renderMediaSlot({ imageUrl: null, alt, monogram });
            photoEl.textContent = PHOTO_STATUS_BROKEN;
            console.warn('[IñigoSync] Court photo failed to load for "%s" — showing the placeholder instead. Check court.image_url / court.unit_images.', alt);
        }, { once: true });
    }

    // Shows unit N. Called on open (always 0) and on every <select> change —
    // it deliberately does nothing else, so switching units never closes,
    // re-renders or re-focuses the dialog.
    function selectUnit(index) {
        if (!activeCourt || units.length === 0) return;

        const wanted = Number.isFinite(index) ? Math.floor(index) : 0;
        const unit = units[Math.min(Math.max(0, wanted), units.length - 1)];

        paintMedia(unit);

        // textContent, not innerHTML: the label can come straight from
        // court.unit_images, so it must never be able to become markup (D3).
        // It renders as the .eyebrow above the sport name — a caption for the
        // photo, not a second heading.
        unitEl.textContent = unit.label || '';
        bookEl.textContent = (activeCourt.variants?.length > 1 ? variantLabel(activeVariant.name) + ' · ' : '') + (unit.label || activeVariant.name);
        // With a single unit there is no combobox to caption, and the title +
        // "What you book" row already say everything a lone "Court 1"
        // eyebrow would.
        unitEl.hidden = !unit.label || units.length < 2;
        const scheduledUnit = activeVariant.unitRates?.find((rate) => String(rate.label || '').trim().toLowerCase() === String(unit.label || '').trim().toLowerCase());
        const scheduledText = unitRateText(scheduledUnit);
        rateEl.className = 'court-viewer-rate' + (scheduledText ? '' : ' is-tba');
        rateEl.textContent = scheduledText || (activeVariant.rate == null
            ? 'Rate TBA — please check with the front desk.'
            : formatUnitRate(activeVariant.rate, activeVariant.rateUnit));
    }

    function chooseType(index) {
        const variants = activeCourt.variants?.length ? activeCourt.variants : [activeCourt];
        activeVariant = variants[Math.min(Math.max(Number(index) || 0, 0), variants.length - 1)];
        const resolved = resolveCourtUnits(activeVariant);
        units = resolved.units;
        const hasChoice = units.length > 1;
        pickerLabelEl.textContent = resolved.pickerLabel;
        selectEl.innerHTML = units.map((unit, i) => '<option value="' + i + '">' + escapeHtml(unit.label || activeVariant.name) + '</option>').join('');
        selectEl.selectedIndex = 0;
        pickerEl.hidden = !hasChoice;
        selectEl.disabled = !hasChoice;
        noteEl.textContent = activeVariant.note || '';
        noteEl.hidden = !activeVariant.note;
        rateEl.className = 'court-viewer-rate is-tba';
        rateEl.textContent = 'Rate TBA — please check with the front desk.';
        selectUnit(0);
    }

    function open(court, invoker) {
        if (!court) return;
        lastFocused = invoker || document.activeElement;
        activeCourt = court;
        titleEl.textContent = court.name;
        const hasTypes = Boolean(court.variants?.length > 1);
        if (typePicker && typeSelect) {
            typePicker.hidden = !hasTypes;
            typeSelect.disabled = !hasTypes;
            typeSelect.innerHTML = hasTypes ? court.variants.map((variant, i) => '<option value="' + i + '">' + escapeHtml(variantLabel(variant.name)) + ' (' + variant.quantity + ' lanes)</option>').join('') : '';
            typeSelect.selectedIndex = hasTypes ? 0 : -1;
        }
        chooseType(0);

        if (hideTimer) {
            window.clearTimeout(hideTimer);
            hideTimer = null;
        }

        root.hidden = false;
        document.body.classList.add('court-viewer-lock');
        // Force a synchronous layout flush so the browser commits the
        // opacity:0 / display:flex state *before* [data-open] flips opacity
        // to 1. Batching both into one style recalc would skip the fade
        // entirely; requestAnimationFrame is not a reliable barrier here
        // because rAF callbacks run before the next style recalc, not after
        // the current one.
        void root.offsetWidth;
        root.setAttribute('data-open', '');
        isOpen = true;
        // The dialog carries tabindex="-1" and aria-labelledby, so focusing it
        // announces the sport name before anything else.
        dialog.focus();
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;

        root.removeAttribute('data-open');
        document.body.classList.remove('court-viewer-lock');
        // Invalidate any in-flight image so a load error arriving during the
        // fade-out cannot repaint a dialog that is on its way out.
        mediaToken++;

        hideTimer = window.setTimeout(() => {
            root.hidden = true;
            // Drop the media so reopening never flashes the previous sport,
            // and a large photo isn't held decoded once it's off-screen. Same
            // for the option list — nothing stale is left for the next open.
            // open() clears this timer first, so a reopen inside the 250ms
            // fade can never be wiped by a late run of this callback.
            mediaEl.innerHTML = '';
            selectEl.innerHTML = '';
            selectEl.disabled = true;
            pickerEl.hidden = true;
            unitEl.hidden = true;
            unitEl.textContent = '';
            units = [];
            activeCourt = null;
            activeVariant = null;
            if (typePicker && typeSelect) { typePicker.hidden = true; typeSelect.disabled = true; typeSelect.innerHTML = ''; }
            hideTimer = null;
        }, CLOSE_DELAY_MS);

        // Return focus to the card that opened this, if it's still in the DOM
        // (the grid re-renders only once per load, so it normally is).
        if (lastFocused && typeof lastFocused.focus === 'function' && document.contains(lastFocused)) {
            lastFocused.focus();
        }
        lastFocused = null;
    }

    typeSelect?.addEventListener('change', () => { if (activeCourt) chooseType(typeSelect.value); });
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (backdrop) backdrop.addEventListener('click', close);
    // Belt and braces: a click on the dialog's own padding/margin area.
    root.addEventListener('click', (e) => {
        if (e.target === root) close();
    });

    // Picking a different court/lane/table. `change` (not `input`) so a
    // keyboard user arrowing through the list on a platform that defers the
    // event gets one repaint, not one per key. The value is an index this
    // file wrote into the option itself — never user-supplied text.
    selectEl.addEventListener('change', () => {
        selectUnit(Number(selectEl.value));
    });

    document.addEventListener('keydown', (e) => {
        if (!isOpen) return;

        if (e.key === 'Escape') {
            e.preventDefault();
            close();
            return;
        }

        if (e.key !== 'Tab') return;

        // Focus trap. The dialog holds one or two focusable children — the
        // close button always, plus the unit combobox when the sport has more
        // than one unit — so without this Tab would walk straight out into the
        // page behind the backdrop. The combobox is `disabled` whenever it is
        // hidden, which is what keeps it out of this list (`:not([disabled])`)
        // rather than leaving an unfocusable element in the rotation.
        const focusables = Array.from(dialog.querySelectorAll(FOCUSABLE));
        if (focusables.length === 0) {
            e.preventDefault();
            dialog.focus();
            return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;

        if (e.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
            e.preventDefault();
            first.focus();
        }
    });

    return { open, close };
}

document.addEventListener('DOMContentLoaded', () => {
    const courtViewer = createCourtViewer();

    const courtGrid = document.querySelector('[data-court-grid]');
    const status = document.querySelector('[data-courts-status]');
    let clickSequence = 0;
    let activeCourtCard = null;
    const retryMarkup = (text, target) => '<p class="content-state" role="status">' + text + ' <button type="button" data-content-retry="' + target + '">Try again</button></p>';

    async function loadCourts(force = false) {
        if (!courtGrid) return;
        courtGrid.setAttribute('aria-busy', 'true');
        if (status) status.textContent = 'Loading current court information…';
        try {
            const courts = await getCourts({ force });
            const focusedSlug = courtGrid.contains(document.activeElement) ? document.activeElement.dataset.courtId : null;
            courtGrid.innerHTML = courts.length ? courts.map(renderCourtCard).join('') : '<p class="content-state">No courts are currently listed. Please check with the front desk.</p>';
            if (status) status.textContent = '';
            if (focusedSlug) [...courtGrid.querySelectorAll('.court-card')].find(card => card.dataset.courtId === focusedSlug)?.focus({ preventScroll: true });
            document.dispatchEvent(new Event('inigo:courts-rendered'));
        } catch {
            courtGrid.innerHTML = retryMarkup('Court information could not be loaded.', 'courts');
            if (status) status.textContent = '';
        } finally { courtGrid.setAttribute('aria-busy', 'false'); }
    }
    courtGrid?.addEventListener('click', async event => {
        const card = event.target.closest('.court-card');
        if (!card || !courtGrid.contains(card) || !courtViewer) return;
        const sequence = ++clickSequence;
        activeCourtCard?.removeAttribute('aria-busy');
        activeCourtCard = card;
        card.setAttribute('aria-busy', 'true');
        if (status) status.textContent = '';
        window.InigoLoading?.show('Loading the latest photos and prices…');
        try {
            const rows = await getCourts({ force: true });
            if (sequence !== clickSequence) return;
            const court = rows.find(row => row.sportSlug === card.dataset.courtId);
            if (!court) {
                window.InigoToast?.show('This sport is no longer listed. Refresh the court list and try again.', true);
                return;
            }
            courtViewer.open(court, card);
        } catch {
            if (sequence === clickSequence) window.InigoToast?.show('The latest photos and prices could not be loaded. Select the sport again to retry.', true);
        } finally {
            if (sequence === clickSequence) {
                card.removeAttribute('aria-busy');
                activeCourtCard = null;
                window.InigoLoading?.hide();
            }
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && activeCourtCard) {
            clickSequence++;
            if (status) status.textContent = '';
            window.InigoLoading?.hide();
            activeCourtCard?.removeAttribute('aria-busy');
            activeCourtCard = null;
        }
    });
    document.addEventListener('click', event => {
        const target = event.target.closest('[data-content-retry]')?.dataset.contentRetry;
        if (target === 'courts') loadCourts(true);
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) loadCourts(true);
    });
    loadCourts();

    // ------------------------------------------------------------------
    // Theme toggle — includes/theme.js manages the data-theme attribute
    // and persistence; this just wires the navbar button to it and keeps
    // the sun/moon icon in sync.
    // ------------------------------------------------------------------
    const themeToggleBtn = document.querySelector('[data-theme-toggle]');
    function syncThemeToggleUI(theme) {
        if (!themeToggleBtn) return;
        const isLight = theme === 'light';
        themeToggleBtn.setAttribute('aria-pressed', String(isLight));
        themeToggleBtn.querySelectorAll('.sun-circle, .sun-line').forEach((el) => {
            el.style.display = isLight ? 'none' : '';
        });
        const moonPath = themeToggleBtn.querySelector('.moon-path');
        if (moonPath) moonPath.style.display = isLight ? '' : 'none';
    }
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            if (window.ThemeController) window.ThemeController.toggle();
        });
        document.addEventListener('themechange', (e) => syncThemeToggleUI(e.detail.theme));
        syncThemeToggleUI(document.documentElement.getAttribute('data-theme') || 'dark');
    }

    // ------------------------------------------------------------------
    // Scroll-reveal for .reveal sections.
    //
    // Bug fix: this used to `return` here under reduced-motion (or when
    // IntersectionObserver isn't supported), which silently skipped every
    // bit of nav scroll-spy and mobile-menu wiring below it — reduced-
    // motion users got a broken navbar. Motion preference now only decides
    // *how* .reveal sections become visible; it no longer gates anything
    // else in this handler.
    // ------------------------------------------------------------------
    const revealEls = document.querySelectorAll('.reveal');
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefersReducedMotion || !('IntersectionObserver' in window)) {
        revealEls.forEach((el) => el.classList.add('is-visible'));
    } else {
        const revealObserver = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('is-visible');
                        revealObserver.unobserve(entry.target);
                    }
                });
            },
            { threshold: 0.01, rootMargin: '0px 0px -24px 0px' }
        );

        revealEls.forEach((el) => revealObserver.observe(el));
    }

    // ------------------------------------------------------------------
    // Nav scroll-spy — always wired, regardless of motion preference or
    // IntersectionObserver support (see the bug-fix note above).
    //
    // The pill navbar's inline links and the off-canvas mobile menu both
    // render the same links (see Index.html), so there are two <a> elements
    // per href — match by href, not by node identity, so both stay in sync.
    //
    // The nav is Home / Featured / Courts & Pricing / About, and each of
    // those resolves to a real section: the hero carries id="home", so `#home` maps
    // through the normal document.querySelector path. The `href === '#'`
    // branch below is kept as a fallback for any nav that still ships a bare
    // '#' Home link — it is no longer used by Pages/Index.html.
    // Pages/terms.html's nav links out to Index.html rather than to an
    // in-page anchor, so its sectionMap is empty and this whole block
    // no-ops there, exactly as before.
    // ------------------------------------------------------------------
    const navLinks = document.querySelectorAll('nav ul li a[href^="#"]');
    const sectionMap = Array.from(navLinks).map((link) => {
        const href = link.getAttribute('href');
        const target = href === '#' ? document.querySelector('.hero') : document.querySelector(href);
        return target ? { link, target } : null;
    }).filter(Boolean);
    // The footer continues About, including its map and platform credits.
    const aboutLink = sectionMap.find(({ link }) => link.getAttribute('href') === '#about')?.link;
    const footer = document.querySelector('.site-footer');
    if (aboutLink && footer) sectionMap.push({ link: aboutLink, target: footer });

    function setActiveLink(activeLink) {
        const activeHref = activeLink.getAttribute('href');
        navLinks.forEach((link) => {
            link.classList.toggle('active', link.getAttribute('href') === activeHref);
        });
    }

    function updateActiveLink() {
        const offset = window.innerHeight * 0.25;
        const activeEntry = sectionMap.reduce((best, entry) => {
            const rect = entry.target.getBoundingClientRect();
            const visible = rect.top <= offset && rect.bottom > offset;
            if (visible) {
                return { entry, top: Math.abs(rect.top) };
            }
            return best;
        }, null);

        if (activeEntry) {
            setActiveLink(activeEntry.entry.link);
        } else {
            const preceding = sectionMap.filter(({ target }) => target.getBoundingClientRect().top <= offset).at(-1);
            const fallback = preceding?.link || sectionMap[0]?.link;
            if (fallback) setActiveLink(fallback);
        }
    }

    if ('IntersectionObserver' in window) {
        sectionMap.forEach(({ target }) => {
            const sectionObserver = new IntersectionObserver(
                updateActiveLink,
                { threshold: 0.35 }
            );

            sectionObserver.observe(target);
        });
    }

    navLinks.forEach((link) => {
        link.addEventListener('click', () => {
            setActiveLink(link);
        });
    });

    window.addEventListener('scroll', updateActiveLink);
    window.addEventListener('resize', updateActiveLink);
    window.addEventListener('hashchange', updateActiveLink);
    updateActiveLink();

    // Move the entire floating header, including its outer padding, as one unit.
    const siteNav = document.querySelector('body.landing-night > .site-nav');
    if (siteNav) {
        let previousY = Math.max(0, window.scrollY);
        let directionAnchor = previousY;
        let previousDirection = 0;
        let pending = false;
        const syncHeader = () => {
            pending = false;
            const y = Math.max(0, window.scrollY);
            const delta = y - previousY;
            const direction = Math.sign(delta);
            if (direction && direction !== previousDirection) {
                directionAnchor = previousY;
                previousDirection = direction;
            }
            const keepVisible = y < 96 || document.body.classList.contains('landing-menu-open') || siteNav.contains(document.activeElement);
            if (keepVisible || (direction < 0 && directionAnchor - y >= 12)) siteNav.classList.remove('is-hidden');
            else if (direction > 0 && y - directionAnchor >= 12) siteNav.classList.add('is-hidden');
            previousY = y;
        };
        window.addEventListener('scroll', () => {
            if (!pending) { pending = true; requestAnimationFrame(syncHeader); }
        }, { passive: true });
        siteNav.addEventListener('focusin', () => siteNav.classList.remove('is-hidden'));
        siteNav.addEventListener('focusout', () => requestAnimationFrame(syncHeader));
        new MutationObserver(() => {
            if (document.body.classList.contains('landing-menu-open')) siteNav.classList.remove('is-hidden');
        }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    // Close the off-canvas mobile menu whenever something inside it is
    // clicked (a nav link or the Log In / Sign Up button).
    const menuToggleCheckbox = document.getElementById('menu-toggle');
    const navMenu = document.querySelector('.nav-menu');
    if (menuToggleCheckbox && navMenu) {
        navMenu.querySelectorAll('a, button').forEach((el) => {
            el.addEventListener('click', () => {
                menuToggleCheckbox.checked = false;
            });
        });
    }
});
