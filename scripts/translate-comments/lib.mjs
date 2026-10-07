import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const ROOT = path.resolve(import.meta.dirname, '../..');

// Any Vietnamese-specific letter (precomposed). Plain ASCII words like "va", "cho" are not caught,
// but every real Vietnamese sentence contains at least one of these.
export const VN_RE = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'logs', 'tmp', 'coverage', 'translate-comments']);
const JS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

export function fileKind(rel) {
  const base = path.basename(rel);
  const ext = path.extname(rel);
  if (JS_EXT.has(ext) && !rel.endsWith('.d.ts')) return 'js';
  if (['.sh', '.bash', '.yml', '.yaml', '.toml'].includes(ext)) return 'hash';
  if (base.startsWith('Dockerfile') || base.startsWith('.env') || base.endsWith('.env.example')) return 'hash';
  return null;
}

export function walk(dir = ROOT, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) walk(abs, out);
    else if (ent.isFile() && fileKind(path.relative(ROOT, abs))) out.push(path.relative(ROOT, abs));
  }
  return out.sort();
}

function scriptKind(rel) {
  const ext = path.extname(rel);
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (JS_EXT.has(ext) && ext.includes('j')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(rel, text) {
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind(rel));
}

// Every token (including punctuation) of the file, in order. Comments are not tokens.
function allTokens(sf) {
  const tokens = [];
  const visit = (node) => {
    // getChildren() includes parsed JSDoc nodes; those are comments, not code.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sf);
    if (children.length === 0) tokens.push(node);
    else children.forEach(visit);
  };
  visit(sf);
  return tokens;
}

/** Comments of a JS/TS file: [{ start, end, text }] sorted by start. */
export function jsComments(rel, text) {
  const sf = parse(rel, text);
  const seen = new Map();
  const add = (ranges) => ranges?.forEach((r) => seen.set(r.pos, { start: r.pos, end: r.end, text: text.slice(r.pos, r.end) }));
  for (const tok of allTokens(sf)) {
    add(ts.getLeadingCommentRanges(text, tok.pos));
    add(ts.getTrailingCommentRanges(text, tok.end));
  }
  return [...seen.values()].sort((a, b) => a.start - b.start);
}

/** Signature of the code with comments removed: used to prove only comments changed. */
export function jsCodeSignature(rel, text) {
  const sf = parse(rel, text);
  return allTokens(sf).map((t) => `${t.kind}:${t.getText(sf)}`).join('\n');
}

export function jsSyntaxErrors(rel, text) {
  return parse(rel, text).parseDiagnostics?.length ?? 0;
}

/**
 * '#' comments for shell / Dockerfile / env / yaml / toml.
 * Full-line comments, plus trailing " # ..." outside quotes. Shebangs are skipped.
 */
export function hashComments(rel, text) {
  const out = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '\\' && quote === '"') i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
        if (!(i === 0 && line.startsWith('#!') && offset === 0)) {
          const comment = line.slice(i).replace(/\r$/, '');
          out.push({ start: offset + i, end: offset + i + comment.length, text: comment });
        }
        break;
      }
    }
    offset += line.length + 1;
  }
  return out;
}

export function commentsOf(rel, text) {
  return fileKind(rel) === 'js' ? jsComments(rel, text) : hashComments(rel, text);
}

export function lineOf(text, pos) {
  let n = 1;
  for (let i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Returns an error message if `translation` cannot safely replace `original`, else null. */
export function validateTranslation(original, translation) {
  if (typeof translation !== 'string' || translation.trim() === '') return 'empty translation';
  if (original.startsWith('//')) {
    if (!translation.startsWith('//')) return 'line comment must start with //';
    if (/[\r\n]/.test(translation)) return 'line comment must stay on one line';
  } else if (original.startsWith('/*')) {
    if (!translation.startsWith(original.startsWith('/**') ? '/**' : '/*')) return 'block comment opener changed';
    if (!translation.endsWith('*/')) return 'block comment must end with */';
    if (translation.slice(2, -2).includes('*/')) return 'block comment contains */ inside';
  } else if (original.startsWith('#')) {
    if (!translation.startsWith('#')) return 'hash comment must start with #';
    if (/[\r\n]/.test(translation)) return 'hash comment must stay on one line';
  }
  return null;
}
