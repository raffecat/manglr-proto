#!/usr/bin/env node

const fs = require('fs');
const parser = require('node-html-parser');
const compiler = require('../src/manglr-aot');

const in_file = process.argv[2];
if (!in_file) { console.error("usage: manglr <html-file>"); process.exit(1); }
const source = fs.readFileSync(in_file, 'utf8');
console.log(source);

const doc_el = parser.parse(source, {style:true,pre:true});
console.log(doc_el.firstChild);
console.log(doc_el.firstChild.attributes);
console.log(doc_el.firstChild.attributes.length);

compiler.compile(doc_el.firstChild);
