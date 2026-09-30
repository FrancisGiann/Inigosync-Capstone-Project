// Build the public static site without publishing repository-only files.
const fs = require('node:fs');
const path = require('node:path');

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

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const file of rootFiles) {
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}
for (const directory of publicDirectories) {
  copyPublicDirectory(path.join(root, directory), path.join(output, directory));
}
copyPublicDirectory(path.join(root, 'database', 'web'), path.join(output, 'database', 'web'));

console.log(`Static site built in ${output}`);
