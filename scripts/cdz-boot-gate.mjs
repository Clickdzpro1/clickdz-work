#!/usr/bin/env node
// cdz-boot-gate — a fast, dependency-free static gate that catches the two prod
// boot-crash classes that have bitten ClickDz ships, WITHOUT running the (red
// baseline) monorepo tsc/lint:
//   (1) a decorator called without its import  → ReferenceError at module-eval.
//       The #73 incident: `@Public()` left after the `Public` import was dropped.
//   (2) a named import the target module doesn't export → ESModulesLinkingError.
//       The WS12 incident: `import { api } from '.../agents/api'`.
// Scope: the commit's changed .ts/.tsx PLUS every backend copilot controller
// (the historical hot spot), always. Test/spec files are excluded.
// Escape hatch: `[skip boot-gate]` in the HEAD commit message bypasses (emergencies).
// Exit 0 = pass, 1 = a real hit (blocks the image publish).
//
// Correctness note: false positives here would block EVERY ship, so both checks
// are high-signal and were validated to zero false positives across all ~3,100
// source files of the current (prod-booting) tree, and to catch planted bugs.

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const FE_ALIAS = 'packages/frontend/core/src/'; // @affine/core/ → this
const sh = cmd => { try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

// ---- escape hatch ----
if (/\[skip boot-gate\]/i.test(sh('git log -1 --pretty=%B') || '')) {
  console.log('cdz-boot-gate: [skip boot-gate] in commit message — bypassing.'); process.exit(0);
}

// ---- target files: changed (needs fetch-depth>=2) + always the copilot hot spot ----
function changedFiles() {
  if (!sh('git rev-parse --verify HEAD~1')) { console.log('cdz-boot-gate: no parent commit — hot-spot scan only.'); return []; }
  const out = sh('git diff --name-only HEAD~1..HEAD'); return out ? out.split('\n').filter(Boolean) : [];
}
function hotspotFiles() {
  const dir = 'packages/backend/server/src/plugins/copilot';
  if (!existsSync(path.join(ROOT, dir))) return [];
  const out = sh(`git ls-files ${dir}/*.ts`); return out ? out.split('\n').filter(Boolean) : [];
}
const isSrc = f => /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts') && !/\.(spec|test)\.tsx?$/.test(f) && !/\.integration\./.test(f) && !/(^|\/)__tests__\//.test(f) && existsSync(path.join(ROOT, f));
const targetOverride = process.env.__GATE_FILE__ ? readFileSync(process.env.__GATE_FILE__, 'utf8').split('\n').filter(Boolean) : null;
const targets = (targetOverride ?? [...new Set([...changedFiles(), ...hotspotFiles()])]).filter(isSrc);
if (targets.length === 0) { console.log('cdz-boot-gate: no target files — pass.'); process.exit(0); }

const problems = [];
const readSafe = p => { try { return readFileSync(path.join(ROOT, p), 'utf8'); } catch { return null; } };

// ---- sanitizer: strips comments; blanks template-literal TEXT (respecting ${}
// nesting) and, when blankStrings, blanks string CONTENTS too. Backticks/quotes
// and structure (${ }) are preserved; newlines preserved. A `/*` or `@click=` or
// `@Component(` inside a string/template can therefore never be misread as code.
function sanitize(src, blankStrings) {
  let out = ''; let i = 0; const n = src.length;
  const stack = [{ t: 'code', brace: 0 }];
  const top = () => stack[stack.length - 1];
  while (i < n) {
    const c = src[i], d = src[i + 1], cur = top();
    if (cur.t === 'code') {
      if (c === '/' && d === '/') { out += '  '; i += 2; while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
      if (c === '/' && d === '*') { out += '  '; i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += (src[i] === '\n' ? '\n' : ' '); i++; } if (i < n) { out += '  '; i += 2; } continue; }
      if (c === "'" || c === '"') { const q = c; out += c; i++; while (i < n) { const e = src[i]; if (e === '\\') { out += blankStrings ? '  ' : e + (src[i + 1] ?? ''); i += 2; continue; } if (e === q) { out += e; i++; break; } if (e === '\n') { out += '\n'; i++; break; } out += blankStrings ? ' ' : e; i++; } continue; }
      if (c === '`') { out += c; i++; stack.push({ t: 'tpl' }); continue; }
      if (c === '{') { cur.brace++; out += c; i++; continue; }
      if (c === '}') { if (cur.brace === 0 && stack.length > 1) { stack.pop(); out += c; i++; continue; } if (cur.brace > 0) cur.brace--; out += c; i++; continue; }
      out += c; i++; continue;
    }
    // template text: blank it, but honor ${ } (push code) and closing backtick (pop)
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === '`') { out += c; i++; stack.pop(); continue; }
    if (c === '$' && d === '{') { out += '${'; i += 2; stack.push({ t: 'code', brace: 0 }); continue; }
    out += (c === '\n' ? '\n' : ' '); i++;
  }
  return out;
}

// declared/imported top-level identifier names (run on code-only variant)
function declaredNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s*['"][^'"]+['"]/g)) {
    const clause = m[1];
    const def = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/); if (def) names.add(def[1]);
    const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/); if (ns) names.add(ns[1]);
    const br = clause.match(/\{([\s\S]*?)\}/);
    if (br) for (const part of br[1].split(',')) { const t = part.trim().replace(/^type\s+/, ''); if (!t) continue; const as = t.split(/\s+as\s+/); names.add((as[1] || as[0]).trim()); }
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*=\s*require/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:declare\s+)?(?:class|function\s*\*?|const|let|var|enum|interface|type|namespace)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

// ---------- CHECK A: decorator-import completeness ----------
// Only real decorator-call syntax `@Name(` counts (Lit bindings are `@name=`, never `(`).
const CSS_AT = new Set(['media', 'supports', 'keyframes', 'container', 'font', 'page', 'import', 'charset', 'layer', 'namespace', 'property', 'scope', 'starting']);
for (const f of targets) {
  const raw = readSafe(f); if (raw == null) continue;
  const code = sanitize(raw, true); // strings + templates blanked
  const decl = declaredNames(code);
  const seen = new Set();
  for (const m of code.matchAll(/@([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (CSS_AT.has(name.toLowerCase()) || seen.has(name)) continue; seen.add(name);
    if (!decl.has(name)) problems.push(`[decorator-import] ${f}: @${name}( used but not imported/declared`);
  }
}

// ---------- CHECK B: intra-repo named-export resolution ----------
function resolveModule(fromFile, spec) {
  let base;
  if (spec.startsWith('@affine/core/')) base = spec.replace('@affine/core/', FE_ALIAS);
  else if (spec.startsWith('.')) base = path.normalize(path.join(path.dirname(fromFile), spec));
  else return null;
  for (const c of [base + '.ts', base + '.tsx', base + '.d.ts', path.join(base, 'index.ts'), path.join(base, 'index.tsx'), path.join(base, 'index.d.ts'), base]) {
    const abs = path.join(ROOT, c);
    if (existsSync(abs) && statSync(abs).isFile()) return c;
  }
  return null;
}
const exportCache = new Map();
function exportsOf(modPath, depth = 0) {
  if (depth > 8) return { names: new Set(), star: true };
  if (exportCache.has(modPath)) return exportCache.get(modPath);
  const raw = readSafe(modPath); if (raw == null) { const r = { names: new Set(), star: true }; exportCache.set(modPath, r); return r; }
  // Detect exports on RAW source (NOT sanitized): the string/template scanner can
  // desync on regex/backtick-heavy files and blank real `export` lines, which would
  // be a FALSE POSITIVE (blocking a good ship). A stray "export" in a comment/string
  // only ever ADDS a fake export name → a false negative (safe). Raw is the safe choice.
  const src = raw;
  const names = new Set(); let star = false;
  // Any re-export (`export {…} from '…'` or `export *`) makes this module's true
  // surface depend on OTHER modules that our hand-rolled resolver may not fully
  // chase → mark permissive (caller skips). The WS12 class was a LEAF module with
  // only direct exports (no re-exports), so it is still checked. Barrels (core/doc,
  // provider-chat-runtime, base, …) are stable upstream and simply not gated.
  if (/export\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"]/.test(src)) star = true;
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*['"][^'"]+['"])?/g))
    for (const part of m[1].split(',')) { const t = part.trim(); if (!t) continue; const as = t.replace(/^type\s+/, '').split(/\s+as\s+/); names.add((as[1] || as[0]).trim()); }
  for (const m of src.matchAll(/export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:declare\s+)?(?:class|function\s*\*?|const|let|var|enum|interface|type|namespace)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  if (/export\s+default\b/.test(src)) names.add('default');
  for (const m of src.matchAll(/export\s+(?:type\s+)?\*\s+(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s*['"]([^'"]+)['"]/g)) {
    star = true; // any `export *` (or `export type *`) → uncertain surface, caller skips
    const sub = /\*\s+as\s+/.test(m[0]) ? null : resolveModule(modPath, m[1]);
    if (sub) for (const nm of exportsOf(sub, depth + 1).names) names.add(nm);
  }
  const r = { names, star }; exportCache.set(modPath, r); return r;
}
for (const f of targets) {
  const raw = readSafe(f); if (raw == null) continue;
  const src = sanitize(raw, false);
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const spec = m[2];
    if (!(spec.startsWith('.') || spec.startsWith('@affine/core/'))) continue;
    const wanted = m[1].split(',').map(s => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()).filter(Boolean);
    if (!wanted.length) continue;
    const mod = resolveModule(f, spec); if (!mod) continue;
    const { names, star } = exportsOf(mod); if (star) continue;
    const missing = wanted.filter(n => !names.has(n));
    if (missing.length) problems.push(`[named-export] ${f}: {${missing.join(', ')}} not exported by '${spec}'`);
  }
}

// ---------- verdict ----------
if (problems.length) {
  console.error(`\ncdz-boot-gate: ${problems.length} boot-crash risk(s) found (scanned ${targets.length} files):\n`);
  for (const p of problems) console.error('  - ' + p);
  console.error('\nThese crash prod at module-eval (ReferenceError) or fail the webpack link.');
  console.error('Fix the import(s), or add [skip boot-gate] to the commit message for an emergency bypass.\n');
  process.exit(1);
}
console.log(`cdz-boot-gate: OK — ${targets.length} files scanned, no boot-crash risks.`);
process.exit(0);
