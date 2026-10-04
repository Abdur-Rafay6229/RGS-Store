// Build: copy web assets into www/ (Capacitor webDir)
const fs = require('fs');
const path = require('path');

const root = __dirname;
const www = path.join(root, 'www');

const files = [
  'index.html',
  'manifest.json',
  'sw.js',
  'icon.png',
  'icon-192.png',
  'src/css/styles.css',
  'src/js/app.js',
  'src/js/firebase.js',
  'src/assets/icon.png',
  'src/assets/icon-192.png'
];

function copyFile(rel) {
  const src = path.join(root, rel);
  const dest = path.join(www, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('✓', rel);
}

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });
files.forEach(copyFile);
console.log('\n✅ Built to www/ — run: npx cap sync');
