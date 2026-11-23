#!/usr/bin/env node
/**
 * test-hygiene.mjs — Dois diagnósticos complementares a validate-testes.mjs:
 *
 *   A) Falsos positivos em arquivos de teste (padrões que sempre passam):
 *      mock-sem-verificacao    vi.fn()/jest.fn() sem asserção de chamadas no arquivo
 *      catch-silenciado        } catch (...) {} vazio — exceção silenciada
 *      expect-anything-dart    expect(anything, anything) em Dart — nunca falha
 *      promise-stub-unchecked  .mockResolvedValue(literal) sem deepEqual/toEqual
 *
 *   B) Erros de dependência por stack (todos os arquivos fonte):
 *      import-relativo-inexistente  import relativo para arquivo que não existe
 *      pacote-nao-declarado         import de pacote não declarado no manifesto
 *                                   (Dart: pubspec.yaml · TS/JS: package.json · Python: pyproject.toml)
 *
 * Uso:
 *   node quality/delivery/test-hygiene.mjs                  # padrão: fontes e testes do repo
 *   node quality/delivery/test-hygiene.mjs <dir|arquivo>    # alvo específico
 *   node quality/delivery/test-hygiene.mjs --tests-only     # só falsos positivos
 *   node quality/delivery/test-hygiene.mjs --deps-only      # só dependências
 *
 * Limitações conhecidas:
 *   - Não faz stripping de literais de string: padrões dentro de strings
 *     (e.g. fixtures em testes-de-teste) podem gerar falsos positivos.
 *   - Dependências peer (e.g. `firebase` via @firebase/rules-unit-testing)
 *     aparecem como não declaradas porque a verificação é sobre o package.json direto.
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { PROFILE } from '../lib/profile.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Python standard library modules (usado em getPyDeps / scanPyDeps)
export const PY_STDLIB = new Set([
  '__future__', 'abc', 'ast', 'asyncio', 'builtins', 'collections', 'contextlib',
  'copy', 'dataclasses', 'datetime', 'enum', 'functools', 'hashlib', 'io',
  'itertools', 'json', 'logging', 'math', 'operator', 'os', 'pathlib', 'random',
  're', 'shutil', 'string', 'sys', 'tempfile', 'time', 'traceback', 'types',
  'typing', 'typing_extensions', 'unittest', 'urllib', 'uuid', 'warnings',
  'weakref', 'inspect', 'importlib', 'subprocess', 'socket', 'threading',
  'queue', 'struct', 'base64', 'decimal', 'fractions', 'numbers', 'statistics',
  'textwrap', 'pprint', 'pickle', 'shelve',
  'argparse', 'platform', 'fnmatch', 'errno', 'configparser', 'getopt',
  'glob', 'gzip', 'hmac', 'html', 'signal', 'contextlib', 'bisect',
  'heapq', 'array', 'copy', 'csv', 'difflib', 'dis', 'fileinput',
  'linecache', 'mimetypes', 'netrc', 'ntpath', 'nturl2path', 'posixpath',
  'pdb', 'profile', 'pstats', 'runpy', 'sched', 'select', 'selectors',
  'smtplib', 'sndhdr', 'socketserver', 'sunau', 'telnetlib', 'termios',
  'test', 'token', 'tokenize', 'trace', 'tracemalloc', 'uu', 'wave',
  'xdrlib', 'xml', 'xmlrpc', 'zipfile', 'zipimport',
]);

// ── coleta de arquivos ────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', '.dart_tool', '.pub-cache', 'ios', 'android', 'web', 'assets', 'out', '.venv', 'venv', '__pycache__', '.uv', 'site-packages']);
const SOURCE_EXT = /\.(dart|ts|tsx|mjs|js|cjs|py)$/;
const SKIP_PATTERNS = [
  /node_modules/, /\.dart_tool/, /[/\\]build[/\\]/, /[/\\]dist[/\\]/,
  /\.pub-cache/, /lib[/\\]l10n[/\\]/, /\.g\.dart$/, /\.freezed\.dart$/,
  /\.mocks\.dart$/, /\.gr\.dart$/, /firebase_options\.dart$/,
  /functions[/\\]lib[/\\]/, /\.d\.ts$/, /quality[/\\]\.state[/\\]/,
  /quality[/\\]reports[/\\]/, /[/\\]out[/\\]/, /\.min\.js$/,
];

export function collectFiles(targets, root = ROOT) {
  const found = [];
  for (const t of targets) {
    const abs = path.isAbsolute(t) ? t : path.resolve(root, t);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) walkDir(abs, found, root);
    else pushIfSource(abs, found, root);
  }
  return found;
}

function walkDir(dir, out, root) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkDir(full, out, root);
    } else {
      pushIfSource(full, out, root);
    }
  }
}

function pushIfSource(abs, out, root) {
  if (!SOURCE_EXT.test(abs)) return;
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (!SKIP_PATTERNS.some((p) => p.test(rel))) out.push({ abs, rel });
}

const isTestFile = (rel) =>
  /(_test\.dart|\.test\.(mjs|ts|tsx|js|cjs)|\.spec\.(ts|tsx|js))$/.test(rel);

function linesUntil(src, idx) {
  return src.slice(0, idx).split('\n').length;
}

// ── A) Falsos positivos ───────────────────────────────────────────────────────

export function scanFalsePositives({ abs, rel }) {
  if (!isTestFile(rel)) return [];
  const src = fs.readFileSync(abs, 'utf8');
  const ext = path.extname(rel).slice(1);
  const out = [];
  if (ext === 'dart') {
    out.push(...checkExpectAnythingDart(src, rel), ...checkCatchSilenciado(src, rel));
  } else if (['ts', 'tsx', 'mjs', 'js', 'cjs'].includes(ext)) {
    out.push(
      ...checkMockSemVerificacao(src, rel),
      ...checkCatchSilenciado(src, rel),
      ...checkPromiseStubUnchecked(src, rel),
    );
  }
  return out;
}

function checkMockSemVerificacao(src, rel) {
  const hasMock = /\b(?:vi|jest)\.(?:fn|spyOn)\s*\(|sinon\.(?:stub|spy)\s*\(/.test(src);
  if (!hasMock) return [];
  const hasVerify = /toHaveBeenCalled|toHaveBeenCalledWith|toHaveBeenCalledTimes|\.mock\.calls|\.mock\.results|\.called\b|\.callCount\b|\.calledWith\b/.test(src);
  if (hasVerify) return [];
  return [{ file: rel, line: 0, id: 'mock-sem-verificacao', msg: 'vi.fn()/jest.fn()/sinon.stub() criado mas nenhuma asserção de chamadas encontrada — o mock nunca é verificado' }];
}

function checkCatchSilenciado(src, rel) {
  const re = /\}\s*catch\s*\([^)]*\)\s*\{\s*(?:\/\/[^\n]*)?\s*\}/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ file: rel, line: linesUntil(src, m.index), id: 'catch-silenciado', msg: 'bloco catch vazio em teste — exceção silenciada, falhas reais ficam ocultas' });
  }
  return out;
}

function checkExpectAnythingDart(src, rel) {
  const re = /expect\s*\(\s*anything\s*,\s*anything\s*\)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ file: rel, line: linesUntil(src, m.index), id: 'expect-anything-dart', msg: 'expect(anything, anything) — corresponde a qualquer valor, o teste nunca falha' });
  }
  return out;
}

function checkPromiseStubUnchecked(src, rel) {
  const hasStub = /\.mockResolvedValue\s*\(\s*(?:true|false|null|undefined|['"][^'"]*['"]|\d+)\s*\)/.test(src);
  if (!hasStub) return [];
  const hasDeep = /(?:deepEqual|toEqual|toStrictEqual|toMatchObject|toMatchSnapshot)\s*\(/.test(src);
  if (hasDeep) return [];
  return [{ file: rel, line: 0, id: 'promise-stub-unchecked', msg: 'mockResolvedValue com literal sem deepEqual/toEqual — o retorno do stub nunca é verificado em profundidade' }];
}

// ── B) Erros de dependência ───────────────────────────────────────────────────

const _cache = new Map();

export function getPubspecDeps(root = ROOT) {
  const key = `pubspec:${root}`;
  if (_cache.has(key)) return _cache.get(key);
  const deps = new Set(['flutter', 'dart', 'flutter_test', 'flutter_lints']);
  const file = path.join(root, 'pubspec.yaml');
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    // Permite self-import (e.g. package:fluxo/...)
    const selfName = /^name:\s*([a-zA-Z_][a-zA-Z0-9_]*)/m.exec(text);
    if (selfName) deps.add(selfName[1]);
    parsePubspecDeps(text, deps);
  }
  _cache.set(key, deps);
  return deps;
}

function parsePubspecDeps(text, deps) {
  const SECTION_HEADERS = /^(?:dependencies|dev_dependencies|dependency_overrides):/;
  let inSection = false;
  for (const line of text.split('\n')) {
    if (SECTION_HEADERS.test(line)) { inSection = true; continue; }
    // Nova chave top-level (sem indentação, não vazia) encerra a seção
    if (inSection && /^\S/.test(line) && line.trim()) { inSection = false; continue; }
    if (!inSection) continue;
    // Entrada de primeiro nível: exatamente 2 espaços + nome de pacote
    const m = /^  ([a-zA-Z_][a-zA-Z0-9_]*)/.exec(line);
    if (m) deps.add(m[1]);
  }
}

export function getPackageJsonDeps(pkgDir) {
  const key = `pkg:${pkgDir}`;
  if (_cache.has(key)) return _cache.get(key);
  const file = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(file)) { _cache.set(key, null); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const deps = new Set([
      ...Object.keys(j.dependencies ?? {}),
      ...Object.keys(j.devDependencies ?? {}),
      ...Object.keys(j.peerDependencies ?? {}),
    ]);
    _cache.set(key, deps);
    return deps;
  } catch { _cache.set(key, null); return null; }
}

export function getPyDeps(root = ROOT) {
  const key = `py:${root}`;
  if (_cache.has(key)) return _cache.get(key);
  const deps = new Set(PY_STDLIB);
  const file = path.join(root, 'OCR_webscraper_crawler/python/pyproject.toml');
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    // Permite self-import: normaliza hifens para underscore (PEP 625)
    const selfName = /^name\s*=\s*"([^"]+)"/m.exec(text);
    if (selfName) deps.add(selfName[1].replace(/-/g, '_'));
    parsePyprojectDeps(text, deps);
  }
  _cache.set(key, deps);
  return deps;
}

function parsePyprojectDeps(text, deps) {
  const projM = /\[project\][^\[]*?dependencies\s*=\s*\[([^\]]*)\]/s.exec(text);
  if (projM) addPyNames(projM[1], deps);
  const devM = /\[dependency-groups\][^\[]*?dev\s*=\s*\[([^\]]*)\]/s.exec(text);
  if (devM) addPyNames(devM[1], deps);
}

function addPyNames(block, deps) {
  // Cada dependência em pyproject.toml ocupa uma linha: "packagename>=1.0"
  for (const line of block.split('\n')) {
    const m = /^\s*"([a-zA-Z_][a-zA-Z0-9_-]*)/.exec(line);
    if (m) deps.add(m[1].replace(/-/g, '_'));
  }
}

// --- resolução de imports relativos ---

const TS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'];
const TS_INDEX = ['index.ts', 'index.tsx', 'index.js', 'index.mjs'];
const MJS_EXTS = ['.mjs', '.js', '.ts', '.cjs'];
const MJS_INDEX = ['index.mjs', 'index.js', 'index.ts'];

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function tryExts(base, exts, idxs) {
  for (const e of exts) { if (isFile(base + e)) return true; }
  for (const i of idxs) { if (isFile(path.join(base, i))) return true; }
  return false;
}

export function resolveRelative(absFile, imp, ext) {
  const abs = path.resolve(path.dirname(absFile), imp);
  if (isFile(abs)) return true;
  if (ext === 'dart') return false;
  // TypeScript ESM: import './foo.js' pode resolver para './foo.ts'
  if (imp.endsWith('.js')) {
    const tsBase = abs.slice(0, -3);
    if (isFile(tsBase + '.ts') || isFile(tsBase + '.tsx')) return true;
  }
  return ext === 'mjs' || ext === 'cjs' || ext === 'js'
    ? tryExts(abs, MJS_EXTS, MJS_INDEX)
    : tryExts(abs, TS_EXTS, TS_INDEX);
}

// --- mapeamento arquivo → raiz do stack ---

// Raízes do projeto hospedeiro vêm do perfil (R1); ordem importa: mais específico primeiro.
const THP = PROFILE.testHygiene || {};
const STATIC_STACK_ROOTS = THP.stackRoots || [];

// Descobre dinamicamente todos os sub-pacotes de um diretório workspace do perfil
function discoverSubpackages(base, root) {
  const dir = path.join(root, base);
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const sub of ['packages', 'apps']) {
    const subDir = path.join(dir, sub);
    if (!fs.existsSync(subDir)) continue;
    for (const pkg of fs.readdirSync(subDir)) {
      const pkgDir = path.join(subDir, pkg);
      if (fs.existsSync(path.join(pkgDir, 'package.json')))
        found.push(`${base}/${sub}/${pkg}`);
    }
  }
  return found;
}

// Cache de stacks por root (inclui sub-pacotes dinâmicos)
const _stackRootsCache = new Map();

function getStackRoots(root) {
  if (_stackRootsCache.has(root)) return _stackRootsCache.get(root);
  const workspaces = THP.workspaceDirs || [];
  const dynamic = [];
  for (const base of workspaces) dynamic.push(...discoverSubpackages(base, root));
  // Workspace raiz de cada workspace do perfil como fallback (menos específico)
  const roots = [...STATIC_STACK_ROOTS, ...dynamic, ...workspaces];
  _stackRootsCache.set(root, roots);
  return roots;
}

function findStackRoot(rel, root) {
  for (const s of getStackRoots(root)) {
    if (rel.startsWith(s + '/')) return path.join(root, s);
  }
  // Fallback: scripts raiz usam o package.json do repo
  if (rel.startsWith('scripts/')) return root;
  return null;
}

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dns', 'events',
  'fs', 'http', 'http2', 'https', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
  'string_decoder', 'timers', 'tls', 'url', 'util', 'v8', 'vm',
  'worker_threads', 'zlib', 'inspector', 'dgram', 'domain',
]);

function isBuiltin(mod) {
  return mod.startsWith('node:') || NODE_BUILTINS.has(mod.split('/')[0]);
}

// --- scanners por stack ---

const DART_RE = /^\s*(?:import|export|part)\s+'([^']+)'/gm;
const JS_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gm;
const PY_RE = /^(?:import|from)\s+([a-zA-Z_][a-zA-Z0-9_.]*)/gm;

function scanDartDeps(src, abs, rel, root) {
  const deps = getPubspecDeps(root);
  const out = [];
  const re = new RegExp(DART_RE.source, 'gm');
  let m;
  while ((m = re.exec(src)) !== null) {
    const imp = m[1];
    const line = linesUntil(src, m.index);
    if (imp.startsWith('dart:')) continue;
    if (imp.startsWith('package:')) {
      const pkg = imp.slice('package:'.length).split('/')[0];
      if (!deps.has(pkg))
        out.push({ file: rel, line, id: 'pacote-nao-declarado', msg: `package:${pkg} não declarado em pubspec.yaml (stack: Flutter/Dart)` });
    } else if (!resolveRelative(abs, imp, 'dart')) {
      out.push({ file: rel, line, id: 'import-relativo-inexistente', msg: `import relativo não encontrado: ${imp} (stack: Flutter/Dart)` });
    }
  }
  return out;
}

function pkgNameFromImp(imp) {
  return imp.startsWith('@') ? imp.split('/').slice(0, 2).join('/') : imp.split('/')[0];
}

function checkJsPkg({ imp, pkgDeps, stackDir, rel, line, ext, root }) {
  if (!pkgDeps || isBuiltin(imp) || imp.startsWith('#')) return null;
  if (imp.startsWith('@/') || imp.startsWith('~/')) return null; // tsconfig path alias
  if (imp.startsWith('virtual:')) return null; // Vite virtual modules
  const pkgName = pkgNameFromImp(imp);
  if (pkgDeps.has(pkgName)) return null;
  return { file: rel, line, id: 'pacote-nao-declarado', msg: `'${pkgName}' não declarado em package.json de ${path.relative(root, stackDir)} (stack: ${ext.toUpperCase()})` };
}

function scanJsDeps(src, abs, rel, ext, root) {
  const stackDir = findStackRoot(rel, root);
  const pkgDeps = stackDir ? getPackageJsonDeps(stackDir) : null;
  const out = [];
  const re = new RegExp(JS_RE.source, 'gm');
  let m;
  while ((m = re.exec(src)) !== null) {
    const imp = m[1];
    const line = linesUntil(src, m.index);
    if (imp.startsWith('.')) {
      if (!resolveRelative(abs, imp, ext))
        out.push({ file: rel, line, id: 'import-relativo-inexistente', msg: `import relativo não encontrado: ${imp} (stack: ${ext.toUpperCase()})` });
    } else {
      const r = checkJsPkg({ imp, pkgDeps, stackDir, rel, line, ext, root });
      if (r) out.push(r);
    }
  }
  return out;
}

function scanPyDeps(src, rel, root) {
  const pyDeps = getPyDeps(root);
  if (!pyDeps) return [];
  const out = [];
  const re = new RegExp(PY_RE.source, 'gm');
  let m;
  while ((m = re.exec(src)) !== null) {
    const mod = m[1].split('.')[0];
    const line = linesUntil(src, m.index);
    if (!pyDeps.has(mod) && !pyDeps.has(mod.replace(/_/g, '-')))
      out.push({ file: rel, line, id: 'pacote-nao-declarado', msg: `módulo Python '${mod}' não declarado em pyproject.toml (stack: Python/uv)` });
  }
  return out;
}

export function scanDependencies({ abs, rel }, root = ROOT) {
  const ext = path.extname(rel).slice(1);
  const src = fs.readFileSync(abs, 'utf8');
  if (ext === 'dart') return scanDartDeps(src, abs, rel, root);
  if (['ts', 'tsx', 'js', 'mjs', 'cjs'].includes(ext)) return scanJsDeps(src, abs, rel, ext, root);
  if (ext === 'py') return scanPyDeps(src, rel, root);
  return [];
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
  const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const testsOnly = flags.has('--tests-only');
  const depsOnly = flags.has('--deps-only');

  const configured = THP.defaultTargets || [];
  const defaultTargets = (configured.length ? configured : ['quality'])
    .filter((d) => fs.existsSync(path.join(ROOT, d)));

  const files = collectFiles(targets.length ? targets : defaultTargets);

  if (!files.length) {
    console.log('Nenhum arquivo encontrado.');
    process.exit(0);
  }

  const findings = [];
  for (const f of files) {
    if (!depsOnly) findings.push(...scanFalsePositives(f));
    if (!testsOnly) findings.push(...scanDependencies(f));
  }

  if (!findings.length) {
    const mode = testsOnly ? 'falsos positivos' : depsOnly ? 'dependências' : 'falsos positivos + dependências';
    console.log(`✓ ${files.length} arquivo(s) — nenhum problema encontrado (${mode}).`);
    process.exit(0);
  }

  console.error(`test-hygiene: ${findings.length} problema(s) em ${files.length} arquivo(s):\n`);
  for (const f of findings) {
    const loc = f.line ? `:${f.line}` : '';
    console.error(`  ${f.file}${loc} [${f.id}]`);
    console.error(`    → ${f.msg}`);
  }
  process.exit(1);
}
