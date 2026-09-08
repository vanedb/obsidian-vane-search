import { statSync } from 'node:fs';
const LIMIT = 3 * 1024 * 1024;
const size = statSync('main.js').size;
console.log(`main.js: ${(size / 1024).toFixed(0)} KB (limit ${LIMIT / 1024} KB)`);
if (size >= LIMIT) { console.error('main.js exceeds the 3 MB budget'); process.exit(1); }
