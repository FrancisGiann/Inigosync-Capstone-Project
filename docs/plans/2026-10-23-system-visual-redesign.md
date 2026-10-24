# IñigoSync system-wide visual redesign plan

**Status:** implemented locally; not committed or deployed.  
**Reference:** user-supplied moving-company landing-page sample, interpreted as a visual direction only.  
**Scope:** all public and signed-in web interfaces in this repository, in light and dark modes. Landing-page copy may be improved, but Home, Featured, Courts & Pricing, About, reviews, and contact each retain their current purpose and factual basis. Customer, staff, and owner account content, data, pricing, labels, booking rules, roles, and actions remain unchanged.

## 1. Design objective

Make IñigoSync feel like one coherent sports-center product. The supplied light-mode sample suggests a clear visual rhythm: a photographic opening, strong left-aligned message and actions, a compact facts strip, generous white/ivory sections, image-led cards, occasional deep-color bands, simple testimonials, and a strong footer action. Translate that rhythm to IñigoSync's existing sections and workflows. Do not reuse moving-company words, imagery, statistics, service categories, or claims.

The light theme is the primary visual reference. The dark theme uses the same layout, hierarchy, spacing, images, and interactions, with appropriately remapped surfaces, text, borders, and overlays. A theme change must never change page content or available actions.

## 2. Proposed visual language

### Color roles

The palette takes its direction from the existing sports-center building imagery and the requested orange, khaki, and white. These are **starting values**, not sampled brand specifications. Tune against the actual venue photos and review every semantic pairing in both themes before implementation is accepted.

| Role | Light mode | Dark mode | Usage |
| --- | --- | --- | --- |
| Page | `#F8F6F0` warm ivory | `#10222D` deep blue-charcoal | Main canvas |
| Card | `#FFFFFF` | `#172C38` | Cards, dialogs, menus |
| Subtle band | `#E9E1CF` pale khaki | `#243B47` | Alternating sections and grouped panels |
| Main text | `#182A35` | `#F3EFE5` | Headings and body copy |
| Muted text | `#52616A` | `#C9D2D1` | Supporting copy and metadata |
| Primary action | `#E56A2E` orange with dark ink | `#E56A2E` orange with dark ink | Main CTAs and selected actions |
| Accent text | `#A94413` burnt orange | `#F4A46C` light orange | Links, eyebrow labels, emphasis |
| Khaki accent | `#C6B58D` | `#C6B58D` | Quiet chips, dividers, illustrations |
| Strong contrast band | `#10222D` | `#0B1A23` | Photo overlays, footer, major feature bands |

Proposed contrast checks: deep ink on ivory 13.67:1; burnt orange on ivory 5.52:1; ivory on deep blue 14.19:1; khaki on deep blue 8.07:1. White text on the proposed orange is only 3.26:1, so primary buttons should use deep ink (4.99:1 on that orange) or a darker orange when white text is necessary. These figures cover only those pairs; all final states need an automated and visual contrast audit.

Keep semantic success, warning, error, and booking-availability colors distinct from brand orange. Never communicate status by color alone. Keep photographic content in natural color; change overlays and surrounding surfaces for each theme rather than inverting images.

The visible **IñigoSync** wordmark should use the orange of the adjacent `assets/Logo/WebLogo.png` mark. Its dominant sampled orange is approximately `#FD8107` (the separate full Iñigos Sports Center logo uses `#FF5806`). On light ivory, `#FD8107` alone has only about 2.34:1 contrast, so the wordmark needs an appropriate dark backing or outline to remain legible while visibly matching the logo.

### Type, shape, and spacing

- Retain the existing Sora heading and Inter UI/body families from `Style/typography.css`; adjust weights and scale consistently rather than adding another font.
- Use a 12-column public-page grid with a readable content maximum around 1280–1440px. Signed-in dashboards keep their sidebars and denser working area.
- Use spacing steps of 8, 12, 16, 24, 32, 48, and 72px. Major public sections use 72–96px vertical breathing room on desktop, reduced on mobile. Data-heavy portal screens use tighter 16–32px grouping.
- Use 12–16px card corners, 10–12px control corners, subtle borders, and restrained shadows. Avoid a different corner/shadow style in every portal.
- Use one clear action hierarchy: filled orange primary; outlined/tonal secondary; text/quiet tertiary; reserved red for destructive actions.
- Give buttons and interactive rows a visible hover, focus, active, disabled, and loading state. Target at least 44px touch height where practical.

### Responsive rules

- Design at 320/390px phones, 768px tablet, 1024px laptop, 1440px desktop, and 1920px wide screens, including short-height viewports.
- Public sections move from one column on phones to two at tablet width, then to appropriate multi-column desktop layouts; avoid orphan final rows and horizontal page overflow.
- Maintain readable image crop, text contrast, CTA visibility, and usable carousel controls at each size.
- Tables in staff/owner/customer tools use their existing responsive strategy, with deliberate scrolling or compact row presentation rather than clipped columns.
- Respect reduced-motion preferences; use motion to clarify state, not to delay navigation.

## 3. Reference-to-IñigoSync page mapping

| Reference pattern | IñigoSync application | Content and behavior to retain |
| --- | --- | --- |
| Photo hero with dark left gradient, headline, two actions | Home hero in `index.html` | Existing IñigoSync headline, court-booking CTA, court exploration link, real venue image |
| Facts strip below hero | Existing sports count, serving-since fact, and online-booking fact | Values must come from existing UI/data; do not invent metrics |
| Bright image-led service grid | Featured events and Courts & Pricing | Existing event carousel, sport names, court photos, capacity/rates, booking paths |
| Dark editorial band with image and reasons | About / venue story | Existing about copy and real Iñigos imagery; no moving-company content |
| Review cards and editorial section | Existing visitor reviews and FAQ/help content | Review text, attribution, and existing FAQ answers remain unchanged |
| Strong final action and deep footer | Existing contact, visit, policy, and booking footer content | Current address, contact methods, links, and destinations |

The landing layout should resemble the sample's **composition**: light page canvas, strong media, disciplined section rhythm, small orange/khaki highlights, simple cards, and occasional deep bands. It should not become a pixel copy of a moving-company website. Existing Featured and Courts improvements should be adapted into this system, not discarded.

## 4. System-wide surface plan

1. **Public landing:** redesign nav, hero, facts strip, Featured, Courts & Pricing, About, reviews, FAQ/chat launcher, and footer as one visual sequence. Keep carousel, court viewer, booking flow, and all anchors usable.
2. **Auth and booking overlays:** carry the same surface, type, button, field, and focus rules into login, sign-up, verification, court viewer, booking date/time, cart, and confirmation states. Keep form order, validation, required fields, and the current court viewer's fixed image/action behavior.
3. **Customer portal:** refresh sidebar/topbar, overview, booking, bookings, receipts, profile, settings, dialogs, and FAQ with the same tokens. Preserve booking states, payment information, feedback, and account controls. Dense data receives a calmer layout than the marketing page.
4. **Staff portal:** refresh sidebar/topbar, overview, walk-in wizard, schedule, transactions, settings, notification menus, and dialogs. Keep scan/QR and operational statuses immediately legible. Never let decorative elements hide urgent tasks or table controls.
5. **Owner portal:** refresh navigation, overview charts, staff, courts, media, booking rules, payments, feedback, announcements, audit, settings, and editors. Keep dense administrative tools compact; use the light reference's card rhythm without turning every table into a large marketing card.
6. **Supporting pages:** apply both themes to policy/credits pages, staff onboarding, loading/empty/error states, and walk-in payment return. Screen-level receipt wrappers and controls can adopt the new design, while printable/payment acknowledgement documents stay high-contrast and stable in print.

## 5. Theme architecture and implementation boundaries

1. Create a shared semantic token layer for both modes (page, band, card, elevated surface, ink, muted ink, border, shadow, primary action, primary text, focus, and status). Load it before page-specific styles in public, customer, staff, owner, and supporting pages.
2. Keep the existing `data-theme`/`inigosync-theme` mechanism and system-preference fallback in `includes/theme.js`. Light is the design reference, but the saved or operating-system preference still decides the initial mode. Align every early theme guard with the controller's exact fallback order to avoid a wrong-theme flash. Make a theme switch reachable on supporting pages as well as the main shells.
3. Remove duplicated color definitions only after all consumers are mapped. `Style/LandingPage.css` currently defines public/shared tokens; `Style/LandingNight.css` overrides them for the landing page; `Style/owner_dashboard.css` and `Style/staff_dashboard.css` repeat their own roots. The migration must preserve compatibility aliases until every stylesheet consumes semantic tokens.
4. Replace page-specific fixed visual colors in `Style/Auth.css`, `Style/Dashboard.css`, `Style/Policies.css`, `Style/LandingBooking.css`, owner/staff companion styles, and inline utility-page styles. Retain purposeful fixed colors for print/QR artifacts and other media that require stable rendering.
5. Make themed chart and illustration colors respond to the existing `themechange` event. Verify icon strokes, logos, photo overlays, maps, tooltips, browser theme color, and embedded assets in both modes.
6. Keep HTML data attributes, JavaScript selectors, route names, APIs, database contracts, and payment/auth logic unchanged unless a visual refactor requires a narrowly reviewed markup change. Preserve current uncommitted work in the landing and owner files.

## 6. Work sequence and review gates

| Phase | Deliverable | Gate before moving on |
| --- | --- | --- |
| A. Baseline | Screenshots and component inventory across all pages in both themes; inventory of current hard-coded colors and theme overrides | Every user-visible surface and state is listed; existing uncommitted changes recorded |
| B. Design specification | Color tokens, typography, spacing, buttons, cards, form fields, tables, dialogs, navigation, status/feedback, and responsive examples | Light/dark component examples approved as one coherent visual system; contrast pairs checked |
| C. Landing pilot | Sample-inspired landing page and its auth/booking overlays | Visual review at 320, 390, 768, 1024, 1440, 1920px; core navigation/carousel/booking checks pass |
| D. Customer | Customer dashboard and receipt screen wrapper | Booking, account, feedback, theme persistence, and responsive states pass |
| E. Operations | Staff and owner portals, including charts, schedules, forms, and editors | Dense workflows remain usable on phone/tablet/desktop; no status or data meaning changes |
| F. Supporting pages | Policies, credits, onboarding, payment return, loading/empty/error UI | Both modes available; links, form labels, and key messages intact |
| G. System QA | Screenshot comparison, accessibility audit, responsive review, automated regression/build checks | All acceptance criteria below met; visual exceptions documented |

Do not mix this redesign with content rewriting, feature additions, new pricing, business-rule changes, or speculative statistics. Build the shared system first, then migrate one surface at a time so differences are visible and reversible.

## 7. Acceptance criteria

- Every listed page and major overlay uses the new visual language in **both** themes; switching theme preserves current page state and works after reload.
- The public light page clearly echoes the reference's photo-led hierarchy, bright section rhythm, compact facts strip, dark feature/footer bands, and image-led cards while displaying only IñigoSync content.
- Equivalent controls have the same visual treatment across public, customer, staff, and owner surfaces; status colors remain semantically clear.
- Existing text, factual claims, prices, contact information, forms, page destinations, role boundaries, booking/payment behavior, and data rendering stay unchanged.
- No horizontal page overflow at the target widths; modals and sticky actions remain usable at 320×568 and with enlarged text.
- Text contrast meets at least WCAG AA for normal text; focus indicators are visible; controls remain usable by keyboard and touch; reduced-motion settings are respected.
- Build and relevant existing UI/flow tests pass. Compare before/after screenshots in both themes, and record any pre-existing failures separately from redesign regressions.

## 8. Known implementation risk

The site already has theme support but not a single color source of truth. A shared-token migration can expose hidden overrides, especially on the landing page and in staff/owner styles. Inline styles on staff onboarding and the walk-in payment return are separate migration targets. Printed acknowledgements and QR surfaces require a deliberate stable treatment. Visual QA must include dialogs, charts, empty/loading/error states, and data-heavy views, not just the landing hero.

## 9. Local implementation evidence

- Shared semantic colors and component treatments are implemented in `Style/ThemeTokens.css` and linked by public, customer, staff, owner, and supporting pages. The IñigoSync wordmark uses the adjacent logo's sampled `#FD8107` orange with a dark outline in light mode.
- Final landing screenshots are under `output/landing-qa/final-{1440,390}-{light,dark}.png`; scrolled Featured and Courts evidence is under `verified-{featured,courts}-{light,dark}.png`. The actual customer, staff, and owner HTML was rendered without auth/data scripts for visual verification under `real-portal-{customer,staff,owner}-{light,dark}.png`.
- `node scripts/build.cjs`, `tests/landing-controls.cjs`, and `git diff --check` passed. The authenticated portal workflows were not exercised in a live signed-in session; the portal captures verify static layout and theme styling only.
