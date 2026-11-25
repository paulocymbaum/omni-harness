import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRoot, loadConfig, countMatches } from '../util.mjs';
import { PROFILE } from '../profile.mjs';
import { isGenerated, isTest, flutterFeature } from '../layers.mjs';
import { which } from '../tools.mjs';
import { result } from '../report.mjs';
import { fmtPercent } from '../messages.mjs';
import { step, tail, addedLineSet } from './common.mjs';
import { workerFlags } from '../limits.mjs';

const TH = loadConfig('thresholds');

// ================================================================ Flutter
const flutterDart = (entries) => entries.filter((e) => e.status !== 'D' && e.path.endsWith('.dart') && !isGenerated(e.path) && /^(lib|test)\//.test(e.path));

export function flutterAnalyze(entries, out, budget) {
  const dart = flutterDart(entries);
  if (dart.length === 0) return;
  if (!which('dart')) {
    out.push(result('ferramentas', 'warn', 'tool.missing', { tool: 'dart', impact: 'Análise estática do Flutter não medida.' }));
    return;
  }
  // dart analyze aceita um alvo por vez: arquivo a arquivo até 8; acima disso, lib/ e test/ inteiros.
  const root = repoRoot();
  const targets = dart.length <= 8 ? dart.map((e) => e.path) : [...new Set(dart.map((e) => e.path.split('/')[0]))];
  const byFile = new Map(dart.map((e) => [e.path, e]));
  let legacy = 0;
  let issues = 0;
  let measured = false;
  for (const target of targets) {
    const r = step(out, budget, `dart analyze ${target}`, 'dart', ['analyze', '--format=machine', target], { capMs: 180_000 });
    if (!r) continue;
    measured = true;
    for (const line of r.stdout.split('\n')) {
      const f = line.split('|');
      if (f.length < 8) continue;
      const [severity, , code, file, ln] = f;
      const rel = path.relative(root, file).split(path.sep).join('/');
      const e = byFile.get(rel);
      if (!e) continue;
      const lineNo = Number(ln);
      const onChanged = addedLineSet(e).has(lineNo);
      const msg = f.slice(7).join('|');
      if (severity === 'ERROR' || (severity === 'WARNING' && onChanged)) {
        issues++;
        out.push(result('lint', 'fail', 'lint.issue', { file: rel, line: lineNo, code, msg }));
      } else if (onChanged) {
        issues++;
        out.push(result('lint', 'warn', 'lint.issue', { file: rel, line: lineNo, code, msg }));
      } else legacy++;
    }
  }
  if (!measured) return;
  if (legacy) out.push(result('lint', 'warn', 'lint.legacy', { tool: 'dart analyze', value: legacy, scope: 'Flutter' }));
  if (!issues) out.push(result('lint', 'pass', 'lint.pass', { tool: 'dart analyze', scope: `${dart.length} arquivo(s) Dart` }));
}

export function flutterRelatedTests(entries, out, budget) {
  const dart = flutterDart(entries);
  if (dart.length === 0) return;
  const root = repoRoot();
  // Testes relacionados: features tocadas, dir extra do perfil (código compartilhado) e testes alterados.
  const SHARED_CORE = PROFILE.flutter && PROFILE.flutter.sharedCore;
  if (!which('flutter')) {
    out.push(result('ferramentas', 'warn', 'tool.missing', { tool: 'flutter', impact: 'Testes do Flutter não executados.' }));
    return;
  }
  const targetsTest = new Set();
  const features = new Set();
  for (const e of dart) {
    if (isTest(e.path)) { if (e.path.endsWith('_test.dart')) targetsTest.add(e.path); continue; }
    const f = flutterFeature(e.path);
    if (f) features.add(f);
    else if (SHARED_CORE && new RegExp(SHARED_CORE.applies).test(e.path) && fs.existsSync(path.join(root, SHARED_CORE.testDir))) targetsTest.add(SHARED_CORE.testDir);
  }
  for (const f of features) {
    const dir = `test/features/${f}`;
    if (fs.existsSync(path.join(root, dir))) targetsTest.add(dir);
    else out.push(result('testes', 'warn', 'tests.missing', { scope: f }));
  }
  if (targetsTest.size === 0) {
    out.push(result('testes', 'warn', 'tests.none', { scope: 'Flutter' }));
    return;
  }
  const r = step(out, budget, 'flutter test', 'flutter', ['test', '--no-pub', ...workerFlags().flutter, '-r', 'expanded', ...targetsTest], { capMs: 600_000 });
  if (!r) return;
  const detail = [...targetsTest].join(', ');
  out.push(r.code === 0
    ? result('testes', 'pass', 'tests.pass', { scope: 'Flutter', detail })
    : result('testes', 'fail', 'tests.fail', { scope: 'Flutter', detail, tail: tail(r.stdout + r.stderr) }));
}

function parseLcov(file) {
  const cov = new Map();
  let current = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('SF:')) { current = line.slice(3).trim(); cov.set(current, new Map()); }
    else if (line.startsWith('DA:') && current) {
      const [ln, hits] = line.slice(3).split(',');
      cov.get(current).set(Number(ln), Number(hits));
    }
  }
  return cov;
}

/** Cobertura das linhas adicionadas (só linhas executáveis presentes no LCOV). */
export function diffCoverage(entries, lcov, root, scope, limit) {
  let exec = 0;
  let covered = 0;
  const missing = [];
  const out = [];
  for (const e of entries) {
    const abs = path.join(root, e.path);
    const lines = lcov.get(e.path) ?? lcov.get(abs);
    if (!lines) {
      // Nenhum teste carrega o arquivo: sem linhas executáveis conhecidas, não entra na porcentagem.
      if (e.added.some((a) => a.text.trim())) out.push(result('cobertura-diff', 'warn', 'diffcov.untested', { file: e.path }));
      continue;
    }
    for (const a of e.added) {
      if (!lines.has(a.line)) continue;
      exec++;
      if (lines.get(a.line) > 0) covered++;
      else if (missing.length < 10) missing.push(`${e.path}:${a.line}`);
    }
  }
  if (exec === 0) return [...out, result('cobertura-diff', 'pass', 'diffcov.empty', { scope })];
  const ratio = covered / exec;
  const p = { scope, value: fmtPercent(ratio), limit: `${limit} %`, lines: missing.join(', ') };
  return [...out, ratio * 100 >= limit ? result('cobertura-diff', 'pass', 'diffcov.pass', p) : result('cobertura-diff', 'fail', 'diffcov.fail', p)];
}

export function flutterFull(entries, out, budget) {
  const libChanged = entries.filter((e) => e.status !== 'D' && /^lib\/.*\.dart$/.test(e.path) && !isGenerated(e.path));
  const anyDart = entries.some((e) => e.path.endsWith('.dart') || e.path === 'pubspec.yaml');
  if (!anyDart) return;
  if (!which('flutter')) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcov-'));
  try {
    const lcovPath = path.join(tmp, 'lcov.info');
    const r = step(out, budget, 'flutter test --coverage', 'flutter', ['test', '--no-pub', ...workerFlags().flutter, '--coverage', `--coverage-path=${lcovPath}`], { capMs: 900_000 });
    if (!r) return;
    out.push(r.code === 0
      ? result('testes', 'pass', 'tests.pass', { scope: 'Flutter (suíte completa)', detail: 'flutter test' })
      : result('testes', 'fail', 'tests.fail', { scope: 'Flutter (suíte completa)', detail: 'flutter test', tail: tail(r.stdout + r.stderr) }));
    if (fs.existsSync(lcovPath) && libChanged.length) {
      out.push(...diffCoverage(libChanged, parseLcov(lcovPath), repoRoot(), 'Flutter', TH.diffCoverage.flutter));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── fronteiras e cobertura de features (varredura completa do relatório) ──────────────
const RE_IMPORT_DART = /^\s*(?:import|export)\s+['"]([^'"]+)['"]/gm;

/** Import proibido pela fronteira da camada (domain/data/shared do Flutter). */
function importProibido(u, camada) {
  const internal = u.startsWith('package:fluxo/') || !u.includes(':');
  const p = u.replace(/^package:fluxo\//, '');
  if (camada.domain) {
    return /^package:(cloud_firestore|firebase_[a-z_]+)\//.test(u)
      || (/^package:flutter\//.test(u) && u !== 'package:flutter/foundation.dart')
      || (internal && /(^|\/)(data|presentation)\//.test(p));
  }
  if (camada.data) return internal && /(^|\/)presentation\//.test(p);
  return camada.shared && internal && /(^|\/)features\//.test(p);
}

/** Violações de fronteira nos imports das camadas domain/data/shared do Flutter. */
function violacoesDeImportacao(files, root) {
  const violations = [];
  for (const f of files) {
    if (!f.endsWith('.dart') || isGenerated(f)) continue;
    const camada = {
      domain: /^lib\/features\/[^/]+\/domain\//.test(f),
      data: /^lib\/features\/[^/]+\/data\//.test(f),
      shared: /^lib\/(shared|core)\//.test(f),
    };
    if (!camada.domain && !camada.data && !camada.shared) continue;
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const mm of text.matchAll(RE_IMPORT_DART)) {
      if (importProibido(mm[1], camada)) violations.push(`${f} → ${mm[1]}`);
    }
  }
  return violations;
}

/** Fronteiras de arquitetura + fallbacks proibidos de API (REPROVADO se houver). */
export function flutterFronteiras(files, root, out, m) {
  const violations = violacoesDeImportacao(files, root);
  m.boundaries = violations.length;
  out.push(violations.length
    ? result('fronteiras', 'fail', 'report.boundaries', { value: violations.length, top: violations.slice(0, 3).join('; ') })
    : result('fronteiras', 'pass', 'report.boundariesNone', {}));

  let fallbacks = 0;
  for (const f of files) if (/^lib\/.*\.dart$/.test(f)) fallbacks += countMatches(fs.readFileSync(path.join(root, f), 'utf8'), /API fallback to Firestore/g);
  out.push(result('fallback-api', fallbacks ? 'fail' : 'pass', 'report.fallbacks', { value: fallbacks }));
}

/** Features Flutter sem nenhum teste — só quando há projeto Flutter na árvore (readdirSync seguro). */
export function flutterFeaturesSemTestes(files, root, out, m) {
  const featuresDir = path.join(root, 'lib/features');
  if (!fs.existsSync(featuresDir)) return;
  const features = fs.readdirSync(featuresDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const untested = features.filter((f) => !files.some((x) => x.startsWith(`test/features/${f}/`) && x.endsWith('_test.dart')));
  m.untested = untested.length;
  out.push(untested.length
    ? result('testes', 'fail', 'report.featuresNoTests', { value: untested.length, total: features.length, list: untested.join(', ') })
    : result('testes', 'pass', 'report.featuresAllTested', { total: features.length }));
}
