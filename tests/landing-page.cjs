// Run against scripts/preview.cjs. Set PLAYWRIGHT_MODULE if using a bundled runtime.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = 'http://127.0.0.1:4178';
const out = path.resolve(__dirname,'../output/landing-qa');
fs.mkdirSync(out,{recursive:true});
const fallbackContext = { console: { log() {} } };
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../includes/courts-data.js'),'utf8'),fallbackContext);
const fallbackPickleball = vm.runInNewContext("COURTS_INVENTORY.find(court => court.id === 'pickleball')",fallbackContext);
assert.equal(fallbackPickleball.quantity,10,'static fallback matches verified Pickleball capacity');
(async()=>{
    const browser = await chromium.launch({channel:'msedge',headless:true});
    try {
        const page = await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
        // Real widget was verified separately; avoid spending its free views in regression runs.
        await browser.contexts()[0].route('https://elfsightcdn.com/**',route=>route.abort());
        const errors=[];page.on('pageerror',error=>errors.push(error.message));
        let courtRequests=0;
        page.on('request',request=>{if(request.url().includes('/rest/v1/court?'))courtRequests++;});
        await page.goto(base+'/index.html');
        await page.waitForFunction(()=>document.querySelectorAll('.court-card').length===9);
        await page.waitForFunction(()=>document.querySelectorAll('.hero-copy').length===4);
        const coverAssets = ['basketball','badminton','bowling','bowling-duckpin','bowling-tenpin','billiards','lawn-tennis','pickleball','table-tennis','volleyball'];
        const coverLoads = await page.evaluate(async sports => Promise.all(sports.map(slug => new Promise(resolve => {
            const image = new Image();
            image.onload = () => resolve({ slug, width: image.naturalWidth, height: image.naturalHeight });
            image.onerror = () => resolve({ slug, width: 0, height: 0 });
            image.src = window.InigoVisuals.sportCover(slug);
        }))), coverAssets);
        assert(coverLoads.every(image => image.width > 0 && image.height > 0), 'all sport cover crops, including both Bowling card aliases, load');
        assert.equal(coverLoads.find(image => image.slug === 'bowling-duckpin').width, coverLoads.find(image => image.slug === 'bowling').width);
        assert.equal(coverLoads.find(image => image.slug === 'bowling-tenpin').height, coverLoads.find(image => image.slug === 'bowling').height);
        const databaseCoverCard = await page.evaluate(() => renderCourtCard({
            sportSlug: 'basketball', name: 'Basketball', quantity: 1, unit: 'courts',
            imageUrl: 'https://cdn.example.test/shared-basketball-cover.png', rate: null,
            rateUnit: '/hr', rating: null,
        }));
        assert.match(databaseCoverCard, /shared-basketball-cover\.png/, 'landing cards prefer the shared public.court.image_url cover');
        assert.doesNotMatch(await page.locator('.court-card').first().innerHTML(), /sports-equipment\.png|sport-art-/);
        assert.equal(await page.locator('.google-reviews-link,.map-external-link').count(),0);
        assert.match(await page.locator('.court-card[data-court-id="basketball"] .court-rate').innerText(),/From ₱700\/hr/);
        assert.match(await page.locator('.court-card[data-court-id="pickleball"] .court-rate').innerText(),/Rate TBA/);
        assert.match(await page.locator('.court-card[data-court-id="bowling-duckpin"] .court-rate').innerText(),/From ₱100\/set/);
        assert.match(await page.locator('.court-card[data-court-id="bowling-tenpin"] .court-rate').innerText(),/From ₱150\/set/);
        const initialRequests=courtRequests;
        await page.locator('[data-court-id="basketball"]').click();
        await page.waitForSelector('[data-court-viewer][data-open]');
        assert(courtRequests>initialRequests,'Viewer must refetch live courts');
        assert.equal(await page.locator('[data-court-viewer-dialog]:visible').count(),1,'court and date/time controls share one dialog');
        assert.equal(await page.locator('[data-landing-book-date]:visible').count(),1,'date selection is available as soon as a sport card opens');
        assert.equal(await page.locator('[data-landing-book-next]').count(),0,'the separate Next step is removed');
        assert.match(await page.locator('[data-booking-summary-court]').innerText(),/Basketball/);
        assert.match(await page.locator('.landing-booking-footer').innerText(),/Cancel[\s\S]*Login \/ Sign up to continue/);
        const desktopBookingLayout=await page.locator('[data-court-viewer-dialog]').evaluate(el=>{
            const box=selector=>el.querySelector(selector).getBoundingClientRect();
            return {dialog:el.getBoundingClientRect().toJSON(),footer:box('.landing-booking-footer').toJSON(),
                contentOverflow:getComputedStyle(el.querySelector('.landing-booking-content')).overflowY,
                courtOverflow:getComputedStyle(el.querySelector('.landing-booking-court-column')).overflowY,
                detailOverflow:getComputedStyle(el.querySelector('.landing-booking-court-scroll')).overflowY,
                mediaOutsideDetailScroller:!el.querySelector('.landing-booking-court-scroll').contains(el.querySelector('.court-viewer-media')),
                mediaPinned:(()=>{
                    const media=el.querySelector('.court-viewer-media');
                    const scroller=el.querySelector('.landing-booking-court-scroll');
                    const before=media.getBoundingClientRect().top;
                    scroller.scrollTop=180;
                    const after=media.getBoundingClientRect().top;
                    scroller.scrollTop=0;
                    return Math.abs(after-before)<1;
                })(),
                dateInsideCourt:el.querySelector('.landing-booking-court-column').contains(el.querySelector('.landing-booking-panel')),
                summaryHasDate:el.querySelector('.landing-booking-summary').contains(el.querySelector('[data-landing-book-date]')),
                courtRight:box('.landing-booking-court-column').right,summaryLeft:box('.landing-booking-summary').left};
        });
        assert(Math.abs(desktopBookingLayout.dialog.bottom-desktopBookingLayout.footer.bottom)<1,'booking footer stays attached to the dialog bottom');
        assert(desktopBookingLayout.dialog.width>=1000,'desktop booking dialog keeps a generous horizontal footprint');
        assert.equal(desktopBookingLayout.contentOverflow,'hidden','the fixed dialog content grid does not scroll');
        assert.equal(desktopBookingLayout.courtOverflow,'hidden','the fixed photo column does not scroll as a whole');
        assert.equal(desktopBookingLayout.detailOverflow,'auto','only the court details and date/time region scrolls');
        assert.equal(desktopBookingLayout.mediaOutsideDetailScroller,true,'the court photo sits outside the detail scroller');
        assert.equal(desktopBookingLayout.mediaPinned,true,'the court photo stays at the top while details scroll');
        assert.equal(desktopBookingLayout.dateInsideCourt,true,'date and hourly choices sit under court details in the left column');
        assert.equal(desktopBookingLayout.summaryHasDate,false,'the right column contains only the booking summary');
        assert(desktopBookingLayout.summaryLeft>=desktopBookingLayout.courtRight,'booking summary is in a separate right column');
        await page.setViewportSize({width:790,height:900});
        const intermediateBookingLayout=await page.locator('[data-court-viewer-dialog]').evaluate(el=>({
            contentDisplay:getComputedStyle(el.querySelector('.landing-booking-content')).display,
            contentOverflow:getComputedStyle(el.querySelector('.landing-booking-content')).overflowY,
            dialogWidth:el.getBoundingClientRect().width,
            contentWidth:el.querySelector('.landing-booking-content').getBoundingClientRect().width,
        }));
        assert.equal(intermediateBookingLayout.contentDisplay,'flex','intermediate viewport stacks before the two columns become cramped');
        assert.equal(intermediateBookingLayout.contentOverflow,'auto','intermediate stacked content remains reachable');
        assert(intermediateBookingLayout.dialogWidth<=790 && intermediateBookingLayout.contentWidth>0,'intermediate booking layout stays inside its viewport');
        await page.setViewportSize({width:390,height:844});
        const mobileBookingLayout=await page.locator('[data-court-viewer-dialog]').evaluate(el=>({
            width:el.getBoundingClientRect().width, viewport:innerWidth,
            contentDisplay:getComputedStyle(el.querySelector('.landing-booking-content')).display,
            courtDisplay:getComputedStyle(el.querySelector('.landing-booking-court-column')).display,
            contentOverflow:getComputedStyle(el.querySelector('.landing-booking-content')).overflowY,
            leftOverflow:getComputedStyle(el.querySelector('.landing-booking-court-column')).overflowY,
            detailOverflow:getComputedStyle(el.querySelector('.landing-booking-court-scroll')).overflowY,
            mediaPosition:getComputedStyle(el.querySelector('.court-viewer-media')).position,
            mediaPinned:(()=>{
                const content=el.querySelector('.landing-booking-content');
                const media=el.querySelector('.court-viewer-media');
                const contentTop=content.getBoundingClientRect().top;
                content.scrollTop=140;
                const after=media.getBoundingClientRect().top;
                content.scrollTop=0;
                return Math.abs(after-contentTop)<1;
            })(),
            summaryBelowCourt:el.querySelector('.landing-booking-summary').getBoundingClientRect().top>=el.querySelector('.landing-booking-court-column').getBoundingClientRect().bottom,
            footerBottom:el.querySelector('.landing-booking-footer').getBoundingClientRect().bottom,
            dialogBottom:el.getBoundingClientRect().bottom,
        }));
        assert(mobileBookingLayout.width<=mobileBookingLayout.viewport,'booking card fits the mobile viewport');
        assert.equal(mobileBookingLayout.contentDisplay,'flex','mobile booking columns stack vertically');
        assert.equal(mobileBookingLayout.courtDisplay,'flex','mobile layout retains court photo, selectors, and date/time');
        assert.equal(mobileBookingLayout.contentOverflow,'auto','the stacked interior scrolls on mobile');
        assert.equal(mobileBookingLayout.leftOverflow,'visible','mobile content has one interior scroll container');
        assert.equal(mobileBookingLayout.detailOverflow,'visible','mobile detail content scrolls with the stacked booking content');
        assert.equal(mobileBookingLayout.mediaPosition,'sticky','the photo pins at the top while the mobile court details scroll');
        assert.equal(mobileBookingLayout.mediaPinned,true,'the mobile photo remains visible during a details scroll');
        assert.equal(mobileBookingLayout.summaryBelowCourt,true,'mobile summary follows the court/date controls');
        assert(Math.abs(mobileBookingLayout.dialogBottom-mobileBookingLayout.footerBottom)<1,'mobile footer stays fixed at the card bottom');
        await page.setViewportSize({width:1440,height:1000});
        assert.equal(await page.locator('[data-court-viewer-media] img').count(),1,'shared sport cover appears in the court viewer');
        assert.match(await page.locator('[data-court-viewer-media] img').getAttribute('src'),/sports-covers\/basketball\.png/);
        assert.equal(await page.locator('[data-court-viewer-select] option').count(),2);
        assert.match(await page.locator('[data-court-viewer-rate]').innerText(),/₱700 day \/ ₱1,000 night per hour/);
        await page.locator('[data-court-viewer-select]').selectOption('1');
        assert.match(await page.locator('[data-court-viewer-rate]').innerText(),/₱1,300\/hr/);
        await page.keyboard.press('Escape');
        await page.waitForFunction(()=>document.querySelector('[data-court-viewer]').hidden);
        assert(await page.locator('[data-court-id="basketball"]').evaluate(el=>el===document.activeElement));
        await page.locator('[data-court-id="bowling-duckpin"]').click();
        await page.waitForSelector('[data-court-viewer][data-open]');
        assert.equal(await page.locator('[data-court-viewer-type] option').count(),0);
        assert.equal(await page.locator('[data-court-viewer-select] option').count(),8);
        assert.match(await page.locator('[data-court-viewer-title]').innerText(),/Bowling — Duckpin/);
        await page.keyboard.press('Escape');
        await page.waitForFunction(()=>document.querySelector('[data-court-viewer]').hidden);
        await page.locator('[data-court-id="bowling-tenpin"]').click();
        await page.waitForSelector('[data-court-viewer][data-open]');
        assert.equal(await page.locator('[data-court-viewer-select] option').count(),12);
        await page.locator('[data-court-viewer-select]').selectOption('11');
        assert.match(await page.locator('[data-court-viewer-title]').innerText(),/Bowling — Ten-Pin/);
        assert.match(await page.locator('[data-court-viewer-book]').innerText(),/Lane 12/);
        await page.keyboard.press('Escape');
        await page.waitForFunction(()=>document.querySelector('[data-court-viewer]').hidden);
        console.log('PASS unified court/date dialog, separate Duckpin/Ten-Pin cards, rates, 8/12 lanes, lane selection and focus return');
        const partial = await page.evaluate(() => resolveCourtUnits({name:'Bowling — Duckpin',unit:'lanes',quantity:8,imageUrl:'general.jpg',unitImages:[{label:'Lane 3',imageUrl:'specific.jpg'}]}));
        assert.equal(partial.units.length,8);
        assert.equal(partial.units[0].specific,false);
        assert.equal(partial.units[2].imageUrl,'specific.jpg');
        assert.equal(partial.units[2].specific,true);
        assert.equal(await page.evaluate(()=>window.InigoVisuals.venuePhoto('javascript:alert(1)')),null);
        console.log('PASS partial unit photos preserve lane counts and unsafe photo URLs are rejected');

        for(const width of [320,390,768,1024,1440]){
            await page.setViewportSize({width,height:900});
            await page.locator('#location').scrollIntoViewIfNeeded();
            assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Overflow at '+width);
            await page.evaluate(()=>scrollBy(0,-140));
            await page.waitForFunction(()=>!document.querySelector('body > .site-nav').classList.contains('is-hidden'));
            assert(await page.locator('body > .site-nav').evaluate(el=>{const r=el.querySelector('.site-nav-pill').getBoundingClientRect();return el.contains(document.elementFromPoint(r.left+r.width/2,r.top+20));}),'Navbar obscured at '+width);
            for(const theme of ['light','dark']){
                await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
                const active=page.locator('.site-nav-links a.active').first();
                assert.equal(await active.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
                assert.equal(await page.locator('.site-nav-actions .book-now').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 120, 46)');
            }
        }
        await page.setViewportSize({width:390,height:844});
        await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
        await page.getByRole('button',{name:'Open menu',exact:true}).click();
        assert(await page.locator('#landing-mobile-menu').evaluate(el=>!el.inert));
        assert(await page.locator('body > main').evaluate(el=>el.inert));
        await page.keyboard.press('Escape');
        assert(await page.locator('#landing-mobile-menu').evaluate(el=>el.inert));
        await page.getByRole('button',{name:'Open menu',exact:true}).click();
        await page.locator('#landing-mobile-menu [data-auth-open]').click();
        await page.waitForSelector('[data-auth-overlay][data-open]');
        assert(await page.locator('body > main').evaluate(el=>!el.inert));
        await page.locator('[role="tab"][data-auth-tab="signup"]').click();
        assert(await page.locator('[data-auth-panel="signup"]').evaluate(el=>el.classList.contains('is-active')));
        await page.keyboard.press('Escape');
        await page.waitForFunction(()=>document.querySelector('[data-auth-overlay]').hidden);
        console.log('PASS navbar on top at five widths, active styling in both themes, orange auth buttons, drawer, login/signup UI');
        await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
        await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});
        await page.setViewportSize({width:1440,height:1000});
        await page.locator('#location').scrollIntoViewIfNeeded();
        await page.waitForTimeout(2500);
        await page.locator('.footer-map-canvas').screenshot({path:path.join(out,'map.png')});
        assert.match(await page.locator('.footer-map-frame').getAttribute('src'),/cid=16628664884079723934/);
        assert.match(await page.locator('.map-directions').getAttribute('href'),/destination_place_id=ChIJYWSThmFMvTMRnoWVEJzixOY/);
        for(const file of ['privacy.html','house-rules.html','terms.html']) assert.equal((await page.request.get(base+'/Pages/'+file)).status(),200);
        await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
        await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});
        assert.equal(errors.length,0,errors.join('\n'));
        console.log('PASS policy pages, exact map target, zero JavaScript errors');

        // Failures and an empty database must never resurrect demonstration rows.
        const empty=await browser.newPage();
        await empty.route('**/rest/v1/**',route=>route.fulfill({json:[]}));
        await empty.goto(base+'/index.html');
        await empty.waitForSelector('.court-grid .content-state');
        assert.equal(await empty.locator('.court-card').count(),0);
        assert.match(await empty.locator('.court-grid').innerText(),/No courts/);
        const failed=await browser.newPage();
        await failed.route('**/rest/v1/**',route=>route.fulfill({status:503,json:{message:'Test outage'}}));
        await failed.goto(base+'/index.html');
        await failed.waitForSelector('[data-content-retry="courts"]');
        assert.equal(await failed.locator('.court-card').count(),0);
        await failed.unroute('**/rest/v1/**');
        await failed.locator('[data-content-retry="courts"]').click();
        await failed.waitForSelector('.court-card');
        console.log('PASS empty-state behavior, outage state and retry recovery');
        const animated=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'no-preference'});
        await animated.goto(base+'/index.html');
        await animated.waitForSelector('.court-card');
        const runtime=await animated.evaluate(()=>({gsap:typeof gsap,scrollTriggers:ScrollTrigger.getAll().length}));
        assert.equal(runtime.gsap,'object');assert(runtime.scrollTriggers>0);
        await animated.emulateMedia({reducedMotion:'reduce'});
        await animated.waitForFunction(()=>ScrollTrigger.getAll().length===0);
        await animated.setViewportSize({width:390,height:844});
        await animated.locator('#location').scrollIntoViewIfNeeded();
        await animated.waitForTimeout(1800);
        await animated.locator('.footer-map-canvas').screenshot({path:path.join(out,'mobile-map.png')});
        await animated.getByRole('button',{name:'Open menu',exact:true}).click();
        await animated.screenshot({path:path.join(out,'mobile-menu.png')});
        console.log('PASS live motion and runtime reduced-motion cleanup');
    } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
