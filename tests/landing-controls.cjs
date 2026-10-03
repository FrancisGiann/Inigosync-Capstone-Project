// Run against scripts/preview.cjs. Provider data is mocked; no widget views used.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:4178/index.html';
const uuid = '11111111-2222-3333-4444-555555555555';
let publishedSportsCount = 2;
let failCourtFetch = false;
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
                if (table === 'court' && failCourtFetch) return route.fulfill({status:500,json:{message:'Fixture court fetch failure'}});
                const data = table === 'event'
                    ? Array.from({length:count},(_,i)=>({title:'Feature '+(i+1),meta:'Venue event',tag:'Featured',image_url:'../assets/landing/featured-tournament-placeholder.png'}))
                    : table === 'court'
                        ? Array.from({length:publishedSportsCount},(_,i)=>({id:'court-'+i,name:'Sport '+(i+1),quantity:1,unit:'courts',is_active:true,display_order:i,rate:null,rate_unit:'/hr',sport:{slug:'sport-'+i,name:'Sport '+(i+1)}}))
                        : [];
                return route.fulfill({json:data});
            });
            await page.goto(base,{waitUntil:'domcontentloaded'});
            await page.waitForFunction(n => n ? document.querySelectorAll('.hero-copy').length === n && document.querySelector('.hero-title')?.textContent === 'Feature 1' : document.querySelector('.hero-meta')?.textContent.includes('no published events'),count);
            return page;
        }
        const page = await setup();
        assert.equal(await page.locator('.hero-media-backdrop').count(),0,'Event photos do not double as a blurred background');
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
        await page.waitForFunction(()=>[...document.querySelectorAll('[data-sports-count]')].every(node=>node.textContent==='2'));
        assert.deepEqual(await page.locator('[data-sports-count]').allTextContents(),['2','2']);
        assert.deepEqual(await page.locator('[data-sports-label]').allTextContents(),['Sports offered','Sports offered']);
        publishedSportsCount=3;
        await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
        await page.waitForFunction(()=>[...document.querySelectorAll('[data-sports-count]')].every(node=>node.textContent==='3'));
        publishedSportsCount=1;
        await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
        await page.waitForFunction(()=>[...document.querySelectorAll('[data-sports-count]')].every(node=>node.textContent==='1'));
        assert.deepEqual(await page.locator('[data-sports-label]').allTextContents(),['Sport offered','Sport offered']);
        publishedSportsCount=3;
        await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
        await page.waitForFunction(()=>[...document.querySelectorAll('[data-sports-count]')].every(node=>node.textContent==='3'));
        for (const width of [320,390,768,1024,1440,1920]) {
            await page.setViewportSize({width,height:900});
            for (const theme of ['dark','light']) {
                await page.evaluate(theme=>window.ThemeController.set(theme),theme);
                const format=width<=768?'portrait':'landscape';
                const background=await page.locator('.hero').evaluate(el=>getComputedStyle(el).backgroundImage);
                assert(background.includes(`featured-bg-${theme}-${format}.jpg`),`Featured background must use the ${theme} ${format} image at ${width}px`);
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

                    const courtBackground=getComputedStyle(document.querySelector('.courts')).backgroundColor;
                    const poster=getComputedStyle(document.querySelector('.featured-frame'));
                    const featured=getComputedStyle(document.querySelector('.featured'));
                    const featuredTitle=getComputedStyle(document.querySelector('#featured-title'));
                    const heroTitle=getComputedStyle(document.querySelector('.hero-title'));
                    const heroTag=getComputedStyle(document.querySelector('.hero-tag'));
                    const heroMeta=getComputedStyle(document.querySelector('.hero-meta'));
                    return {mapHeight:map.height,cardBelow:card.top>=map.bottom-1,
                        padding:getComputedStyle(document.querySelector('.site-footer')).paddingTop,
                        platformCredits:document.querySelectorAll('.footer-credits, .footer-provider').length,
                        courtBackground,posterRadius:poster.borderRadius,posterShadow:poster.boxShadow,
                        posterBorder:poster.borderColor,posterBackground:poster.backgroundColor,
                        featuredPadding:featured.paddingTop,featuredTitleSize:featuredTitle.fontSize,
                        featuredCtaCount:document.querySelectorAll('.featured-cta').length,
                        heroTitleSize:heroTitle.fontSize,heroTitleFont:heroTitle.fontFamily,
                        heroTitleLineHeight:heroTitle.lineHeight,
                        heroTagFont:heroTag.fontFamily,heroMetaSize:heroMeta.fontSize};
                });
                assert.equal(layout.mapHeight,width<=768?240:340);
                assert.equal(layout.padding,width<=768?'24px':'32px');
                assert.equal(layout.platformCredits,0);
                assert.equal(layout.courtBackground,theme==='light'?'rgb(255, 255, 255)':'rgb(17, 21, 21)');
                assert.equal(layout.posterRadius,'12px');
                assert.notEqual(layout.posterShadow,'none');
                assert.notEqual(layout.posterBorder,'rgb(255, 255, 255)');
                assert.notEqual(layout.posterBackground,'rgb(248, 244, 235)');
                assert.equal(layout.featuredPadding,width<=768?'76px':'96px');
                assert(parseFloat(layout.featuredTitleSize)>=(width<=768?30:34));
                assert.equal(layout.featuredCtaCount,0);
                assert(parseFloat(layout.heroTitleSize)>=(width<=768?32:36));
                assert.equal(layout.heroTagFont,layout.heroTitleFont);
                assert(parseFloat(layout.heroMetaSize)>=(width<=768?13:15));
                if(width<=768) { assert(layout.cardBelow); }
            }
            await page.locator('[data-home-next]').scrollIntoViewIfNeeded();
            assert(await page.locator('.hero-media-slide.is-active .hero-media-img').evaluate(img=>getComputedStyle(img).objectFit==='contain'), 'Featured photo must fit at '+width);
            if(width>=1200) assert(await page.locator('.hero-media-slide.is-active .hero-media-img').evaluate(img=>Math.abs(img.getBoundingClientRect().height-document.querySelector('.hero-media').getBoundingClientRect().height+320)<1), 'Featured photo has the larger desktop height at '+width);
            if(width<=768) assert(await page.locator('.hero-media-slide.is-active .hero-media-img').evaluate(img=>img.getBoundingClientRect().bottom<=document.querySelector('.hero-copy-wrap').getBoundingClientRect().top), 'Photo overlaps copy at '+width);
            assert(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), 'Overflow at '+width);
            assert(await page.locator('.footer-bottom').evaluate((footer,width)=>{
                const [location,copyright,signoff]=[...footer.children].map(el=>el.getBoundingClientRect());
                const row=footer.getBoundingClientRect();
                if(width<=768) return location.bottom<=copyright.top && copyright.bottom<=signoff.top && [location,copyright,signoff].every(r=>Math.abs(r.left+r.width/2-row.left-row.width/2)<1);
                return location.right<copyright.left && copyright.right<signoff.left && Math.abs(copyright.left+copyright.width/2-row.left-row.width/2)<1;
            },width), 'Footer order and centering at '+width);
            assert.equal((await page.locator('.footer-bottom > :last-child').innerText()).trim(),'See you on the court.');
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
        assert.equal(await page.getByRole('link',{name:'Facebook'}).count(),1,'Facebook link keeps its accessible name');
        assert.equal(await page.locator('.court-art-note').count(),0);
        assert.equal(await page.locator('.featured').getByRole('button',{name:'Book a court'}).count(),0);
        assert.equal(await page.locator('.featured').getByRole('link',{name:'Explore the courts'}).count(),0);
        failCourtFetch=true;
        await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
        await page.waitForFunction(()=>[...document.querySelectorAll('[data-sports-count]')].every(node=>node.textContent==='—'));
        assert(await page.locator('.content-state').isVisible(),'A failed refresh clears the previous sports count');
        failCourtFetch=false;
        publishedSportsCount=2;
        await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
        await page.waitForFunction(()=>[...document.querySelectorAll('[data-sports-count]')].every(node=>node.textContent==='2'));
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
                assert.equal(await widget.locator('[data-google-reviews-note]').count(),0);
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
