// Run against scripts/preview.cjs. Provider data is mocked; no widget views used.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
require('node:fs').mkdirSync('output/landing-qa',{recursive:true});
const base = 'http://127.0.0.1:4178/index.html';
const uuid = '11111111-2222-3333-4444-555555555555';
let publishedSportsCount = 2;
let failCourtFetch = false;
const browserPageErrors=[];
(async () => {
    const browser = await chromium.launch({channel:'msedge',headless:true});
    try {
        async function setup({count=4, reviews='loaded', motion='reduce', eventTitle}={}) {
            const page = await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:motion});
            page.on('pageerror',error=>browserPageErrors.push(String(error)));
            page.setDefaultTimeout(15000);
            await page.route('**/rest/v1/**', route => {
                const table = new URL(route.request().url()).pathname.split('/').pop();
                if (table === 'court' && failCourtFetch) return route.fulfill({status:500,json:{message:'Fixture court fetch failure'}});
                if (table === 'public_featured_booking_reviews' && reviews === 'error') return route.fulfill({status:500,json:{message:'Fixture review fetch failure'}});
                const data = table === 'event'
                    ? Array.from({length:count},(_,i)=>({title:eventTitle || 'Feature '+(i+1),meta:'Venue event',tag:'Featured',image_url:'../assets/landing/featured-tournament-placeholder.png'}))
                    : table === 'court'
                        ? Array.from({length:publishedSportsCount},(_,i)=>({id:'court-'+i,name:'Sport '+(i+1),quantity:1,unit:'courts',is_active:true,display_order:i,rate:null,rate_unit:'/hr',sport:{slug:'sport-'+i,name:'Sport '+(i+1)}}))
                        : table === 'public_featured_booking_reviews' && reviews === 'loaded'
                            ? [
                                {display_order:1,rating:5,comment:'Great courts and friendly staff.',created_at:'2026-09-20T10:00:00Z'},
                                {display_order:2,rating:4,comment:'Easy booking.',created_at:'2026-09-18T10:00:00Z'}
                            ]
                            : [];
                return route.fulfill({json:data});
            });
            await page.goto(base,{waitUntil:'domcontentloaded'});
            await page.waitForFunction(({count,expectedTitle}) => count
                ? document.querySelectorAll('.hero-copy').length === count && document.querySelector('.hero-copy .hero-title')?.textContent.trim() === expectedTitle
                : document.querySelector('.hero-copy .hero-meta')?.textContent.includes('no published events'),
                {count,expectedTitle:eventTitle || 'Feature 1'});
            return page;
        }
        const page = await setup();
        const longTitlePage = await setup({count:5,eventTitle:'BRISTOL INTEGRATED SCHOOL',motion:'no-preference'});
        await longTitlePage.setViewportSize({width:390,height:844});
        await longTitlePage.locator('#featured').scrollIntoViewIfNeeded();
        await longTitlePage.waitForFunction(()=>document.querySelector('.featured-frame-center .featured-frame-img')?.complete);
        const longTitleLayout = await longTitlePage.evaluate(()=>{
            const title=document.querySelector('.featured-copy-stack .hero-title');
            const copy=document.querySelector('.featured-copy-stack').getBoundingClientRect();
            const controls=document.querySelector('.featured-progress').getBoundingClientRect();
            const image=document.querySelector('.featured-gallery').getBoundingClientRect();
            const arrows=document.querySelector('.featured-arrows').getBoundingClientRect();
            const pause=document.querySelector('[data-home-pause]').getBoundingClientRect();
            const dots=document.querySelector('.hero-dots').getBoundingClientRect();
            const prev=document.querySelector('[data-home-prev]').getBoundingClientRect();
            const next=document.querySelector('[data-home-next]').getBoundingClientRect();
            return {text:title.textContent.trim(),titleOverflow:title.scrollWidth>title.clientWidth,
                controlsBelowCopy:controls.top>=copy.bottom,controlsRightAligned:Math.abs(controls.right-document.querySelector('.featured-caption-wrap').getBoundingClientRect().right+20)<2,arrowsWithinImage:arrows.top>=image.top&&arrows.bottom<=image.bottom,
                imageBottom:image.bottom,pauseSize:getComputedStyle(document.querySelector('[data-home-pause]')).fontSize,
                pauseLabel:document.querySelector('[data-home-pause]').getAttribute('aria-label'),
                controlsDirection:getComputedStyle(document.querySelector('.featured-progress')).flexDirection,
                dotsDirection:getComputedStyle(document.querySelector('.hero-dots')).flexDirection,
                dotsWrap:getComputedStyle(document.querySelector('.hero-dots')).flexWrap,
                dotsCount:document.querySelectorAll('.hero-dots .hero-dot').length,
                controlsCentered:Math.abs((pause.left+pause.right-dots.left-dots.right)/2)<1,
                pauseAboveDots:pause.bottom<=dots.top,arrowCenters:[prev,next].map(r=>(r.top+r.height/2-image.top)/image.height)};
        });
        assert.equal(longTitleLayout.text,'BRISTOL INTEGRATED SCHOOL');
        assert.equal(longTitleLayout.titleOverflow,false,'Long featured titles wrap without clipping on phones');
        assert.equal(longTitleLayout.controlsBelowCopy,true,'Pause and pagination have a separate row below the event caption');
        assert.equal(longTitleLayout.controlsRightAligned,true,'Phone slideshow controls occupy a dedicated right aligned area');
        assert.equal(longTitleLayout.arrowsWithinImage,true,'Previous and next controls stay on the photo edges');
        assert.equal(longTitleLayout.pauseSize,'0px','Pause control uses an icon instead of visible text');
        assert.equal(longTitleLayout.pauseLabel,'Pause slideshow','Pause icon retains an accessible label');
        assert.equal(longTitleLayout.controlsDirection,'column','Slideshow controls stack under the event caption');
        assert.equal(longTitleLayout.controlsCentered,true,'Pause and pagination align within the right side control group');
        assert.equal(longTitleLayout.pauseAboveDots,true,'Pause control sits above the pagination dots');
        assert.equal(longTitleLayout.dotsDirection,'row','Pagination indicators remain in one horizontal row');
        assert.equal(longTitleLayout.dotsWrap,'nowrap','Five pagination indicators do not wrap into a column');
        assert.equal(longTitleLayout.dotsCount,5,'All five pagination indicators remain visible');
        assert(longTitleLayout.arrowCenters.every(center=>center>=.42&&center<=.44),`Image arrows stay around 43% height: ${longTitleLayout.arrowCenters}`);
        await longTitlePage.locator('[data-home-pause]').click();
        assert.equal(await longTitlePage.locator('[data-home-pause]').getAttribute('aria-label'),'Play slideshow');
        assert.equal(await longTitlePage.locator('[data-home-pause] .play-icon').evaluate(el=>getComputedStyle(el).display),'block');
        assert.equal(await longTitlePage.locator('.hero-dots').evaluate(el=>getComputedStyle(el).flexDirection),'row');
        await longTitlePage.screenshot({path:'output/landing-qa/featured-long-title-390.png'});
        await longTitlePage.setViewportSize({width:1440,height:900});
        await longTitlePage.screenshot({path:'output/landing-qa/featured-long-title-1440.png'});
        await longTitlePage.close();
        const visitLogin = page.locator('.landing-visit-cta [data-auth-open="login"]');
        await visitLogin.click();
        assert(await page.locator('[data-auth-overlay]').isVisible(),'Plan your visit opens the existing login dialog');
        await page.keyboard.press('Tab');
        assert(await page.locator('.auth-modal').evaluate(el=>el.contains(document.activeElement)),
            'Keyboard focus remains inside the opened login dialog');
        await page.keyboard.press('Escape');
        await page.waitForFunction(()=>document.querySelector('[data-auth-overlay]').hidden);
        assert(await visitLogin.evaluate(el=>el===document.activeElement),'Closing the login dialog returns focus to Plan your visit');
        for(const width of [1440,390,320]) for(const theme of ['light','dark']) {
            await page.setViewportSize({width,height:width<400?844:1000});
            await page.evaluate(theme=>window.ThemeController.set(theme),theme);
            const visitSection=page.locator('.landing-visit-cta');
            await visitSection.scrollIntoViewIfNeeded();
            const visitLayout=await page.evaluate(()=>{
                const rect=selector=>document.querySelector(selector).getBoundingClientRect();
                const text=rect('.landing-visit-cta-inner > div');
                const description=rect('.landing-visit-cta .body-text');
                const actions=rect('.landing-visit-cta-actions');
                const buttons=[...document.querySelectorAll('.landing-visit-cta-actions .cta-button')].map(el=>el.getBoundingClientRect());
                return {textLeft:text.left,actionsLeft:actions.left,descriptionBottom:description.bottom,actionsTop:actions.top,
                    withinViewport:actions.left>=0&&actions.right<=innerWidth&&buttons.every(button=>button.left>=0&&button.right<=innerWidth),
                    buttonRows:buttons.map(button=>Math.round(button.top)),noOverflow:document.documentElement.scrollWidth<=innerWidth};
            });
            assert(Math.abs(visitLayout.textLeft-visitLayout.actionsLeft)<=1,`Plan visit buttons align with the text block at ${width}px ${theme}: ${JSON.stringify(visitLayout)}`);
            assert(visitLayout.actionsTop>=visitLayout.descriptionBottom+12,`Plan visit buttons follow the description with a gap at ${width}px ${theme}: ${JSON.stringify(visitLayout)}`);
            assert(visitLayout.withinViewport&&visitLayout.noOverflow,`Plan visit buttons stay within mobile bounds at ${width}px ${theme}: ${JSON.stringify(visitLayout)}`);
            if(width>768) assert(Math.abs(visitLayout.buttonRows[0]-visitLayout.buttonRows[1])<=1,`Plan visit buttons share one row at desktop width: ${JSON.stringify(visitLayout)}`);
            await visitSection.screenshot({path:`output/landing-qa/plan-visit-${width}-${theme}.png`});
        }
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
        await page.waitForFunction(()=>document.querySelectorAll('[data-onsite-review-grid] .testimonial-card').length===2);
        assert.equal(await page.locator('[data-onsite-review-grid] .testimonial-card').count(),2);
        const landingReviews=await page.locator('[data-onsite-review-grid]').innerText();
        assert.match(landingReviews,/Verified customer[\s\S]*Great courts and friendly staff\./);
        assert.doesNotMatch(landingReviews,/sam@example\.com|09281234567/i,'contact-bearing display names must not appear on the landing page');
        assert(await page.locator('[data-onsite-reviews-status]').isHidden(),'the review count should not appear above loaded cards');
        assert.equal(await page.locator('script[src*="elfsightcdn"]').count(),0);
        await page.waitForFunction(()=>[...document.querySelectorAll('[data-sports-count]')].every(node=>node.textContent==='2'));
        assert.deepEqual(await page.locator('[data-sports-count]').allTextContents(),['2']);
        assert.deepEqual(await page.locator('[data-sports-label]').allTextContents(),['Sports offered']);
        publishedSportsCount=3;
        await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
        await page.waitForFunction(()=>[...document.querySelectorAll('[data-sports-count]')].every(node=>node.textContent==='3'));
        publishedSportsCount=1;
        await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
        await page.waitForFunction(()=>[...document.querySelectorAll('[data-sports-count]')].every(node=>node.textContent==='1'));
        assert.deepEqual(await page.locator('[data-sports-label]').allTextContents(),['Sport offered']);
        publishedSportsCount=3;
        await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
        await page.waitForFunction(()=>[...document.querySelectorAll('[data-sports-count]')].every(node=>node.textContent==='3'));
        for (const width of [320,390,768,850,1024,1440,1920]) {
            await page.setViewportSize({width,height:900});
            for (const theme of ['dark','light']) {
                await page.evaluate(theme=>window.ThemeController.set(theme),theme);
                const format=width<=768?'portrait':'landscape';
                await page.waitForFunction(({theme,format})=>getComputedStyle(document.body,'::before').backgroundImage.includes(`featured-bg-${theme}-${format}.jpg`),{theme,format});
                const background=await page.locator('body').evaluate(el=>getComputedStyle(el,'::before').backgroundImage);
                assert(background.includes(`featured-bg-${theme}-${format}.jpg`),`Stationary venue backdrop must use the ${theme} ${format} image at ${width}px, got ${background} (theme ${await page.locator('html').getAttribute('data-theme')})`);
                const backdropPosition=await page.locator('body').evaluate(el=>getComputedStyle(el,'::before').position);
                assert.equal(backdropPosition,'fixed',`The shared venue backdrop must stay fixed while scrolling at ${width}px`);
                const header=await page.evaluate(()=>{
                    const header=document.querySelector('.site-nav');
                    const pill=document.querySelector('.site-nav-pill');
                    const rect=header.getBoundingClientRect();
                    const style=getComputedStyle(header);
                    const logo=document.querySelector('.site-nav .logo-image');
                    return {left:rect.left,width:rect.width,height:rect.height,background:style.backgroundColor,
                        radius:getComputedStyle(pill).borderRadius,logoLoaded:logo.complete&&logo.naturalWidth>0,
                        brandText:document.querySelector('.site-nav .logo-text')?.textContent.trim(),
                        brandMarkWidth:logo.getBoundingClientRect().width,brandMarkHeight:logo.getBoundingClientRect().height,
                        brandMarkOverflow:getComputedStyle(logo.parentElement).overflow,brandObjectFit:getComputedStyle(logo).objectFit,
                        navDisplay:getComputedStyle(document.querySelector('.site-nav-links')).display,
                        ctaDisplay:getComputedStyle(document.querySelector('.site-nav-actions .book-now')).display,
                        menuDisplay:getComputedStyle(document.querySelector('.menu-toggle')).display,
                        noOverflow:document.documentElement.scrollWidth<=innerWidth};
                });
                assert.equal(header.left,0,`Header surface must start at the viewport edge at ${width}px`);
                assert.equal(header.width,width,`Header surface must span the viewport at ${width}px`);
                assert.equal(header.radius,'0px',`Header must remain flat rather than pill-shaped at ${width}px`);
                assert(header.logoLoaded,`The transparent brand asset should load at ${width}px`);
                assert.equal(header.brandText,'IñigoSync',`Show the product name beside the system logo at ${width}px`);
                assert(header.brandMarkWidth>=40,`Keep the full system logo readable at ${width}px`);
                assert.equal(header.brandMarkHeight,header.brandMarkWidth,`Show the complete square logo artwork at ${width}px`);
                assert.equal(header.brandMarkOverflow,'visible',`Do not crop the full header logo at ${width}px`);
                assert.equal(header.brandObjectFit,'contain',`Fit the complete logo artwork inside the header mark at ${width}px`);
                const footerBrand=await page.evaluate(()=>{
                    const image=document.querySelector('.footer-brand-main .logo-image');
                    const headerText=getComputedStyle(document.querySelector('.site-nav .logo-text'));
                    const footerText=getComputedStyle(document.querySelector('.footer-brand-main .logo-text'));
                    return {loaded:image.complete&&image.naturalWidth>0,text:document.querySelector('.footer-brand-main .logo-text')?.textContent.trim(),
                        width:image.getBoundingClientRect().width,height:image.getBoundingClientRect().height,
                        overflow:getComputedStyle(image.parentElement).overflow,objectFit:getComputedStyle(image).objectFit,
                        family:footerText.fontFamily,headerFamily:headerText.fontFamily,weight:footerText.fontWeight,headerWeight:headerText.fontWeight,
                        color:footerText.color,headerColor:headerText.color,align:getComputedStyle(image.parentElement.parentElement).alignItems};
                });
                assert(footerBrand.loaded,`The full system logo should load in the footer at ${width}px`);
                assert.equal(footerBrand.text,'IñigoSync');
                assert(footerBrand.width>=40,`Footer system logo should be full size at ${width}px`);
                assert.equal(footerBrand.height,footerBrand.width,`Footer should display the complete square logo at ${width}px`);
                assert.equal(footerBrand.overflow,'visible',`Footer must not crop the complete logo at ${width}px`);
                assert.equal(footerBrand.objectFit,'contain');
                assert.equal(footerBrand.family,footerBrand.headerFamily,`Footer lockup should match header font at ${width}px`);
                assert.equal(footerBrand.weight,footerBrand.headerWeight,`Footer lockup should match header weight at ${width}px`);
                assert.equal(footerBrand.color,footerBrand.headerColor,`Footer lockup should match header orange at ${width}px`);
                assert.equal(footerBrand.align,'center',`Footer logo and wordmark should align together at ${width}px`);
                assert.equal(header.background,theme==='light'?'rgb(255, 255, 255)':'rgb(9, 9, 9)',
                    `Header surface should be fully opaque in ${theme} mode at ${width}px: ${header.background}`);
                const backdropFilter=await page.locator('.site-nav').evaluate(el=>getComputedStyle(el).backdropFilter);
                assert.equal(backdropFilter,'none',`Opaque header does not use backdrop blur at ${width}px`);
                assert(header.height>=68&&header.height<=90,`Header should be compact and consistent at ${width}px: ${header.height}`);
                assert.equal(header.navDisplay,width<=768?'none':'block',`Navigation should switch to the drawer at the mobile breakpoint (${width}px)`);
                assert.equal(header.menuDisplay,width<=768?'block':'none',`Menu toggle visibility should follow the mobile breakpoint (${width}px)`);
                assert.equal(header.ctaDisplay,width<=768?'none':'block',`Desktop auth CTA should move into the drawer at ${width}px`);
                assert(header.noOverflow,`Header must not cause horizontal overflow at ${width}px`);
                await page.evaluate(()=>document.activeElement.blur());
                await page.keyboard.press('Tab');
                await page.locator('[data-theme-toggle]').focus();
                assert(await page.locator('[data-theme-toggle]').evaluate(el=>el===document.activeElement),
                    'Theme control should be reachable by keyboard');
                const focusColor=await page.locator('[data-theme-toggle]').evaluate(el=>({
                    outline:getComputedStyle(el).outlineStyle,width:getComputedStyle(el).outlineWidth,color:getComputedStyle(el).outlineColor}));
                assert.deepEqual(focusColor,{outline:'solid',width:'3px',color:theme==='light'?'rgb(185, 71, 0)':'rgb(255, 154, 74)'},
                    `Theme control needs a visible keyboard focus ring in ${theme} mode`);
                await page.locator('[data-theme-toggle]').evaluate(el=>el.blur());
                assert.equal(await page.locator('.site-nav-links a.active').evaluate(el=>getComputedStyle(el).color),
                    theme==='light'?'rgb(185, 71, 0)':'rgb(255, 154, 74)',`Active navigation color should remain legible in ${theme} mode`);
                if(width>768) {
                    await page.locator('.site-nav-links a[href="#featured"]').hover();
                    assert.equal(await page.locator('.site-nav-links a[href="#featured"]').evaluate(el=>getComputedStyle(el).color),
                        theme==='light'?'rgb(185, 71, 0)':'rgb(255, 154, 74)',`Hover navigation color should remain legible in ${theme} mode`);
                    await page.mouse.move(0,500);
                }
                if(width===1440&&theme==='light') {
                    await page.locator('[data-theme-toggle]').click();
                    assert.equal(await page.locator('html').getAttribute('data-theme'),'dark','Theme toggle should switch the header and page into dark mode');
                    await page.locator('[data-theme-toggle]').click();
                    assert.equal(await page.locator('html').getAttribute('data-theme'),'light','Theme toggle should restore light mode');
                }
                const backdropScrollCheck=await page.evaluate(async()=>{
                    const pseudo=()=>getComputedStyle(document.body,'::before');
                    const read=()=>({position:pseudo().position,image:pseudo().backgroundImage,
                        backgroundPosition:pseudo().backgroundPosition,backgroundSize:pseudo().backgroundSize});
                    scrollTo({top:0,behavior:'instant'});
                    const home=read();
                    document.querySelector('#featured').scrollIntoView({block:'start',behavior:'instant'});
                    await new Promise(requestAnimationFrame);
                    const featured=read();
                    const featureSurface=getComputedStyle(document.querySelector('#featured')).backgroundImage;
                    const scrollY=window.scrollY;
                    scrollTo({top:0,behavior:'instant'});
                    return {home,featured,featureSurface,scrollY};
                });
                assert(backdropScrollCheck.scrollY>0,`Scroll check must reach Featured at ${width}px`);
                assert.equal(backdropScrollCheck.featured.position,backdropScrollCheck.home.position,`The shared backdrop must stay fixed between Home and Featured at ${width}px`);
                assert.equal(backdropScrollCheck.featured.backgroundPosition,backdropScrollCheck.home.backgroundPosition,`The shared backdrop crop must stay stable between Home and Featured at ${width}px`);
                assert.equal(backdropScrollCheck.featured.backgroundSize,backdropScrollCheck.home.backgroundSize,`The shared backdrop sizing must stay stable between Home and Featured at ${width}px`);
                assert(!backdropScrollCheck.featureSurface.includes('featured-bg-'),`Featured must reveal the fixed backdrop rather than restart its own image: ${backdropScrollCheck.featureSurface}`);
                const firstScreen=await page.evaluate(()=>{
                    const hero=document.querySelector('.hero').getBoundingClientRect();
                    const facts=document.querySelector('.hero-stats').getBoundingClientRect();
                    const cta=document.querySelector('.cta-buttons').getBoundingClientRect();
                    const launcher=document.querySelector('.floating-basketball').getBoundingClientRect();
                    const featured=document.querySelector('.featured').getBoundingClientRect();
                    const factsLauncherOverlap=facts.left<launcher.right&&facts.right>launcher.left&&facts.top<launcher.bottom&&facts.bottom>launcher.top;
                    return {heroHeight:hero.height,heroBottom:hero.bottom+scrollY,
                        factsTop:facts.top+scrollY,factsBottom:facts.bottom+scrollY,
                        factsInsideHero:facts.top>=hero.top&&facts.bottom<=hero.bottom,
                        factsVisible:innerHeight<700||facts.bottom<=innerHeight+1,
                        factsClearCTA:facts.top>=cta.bottom+8,
                        factsAvoidLauncher:!factsLauncherOverlap,
                        featuredTop:featured.top+scrollY,viewportHeight:innerHeight,
                        noOverflow:document.documentElement.scrollWidth<=innerWidth};
                });
                assert(firstScreen.heroHeight>=640 && firstScreen.factsInsideHero && firstScreen.factsVisible && firstScreen.factsClearCTA &&
                    firstScreen.factsAvoidLauncher && firstScreen.featuredTop>=firstScreen.heroBottom-1 && firstScreen.noOverflow,
                    `Hero facts and Featured must fit cleanly at ${width}px in ${theme} mode: ${JSON.stringify(firstScreen)}`);
                const layout=await page.evaluate(()=>{
                    const rect=s=>document.querySelector(s).getBoundingClientRect();
                    const map=rect('.footer-map-frame'),card=rect('.map-location-card');
                const facts=rect('.hero-stats'),launcher=rect('.floating-basketball');
                const factsLauncherOverlap=facts.left<launcher.right&&facts.right>launcher.left&&facts.top<launcher.bottom&&facts.bottom>launcher.top;

                    const courtBackground=getComputedStyle(document.querySelector('.courts')).backgroundColor;
                    const poster=getComputedStyle(document.querySelector('.featured-frame'));
                    const featured=getComputedStyle(document.querySelector('.featured'));
                    const featuredTitle=getComputedStyle(document.querySelector('#featured-title'));
                    const heroTitle=getComputedStyle(document.querySelector('.hero-title'));
                    const heroTag=getComputedStyle(document.querySelector('.hero-tag'));
                    const heroMeta=getComputedStyle(document.querySelector('.hero-meta'));
                    const visit=document.querySelector('.landing-visit-cta');
                    const visitCopy=document.querySelector('.landing-visit-cta-inner > div:first-child');
                    const factsBand=getComputedStyle(document.querySelector('.landing-facts'));
                    const factsInner=getComputedStyle(document.querySelector('.landing-facts .hero-stats'));
                    const courtGrid=document.querySelector('.court-grid');
                    const courtCards=[...courtGrid.querySelectorAll(':scope > .court-card')];
                    const courtCardWidths=courtCards.map(el=>el.getBoundingClientRect().width);
                    const aboutBand=document.querySelector('.about-story-band');
                    const footer=document.querySelector('.site-footer');
                    const mapCard=document.querySelector('.map-location-card');
                    return {mapHeight:map.height,cardBelow:card.top>=map.bottom-1,factsLauncherOverlap,
                        factsBandBackground:factsBand.backgroundColor,factsBandWidth:rect('.landing-facts').width,
                        factsCardBackground:factsInner.backgroundColor,factsCardWidth:rect('.hero-stats').width,
                        factsCardHeight:rect('.hero-stats').height,
                        factsInnerRadius:factsInner.borderRadius,factsInnerShadow:factsInner.boxShadow,
                        factsIconCount:document.querySelectorAll('.landing-facts .facts-icon').length,
                        googleRating:document.querySelector('.google-rating-fact')?.innerText,
                        googleRatingLabel:document.querySelector('.google-rating-fact')?.getAttribute('aria-label'),
                        googleRatingTitle:document.querySelector('.google-rating-fact')?.title,
                        googleRatingLinks:document.querySelectorAll('.google-rating-fact a').length,
                        factsColumns:getComputedStyle(document.querySelector('.hero-stats')).gridTemplateColumns.trim().split(/\s+/).length,
                        aboutStatRows:document.querySelectorAll('.about-stats').length,
                        factsCardHeight:rect('.hero-stats').height,
                        courtColumns:getComputedStyle(courtGrid).gridTemplateColumns.trim().split(/\s+/).length,
                        courtCardWidths,courtCardCount:courtCards.length,
                        padding:getComputedStyle(document.querySelector('.site-footer')).paddingTop,
                        platformCredits:document.querySelectorAll('.footer-credits, .footer-provider').length,
                        courtBackground,posterRadius:poster.borderRadius,posterShadow:poster.boxShadow,
                        posterBorder:poster.borderColor,posterBackground:poster.backgroundColor,
                        featuredPadding:featured.paddingTop,featuredTitleSize:featuredTitle.fontSize,
                        featuredCtaCount:document.querySelectorAll('.featured-cta').length,
                        featuredCardRadius:getComputedStyle(document.querySelector('.featured-showcase')).borderRadius,
                        featuredCardShadow:getComputedStyle(document.querySelector('.featured-showcase')).boxShadow,
                        featuredBackground:featured.backgroundImage,
                        aboutBandBackground:getComputedStyle(aboutBand).backgroundColor,
                        aboutTitleColor:getComputedStyle(aboutBand.querySelector('.section-title')).color,
                        aboutBodyColor:getComputedStyle(aboutBand.querySelector('.body-text')).color,
                        footerBackground:getComputedStyle(footer).backgroundColor,
                        footerTextColor:getComputedStyle(footer.querySelector('.footer-card h3')).color,
                        mapCardBackground:getComputedStyle(mapCard).backgroundColor,
                        mapCardTextColor:getComputedStyle(mapCard).color,
                        reviewsBackground:getComputedStyle(document.querySelector('.about-reviews')).backgroundColor,
                        visitBackground:getComputedStyle(visit).backgroundImage,
                        visitOverlay:getComputedStyle(visit,'::before').display,
                        visitCopyWash:getComputedStyle(visitCopy,'::before').backgroundImage,
                        visitCopyPseudoDisplay:getComputedStyle(visitCopy,'::before').display,
                        visitCopyWidth:visitCopy.getBoundingClientRect().width,
                        visitTitleShadow:getComputedStyle(visit.querySelector('.section-title')).textShadow,
                        visitBodyShadow:getComputedStyle(visit.querySelector('.body-text')).textShadow,
                        visitEyebrowShadow:getComputedStyle(visit.querySelector('.eyebrow')).textShadow,
                        visitBodyColor:getComputedStyle(visit.querySelector('.body-text')).color,
                        visitBodyWeight:getComputedStyle(visit.querySelector('.body-text')).fontWeight,
                        visitEyebrowColor:getComputedStyle(visit.querySelector('.eyebrow')).color,
                        visitTitleStroke:getComputedStyle(visit.querySelector('.section-title')).webkitTextStrokeWidth,
                        visitTitleColor:getComputedStyle(visit.querySelector('.section-title')).color,
                        visitPrimaryText:getComputedStyle(visit.querySelector('.cta-button:not(.secondary)')).color,
                        visitSecondaryText:getComputedStyle(visit.querySelector('.cta-button.secondary')).color,
                        heroTitleSize:heroTitle.fontSize,heroTitleFont:heroTitle.fontFamily,
                        heroTitleLineHeight:heroTitle.lineHeight,
                        heroTagFont:heroTag.fontFamily,heroMetaSize:heroMeta.fontSize};
                });
                assert.equal(layout.mapHeight,width<=768?240:340);
                assert.equal(layout.factsLauncherOverlap,false,`Facts card must not collide with the help launcher at ${width}px in ${theme} mode`);
                assert.equal(layout.factsBandBackground,'rgba(0, 0, 0, 0)',`Facts section backdrop should remain transparent at ${width}px in ${theme} mode`);
                assert.equal(layout.factsBandWidth,width,`Facts band should span the viewport at ${width}px in ${theme} mode`);
                assert.notEqual(layout.factsCardBackground,'rgba(0, 0, 0, 0)',`Facts need a contained elevated surface at ${width}px in ${theme} mode`);
                assert(layout.factsCardWidth<width,`Facts surface must be contained at ${width}px in ${theme} mode`);
                assert(layout.factsCardHeight>=(width<=768?120:104),`Home facts card should remain clearly readable at ${width}px in ${theme} mode`);
                assert.equal(layout.factsInnerRadius,'10px',`Facts surface should have a restrained radius at ${width}px in ${theme} mode`);
                assert.notEqual(layout.factsInnerShadow,'none',`Facts surface should be subtly elevated at ${width}px in ${theme} mode`);
                assert.equal(layout.factsIconCount,4,`Show one simple icon for each of the four facts at ${width}px in ${theme} mode`);
                assert.match(layout.googleRating,/4\.4\/5[\s\S]*Google rating/);
                assert.equal(layout.googleRatingLabel,'Google rating, 4.4 out of 5');
                assert.equal(layout.googleRatingTitle,'Google listing snapshot · Oct 24, 2026');
                assert.equal(layout.googleRatingLinks,0,'Google rating is a concise non-clickable snapshot tile');
                assert.equal(layout.factsColumns,width<=768?1:4,`Facts use four columns on desktop and a stack on mobile at ${width}px`);
                assert.equal(layout.aboutStatRows,0,`The three Home facts should not be repeated in About at ${width}px in ${theme} mode`);
                assert(layout.factsCardHeight>= (width<=768?120:104),`The Home facts card should remain readable and substantial at ${width}px in ${theme} mode`);
                assert.equal(layout.courtCardCount,3,`Court fixture should render all cards at ${width}px in ${theme} mode`);
                assert.equal(layout.courtColumns,width<=560?1:width<=900?2:3,`Court cards should use consistent responsive columns at ${width}px in ${theme} mode`);
                assert(Math.max(...layout.courtCardWidths)-Math.min(...layout.courtCardWidths)<1,`All sport cards should have the same width at ${width}px in ${theme} mode: ${layout.courtCardWidths}`);
                assert.equal(layout.padding,width<=768?'24px':'32px');
                assert.equal(layout.platformCredits,0);
                assert.equal(layout.courtBackground,theme==='light'?'rgb(244, 244, 244)':'rgb(17, 17, 17)');
                assert.equal(layout.featuredCardRadius,'0px');
                assert.equal(layout.featuredCardShadow,'none');
                assert.equal(layout.featuredBackground,'none');
                if(theme==='light') {
                    assert.equal(layout.aboutBandBackground,'rgb(244, 244, 244)',`About should use a light story band at ${width}px`);
                    assert.equal(layout.aboutTitleColor,'rgb(17, 17, 17)');
                    assert.equal(layout.aboutBodyColor,'rgb(80, 80, 80)');
                    assert.equal(layout.footerBackground,'rgb(244, 244, 244)',`Footer should remain light at ${width}px`);
                    assert.equal(layout.footerTextColor,'rgb(17, 17, 17)');
                    assert.equal(layout.mapCardBackground,'rgb(255, 255, 255)',`Map card should remain light at ${width}px`);
                    assert.equal(layout.mapCardTextColor,'rgb(17, 17, 17)');
                    assert.equal(layout.reviewsBackground,'rgb(255, 255, 255)');
                } else {
                    assert.equal(layout.aboutBandBackground,'rgb(5, 5, 5)');
                    assert.equal(layout.aboutTitleColor,'rgb(243, 239, 229)');
                    assert.equal(layout.aboutBodyColor,'rgb(201, 210, 209)');
                    assert.equal(layout.footerBackground,'rgb(5, 5, 5)');
                    assert.equal(layout.footerTextColor,'rgb(243, 239, 229)');
                    assert.equal(layout.mapCardBackground,'rgb(23, 44, 56)');
                    assert.equal(layout.mapCardTextColor,'rgb(243, 239, 229)');
                    assert.equal(layout.reviewsBackground,'rgb(9, 9, 9)');
                }
                assert.equal(layout.visitBackground,'none',`Plan your visit must show the underlying page background at ${width}px in ${theme} mode`);
                assert.equal(layout.visitOverlay,'none',`Plan your visit has no section overlay in ${theme} mode`);
                if(theme==='light') {
                    assert.equal(layout.visitCopyWash,'none',`Light mode has no panel behind the copy at ${width}px`);
                    assert.equal(layout.visitCopyPseudoDisplay,'none',`Light mode has no copy panel pseudo-element at ${width}px`);
                    for(const shadow of [layout.visitTitleShadow,layout.visitBodyShadow,layout.visitEyebrowShadow]) assert.notEqual(shadow,'none',`Light-mode text has per-glyph contrast treatment at ${width}px`);
                    assert.equal(layout.visitBodyColor,'rgb(255, 255, 255)');
                    assert.equal(layout.visitEyebrowColor,'rgb(255, 255, 255)');
                    assert.equal(layout.visitTitleStroke,'0px');
                    assert.equal(layout.visitBodyWeight,'600');
                }
                else assert.equal(layout.visitCopyWash,'none',`Dark mode keeps its original photo surface at ${width}px`);
                if(theme==='light'&&width>768) assert(layout.visitCopyWidth<=700,`Light-mode text stays within its existing copy width at ${width}px`);
                assert.equal(layout.visitTitleColor,'rgb(255, 255, 255)');
                assert.equal(layout.visitPrimaryText,'rgb(17, 17, 17)');
                assert.equal(layout.visitSecondaryText,theme==='light'?'rgb(17, 17, 17)':'rgb(255, 255, 255)');
                assert(!layout.featuredBackground.includes('featured-bg-'),`Featured must reveal the shared fixed backdrop instead of restarting its own image: ${layout.featuredBackground}`);
                assert(parseFloat(layout.featuredPadding)>=28 && parseFloat(layout.featuredPadding)<=(width<=768?28:44));
                assert(parseFloat(layout.featuredTitleSize)>=(width<=768?30:34));
                assert.equal(layout.featuredCtaCount,0);
                assert(parseFloat(layout.heroTitleSize)>=(width<=768?32:36));
                assert.equal(layout.heroTagFont,layout.heroTitleFont);
                assert(parseFloat(layout.heroMetaSize)>=(width<=768?13:15));
                if(width<=768) { assert(layout.cardBelow); }
            }
            if([390,1440,1920].includes(width)) {
                for(const theme of ['light','dark']) {
                    await page.evaluate(theme=>window.ThemeController.set(theme),theme);
                    await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
                    await page.waitForFunction(()=>!document.querySelector('.site-nav').classList.contains('is-hidden'));
                    await page.waitForTimeout(120);
                    const height=width===390?844:width===1920?1000:900;
                    await page.setViewportSize({width,height});
                    await page.screenshot({path:`output/landing-qa/header-${width}x${height}-${theme}.png`});
                    if(width===390) {
                        await page.getByRole('button',{name:'Open menu'}).click();
                        assert(await page.locator('.nav-menu').isVisible(),`Mobile drawer should open over the ${theme} hero`);
                        await page.waitForTimeout(120);
                        await page.screenshot({path:`output/landing-qa/header-${width}x${height}-${theme}-menu.png`});
                        await page.keyboard.press('Escape');
                    }
                    await page.locator('#featured').scrollIntoViewIfNeeded();
                    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
                    await page.evaluate(()=>scrollBy({top:-120,behavior:'instant'}));
                    await page.waitForTimeout(120);
                    await page.screenshot({path:`output/landing-qa/header-${width}x${height}-${theme}-scrolled.png`});
                }
                await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
                await page.setViewportSize({width,height:900});
            }
            await page.locator('[data-home-next]').scrollIntoViewIfNeeded();
            await page.waitForFunction(()=>{const image=document.querySelector('.featured-frame-center .featured-frame-img');return image&&image.complete&&image.naturalWidth>0});
            assert(await page.locator('.featured-frame-center .featured-frame-img').evaluate(img=>getComputedStyle(img).objectFit==='cover'), 'Featured photos should fill their responsive frame at '+width);
            if(width>=1200) assert(await page.locator('.featured-frame-center .featured-frame-img').evaluate(img=>img.getBoundingClientRect().width>0&&img.getBoundingClientRect().height>0&&img.closest('.featured-frame-center').contains(img)), 'Featured photo must remain inside the desktop frame at '+width);
            if(width<=768) assert(await page.evaluate(()=>document.querySelector('.featured-gallery').getBoundingClientRect().bottom<=document.querySelector('.featured-caption-wrap').getBoundingClientRect().top+1), 'Featured photo must not overlap its caption at '+width);
            assert(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), 'Overflow at '+width);
            assert(await page.locator('.footer-bottom').evaluate((footer,width)=>{
                const [location,copyright,signoff]=[...footer.children].map(el=>el.getBoundingClientRect());
                const row=footer.getBoundingClientRect();
                if(width<=768) return location.bottom<=copyright.top && copyright.bottom<=signoff.top && [location,copyright,signoff].every(r=>Math.abs(r.left+r.width/2-row.left-row.width/2)<1);
                return location.right<copyright.left && copyright.right<signoff.left && Math.abs(copyright.left+copyright.width/2-row.left-row.width/2)<1;
            },width), 'Footer order and centering at '+width);
            assert.equal((await page.locator('.footer-bottom > :last-child').innerText()).trim(),'See you on the court.');
            assert(await page.evaluate(width=>{
                const rect=s=>document.querySelector(s).getBoundingClientRect();
                const copy=rect('.featured-copy-stack'),group=rect('.featured-progress');
                const caption=rect('.featured-caption-wrap');
                return width<=768
                    ? group.top>=copy.bottom-1&&group.right<=caption.right&&group.bottom<=caption.bottom&&group.left>=caption.left
                    : group.left>=copy.right-1&&group.right<=caption.right&&group.top>=caption.top&&group.bottom<=caption.bottom;
            },width), 'Featured controls must occupy a dedicated right side area at '+width);
            const featuredLayout=await page.evaluate(()=>{
                const image=document.querySelector('.featured-gallery').getBoundingClientRect();
                const caption=document.querySelector('.featured-caption-wrap').getBoundingClientRect();
                const prev=document.querySelector('[data-home-prev]').getBoundingClientRect();
                const next=document.querySelector('[data-home-next]').getBoundingClientRect();
                const pause=document.querySelector('[data-home-pause]').getBoundingClientRect();
                const icon=[...document.querySelectorAll('[data-home-pause] svg')].find(el=>getComputedStyle(el).display!=='none').getBoundingClientRect();
                const dots=document.querySelector('.hero-dots').getBoundingClientRect();
                return {overlap:image.bottom-caption.top,arrowCenters:[prev,next].map(r=>(r.top+r.height/2-image.top)/image.height),
                    controlsDirection:getComputedStyle(document.querySelector('.featured-progress')).flexDirection,
                    dotsDirection:getComputedStyle(document.querySelector('.hero-dots')).flexDirection,
                    dotsWrap:getComputedStyle(document.querySelector('.hero-dots')).flexWrap,
                    centersMatch:Math.abs((pause.left+pause.right-dots.left-dots.right)/2)<1,pauseAboveDots:pause.bottom<=dots.top,
                    pauseIconCentered:Math.abs((pause.left+pause.right-icon.left-icon.right)/2)<.5&&Math.abs((pause.top+pause.bottom-icon.top-icon.bottom)/2)<.5};
            });
            if(width<=768) assert(featuredLayout.overlap<=0,`Mobile caption sits below the photo without overlap at ${width}px: ${featuredLayout.overlap}`);
            else assert(featuredLayout.overlap>=24&&featuredLayout.overlap<=48,`Desktop caption overlaps only a shallow image strip at ${width}px: ${featuredLayout.overlap}`);
            assert(featuredLayout.arrowCenters.every(center=>center>=.42&&center<=.44),`Arrows sit at 42–44% of the photo height at ${width}px: ${featuredLayout.arrowCenters}`);
            assert.equal(featuredLayout.controlsDirection,'column');
            assert.equal(featuredLayout.dotsDirection,'row');
            assert.equal(featuredLayout.dotsWrap,'nowrap');
            assert(featuredLayout.centersMatch&&featuredLayout.pauseAboveDots,`Pause is centered above the dot row at ${width}px`);
            assert(featuredLayout.pauseIconCentered,`Pause SVG is centered inside its button at ${width}px`);
            assert(await page.locator('[data-home-pause] .pause-icon').count()===1,'Pause uses a clear two-bar SVG icon');
            for (const selector of ['[data-home-prev]','[data-home-next]']) {
                const control=await page.locator(selector).evaluate(el=>{
                    const r=el.getBoundingClientRect(),gallery=document.querySelector('.featured-gallery').getBoundingClientRect();
                    const stage=document.querySelector('.featured-media-stage'),progress=document.querySelector('.featured-progress');
                    return {visible:!el.hidden,width:r.width,height:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right,galleryTop:gallery.top,galleryBottom:gallery.bottom,stage:stage.getBoundingClientRect().toJSON(),stagePosition:getComputedStyle(stage).position,progressPosition:getComputedStyle(progress).position,offsetParent:el.offsetParent?.className,receivesPointer:el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};
                });
                assert(control.visible&&control.width>=40&&control.height>=40&&control.top>=control.galleryTop&&control.bottom<=control.galleryBottom&&control.left>=0&&control.right<=width&&control.receivesPointer, 'Obscured or overlapping control at '+width+': '+JSON.stringify(control));
            }
        }
        for(const {width,height} of [{width:320,height:568},{width:390,height:844}]) {
            await page.setViewportSize({width,height});
            await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
            await page.waitForFunction(()=>{
                const theme=document.documentElement.dataset.theme,format=innerWidth<=768?'portrait':'landscape';
                return getComputedStyle(document.body,'::before').backgroundImage.includes(`featured-bg-${theme}-${format}.jpg`);
            });
            const fit=await page.evaluate(()=>{
                const rect=s=>document.querySelector(s).getBoundingClientRect();
                const hero=rect('.hero'),copy=rect('.hero-copy-wrap'),cta=rect('.cta-buttons'),stats=rect('.hero-stats');
                const facts=rect('.landing-facts'),launcher=rect('.floating-basketball');
                const heroSection=document.querySelector('.hero'),featuredSection=document.querySelector('#featured');
                const sectionsConnected=Math.abs(heroSection.offsetTop+heroSection.offsetHeight-featuredSection.offsetTop)<=1;
                const factsColumns=getComputedStyle(document.querySelector('.hero-stats')).gridTemplateColumns;
                const theme=document.documentElement.dataset.theme;
                const backdrop=getComputedStyle(document.body,'::before').backgroundImage;
                const overlap=stats.left<launcher.right&&stats.right>launcher.left&&stats.top<launcher.bottom&&stats.bottom>launcher.top;
                return {heroHeight:hero.height,viewportHeight:innerHeight,
                    contentFits:copy.bottom<=hero.bottom+1&&cta.bottom<=hero.bottom+1&&stats.top>=cta.bottom+8&&stats.bottom<=hero.bottom+1&&stats.bottom<=facts.bottom+1,
                    factsVisible:innerHeight<700 || stats.bottom<=innerHeight+1,
                    factsAvoidLauncher:!overlap,
                    sectionsConnected,
                    factsStackedOnMobile:innerWidth>768 || factsColumns.trim().split(/\s+/).length===1,
                    backdropReady:backdrop.includes(`featured-bg-${theme}-portrait.jpg`),
                    noOverflow:document.documentElement.scrollWidth<=innerWidth};
            });
            assert(fit.heroHeight>=640 && fit.contentFits && fit.factsVisible && fit.factsAvoidLauncher && fit.sectionsConnected && fit.factsStackedOnMobile && fit.backdropReady && fit.noOverflow,
                `Featured content must remain readable and reachable at ${width}x${height}: ${JSON.stringify(fit)}`);
        }
        await page.setViewportSize({width:1440,height:900});
        await page.evaluate(()=>{ document.activeElement.blur(); scrollTo({top:0,behavior:'instant'}); });
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
        const reducedMotionTransition = await page.locator('.site-nav').evaluate(el=>getComputedStyle(el).transitionDuration);
        assert(parseFloat(reducedMotionTransition)<=0.0001,
            `Reduced-motion header transition should be effectively instant, got ${reducedMotionTransition}`);
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
        publishedSportsCount=9;
        await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
        await page.waitForFunction(()=>document.querySelectorAll('.court-grid > .court-card').length===9);
        for (const {width,height} of [{width:1440,height:1000},{width:390,height:844}]) {
            await page.setViewportSize({width,height});
            for (const theme of ['light','dark']) {
                await page.evaluate(theme=>window.ThemeController.set(theme),theme);
                await page.waitForTimeout(100);
                await page.screenshot({path:`output/landing-qa/refresh-full-${width}-${theme}.png`,fullPage:true});
            }
        }
        console.log('PASS controls, footer dimensions and themes at seven widths');
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
        for(const count of [6,8]) {
            const overflowDots=await setup({count});
            for(const {width,height} of [{width:1440,height:1000},{width:390,height:844}]) {
                await overflowDots.setViewportSize({width,height});
                for(const theme of ['light','dark']) {
                    await overflowDots.evaluate(theme=>window.ThemeController.set(theme),theme);
                    await overflowDots.locator('#featured').scrollIntoViewIfNeeded();
                    const initialDots=await overflowDots.evaluate(()=>{
                        const strip=document.querySelector('.hero-dots');
                        const dots=[...strip.children];
                        const widths=dots.map(dot=>dot.getBoundingClientRect().width);
                        const progress=document.querySelector('.featured-progress').getBoundingClientRect();
                        const copy=document.querySelector('.featured-copy-stack').getBoundingClientRect();
                        const caption=document.querySelector('.featured-caption-wrap').getBoundingClientRect();
                        const pause=document.querySelector('[data-home-pause]').getBoundingClientRect();
                        const row=strip.getBoundingClientRect();
                        return {count:dots.length,direction:getComputedStyle(strip).flexDirection,wrap:getComputedStyle(strip).flexWrap,
                            overflow:getComputedStyle(strip).overflowX,scrollWidth:strip.scrollWidth,clientWidth:strip.clientWidth,
                            minDotWidth:Math.min(...widths),maxDotWidth:Math.max(...widths),activeCount:dots.filter(dot=>dot.getAttribute('aria-current')==='true').length,
                            groupWithinRightColumn:innerWidth<=768?progress.top>=copy.bottom-1&&progress.right<=caption.right+1:progress.left>=copy.right-1&&progress.right<=caption.right+1,
                            pauseCentered:Math.abs((pause.left+pause.right-row.left-row.right)/2)<1,pauseAboveRow:pause.bottom<=row.top};
                    });
                    assert.equal(initialDots.count,count,`Keep every one of ${count} event dots`);
                    assert.equal(initialDots.direction,'row');
                    assert.equal(initialDots.wrap,'nowrap');
                    assert.equal(initialDots.overflow,'auto');
                    assert(initialDots.scrollWidth>initialDots.clientWidth,`${count} dots expose a horizontal scroll range at ${width}px`);
                    assert.equal(initialDots.minDotWidth,36,`${count} dots retain their intended tap target width`);
                    assert.equal(initialDots.maxDotWidth,36,`${count} dots do not shrink or spill outside the strip`);
                    assert.equal(initialDots.activeCount,1,'Exactly one event dot is marked current');
                    assert(initialDots.groupWithinRightColumn&&initialDots.pauseCentered&&initialDots.pauseAboveRow,
                        `Pause/dots group stays right-aligned with pause centered above at ${width}px: ${JSON.stringify(initialDots)}`);
                    await overflowDots.locator('.hero-dot').last().focus();
                    await overflowDots.waitForTimeout(50);
                    const focusLayout=await overflowDots.evaluate(()=>{
                        const strip=document.querySelector('.hero-dots'),stripRect=strip.getBoundingClientRect();
                        const last=strip.lastElementChild.getBoundingClientRect();
                        return {scrollLeft:strip.scrollLeft,lastVisible:last.left>=stripRect.left&&last.right<=stripRect.right,
                            focused:document.activeElement===strip.lastElementChild,label:document.activeElement.getAttribute('aria-label')};
                    });
                    assert(focusLayout.scrollLeft>0&&focusLayout.lastVisible&&focusLayout.focused,
                        `Keyboard focus scrolls to the last event dot at ${width}px: ${JSON.stringify(focusLayout)}`);
                    assert.match(focusLayout.label,new RegExp(`Feature ${count}`));
                    await overflowDots.locator('.hero-dot').last().click();
                    assert.equal(await overflowDots.locator('.hero-copy.is-active .hero-title').innerText(),`Feature ${count}`);
                    assert.equal(await overflowDots.locator('.hero-dot').last().getAttribute('aria-current'),'true');
                    await overflowDots.locator('#featured').screenshot({path:`output/landing-qa/featured-dots-${count}-${width}-${theme}.png`});
                }
            }
            await overflowDots.close();
        }
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
        for (const [reviews,expected] of [['empty','No featured reviews yet'],['error','Customer reviews are temporarily unavailable.']]) {
            const reviewPage=await setup({reviews});
            if (reviews === 'empty') {
                await reviewPage.locator('.onsite-review-placeholder').waitFor({state:'visible'});
                assert.match(await reviewPage.locator('.onsite-review-placeholder').innerText(),/No featured reviews yet[\s\S]*Selected customer reviews will appear here after the owner chooses them/);
                assert(await reviewPage.locator('[data-onsite-reviews-status]').isHidden());
            } else {
                await reviewPage.waitForFunction(text=>document.querySelector('[data-onsite-reviews-status]').textContent===text,expected);
                assert.equal(await reviewPage.locator('[data-onsite-review-grid] .testimonial-card').count(),0);
            }
            await reviewPage.close();
        }
        for(const {width,height} of [{width:1440,height:1000},{width:390,height:844}]) {
            await page.setViewportSize({width,height});
            for(const theme of ['light','dark']) {
                await page.evaluate(theme=>window.ThemeController.set(theme),theme);
                await page.locator('#location').scrollIntoViewIfNeeded();
                const map=page.locator('.footer-map-frame');
                assert(await map.isVisible(),'Original Google Maps embed remains visible in '+theme+' mode');
                assert.match(await map.getAttribute('src'),/cid=16628664884079723934[\s\S]*ll=13\.9626169,121\.5803986[\s\S]*z=17[\s\S]*output=embed[\s\S]*t=k/);
                assert.equal(await map.getAttribute('title'),'Iñigos Sports Center location');
                assert.match(await page.locator('.map-directions').getAttribute('href'),/destination_place_id=ChIJYWSThmFMvTMRnoWVEJzixOY/);
                if(theme==='light') await page.waitForTimeout(5000);
                await page.screenshot({path:`output/landing-qa/footer-google-map-${width}-${theme}.png`});
            }
        }
        assert.deepEqual(browserPageErrors,[],'Landing page produces no uncaught browser errors');
        console.log('PASS original Google map embed, CID/coordinates, directions, 340/240px layouts, and light/dark screenshots');
        console.log('PASS arrows, wraparound, dots, keyboard, swipe, autoplay/pause, reduced motion, seven widths, zero/one event, featured review order, empty/error states and no Google widget dependency');
    } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
