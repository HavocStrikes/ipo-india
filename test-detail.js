/** Quick debug harness: node test-detail.js <html-file> */
const fs = require('fs');
const { parseDetail } = require('./lib/detail');

const file = process.argv[2] || '/tmp/esds.html';
if (!fs.existsSync(file)) {
  console.log(`SKIP — no fixture at ${file} (pass one: node test-detail.js <html-file>)`);
  process.exit(0);
}
const html = fs.readFileSync(file, 'utf-8');
console.log(JSON.stringify(parseDetail(html), null, 1));
