const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cacheBustPublicEntrypoints, withContentVersion } = require('../scripts/build.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');

assert.equal(
  withContentVersion('./includes/auth.js?mode=login&amp;v=old#dialog', 'abc123'),
  './includes/auth.js?mode=login&amp;v=abc123#dialog',
  'Versioning must preserve HTML-escaped query separators and fragments while replacing an old version',
);
assert.equal(
  withContentVersion('./auth.js?q=a%20b&amp;encoded=%7E&tilde=~#dialog', 'abc123'),
  './auth.js?q=a%20b&amp;encoded=%7E&tilde=~&v=abc123#dialog',
  'Appending a version must leave existing query bytes unchanged',
);
assert.equal(
  withContentVersion('./auth.js?a=1&amp;v=old&b=2&amp;v=older#dialog', 'abc123'),
  './auth.js?a=1&amp;v=abc123&b=2#dialog',
  'Duplicate version parameters must collapse to one while preserving other serialized query segments',
);
assert.equal(withContentVersion('./auth.js#dialog', 'abc123'), './auth.js?v=abc123#dialog');

// Always inspect a freshly generated dist tree, never a stale build left by a developer.
execFileSync(process.execPath, [path.join(root, 'scripts', 'build.cjs')], { stdio: 'inherit' });

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(filePath) : [filePath];
  });
}

let checkedLocalScripts = 0;
const seenEntrypoints = new Set();
const htmlFiles = walkFiles(output).filter((filePath) => path.extname(filePath).toLowerCase() === '.html');

for (const htmlFile of htmlFiles) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  for (const [, , src] of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi)) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(src)) continue;

    const suffixIndex = src.search(/[?#]/);
    const srcPath = suffixIndex === -1 ? src : src.slice(0, suffixIndex);
    const decodedPath = decodeURIComponent(srcPath);
    const target = path.resolve(
      decodedPath.startsWith('/') ? output : path.dirname(htmlFile),
      decodedPath.startsWith('/') ? `.${decodedPath}` : decodedPath,
    );
    assert.ok(fs.existsSync(target), `Local script URL must resolve: ${src} in ${path.relative(output, htmlFile)}`);
    if (path.extname(target).toLowerCase() !== '.js') continue;

    const suffix = suffixIndex === -1 ? '' : src.slice(suffixIndex);
    const query = suffix.split('#', 1)[0].replace(/^\?/, '');
    const params = new URLSearchParams(query);
    const expectedHash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex').slice(0, 12);
    assert.equal(params.get('v'), expectedHash, `Script hash must match its built content: ${src}`);
    assert.equal(params.getAll('v').length, 1, `Script URL must have one content version: ${src}`);
    checkedLocalScripts += 1;
    seenEntrypoints.add(path.relative(output, target).split(path.sep).join('/'));
  }
}

assert.ok(checkedLocalScripts > 0, 'Expected to verify local JavaScript URLs in built HTML');
for (const entrypoint of ['includes/auth.js', 'Config/supabaseClient.js']) {
  assert.ok(seenEntrypoints.has(entrypoint), `Expected built HTML to reference ${entrypoint}`);
}

console.log(`Verified content hashes and URL resolution for ${checkedLocalScripts} local script references across ${htmlFiles.length} HTML files.`);

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inigosync-cache-bust-'));
try {
  const fixtureHtml = path.join(fixtureRoot, 'Pages', 'example.html');
  const rootScript = path.join(fixtureRoot, 'Config', 'root.js');
  const moduleScript = path.join(fixtureRoot, 'includes', 'module.js');
  fs.mkdirSync(path.dirname(fixtureHtml), { recursive: true });
  fs.mkdirSync(path.dirname(rootScript), { recursive: true });
  fs.mkdirSync(path.dirname(moduleScript), { recursive: true });
  fs.writeFileSync(rootScript, 'window.rootFixture = true;');
  fs.writeFileSync(moduleScript, 'export const fixture = true;');
  const externalTag = '<script src="https://cdn.example.test/library.js?x=1&amp;y=2"></script>';
  fs.writeFileSync(fixtureHtml, [
    '<script src="/Config/root.js?q=a%20b&amp;tilde=~#root"></script>',
    '<script type="module" src="../includes/module.js?mode=module&amp;v=stale#module"></script>',
    externalTag,
  ].join('\n'));

  cacheBustPublicEntrypoints(fixtureRoot);
  const rewrittenFixture = fs.readFileSync(fixtureHtml, 'utf8');
  const hashFor = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 12);
  assert.ok(rewrittenFixture.includes(`/Config/root.js?q=a%20b&amp;tilde=~&amp;v=${hashFor(rootScript)}#root`), 'Root-relative script URL and serialized suffix must be preserved');
  assert.ok(rewrittenFixture.includes(`type="module" src="../includes/module.js?mode=module&amp;v=${hashFor(moduleScript)}#module"`), 'Module script must be versioned and keep its existing version position and fragment');
  assert.ok(rewrittenFixture.includes(externalTag), 'External script URLs must remain unchanged');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('Verified query serialization, root-relative URLs, module scripts, and unchanged external URLs.');
