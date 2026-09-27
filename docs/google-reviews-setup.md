# Connect the free Google reviews widget

The landing page is connected to the published Elfsight Free widget in
`Config/googleReviews.js`. It is the only review feed displayed on the landing
page. Missing IDs and loading failures display a plain availability message;
stored local feedback remains in the database. The map retains its Get
directions button.

1. Sign in to a free Elfsight account and create one Google Reviews widget.
   Do not add a payment method, select a paid plan, or start a paid upgrade.
2. Select **Inigo's Sports Center, Lucena City, Philippines**. Verify the address
   is Lucena Diversion Road, Bocohan and that the map matches the site's listing:
   https://www.google.com/maps?cid=16628664884079723934
   Google Place ID: `ChIJYWSThmFMvTMRnoWVEJzixOY`.
3. Choose a carousel with manual navigation and autoplay off. Show author names,
   ratings, dates, text, and the provider's current aggregate rating. Do not
   hardcode 4.4 or invent a review count. Keep original attribution and branding.
4. Match the site: dark surface #1c2222, text #f5f3ee, orange accent #ff782e,
   12px card corners, and the existing font where supported by the free editor.
   Configure responsive cards (three on desktop, one on phones) where supported.
   Paste `Style/GoogleReviews.widget.css` into Elfsight's Custom CSS editor. It
   uses the provider's `es-` customization classes and inherits the site's color
   variables through the shadow root, responding to the light/dark toggle.
5. Copy the UUID from `elfsight-app-UUID` in the generated embed code into
   `widgetId` in `Config/googleReviews.js`. Do not paste script HTML or secrets.
   The landing page loads the official platform script asynchronously itself.
6. Preview the page, confirm the exact business, live rating and real reviews,
   and check arrow controls, mobile layout, keyboard access, and a blocked embed.
   Existing testimonial database records are preserved.

Elfsight currently advertises one free widget, 200 views/month, branding, and no
credit card. Reviews refresh periodically, not instantly. The widget can be
deactivated when the view allowance is exceeded.
Confirm the current free-plan terms in the account before activation:
https://elfsight.com/google-reviews-widget/pricing/

Tests use intercepted provider responses to avoid consuming the free allowance.
They verify integration behavior, not actual Google review authenticity or the
provider's refresh schedule. Those require the real configured widget.
