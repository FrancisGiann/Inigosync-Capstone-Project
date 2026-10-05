// Build the public static site without publishing repository-only files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const rootFiles = ['index.html', 'manifest.json', 'robots.txt', 'sitemap.xml'];
const publicDirectories = ['Pages', 'Style', 'assets', 'Config', 'includes', 'event'];
const publicExtensions = new Set([
  '.css', '.glb', '.html', '.ico', '.jpeg', '.jpg', '.js', '.json',
  '.png', '.svg', '.webp', '.woff', '.woff2',
]);

function copyPublicDirectory(source, destination) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyPublicDirectory(sourcePath, destinationPath);
    } else if (entry.isFile() && publicExtensions.has(path.extname(entry.name).toLowerCase())) {
      fs.mkdirSync(destination, { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(filePath) : [filePath];
  });
}

function resolveLocalAsset(directory, htmlPath, url) {
  // Absolute and protocol-relative URLs (such as CDN scripts) are not local files.
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url)) return null;

  const suffixIndex = url.search(/[?#]/);
  const urlPath = suffixIndex === -1 ? url : url.slice(0, suffixIndex);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const targetPath = path.resolve(
    directory,
    decodedPath.startsWith('/')
      ? `.${decodedPath}`
      : path.relative(directory, path.dirname(htmlPath)),
    ...(decodedPath.startsWith('/') ? [] : [decodedPath]),
  );
  return { targetPath };
}

function withContentVersion(url, hash) {
  const hashIndex = url.indexOf('#');
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : url.slice(hashIndex);
  const queryIndex = beforeHash.indexOf('?');
  const urlPath = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : beforeHash.slice(queryIndex + 1);
  if (!query) return `${urlPath}?v=${hash}${fragment}`;

  const segments = query.split(/(&amp;|&)/);
  let foundVersion = false;
  for (let index = 0; index < segments.length; index += 2) {
    const segment = segments[index];
    const equalsIndex = segment.indexOf('=');
    const rawName = equalsIndex === -1 ? segment : segment.slice(0, equalsIndex);
    let name;
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, ' '));
    } catch {
      continue;
    }
    if (name !== 'v') continue;

    if (!foundVersion) {
      const rawValue = `v=${hash}`;
      segments[index] = equalsIndex === -1 ? rawValue : `${segment.slice(0, equalsIndex + 1)}${hash}`;
      foundVersion = true;
    } else {
      segments[index] = '';
      segments[index - 1] = '';
    }
  }

  const preservedQuery = segments.join('');
  if (foundVersion) return `${urlPath}?${preservedQuery}${fragment}`;
  const separators = [...query.matchAll(/&amp;|&/g)];
  const separator = separators.length ? separators.at(-1)[0] : '&';
  const suffix = /(?:&amp;|&)$/.test(query) ? '' : separator;
  return `${urlPath}?${query}${suffix}v=${hash}${fragment}`;
}

function cacheBustPublicEntrypoints(directory) {
  const stylesheets = walkFiles(directory)
    .filter((filePath) => path.extname(filePath).toLowerCase() === '.css');
  const hashedPaths = new Map();

  for (const stylesheet of stylesheets) {
    const contents = fs.readFileSync(stylesheet);
    const hash = crypto.createHash('sha256').update(contents).digest('hex').slice(0, 12);
    const hashedPath = path.join(
      path.dirname(stylesheet),
      `${path.basename(stylesheet, path.extname(stylesheet))}.${hash}${path.extname(stylesheet)}`,
    );
    fs.renameSync(stylesheet, hashedPath);
    hashedPaths.set(path.resolve(stylesheet), path.resolve(hashedPath));
  }

  for (const htmlPath of walkFiles(directory).filter((filePath) => path.extname(filePath).toLowerCase() === '.html')) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(/<link\b[^>]*>/gi, (tag) => {
      const relMatch = tag.match(/\brel\s*=\s*(["'])(.*?)\1/i);
      if (!relMatch || !relMatch[2].toLowerCase().split(/\s+/).includes('stylesheet')) return tag;

      return tag.replace(/\bhref\s*=\s*(["'])(.*?)\1/i, (attribute, quote, href) => {
        // Absolute and protocol-relative URLs (such as Google Fonts) are not local files.
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return attribute;

        const suffixIndex = href.search(/[?#]/);
        const hrefPath = suffixIndex === -1 ? href : href.slice(0, suffixIndex);
        const suffix = suffixIndex === -1 ? '' : href.slice(suffixIndex);
        let decodedPath;
        try {
          decodedPath = decodeURIComponent(hrefPath);
        } catch {
          return attribute;
        }
        const targetPath = path.resolve(
          directory,
          decodedPath.startsWith('/')
            ? `.${decodedPath}`
            : path.relative(directory, path.dirname(htmlPath)),
          ...(decodedPath.startsWith('/') ? [] : [decodedPath]),
        );
        const hashedPath = hashedPaths.get(targetPath);
        if (!hashedPath) return attribute;

        const relativeHashedPath = path.relative(path.dirname(htmlPath), hashedPath).split(path.sep).join('/');
        const relativePrefix = hrefPath.startsWith('./') ? './' : '';
        const rewrittenPath = hrefPath.startsWith('/')
          ? `/${path.relative(directory, hashedPath).split(path.sep).join('/')}`
          : `${relativePrefix}${relativeHashedPath}`;
        return `href=${quote}${rewrittenPath}${suffix}${quote}`;
      });
    });
    html = html.replace(/<script\b[^>]*>/gi, (tag) => {
      return tag.replace(/\bsrc\s*=\s*(["'])(.*?)\1/i, (attribute, quote, src) => {
        const localAsset = resolveLocalAsset(directory, htmlPath, src);
        if (!localAsset || path.extname(localAsset.targetPath).toLowerCase() !== '.js') return attribute;
        if (!fs.existsSync(localAsset.targetPath)) return attribute;
        const hash = crypto.createHash('sha256').update(fs.readFileSync(localAsset.targetPath)).digest('hex').slice(0, 12);
        return `src=${quote}${withContentVersion(src, hash)}${quote}`;
      });
    });
    fs.writeFileSync(htmlPath, html);
  }
}

if (require.main === module) {
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  for (const file of rootFiles) {
    fs.copyFileSync(path.join(root, file), path.join(output, file));
  }
  for (const directory of publicDirectories) {
    copyPublicDirectory(path.join(root, directory), path.join(output, directory));
  }
  copyPublicDirectory(path.join(root, 'database', 'web'), path.join(output, 'database', 'web'));
  cacheBustPublicEntrypoints(output);

  console.log(`Static site built in ${output}`);
}

module.exports = { cacheBustPublicEntrypoints, withContentVersion };
