#!/usr/bin/env node
/**
 * Write translated comments from the JSON back into the source files.
 *
 *   node scripts/translate-comments/apply.mjs [comments.json] [--dry-run]
 *
 * Safety checks, per item and per file:
 *   - the source at [start, end) must still equal `original` (else falls back to a unique text match)
 *   - the translation keeps the comment delimiters (// stays one line, /* ... *\/ stays closed, # stays one line)
 *   - JS/TS: the token stream with comments removed is identical before and after, and no new syntax errors
 * A file failing a file-level check is left untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, VN_RE, fileKind, walk, commentsOf, jsCodeSignature, jsSyntaxErrors, validateTranslation } from './lib.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const inFile = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(import.meta.dirname, 'comments.vi.json'));

const { items } = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const byFile = Map.groupBy(items, (it) => it.file);

const problems = [];
let applied = 0;
let filesWritten = 0;

for (const [rel, fileItems] of byFile) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    problems.push(`${rel}: file no longer exists`);
    continue;
  }
  const before = fs.readFileSync(abs, 'utf8');
  const edits = [];

  for (const it of fileItems) {
    if (!it.translation || it.translation === it.original) continue;
    const err = validateTranslation(it.original, it.translation);
    if (err) {
      problems.push(`${it.id} ${rel}:${it.line}: ${err}`);
      continue;
    }
    let start = it.start;
    if (before.slice(start, it.end) !== it.original) {
      const first = before.indexOf(it.original);
      if (first === -1 || before.indexOf(it.original, first + 1) !== -1) {
        problems.push(`${it.id} ${rel}:${it.line}: source changed since extract, cannot locate comment`);
        continue;
      }
      start = first;
    }
    edits.push({ start, end: start + it.original.length, text: it.translation });
  }
  if (edits.length === 0) continue;

  edits.sort((a, b) => b.start - a.start);
  let after = before;
  for (const e of edits) after = after.slice(0, e.start) + e.text + after.slice(e.end);

  if (fileKind(rel) === 'js') {
    if (jsCodeSignature(rel, before) !== jsCodeSignature(rel, after)) {
      problems.push(`${rel}: code (non-comment) tokens would change, file skipped`);
      continue;
    }
    if (jsSyntaxErrors(rel, after) > jsSyntaxErrors(rel, before)) {
      problems.push(`${rel}: translation introduces a syntax error, file skipped`);
      continue;
    }
  }

  if (!dryRun) fs.writeFileSync(abs, after);
  applied += edits.length;
  filesWritten++;
}

console.log(`${dryRun ? '[dry-run] would apply' : 'Applied'} ${applied} comments in ${filesWritten} files.`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  problems.forEach((p) => console.log('  - ' + p));
}

if (!dryRun) {
  const left = [];
  for (const rel of walk()) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const c of commentsOf(rel, text)) if (VN_RE.test(c.text)) left.push(`${rel}: ${c.text.split('\n')[0].slice(0, 80)}`);
  }
  console.log(`\nVietnamese comments remaining: ${left.length}`);
  left.slice(0, 30).forEach((l) => console.log('  ' + l));
}
process.exitCode = problems.length ? 1 : 0;
