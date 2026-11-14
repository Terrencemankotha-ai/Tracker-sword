// Copies the web app into www/ for the phone builds and points it at the live data.
// DATA_URL comes from the environment (the build workflow sets it to your GitHub Pages site).
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const files = ['index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons', 'data'];
rmSync('www', { recursive: true, force: true });
mkdirSync('www');
for (const f of files) cpSync(f, `www/${f}`, { recursive: true });

const url = process.env.DATA_URL || '';
if (!/^https:\/\//.test(url)) {
  console.warn('DATA_URL not set: the app will only show the figures bundled at build time.');
}
writeFileSync('www/config.js', `window.ATS_DATA_URL = ${JSON.stringify(url)};\n`);
console.log('www/ ready, data from', url || '(bundled copy)');
