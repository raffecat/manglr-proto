#!/usr/bin/env node

const fs = require('fs');
const parser = require('../third-party/node-html-parser');
const compiler = require('../src/manglr-aot');

const in_file = process.argv[2];
const out_file = process.argv[3];
if (!in_file || !out_file) { console.error("usage: manglr <in-html> <out-js>"); process.exit(1); }
const source = fs.readFileSync(in_file, 'utf8');
console.log(source);

const doc_el = parser.parse(source, {style:true,pre:true});
console.log(doc_el.firstChild);

const blob = compiler.compile(doc_el.firstChild); // the <html> element.
fs.writeFileSync(out_file, blob, 'utf8');
