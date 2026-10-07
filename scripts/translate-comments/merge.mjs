#!/usr/bin/env node
/**
 * Merge translated batches ({ id: translation } JSON files) into the extracted comments file.
 *
 *   node scripts/translate-comments/merge.mjs <batch-dir> [comments.vi.json] [out.json]
 *
 * Every *.en.json file in <batch-dir> is read. Output defaults to comments.en.json next to this script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { validateTranslation } from './lib.mjs';

const [batchDir, inArg, outArg] = process.argv.slice(2);
if (!batchDir) {
  console.error('usage: merge.mjs <batch-dir> [comments.vi.json] [out.json]');
  process.exit(2);
}
const inFile = path.resolve(inArg ?? path.join(import.meta.dirname, 'comments.vi.json'));
const outFile = path.resolve(outArg ?? path.join(import.meta.dirname, 'comments.en.json'));

const translations = {};
for (const f of fs.readdirSync(batchDir).filter((f) => f.endsWith('.en.json')).sort()) {
  Object.assign(translations, JSON.parse(fs.readFileSync(path.join(batchDir, f), 'utf8')));
}

const data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const missing = [];
const invalid = [];
for (const it of data.items) {
  const t = translations[it.id];
  if (t === undefined) missing.push(it.id);
  else {
    const err = validateTranslation(it.original, t);
    if (err) invalid.push(`${it.id} ${it.file}:${it.line}: ${err}`);
    it.translation = t;
  }
}
fs.writeFileSync(outFile, JSON.stringify(data, null, 2) + '\n');

console.log(`Merged ${data.items.length - missing.length}/${data.items.length} translations -> ${path.relative(process.cwd(), outFile)}`);
if (missing.length) console.log(`Missing: ${missing.join(', ')}`);
if (invalid.length) console.log(`Invalid (apply.mjs will skip these):\n  ${invalid.join('\n  ')}`);
