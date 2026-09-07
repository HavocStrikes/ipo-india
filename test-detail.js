/** Quick debug harness: node test-detail.js <html-file> */
const fs = require('fs');
const { parseDetail } = require('./lib/detail');

const file = process.argv[2] || '/tmp/esds.html';
const html = fs.readFileSync(file, 'utf-8');
console.log(JSON.stringify(parseDetail(html), null, 1));
