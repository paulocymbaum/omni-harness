import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRoot } from '../util.mjs';
import { PROFILE } from '../profile.mjs';
import { ocrPackage } from '../layers.mjs';
import { which } from '../tools.mjs';
import { result } from '../report.mjs';
import { step, tail, addedLineSet } from './common.mjs';
import { workerFlags } from '../limits.mjs';

// ================================================================ TypeScript (tsc)
const TSC_ERR = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

function tscGate(out, budget, { dir, tsconfig = 'tsconfig.json', prefix, touched, scope }) {
  const root = repoRoot();
  const tsc = path.join(root, dir, 'node_modules/.bin/tsc');
  if (!fs.existsSync(tsc)) {
    out.push(result('ferramentas', 'warn', 'tool.depsMissing', { scope, hint: 'rode npm/pnpm install', what: 'checagem de tipos' }));
    return;
  }
  const r = step(out, budget, `tsc ${scope}`, tsc, ['-p', tsconfig, '--noEmit', '--pretty', 'false'], { cwd: path.join(root, dir), capMs: 240_000 });
  if (!r) return;
  let legacy = 0;
  let errors = 0;
  for (const line of (r.stdout + r.stderr).split('\n')) {
    const m = TSC_ERR.exec(line.trim());
    if (!m) continue;
    const rel = path.posix.normalize(`${prefix}/${m[1].split(path.sep).join('/')}`);
    if (touched.has(rel)) { errors++; out.push(result('tipos', 'fail', 'types.issue', { file: rel, line: Number(m[2]), code: m[4], msg: m[5] })); }
    else legacy++;
  }
  if (legacy) out.push(result('tipos', 'warn', 'types.legacy', { tool: 'tsc', value: legacy, scope }));
  if (!errors) out.push(result('tipos', 'pass', 'types.pass', { tool: 'tsc', scope }));
}

// ================================================================ functions/
function functionsTests(out, budget, { testFiles, scope }) {
  const root = repoRoot();
  const fnDir = path.join(root, 'functions');
  const tsc = path.join(fnDir, 'node_modules/.bin/tsc');
  if (!fs.existsSync(tsc)) {
    out.push(result('ferramentas', 'warn', 'tool.depsMissing', { scope: 'functions', hint: 'npm --prefix functions install', what: 'testes' }));
    return;
  }
  if (testFiles.length === 0) { out.push(result('testes', 'warn', 'tests.none', { scope })); return; }
  // functions/lib é versionado: compila num diretório temporário para não sujar a árvore.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qfn-'));
  try {
    const b = step(out, budget, 'tsc (build temporário de functions)', tsc, ['-p', 'tsconfig.json', '--outDir', path.join(tmp, 'lib')], { cwd: fnDir, capMs: 240_000 });
    if (!b) return;
    if (b.code !== 0) { out.push(result('testes', 'fail', 'build.fail', { tool: 'tsc', scope: 'functions', tail: tail(b.stdout + b.stderr) })); return; }
    fs.cpSync(path.join(fnDir, 'test'), path.join(tmp, 'test'), { recursive: true });
    fs.copyFileSync(path.join(fnDir, 'package.json'), path.join(tmp, 'package.json'));
    fs.symlinkSync(path.join(fnDir, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
    const files = testFiles.map((f) => path.join(tmp, 'test', path.relative('functions/test', f)));
    const r = step(out, budget, 'node --test (functions)', process.execPath, ['--test', ...workerFlags().nodeTest, ...files], { cwd: tmp, capMs: 600_000 });
    if (!r) return;
    const detail = `${testFiles.length} arquivo(s) de teste`;
    out.push(r.code === 0
      ? result('testes', 'pass', 'tests.pass', { scope, detail })
      : result('testes', 'fail', 'tests.fail', { scope, detail, tail: tail(r.stdout + r.stderr) }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function functionsTestFiles(root) {
  const dir = path.join(root, 'functions/test');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true })
    .map((f) => String(f).split(path.sep).join('/'))
    .filter((f) => f.endsWith('.test.js') && !f.endsWith('.rules.test.js'))
    .map((f) => `functions/test/${f}`);
}

export function functionsRoutine(entries, out, budget, full) {
  const fn = entries.filter((e) => e.status !== 'D' && /^functions\/(src|test)\//.test(e.path));
  if (fn.length === 0) return;
  const root = repoRoot();
  tscGate(out, budget, { dir: 'functions', prefix: 'functions', touched: new Set(fn.map((e) => e.path)), scope: 'functions' });
  const all = functionsTestFiles(root);
  let tests = all;
  if (!full) {
    const keys = fn.filter((e) => e.path.startsWith('functions/src/')).map((e) => {
      const rel = e.path.replace(/^functions\/src\//, '').replace(/\.ts$/, '');
      return rel.endsWith('/index') ? rel.slice(0, -'/index'.length) : rel;
    });
    const touchedTests = new Set(fn.filter((e) => /\.test\.js$/.test(e.path) && !e.path.endsWith('.rules.test.js')).map((e) => e.path));
    tests = all.filter((t) => {
      if (touchedTests.has(t)) return true;
      const text = fs.readFileSync(path.join(root, t), 'utf8');
      return keys.some((k) => text.includes(`lib/${k}"`) || text.includes(`lib/${k}'`) || text.includes(`lib/${k}/`) || text.includes(`lib/${k}.js`));
    });
  }
  functionsTests(out, budget, { testFiles: tests, scope: full ? 'functions (suíte unitária completa)' : 'functions (testes relacionados)' });
  if (entries.some((e) => /^(firestore|storage)\.rules$/.test(e.path) || /\.rules\.test\.js$/.test(e.path))) rulesDelegated(out);
}

function rulesDelegated(out) {
  if (!which('firebase')) {
    out.push(result('ferramentas', 'warn', 'tool.delegated', { what: 'Testes de regras no emulador Firestore/Storage', reason: 'firebase CLI ausente', workflow: 'presence-integrity.yml / npm --prefix functions run test:rules' }));
  } else {
    out.push(result('ferramentas', 'warn', 'tool.delegated', { what: 'Testes de regras no emulador', reason: 'exigem JDK e emulador; rode npm --prefix functions run test:admin-rules / test:rules', workflow: 'presence-integrity.yml' }));
  }
}

// ================================================================ testes (Vitest / resultado comum)
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function testResult(r, scope, detail) {
  return r.code === 0
    ? result('testes', 'pass', 'tests.pass', { scope, detail })
    : result('testes', 'fail', 'tests.fail', { scope, detail, tail: tail(r.stdout + r.stderr) });
}

/** vitest related (rotina) ou vitest run (completo) no diretório do pacote. */
function vitestGate(out, budget, { dir, files, full, scope, hint }) {
  const root = repoRoot();
  const vitest = path.join(root, dir, 'node_modules/.bin/vitest');
  if (!fs.existsSync(vitest)) {
    out.push(result('ferramentas', 'warn', 'tool.depsMissing', { scope, hint, what: 'testes' }));
    return;
  }
  const args = full ? ['run', '--passWithNoTests'] : ['related', '--run', '--passWithNoTests', ...files.map((e) => path.join(root, e.path))];
  args.push(...workerFlags().vitest); // sem teto o vitest abre núcleos-1 workers jsdom
  // NODE_ENV herdado do shell (ex.: production) quebra o JSX de dev do React nos testes.
  const r = step(out, budget, `vitest ${scope}`, vitest, args, { cwd: path.join(root, dir), capMs: 300_000, env: { NODE_ENV: 'test' } });
  if (!r) return;
  const summary = /Tests\s+(.+)$/m.exec(stripAnsi(r.stdout))?.[1]?.trim() ?? (full ? 'suíte completa' : 'testes relacionados');
  out.push(testResult(r, scope, summary));
}

// ================================================================ OCR (pnpm workspace)
const TS_WORKSPACES = (PROFILE.runnerTs && PROFILE.runnerTs.workspaces) || [];

function groupWorkspacePackages(entries) {
  const pkgs = new Map();
  const roots = TS_WORKSPACES.map((w) => `${w.root}/`);
  for (const e of entries) {
    if (e.status === 'D' || !roots.some((r) => e.path.startsWith(r))) continue;
    const p = ocrPackage(e.path);
    if (!p) continue;
    if (!pkgs.has(p)) pkgs.set(p, []);
    pkgs.get(p).push(e);
  }
  return pkgs;
}

/** Pacotes dependem do dist/ dos irmãos: recompila antes de testar (dist/ é ignorado pelo git). */
function workspaceBuild(out, budget, ws) {
  const build = ws.build || {};
  if (!build.tool || !which(build.tool)) {
    out.push(result('ferramentas', 'warn', 'tool.missing', { tool: build.tool || 'build', impact: `Build dos pacotes ${ws.label || ws.root} não executado.` }));
    return;
  }
  const b = step(out, budget, build.label || `build (${ws.root})`, build.tool, build.args || [], { cwd: path.join(repoRoot(), build.cwd || ws.root), capMs: 240_000 });
  if (b && b.code !== 0) out.push(result('tipos', 'fail', 'build.fail', { tool: `${build.tool} build`, scope: `${ws.label || ws.root} packages`, tail: tail(b.stdout + b.stderr) }));
}

function workspacePython(out, budget, ws) {
  const py = ws.python;
  if (!py) return;
  if (!which(py.tool)) {
    out.push(result('ferramentas', 'warn', 'tool.missing', { tool: py.tool, impact: 'Testes Python do workspace não executados.' }));
    return;
  }
  const r = step(out, budget, py.label || 'pytest (workspace)', py.tool, py.args || [], { capMs: 180_000 });
  if (r) out.push(testResult(r, `${ws.label || ws.root} python`, r.code === 0 ? tail(r.stdout, 1).trim() : 'pytest'));
}

export function ocrRoutine(entries, out, budget, full) {
  const ws = TS_WORKSPACES[0];
  if (!ws) return;
  const pkgs = groupWorkspacePackages(entries);
  if (pkgs.size === 0 && !full) return;
  const tsPkgs = [...pkgs.keys()].filter((p) => p !== 'python');
  if (full || tsPkgs.some((p) => p.startsWith('packages/'))) workspaceBuild(out, budget, ws);
  for (const p of tsPkgs) {
    const dir = `${ws.root}/${p}`;
    const files = pkgs.get(p);
    tscGate(out, budget, { dir, prefix: dir, touched: new Set(files.map((e) => e.path)), scope: `${ws.label} ${p}` });
    vitestGate(out, budget, { dir, files, full, scope: `${ws.label} ${p}`, hint: ws.vitestHint });
  }
  if (pkgs.has('python') || full) workspacePython(out, budget, ws);
  if (full) workspaceRouterScan(out, ws);
}

/** Varredura completa do router do workspace: nenhuma importação proibida pelo perfil. */
export function ocrRouterScan(out) {
  const ws = TS_WORKSPACES[0];
  const scan = ws && ws.routerScan;
  if (!scan) return;
  const root = repoRoot();
  const dir = path.join(root, scan.dir);
  if (!fs.existsSync(dir)) return;
  const bad = new RegExp(scan.badRe, 'g');
  let violations = 0;
  for (const f of fs.readdirSync(dir, { recursive: true }).map(String)) {
    if (!/\.(ts|js|mjs)$/.test(f)) continue;
    const rel = `${scan.dir}/${f.split(path.sep).join('/')}`;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(bad)) {
      violations++;
      out.push(result('fronteiras', 'fail', 'boundary.fail', { file: rel, line: text.slice(0, m.index).split('\n').length, rule: scan.rule, import: m[1] }));
    }
  }
  if (!violations) out.push(result('fronteiras', 'pass', 'boundary.pass', { file: `${scan.dir} (varredura completa)` }));
}


// ================================================================ Web (admin-web, ofluxo_site)
/** Erros do ESLint sempre reprovam; avisos só nas linhas alteradas; o resto é legado. */
function eslintFindings(out, json, files, root) {
  let issues = 0;
  let legacy = 0;
  for (const fileRes of json) {
    const rel = path.relative(root, fileRes.filePath).split(path.sep).join('/');
    const e = files.find((x) => x.path === rel);
    const changed = e ? addedLineSet(e) : new Set();
    for (const m of fileRes.messages) {
      if (m.severity !== 2 && !changed.has(m.line)) { legacy++; continue; }
      issues++;
      out.push(result('lint', m.severity === 2 ? 'fail' : 'warn', 'lint.issue', { file: rel, line: m.line, code: m.ruleId ?? 'eslint', msg: m.message }));
    }
  }
  return { issues, legacy };
}

function eslintGate(out, budget, app, files) {
  const root = repoRoot();
  const r = step(out, budget, `eslint ${app}`, path.join(root, app, 'node_modules/.bin/eslint'), ['--format', 'json', ...files.map((e) => path.join(root, e.path))], { cwd: path.join(root, app), capMs: 180_000 });
  if (!r) return;
  let found;
  try {
    found = eslintFindings(out, JSON.parse(r.stdout || '[]'), files, root);
  } catch {
    out.push(result('lint', 'fail', 'build.fail', { tool: 'eslint', scope: app, tail: tail(r.stdout + r.stderr) }));
    return;
  }
  if (found.legacy) out.push(result('lint', 'warn', 'lint.legacy', { tool: 'eslint', value: found.legacy, scope: app }));
  if (!found.issues) out.push(result('lint', 'pass', 'lint.pass', { tool: 'eslint', scope: app }));
}

export function webRoutine(entries, out, budget, full) {
  const root = repoRoot();
  for (const app of ['admin-web', 'ofluxo_site', 'services/debate-worker', 'packages/creator-render', 'services/creator-worker']) {
    const files = entries.filter((e) => e.status !== 'D' && e.path.startsWith(`${app}/`) && /\.(tsx?|jsx?)$/.test(e.path));
    if (files.length === 0) continue;
    if (!fs.existsSync(path.join(root, app, 'node_modules/.bin/eslint'))) {
      out.push(result('ferramentas', 'warn', 'tool.depsMissing', { scope: app, hint: `npm --prefix ${app} install`, what: 'lint e testes' }));
      continue;
    }
    if (app === 'services/debate-worker' || app === 'packages/creator-render' || app === 'services/creator-worker') tscGate(out, budget, { dir: app, prefix: app, touched: new Set(files.map((e) => e.path)), scope: app });
    eslintGate(out, budget, app, files);
    vitestGate(out, budget, { dir: app, files, full, scope: app, hint: `npm --prefix ${app} install` });
  }
}
