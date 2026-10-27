import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../Style/Dashboard.css', import.meta.url), 'utf8');

test('featured carousel spans the overview row and keeps responsive equal-card layout', () => {
    const hero = css.match(/\.dash-hero\s*\{([^}]*)\}/)?.[1] || '';
    const slide = css.match(/\.dash-hero-slide\s*\{([^}]*)\}/)?.[1] || '';
    const image = css.match(/\.dash-hero-image\s*\{([^}]*)\}/)?.[1] || '';
    const caption = css.match(/\.dash-hero-scrim\s*\{([^}]*)\}/)?.[1] || '';

    assert.match(hero, /width:\s*100%/);
    assert.match(hero, /max-width:\s*100%/);
    assert.doesNotMatch(hero, /1180px/);
    assert.match(slide, /flex:\s*0\s+0\s+calc\(\(100%\s*-\s*36px\)\s*\/\s*3\)/);
    assert.match(image, /object-fit:\s*contain/);
    assert.match(caption, /flex:\s*1\s+0\s+163px/);
    assert.match(css, /@media\s*\(max-width:\s*980px\)[\s\S]*?\.dash-hero-slide\s*\{\s*flex-basis:\s*calc\(\(100%\s*-\s*18px\)\s*\/\s*2\)/);
    assert.match(css, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.dash-hero-slide\s*\{\s*flex-basis:\s*100%/);
});
