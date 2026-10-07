#!/usr/bin/env node
/**
 * Extract every comment containing Vietnamese from the project's source files into a JSON file.
 *
 *   node scripts/translate-comments/extract.mjs [out.json]      (default: comments.vi.json)
 *
 * Each item keeps the exact original comment text (delimiters included) plus its byte offsets,
 * so apply.mjs can put the translation back in exactly the same place.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, VN_RE, walk, commentsOf, lineOf } from './lib.mjs';

const outFile = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, 'comments.vi.json'));

const items = [];
const perFile = {};
for (const rel of walk()) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const c of commentsOf(rel, text)) {
    if (!VN_RE.test(c.text)) continue;
    items.push({
      id: `c${String(items.length + 1).padStart(5, '0')}`,
      file: rel,
      line: lineOf(text, c.start),
      start: c.start,
      end: c.end,
      original: c.text,
      translation: '',
    });
    perFile[rel] = (perFile[rel] ?? 0) + 1;
  }
}

fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), root: ROOT, count: items.length, items }, null, 2) + '\n');

console.log(`Extracted ${items.length} Vietnamese comments from ${Object.keys(perFile).length} files -> ${path.relative(process.cwd(), outFile)}`);
