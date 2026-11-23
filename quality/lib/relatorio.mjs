import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, repoRoot, loadConfig, countNonBlank, countMatches } from './util.mjs';
import { matchAny } from './glob.mjs';
import { LAYERS, isGenerated, isTest, isSource, languageOf } from './layers.mjs';
import { lizardOnFiles, lizardCommand, which } from './tools.mjs';
import { stripLiterals } from './sanitize.mjs';
import { headSha, isGitRepo } from './git.mjs';
import { result, counts, renderResults } from './report.mjs';
import { t, fmtPercent, fmtNumber } from './messages.mjs';
import { ocrRouterScan } from './tiers.mjs';

const TH = loadConfig('thresholds');

const SUPPRESSION_RE = /\/\/\s*ignore(_for_file)?:|(\/\/|\/\*)\s*eslint-disable|\/\/\s*@ts-(ignore|expect-error|nocheck)|#pragma\s+warning\s+disable|\[\s*ExcludeFromCodeCoverage|#\s*noqa|#\s*type:\s*ignore|(\/\/|\/\*)\s*(c8|istanbul)\s+ignore/;

function tail(text, n = 15) {
  return text.split('\n').filter((l) => l.trim()).slice(-n).map((l) => `    ${l}`).join('\n');
}

/** Arquivos do projeto: rastreados + novos ainda não commitados (respeitando o .gitignore). */
function projectFiles(root) {
  return run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, timeoutMs: 30_000 }).stdout
    .split('\0').filter((f) => f && !/(^|\/)node_modules(\/|$)/.test(f) && fs.existsSync(path.join(root, f)));
}

function exec(out, name, cmd, args, { cwd, timeoutMs = 900_000 } = {}) {
  const r = run(cmd, args, { cwd, timeoutMs });
  if (r.missing) { out.push(result('ferramentas', 'warn', 'tool.missing', { tool: cmd, impact: `${name} não medido.` })); return null; }
  if (r.timedOut) { out.push(result('ferramentas', 'warn', 'tool.timeout', { step: name, seconds: Math.round(timeoutMs / 1000) })); return null; }
  return r;
}

const ceilingText = () => {
  const c = TH.functionCc.ceiling;
  return `${c.default}; C# ${c.csharp}, Python ${c.python}`;
};

// ------------------------------------------------------------------ métricas estáticas (todas as camadas)
function staticMetrics(layer, files, root, out) {
  const src = files.filter((f) => isSource(f) && !isTest(f));
  const tests = files.filter((f) => isTest(f) && isSource(f));
  const m = { src: src.length, tests: tests.length, nloc: 0, big: [], suppressions: 0, fns: 0, ccOver: [], longFns: 0, ccMeasured: false };
  for (const f of src) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    const n = countNonBlank(text);
    m.nloc += n;
    if (n > TH.fileNloc.limit) m.big.push({ f, n });
    m.suppressions += countMatches(stripLiterals(text, languageOf(f)), new RegExp(SUPPRESSION_RE.source, 'g'));
  }
  m.big.sort((a, b) => b.n - a.n);
  const bigNloc = m.big.reduce((a, b) => a + b.n, 0);

  // Tamanho de arquivo
  out.push(m.big.length
    ? result('tamanho', 'fail', 'report.bigFiles', { limit: TH.fileNloc.limit, value: m.big.length, top: m.big.slice(0, 3).map((b) => `${b.f} (${fmtNumber(b.n)})`).join(', ') })
    : result('tamanho', 'pass', 'report.bigFilesNone', { limit: TH.fileNloc.limit }));

  // Complexidade por função
  if (src.length && lizardCommand()) {
    const fns = lizardOnFiles(root, src.filter((f) => languageOf(f)), languageOf) ?? [];
    m.ccMeasured = true;
    m.fns = fns.length;
    for (const fn of fns) {
      const lang = languageOf(fn.file) ?? 'default';
      const ceiling = TH.functionCc.ceiling[lang] ?? TH.functionCc.ceiling.default;
      if (fn.ccn > ceiling) m.ccOver.push({ ...fn, ceiling });
      if (fn.nloc > TH.functionNloc.ceiling) m.longFns++;
    }
    m.ccOver.sort((a, b) => b.ccn - a.ccn);
    m.ccTarget = fns.filter((fn) => fn.ccn > TH.functionCc.target).length;
    const top = m.ccOver.slice(0, 3).map((fn) => `${fn.name} (${fn.ccn}, ${fn.file}:${fn.start})`).join('; ');
    out.push(m.ccOver.length
      ? result('complexidade', 'fail', 'report.ccOver', { limit: ceilingText(), value: m.ccOver.length, total: m.fns, top })
      : result('complexidade', 'pass', 'report.ccOk', { limit: ceilingText(), total: m.fns }));
    out.push(result('tamanho-funcao', m.longFns ? 'warn' : 'pass', 'report.longFns', { limit: TH.functionNloc.ceiling, value: m.longFns }));
  } else if (src.length) {
    out.push(result('ferramentas', 'warn', 'tool.missing', { tool: 'lizard', impact: 'Complexidade por função não medida.' }));
  }
  out.push(result('supressoes', m.suppressions ? 'warn' : 'pass', 'report.suppressions', { value: m.suppressions }));
  m.bigNloc = bigNloc;
  return m;
}

// ------------------------------------------------------------------ fronteiras (varredura completa)
function flutterBoundaries(files, root, out, m) {
  const violations = [];
  const imp = /^\s*(?:import|export)\s+['"]([^'"]+)['"]/gm;
  for (const f of files) {
    if (!f.endsWith('.dart') || isGenerated(f)) continue;
    const domain = /^lib\/features\/[^/]+\/domain\//.test(f);
    const data = /^lib\/features\/[^/]+\/data\//.test(f);
    const shared = /^lib\/(shared|core)\//.test(f);
    if (!domain && !data && !shared) continue;
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const mm of text.matchAll(imp)) {
      const u = mm[1];
      const internal = u.startsWith('package:fluxo/') || !u.includes(':');
      const p = u.replace(/^package:fluxo\//, '');
      const bad = (domain && (/^package:(cloud_firestore|firebase_[a-z_]+)\//.test(u) || (/^package:flutter\//.test(u) && u !== 'package:flutter/foundation.dart') || (internal && /(^|\/)(data|presentation)\//.test(p))))
        || (data && internal && /(^|\/)presentation\//.test(p))
        || (shared && internal && /(^|\/)features\//.test(p));
      if (bad) violations.push(`${f} → ${u}`);
    }
  }
  m.boundaries = violations.length;
  out.push(violations.length
    ? result('fronteiras', 'fail', 'report.boundaries', { value: violations.length, top: violations.slice(0, 3).join('; ') })
    : result('fronteiras', 'pass', 'report.boundariesNone', {}));

  let fallbacks = 0;
  for (const f of files) if (/^lib\/.*\.dart$/.test(f)) fallbacks += countMatches(fs.readFileSync(path.join(root, f), 'utf8'), /API fallback to Firestore/g);
  out.push(result('fallback-api', fallbacks ? 'fail' : 'pass', 'report.fallbacks', { value: fallbacks }));

  const features = fs.readdirSync(path.join(root, 'lib/features'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const untested = features.filter((f) => !files.some((x) => x.startsWith(`test/features/${f}/`) && x.endsWith('_test.dart')));
  m.untested = untested.length;
  out.push(untested.length
    ? result('testes', 'fail', 'report.featuresNoTests', { value: untested.length, total: features.length, list: untested.join(', ') })
    : result('testes', 'pass', 'report.featuresAllTested', { total: features.length }));
}

// ------------------------------------------------------------------ execução por camada
function lcovTotal(file) {
  let found = 0;
  let hit = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('LF:')) found += Number(line.slice(3));
    else if (line.startsWith('LH:')) hit += Number(line.slice(3));
  }
  return found ? hit / found : null;
}

function runFlutter(root, out, m) {
  if (!which('flutter')) { out.push(result('ferramentas', 'warn', 'tool.missing', { tool: 'flutter', impact: 'Análise e testes do Flutter não executados.' })); return; }
  const a = exec(out, 'flutter analyze', 'flutter', ['analyze', '--no-pub', '--no-fatal-infos', '--no-fatal-warnings'], { cwd: root, timeoutMs: 600_000 });
  if (a) {
    const text = a.stdout + a.stderr;
    const errors = (text.match(/^\s*error •/gm) || []).length;
    const warnings = (text.match(/^\s*warning •/gm) || []).length;
    const infos = (text.match(/^\s*info •/gm) || []).length;
    m.lintIssues = errors + warnings;
    out.push(result('lint', errors ? 'fail' : warnings ? 'warn' : 'pass', 'report.lint', { tool: 'flutter analyze', errors, warnings, infos, scope: 'Flutter (lib/ e test/)' }));
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrep-'));
  try {
    const lcov = path.join(tmp, 'lcov.info');
    const r = exec(out, 'flutter test --coverage', 'flutter', ['test', '--no-pub', '--coverage', `--coverage-path=${lcov}`], { cwd: root, timeoutMs: 1_800_000 });
    if (!r) return;
    const summary = /([+]\d+(?: ~\d+)?(?: -\d+)?): (All tests passed!|Some tests failed\.)/.exec(r.stdout)?.[0] ?? 'flutter test';
    m.testsPass = r.code === 0;
    out.push(r.code === 0
      ? result('testes', 'pass', 'tests.pass', { scope: 'Flutter (suíte completa)', detail: summary })
      : result('testes', 'fail', 'tests.fail', { scope: 'Flutter (suíte completa)', detail: summary, tail: tail(r.stdout + r.stderr) }));
    if (fs.existsSync(lcov)) coverageResult(out, m, 'Flutter', lcovTotal(lcov), 60);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function coverageResult(out, m, scope, ratio, target) {
  if (ratio == null) return;
  m.coverage = ratio;
  m.coverageTarget = target / 100;
  out.push(result('cobertura', ratio * 100 >= target ? 'pass' : 'fail', 'report.coverage', { scope, value: fmtPercent(ratio), limit: `${target} %` }));
}

function runFunctions(root, out, m) {
  const fnDir = path.join(root, 'functions');
  const tsc = path.join(fnDir, 'node_modules/.bin/tsc');
  if (!fs.existsSync(tsc)) { out.push(result('ferramentas', 'warn', 'tool.depsMissing', { scope: 'functions', hint: 'npm --prefix functions install', what: 'tipos e testes' })); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrepfn-'));
  try {
    const b = exec(out, 'tsc (functions)', tsc, ['-p', 'tsconfig.json', '--outDir', path.join(tmp, 'lib'), '--pretty', 'false'], { cwd: fnDir, timeoutMs: 300_000 });
    if (!b) return;
    const errs = ((b.stdout + b.stderr).match(/error TS\d+/g) || []).length;
    m.lintIssues = errs;
    out.push(errs
      ? result('tipos', 'fail', 'types.legacy', { tool: 'tsc', value: errs, scope: 'functions' })
      : result('tipos', 'pass', 'types.pass', { tool: 'tsc', scope: 'functions' }));
    if (b.code !== 0) return;
    fs.cpSync(path.join(fnDir, 'test'), path.join(tmp, 'test'), { recursive: true });
    fs.copyFileSync(path.join(fnDir, 'package.json'), path.join(tmp, 'package.json'));
    fs.symlinkSync(path.join(fnDir, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
    const files = fs.readdirSync(path.join(tmp, 'test'), { recursive: true }).map(String)
      .filter((f) => f.endsWith('.test.js') && !f.endsWith('.rules.test.js')).map((f) => path.join(tmp, 'test', f));
    const r = exec(out, 'node --test (functions)', process.execPath, ['--test', '--experimental-test-coverage', '--test-reporter=spec', ...files], { cwd: tmp, timeoutMs: 900_000 });
    if (!r) return;
    const text = r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    const pass = /ℹ pass (\d+)/.exec(text)?.[1];
    const fail = /ℹ fail (\d+)/.exec(text)?.[1];
    m.testsPass = r.code === 0;
    const detail = `${pass ?? '?'} aprovado(s), ${fail ?? '?'} reprovado(s)`;
    out.push(r.code === 0
      ? result('testes', 'pass', 'tests.pass', { scope: 'functions (suíte unitária)', detail })
      : result('testes', 'fail', 'tests.fail', { scope: 'functions (suíte unitária)', detail, tail: tail(text) }));
    const cov = /all files\s*\|\s*([\d.]+)/i.exec(text)?.[1];
    if (cov) coverageResult(out, m, 'functions (JS compilado)', Number(cov) / 100, 70);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  out.push(result('ferramentas', 'warn', 'tool.delegated', { what: 'Testes de regras no emulador', reason: which('firebase') ? 'exigem JDK e emulador' : 'firebase CLI ausente', workflow: 'presence-integrity.yml' }));
}

function runOcr(root, out, m) {
  const dir = path.join(root, 'OCR_webscraper_crawler');
  if (!which('pnpm')) { out.push(result('ferramentas', 'warn', 'tool.missing', { tool: 'pnpm', impact: 'Build e testes do OCR não executados.' })); return; }
  if (!fs.existsSync(path.join(dir, 'packages/shared/node_modules'))) { out.push(result('ferramentas', 'warn', 'tool.depsMissing', { scope: 'OCR', hint: 'pnpm ocr:install', what: 'build e testes' })); return; }
  const b = exec(out, 'pnpm build (OCR)', 'pnpm', ['-r', '--filter', './packages/*', 'build'], { cwd: dir, timeoutMs: 600_000 });
  const tc = b && exec(out, 'pnpm typecheck (OCR)', 'pnpm', ['-r', 'typecheck'], { cwd: dir, timeoutMs: 600_000 });
  if (tc) {
    const errs = ((tc.stdout + tc.stderr).match(/error TS\d+/g) || []).length;
    m.lintIssues = errs;
    out.push(tc.code === 0 ? result('tipos', 'pass', 'types.pass', { tool: 'tsc', scope: 'OCR (todos os pacotes)' })
      : result('tipos', 'fail', 'build.fail', { tool: 'pnpm typecheck', scope: 'OCR', tail: tail(tc.stdout + tc.stderr) }));
  }
  const r = exec(out, 'pnpm test (OCR)', 'pnpm', ['-r', 'test'], { cwd: dir, timeoutMs: 900_000 });
  if (r) {
    const clean = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '');
    const passed = [...clean.matchAll(/Tests\s+(\d+) passed/g)].reduce((a, x) => a + Number(x[1]), 0);
    m.testsPass = r.code === 0;
    out.push(r.code === 0
      ? result('testes', 'pass', 'tests.pass', { scope: 'OCR (Vitest, todos os pacotes)', detail: `${fmtNumber(passed)} teste(s)` })
      : result('testes', 'fail', 'tests.fail', { scope: 'OCR (Vitest)', detail: 'pnpm -r test', tail: tail(clean) }));
  }
  out.push(result('ferramentas', 'warn', 'tool.missing', { tool: '@vitest/coverage-v8 (OCR)', impact: 'Cobertura do OCR não medida (QUALITY.md §5.4).' }));
  if (which('uv')) {
    const p = exec(out, 'pytest (menu-schema)', 'uv', ['run', '--directory', 'OCR_webscraper_crawler/python', 'pytest', '-q'], { cwd: root, timeoutMs: 300_000 });
    if (p) out.push(p.code === 0
      ? result('testes', 'pass', 'tests.pass', { scope: 'OCR python (menu-schema)', detail: tail(p.stdout, 1).trim() })
      : result('testes', 'fail', 'tests.fail', { scope: 'OCR python', detail: 'pytest', tail: tail(p.stdout + p.stderr) }));
  }
  const before = out.length;
  ocrRouterScan(out);
  m.boundaries = out.slice(before).filter((x) => x.status === 'fail').length;
}

function runWeb(app, root, out, m) {
  const bin = path.join(root, app, 'node_modules/.bin');
  if (!fs.existsSync(bin)) { out.push(result('ferramentas', 'warn', 'tool.depsMissing', { scope: app, hint: `npm --prefix ${app} install`, what: 'lint, tipos e testes' })); return; }
  const l = exec(out, `eslint ${app}`, path.join(bin, 'eslint'), ['.'], { cwd: path.join(root, app), timeoutMs: 300_000 });
  if (l) out.push(l.code === 0 ? result('lint', 'pass', 'lint.pass', { tool: 'eslint', scope: app }) : result('lint', 'fail', 'build.fail', { tool: 'eslint', scope: app, tail: tail(l.stdout + l.stderr) }));
  const v = exec(out, `vitest ${app}`, path.join(bin, 'vitest'), ['run', '--passWithNoTests'], { cwd: path.join(root, app), timeoutMs: 600_000 });
  if (v) { m.testsPass = v.code === 0; out.push(v.code === 0 ? result('testes', 'pass', 'tests.pass', { scope: app, detail: 'vitest run' }) : result('testes', 'fail', 'tests.fail', { scope: app, detail: 'vitest run', tail: tail(v.stdout + v.stderr) })); }
}

function runBackend(root, out, m) {
  const DN = PROFILE.runnerDotnet || {};
  if (!DN.solution) return; // projeto sem solution .NET no perfil: nada a rodar
  if (!which('dotnet')) { out.push(result('ferramentas', 'warn', 'tool.delegated', { what: 'Build, testes e cobertura do backend .NET', reason: 'dotnet SDK ausente', workflow: DN.workflow || 'CI do projeto' })); return; }
  const b = exec(out, 'dotnet build', 'dotnet', ['build', DN.solution, '-c', 'Release', '-warnaserror', '-nologo'], { cwd: root, timeoutMs: 600_000 });
  if (!b) return;
  if (b.code !== 0) { out.push(result('tipos', 'fail', 'build.fail', { tool: 'dotnet build', scope: 'backend', tail: tail(b.stdout + b.stderr) })); return; }
  out.push(result('tipos', 'pass', 'build.pass', { tool: 'dotnet build -warnaserror', scope: 'backend' }));
  const r = exec(out, 'dotnet test', 'dotnet', ['test', DN.solution, '-c', 'Release', '--no-build', ...(DN.testFilter ? ['--filter', DN.testFilter] : []), '-nologo'], { cwd: root, timeoutMs: 900_000 });
  if (r) { m.testsPass = r.code === 0; out.push(r.code === 0 ? result('testes', 'pass', 'tests.pass', { scope: 'backend', detail: 'dotnet test' }) : result('testes', 'fail', 'tests.fail', { scope: 'backend', detail: 'dotnet test', tail: tail(r.stdout + r.stderr) })); }
}

function runRules(files, root, out, m) {
  const rulesTests = files.filter((f) => /\.rules\.test\.js$/.test(f)).map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  for (const rulesFile of ['firestore.rules', 'storage.rules']) {
    if (!fs.existsSync(path.join(root, rulesFile))) continue;
    const text = fs.readFileSync(path.join(root, rulesFile), 'utf8');
    const collections = [...new Set([...text.matchAll(/match\s+\/([A-Za-z_][\w-]*)\//g)].map((x) => x[1]))].filter((c) => c !== 'databases' && c !== 'b');
    const untested = collections.filter((c) => !new RegExp(`['"\`/]${c}['"\`/]`).test(rulesTests));
    m.rulesTotal = (m.rulesTotal ?? 0) + collections.length;
    m.rulesUntested = (m.rulesUntested ?? 0) + untested.length;
    m.coverage = 1 - m.rulesUntested / m.rulesTotal;
    m.coverageTarget = 1;
    out.push(untested.length
      ? result('regras', 'fail', 'report.rulesUntested', { file: rulesFile, value: untested.length, total: collections.length, list: untested.slice(0, 12).join(', ') + (untested.length > 12 ? ` +${untested.length - 12}` : '') })
      : result('regras', 'pass', 'report.rulesTested', { file: rulesFile, total: collections.length }));
  }
  out.push(result('ferramentas', 'warn', 'tool.delegated', { what: 'Execução dos testes de regras no emulador', reason: which('firebase') ? 'exigem JDK e emulador' : 'firebase CLI ausente', workflow: 'presence-integrity.yml' }));
}

function pinnedCount(files, root) {
  let n = 0;
  for (const f of files.filter((x) => /^\.github\/workflows\/.*\.ya?ml$/.test(x))) {
    n += [...fs.readFileSync(path.join(root, f), 'utf8').matchAll(/uses:\s*([^\s#]+)/g)].filter((mm) => /@[0-9a-f]{40}$/.test(mm[1])).length;
  }
  return n;
}

function runInfra(files, root, out, m) {
  let unpinned = 0;
  const offenders = [];
  for (const f of files.filter((x) => /^\.github\/workflows\/.*\.ya?ml$/.test(x))) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const mm of text.matchAll(/uses:\s*([^\s#]+)/g)) {
      const ref = mm[1];
      if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
      if (!/@[0-9a-f]{40}$/.test(ref)) { unpinned++; if (!offenders.includes(f)) offenders.push(f); }
    }
  }
  const total = unpinned + pinnedCount(files, root);
  if (total) { m.coverage = 1 - unpinned / total; m.coverageTarget = 1; }
  out.push(unpinned
    ? result('cadeia-suprimentos', 'fail', 'report.unpinned', { value: unpinned, list: offenders.join(', ') })
    : result('cadeia-suprimentos', 'pass', 'report.pinned', {}));
  if (!which('terraform')) out.push(result('ferramentas', 'warn', 'tool.missing', { tool: 'terraform', impact: 'terraform fmt/validate não executados.' }));
  else {
    const r = exec(out, 'terraform fmt', 'terraform', ['-chdir=infra/gcp/terraform', 'fmt', '-check', '-recursive'], { cwd: root, timeoutMs: 120_000 });
    if (r) out.push(r.code === 0 ? result('formato', 'pass', 'format.pass', { file: 'infra/gcp/terraform' }) : result('formato', 'fail', 'format.fail', { file: 'infra/gcp/terraform' }));
  }
}

function runQuality(root, out, m) {
  const dir = path.join(root, 'quality', 'test');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join(dir, f));
  const r = exec(out, 'node --test (gates de qualidade)', process.execPath, ['--test', ...files], { cwd: root, timeoutMs: 600_000 });
  if (!r) return;
  const pass = /^# pass (\d+)/m.exec(r.stdout)?.[1] ?? '?';
  const fail = /^# fail (\d+)/m.exec(r.stdout)?.[1] ?? '?';
  m.testsPass = r.code === 0;
  const detail = `${pass} aprovado(s), ${fail} reprovado(s)`;
  out.push(r.code === 0
    ? result('testes', 'pass', 'tests.pass', { scope: 'gates de qualidade', detail })
    : result('testes', 'fail', 'tests.fail', { scope: 'gates de qualidade', detail, tail: tail(r.stdout) }));
}

// ------------------------------------------------------------------ score (QUALITY.md §6.1, só componentes medidos)
export function layerScore(m) {
  const parts = [];
  if (m.coverage != null) parts.push([25, Math.min(1, m.coverage / m.coverageTarget)]);
  if (m.ccMeasured && m.fns) parts.push([20, 1 - m.ccTarget / m.fns]);
  if (m.nloc) parts.push([15, 1 - m.bigNloc / m.nloc]);
  if (m.lintIssues != null) parts.push([10, 1 - Math.min(1, m.lintIssues / Math.max(1, (m.nloc / 1000) * 5))]);
  if (m.boundaries != null) parts.push([10, 1 - Math.min(1, m.boundaries / 10)]);
  if (m.testsPass != null) parts.push([20, m.testsPass ? 1 : 0]);
  const w = parts.reduce((a, [wt]) => a + wt, 0);
  if (!w) return null;
  return Math.round((parts.reduce((a, [wt, v]) => a + wt * Math.max(0, v), 0) / w) * 100);
}

// ------------------------------------------------------------------ orquestração
export function runRelatorio({ camadas } = {}) {
  const root = repoRoot();
  if (!isGitRepo(root)) throw new Error(t('error.notGit'));
  const all = projectFiles(root);
  const selected = LAYERS.filter((l) => l.id !== 'docs' && (!camadas || camadas.includes(l.id)));
  const sections = [];
  for (const layer of selected) {
    // Primeira camada que casa vence (mesma regra de layerOf).
    const files = all.filter((f) => matchAny(f, layer.globs) && LAYERS.find((l) => matchAny(f, l.globs))?.id === layer.id);
    const out = [];
    const m = staticMetrics(layer, files, root, out);
    if (layer.id === 'flutter') { flutterBoundaries(files, root, out, m); runFlutter(root, out, m); }
    else if (layer.id === 'functions') runFunctions(root, out, m);
    else if (layer.id === 'ocr') runOcr(root, out, m);
    else if (layer.id === 'admin-web') runWeb('admin-web', root, out, m);
    else if (layer.id === 'site') runWeb('ofluxo_site', root, out, m);
    else if (layer.id === 'backend') runBackend(root, out, m);
    else if (layer.id === 'rules') runRules(all, root, out, m);
    else if (layer.id === 'infra') runInfra(files, root, out, m);
    else if (layer.id === 'quality') runQuality(root, out, m);
    sections.push({ layer, m, results: out, score: layerScore(m) });
  }
  return { root, sha: headSha(root), dirty: run('git', ['status', '--porcelain'], { cwd: root }).stdout.trim() !== '', sections };
}

export function renderRelatorio(rep) {
  const lines = [`# ${t('report.title')}`, '', t('report.generated', { date: new Date().toISOString().slice(0, 10), sha: (rep.sha ?? '—').slice(0, 8), dirty: rep.dirty ? t('report.dirty') : '' }), ''];
  const all = [];
  const scores = [];
  lines.push('| Camada | Stack | Score | Reprovados | Alertas | Aprovados |', '|---|---|---|---|---|---|');
  for (const s of rep.sections) {
    const c = counts(s.results);
    lines.push(`| ${s.layer.nome} | ${s.layer.stack} | ${s.score ?? '—'} | ${c.fail} | ${c.warn} | ${c.pass} |`);
  }
  lines.push('');
  for (const s of rep.sections) {
    all.push(...s.results);
    if (s.score != null) scores.push(s.score);
    lines.push(`## ${t('report.layer', { nome: s.layer.nome })}`, '');
    lines.push(`- ${t('report.stack', { stack: s.layer.stack })}`);
    if (s.layer.doc) lines.push(`- Documentação: \`${s.layer.doc}\``);
    lines.push(`- ${t('report.files', { files: s.m.src, nloc: s.m.nloc, tests: s.m.tests })}`);
    lines.push(`- ${s.score == null ? 'Score da camada: não calculado (nada medido).' : t('report.score', { score: s.score })}`, '');
    lines.push('```text', ...renderResults(s.results, { aggregateAbove: 1000 }), '```', '');
  }
  const c = counts(all);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : '—';
  lines.push('## Resultado geral', '', t('report.overall', { failed: c.fail, warned: c.warn, passed: c.pass, layers: rep.sections.length, score: avg }), '');
  lines.push('> Score (0–100) por camada, QUALITY.md §6.1, ponderado só pelos componentes medidos: cobertura 25, testes aprovados 20, complexidade (funções ≤ 10) 20, tamanho (linhas fora de arquivos > 400) 15, lint/tipos 10, fronteiras 10.');
  return lines.join('\n');
}
