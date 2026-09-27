// Run against scripts/preview.cjs. Provider data is mocked; no widget views used.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:4178/Pages/Index.html';
const uuid = '11111111-2222-3333-4444-555555555555';
(async () => {
    const browser = await chromium.launch({channel:'msedge',headless:true});
    try {
        async function setup({count=4, id='', provider='blocked', motion='reduce'}={}) {
            const page = await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:motion});
            page.setDefaultTimeout(15000);
            await page.route('**/Config/googleReviews.js', route => route.fulfill({contentType:'application/javascript',body:`window.InigoGoogleReviews={widgetId:${JSON.stringify(id)}};`}));
            await page.route('https://elfsightcdn.com/**', route => provider === 'blocked' ? route.abort() : route.fulfill({contentType:'application/javascript',body: provider === 'empty' ? '' : `document.querySelector('.elfsight-app-${uuid}').textContent='Provider fixture: 4.3 stars';`}));
            await page.route('**/rest/v1/**', route => {
                const table = new URL(route.request().url()).pathname.split('/').pop();
                const data = table === 'event' ? Array.from({length:count},(_,i)=>({title:'Feature '+(i+1),meta:'Venue event',tag:'Featured',image_url:'../assets/landing/featured-tournament-placeholder.png'})) : [];
                return route.fulfill({json:data});
            });
            await page.goto(base,{waitUntil:'domcontentloaded'});
            await page.waitForFunction(n => n ? document.querySelectorAll('.hero-copy').length === n && document.querySelector('.hero-title')?.textContent === 'Feature 1' : document.querySelector('.hero-meta')?.textContent.includes('no published events'),count);
            return page;
        }
        const page = await setup();
        const active = () => page.locator('.hero-copy.is-active .hero-title').innerText();
        await page.getByRole('button',{name:'Previous featured event'}).click();
        assert.equal(await active(),'Feature 4');
        await page.getByRole('button',{name:'Next featured event'}).click();
        assert.equal(await active(),'Feature 1');
        await page.getByRole('button',{name:'Show Feature 3',exact:true}).click();
        assert.equal(await active(),'Feature 3');
        await page.keyboard.press('ArrowLeft');
        assert.equal(await active(),'Feature 2');
        await page.getByRole('button',{name:'Next featured event'}).focus();
        await page.keyboard.press('Enter');
        assert.equal(await active(),'Feature 3');
        await page.locator('[data-home-showcase]').evaluate(hero => {
            for (const [type,x] of [['touchstart',180],['touchend',80]]) {
                const event = new Event(type); Object.defineProperty(event,'changedTouches',{value:[{clientX:x,clientY:100}]}); hero.dispatchEvent(event);
            }
        });
        assert.equal(await active(),'Feature 4');
        assert(await page.locator('[data-home-pause]').isDisabled());
        assert.equal(await page.locator('[data-testimonial-grid], [data-onsite-review-grid]').count(),0);
        assert(await page.locator('[data-google-reviews]').isHidden());
        assert(await page.locator('[data-google-reviews-fallback]').isVisible());
        assert.equal(await page.locator('script[src*="elfsightcdn"]').count(),0);
        for (const width of [320,390,768,1024,1440,1920]) {
            await page.setViewportSize({width,height:900});
            for (const theme of ['dark','light']) {
                await page.evaluate(theme=>window.ThemeController.set(theme),theme);
                if(width<=768) {
                    const firstScreen=await page.evaluate(()=>{
                        const hero=document.querySelector('.hero').getBoundingClientRect();
                        const courts=document.querySelector('.courts').getBoundingClientRect();
                        return {heroHeight:hero.height,courtsTop:courts.top+scrollY,viewportHeight:innerHeight};
                    });
                    assert(firstScreen.heroHeight>=firstScreen.viewportHeight-1 && firstScreen.courtsTop>=firstScreen.viewportHeight-1,
                        `Featured section must fill the first screen at ${width}px in ${theme} mode`);
                }
                const layout=await page.evaluate(()=>{
                    const rect=s=>document.querySelector(s).getBoundingClientRect();
                    const map=rect('.footer-map-frame'),card=rect('.map-location-card');

                    return {mapHeight:map.height,cardBelow:card.top>=map.bottom-1,
                        padding:getComputedStyle(document.querySelector('.site-footer')).paddingTop,
                        credits:document.querySelectorAll('.footer-provider').length};
                });
                assert.equal(layout.mapHeight,width<=768?240:340);
                assert.equal(layout.padding,width<=768?'24px':'32px');
                assert.equal(layout.credits,4);
                if(width<=768) { assert(layout.cardBelow); }
                await page.locator('.footer-credits').scrollIntoViewIfNeeded();
                await page.locator('img[alt="Elfsight"]').evaluate(img=>img.decode());
                assert(await page.locator('img[alt="Elfsight"]').evaluate(img=>img.complete && img.naturalWidth>0));
            }
            await page.locator('[data-home-next]').scrollIntoViewIfNeeded();
            assert(await page.locator('.hero-media-slide.is-active .hero-media-img').evaluate(img=>getComputedStyle(img).objectFit==='contain'), 'Featured photo must fit at '+width);
            if(width>=1200) assert(await page.locator('.hero-media-slide.is-active .hero-media-img').evaluate(img=>Math.abs(img.getBoundingClientRect().height-document.querySelector('.hero-media').getBoundingClientRect().height+320)<1), 'Featured photo has the larger desktop height at '+width);
            if(width<=768) assert(await page.locator('.hero-media-slide.is-active .hero-media-img').evaluate(img=>img.getBoundingClientRect().bottom<=document.querySelector('.hero-copy-wrap').getBoundingClientRect().top), 'Photo overlaps copy at '+width);
            assert(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), 'Overflow at '+width);
            assert(await page.locator('.footer-bottom').evaluate((footer,width)=>{
                const [location,copyright,credits]=[...footer.children].map(el=>el.getBoundingClientRect());
                const row=footer.getBoundingClientRect();
                if(width<=768) return location.bottom<=copyright.top && copyright.bottom<=credits.top && [location,copyright,credits].every(r=>Math.abs(r.left+r.width/2-row.left-row.width/2)<1);
                return location.right<copyright.left && copyright.right<credits.left && Math.abs(copyright.left+copyright.width/2-row.left-row.width/2)<1;
            },width), 'Footer order and centering at '+width);
            assert(await page.evaluate(()=>{
                const rect=s=>document.querySelector(s).getBoundingClientRect();
                const group=rect('.hero-progress'),cta=rect('.cta-buttons'),prev=rect('[data-home-prev]'),next=rect('[data-home-next]'),pause=rect('[data-home-pause]');
                return Math.abs(group.left-cta.left)<1 && group.top>=cta.bottom &&
                    Math.abs(prev.top-next.top)<1 && next.left-prev.right<=9 &&
                    pause.left-next.right<=9 && Math.abs(pause.top-prev.top)<=3;
            }), 'Slideshow controls must form a compact left-aligned group at '+width);
            for (const selector of ['[data-home-prev]','[data-home-next]']) {
                assert(await page.locator(selector).evaluate(el=>{
                    const r=el.getBoundingClientRect(),copy=document.querySelector('.hero-copy-wrap').getBoundingClientRect();
                    return r.width>=44 && r.height>=44 && r.top>=copy.bottom && r.left>=0 && r.right<=innerWidth && el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
                }), 'Obscured or overlapping control at '+width);
            }
        }
        for(const {width,height} of [{width:320,height:568},{width:390,height:844}]) {
            await page.setViewportSize({width,height});
            const fit=await page.evaluate(()=>{
                const rect=s=>document.querySelector(s).getBoundingClientRect();
                const hero=rect('.hero'),copy=rect('.hero-copy-wrap'),controls=rect('.hero-progress'),photo=rect('.hero-media-img');
                return {heroHeight:hero.height,viewportHeight:innerHeight,contentFits:controls.bottom<=hero.bottom+1,
                    photoClear:photo.bottom<=copy.top+1,noOverflow:document.documentElement.scrollWidth<=innerWidth};
            });
            assert(fit.heroHeight>=fit.viewportHeight-1 && fit.contentFits && fit.photoClear && fit.noOverflow,
                `Featured content must remain readable and reachable at ${width}x${height}`);
        }
        await page.setViewportSize({width:1440,height:900});
        await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
        await page.waitForFunction(()=>!document.querySelector('.site-nav').classList.contains('is-hidden'));
        await page.evaluate(async()=>{ for(let i=0;i<70;i++){ scrollBy({top:2,behavior:'instant'}); await new Promise(requestAnimationFrame); } });
        assert(await page.locator('.site-nav').evaluate(el=>el.classList.contains('is-hidden')),'Slow downward scrolling hides the header');
        await page.evaluate(()=>scrollTo({top:600,behavior:'instant'}));
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        await page.waitForFunction(()=>document.querySelector('.site-nav').classList.contains('is-hidden'));
        await page.evaluate(()=>scrollBy({top:-120,behavior:'instant'}));
        await page.waitForFunction(()=>!document.querySelector('.site-nav').classList.contains('is-hidden'));
        await page.evaluate(()=>scrollBy({top:120,behavior:'instant'}));
        await page.waitForFunction(()=>document.querySelector('.site-nav').classList.contains('is-hidden'));
        await page.locator('.site-nav-actions .book-now').focus();
        await page.waitForFunction(()=>!document.querySelector('.site-nav').classList.contains('is-hidden'));
        assert.equal(await page.locator('.site-nav').evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
        assert(await page.locator('a[href="asset-credits.html"]').isVisible());
        await page.locator('a[href="asset-credits.html"]').click();
        assert.match(await page.locator('main').innerText(),/B1Blender/);
        await page.goBack();
        await page.screenshot({path:'output/landing-controls-desktop.png'});
        await page.setViewportSize({width:390,height:844});
        await page.evaluate(async()=>{ scrollTo({top:0,behavior:'instant'}); await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); document.activeElement.blur(); });
        await page.evaluate(()=>scrollTo({top:260,behavior:'instant'}));
        await page.waitForFunction(()=>document.querySelector('.site-nav').classList.contains('is-hidden'));
        assert(await page.locator('.site-nav').evaluate(el=>el.getBoundingClientRect().bottom<=0),'Reduced-motion mobile header hides upward');
        await page.evaluate(()=>scrollBy({top:-100,behavior:'instant'}));
        await page.waitForFunction(()=>!document.querySelector('.site-nav').classList.contains('is-hidden'));
        assert(await page.locator('.site-nav').evaluate(el=>el.getBoundingClientRect().top>=0),'Reduced-motion mobile header returns from the top');
        await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
        await page.getByRole('button',{name:'Open menu'}).click();
        await page.evaluate(()=>scrollBy({top:220,behavior:'instant'}));
        assert(await page.locator('.site-nav').evaluate(el=>!el.classList.contains('is-hidden')),'Open menu keeps header visible');
        await page.keyboard.press('Escape');
        console.log('PASS controls, footer dimensions and themes at six widths');
        await page.setViewportSize({width:320,height:900});
        await page.locator('[data-home-next]').scrollIntoViewIfNeeded();
        await page.screenshot({path:'output/landing-controls-mobile.png'});
        for (const count of [0,1]) {
            const small=await setup({count});
            assert(await small.locator('[data-home-prev]').isHidden());
            assert(await small.locator('[data-home-next]').isHidden());
            await small.close();
        }
        const many=await setup({count:5});
        await many.setViewportSize({width:320,height:900});
        assert(await many.locator('.hero-dots').evaluate(el=>{
            const r=el.getBoundingClientRect();
            return r.left>=0 && r.right<=innerWidth && document.documentElement.scrollWidth<=innerWidth &&
                [...el.children].every(dot=>dot.getBoundingClientRect().right<=r.right+1);
        }), 'Extra dots must wrap within the compact group');
        await many.close();
        const animated=await setup({motion:'no-preference'});
        await animated.setViewportSize({width:390,height:844});
        await animated.evaluate(()=>scrollTo({top:260,behavior:'instant'}));
        await animated.waitForFunction(()=>document.querySelector('.site-nav').classList.contains('is-hidden'));
        await animated.evaluate(()=>scrollBy({top:-100,behavior:'instant'}));
        await animated.waitForFunction(()=>!document.querySelector('.site-nav').classList.contains('is-hidden'));
        await animated.setViewportSize({width:1440,height:1000});
        await animated.locator('[data-home-pause]').click();
        assert.equal(await animated.locator('[data-home-pause]').getAttribute('aria-pressed'),'true');
        await animated.locator('[data-home-next]').click();
        assert.equal(await animated.locator('[data-home-pause]').getAttribute('aria-pressed'),'true');
        await animated.locator('[data-home-pause]').click();
        assert.equal(await animated.locator('[data-home-pause]').getAttribute('aria-pressed'),'false');
        await animated.getByRole('link',{name:'Get directions'}).focus();
        await animated.getByRole('link',{name:'Get directions'}).hover();
        const beforeAuto=await animated.locator('.hero-copy.is-active .hero-title').innerText();
        await animated.waitForFunction(previous=>document.querySelector('.hero-copy.is-active .hero-title').textContent!==previous,beforeAuto,{timeout:8000});
        console.log('PASS pause, manual selection while paused and resumed autoplay');
        await animated.emulateMedia({reducedMotion:'reduce'});
        await animated.waitForFunction(()=>ScrollTrigger.getAll().length===0);
        await animated.setViewportSize({width:390,height:900});
        await animated.evaluate(()=>scrollTo(0,0));
        await animated.screenshot({path:'output/landing-controls-mobile.png',fullPage:true});
        for (const provider of ['blocked','loaded','empty']) {
            const widget=await setup({id:uuid,provider});
            await widget.locator('#testimonials').scrollIntoViewIfNeeded();
            assert.equal(await widget.locator('.google-reviews-link,.map-external-link').count(),0);
            assert.equal(await widget.locator('[data-testimonial-grid], [data-onsite-review-grid]').count(),0);
            if(provider==='loaded') {
                assert.match(await widget.locator('[data-google-reviews]').innerText(),/4.3 stars/);
                assert(await widget.locator('[data-google-reviews-note]').isVisible());
                assert(await widget.locator('[data-google-reviews-note]').evaluate(el=>{
                    const note=el.getBoundingClientRect(),host=document.querySelector('[data-google-reviews]').getBoundingClientRect(),layout=document.querySelector('.google-reviews-layout').getBoundingClientRect();
                    return note.top>=host.bottom && note.top-host.bottom<=12 && Math.abs(note.left-host.left)<1 && Math.abs(host.width-layout.width)<1;
                }));
                await widget.setViewportSize({width:390,height:844});
                assert(await widget.locator('[data-google-reviews-note]').evaluate(el=>el.getBoundingClientRect().top>=document.querySelector('[data-google-reviews]').getBoundingClientRect().bottom));
            }
            if(provider!=='loaded') await widget.locator('[data-google-reviews-fallback]').waitFor({state:'visible',timeout:12000});
            await widget.close();
        }
        const invalid=await setup({id:'invalid-id'});
        assert.equal(await invalid.locator('script[src*="elfsightcdn"]').count(),0);
        assert(await invalid.locator('[data-google-reviews-fallback]').isVisible());
        console.log('PASS arrows, wraparound, dots, keyboard, swipe, autoplay/pause, reduced motion, six widths, zero/one event, configured/missing/invalid widget and provider failure/empty response');
    } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
