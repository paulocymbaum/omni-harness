#!/usr/bin/env node
// Baseline global do ratchet (QG-002 do board 2026-10-23-board-qualidade).
// Mede contadores estruturais por camada, grava quality/baseline.json (--write) e
// reprova (--check) qualquer métrica que PIOROU em relação ao baseline gravado.
// O baseline só desce: melhora exige --write para ser registrada (com a saída dizendo isso).
//
// Uso:
//   node quality/baseline.mjs --write [--full]   mede e grava o baseline (--full inclui lizard)
//   node quality/baseline.mjs --check [--full]   compara com o baseline; exit 1 se piorou
//   node quality/baseline.mjs --json             saída em JSON (com --write/--check)
//
// Métricas ratchet (piorou = reprova): maxNloc, filesOverNloc, supressões (por tipo),
// fronteiras Dart/TS (por regra), fallbacks REST→Firestore, features Flutter sem teste,
// complexidade por camada (--full). Report-only: sourceFiles, functionsExports.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  repoRoot, loadConfig, readJson, writeJson, countNonBlank, countMatches,
} from './lib/util.mjs';
import { PROFILE } from './lib/profile.mjs';
import { layerOf, isSource, isTest, isGenerated, languageOf } from './lib/layers.mjs';
import { stripLiterals } from './lib/sanitize.mjs';
import { lizardCommand, lizardOnFiles } from './lib/tools.mjs';
import { exportedNames, RULES, SUPPRESSIONS, imports as fileImports } from './lib/gates/fast.mjs';

const TH = loadConfig('thresholds');
const NLOC_LIMIT = TH.fileNloc.limit;
const BASELINE_FILE = path.join(repoRoot(), 'quality', 'baseline.json');
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.dart_tool', '.gradle', '.idea', '.firebase', '.config', '.cursor',
  'build', 'dist', 'out', 'coverage', 'Pods', 'gradle', '.venv', '__pycache__',
  'functions/lib', 'local_overrides', '.state', 'reports',
]);

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--write') a.write = true;
    else if (k === '--check') a.check = true;
    else if (k === '--full') a.full = true;
    else if (k === '--json') a.json = true;
    else if (k === '--migration-override') {
      a.migration = true;
      const motivo = argv[i + 1];
      if (motivo && !motivo.startsWith('--')) { a.migrationReason = motivo; i++; }
    }
    else if (k === '--help' || k === '-h') a.help = true;
    else a.unknown = k;
  }
  return a;
}

// ── coleta de arquivos ─────────────────────────────────────────────────────────
function walk(dir, root, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      const relDir = path.relative(root, abs);
      if (SKIP_DIRS.has(e.name) || SKIP_DIRS.has(relDir)) continue;
      walk(abs, root, out);
    } else if (e.isFile()) {
      out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

function readText(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

// ── contadores ─────────────────────────────────────────────────────────────────
export function countSuppressions(text, lang) {
  if (!text) return {};
  const stripped = stripLiterals(text, lang);
  const perKind = {};
  for (const [kind, re] of Object.entries(SUPPRESSIONS)) {
    const n = countMatches(stripped, re);
    if (n > 0) perKind[kind] = n;
  }
  return perKind;
}

export function countBoundaryViolations(rel, text) {
  if (!text) return {};
  const rules = RULES.filter(
    (r) => r.applies(rel) && (r.dart ? rel.endsWith('.dart') : /\.(t|j)sx?$|\.m?js$/.test(rel)),
  );
  if (rules.length === 0) return {};
  const dart = rel.endsWith('.dart');
  const perRule = {};
  for (const i of fileImports(text, dart)) {
    const rule = rules.find((r) => r.bad(i.uri));
    if (rule) perRule[rule.rule] = (perRule[rule.rule] ?? 0) + 1;
  }
  return perRule;
}

export function flutterFeaturesWithoutTest(root, dirs) {
  const d = dirs || {};
  const featuresDir = d.features || 'lib/features';
  const testDir = d.tests || 'test/features';
  const dir = path.join(root, ...featuresDir.split('/'));
  if (!fs.existsSync(dir)) return { count: 0, list: [] };
  const list = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((f) => !fs.existsSync(path.join(root, testDir, f)));
  return { count: list.length, list };
}

// ── medição ────────────────────────────────────────────────────────────────────
function sumValues(obj) {
  return Object.values(obj ?? {}).reduce((a, b) => a + b, 0);
}

export function measure(root = repoRoot(), { full = false } = {}) {
  const files = walk(root, root, []);
  const layers = {};
  const layerSourceFiles = new Map();
  const byKind = {};
  const byRule = {};
  let apiFallbacks = 0;
  let functionsExports = null;
  // Métricas com path de projeto vêm do perfil (R1.5); keys do ratchet permanecem as mesmas.
  const M = PROFILE.metrics || {};
  const afFiles = M.apiFallbacks ? new RegExp(M.apiFallbacks.files) : null;
  const afMarker = M.apiFallbacks ? new RegExp(M.apiFallbacks.marker) : null;

  for (const rel of files) {
    if (isGenerated(rel)) continue;
    const text = readText(root, rel);
    if (text == null) continue;
    const layerId = layerOf(rel).id;

    if (isSource(rel) && !isTest(rel)) {
      const L = layers[layerId] ??= { sourceFiles: 0, maxNloc: 0, filesOverNloc: 0, suppressions: 0 };
      L.sourceFiles++;
      const nloc = countNonBlank(text);
      if (nloc > L.maxNloc) L.maxNloc = nloc;
      if (nloc > NLOC_LIMIT) L.filesOverNloc++;
      const perKind = countSuppressions(text, languageOf(rel));
      L.suppressions += sumValues(perKind);
      for (const [k, n] of Object.entries(perKind)) byKind[k] = (byKind[k] ?? 0) + n;
      if (full) {
        if (!layerSourceFiles.has(layerId)) layerSourceFiles.set(layerId, []);
        layerSourceFiles.get(layerId).push(rel);
      }
    }

    for (const [rule, n] of Object.entries(countBoundaryViolations(rel, text))) {
      byRule[rule] = (byRule[rule] ?? 0) + n;
    }
    if (afFiles && afMarker && afFiles.test(rel)) apiFallbacks += countMatches(text, afMarker);
  }

  if (M.exportsEntry) {
    const indexText = readText(root, M.exportsEntry);
    if (indexText != null) functionsExports = exportedNames(indexText).size;
  }
  const noTest = flutterFeaturesWithoutTest(root, { features: M.featuresDir, tests: M.featuresTestDir });

  if (full) {
    const hasLizard = Boolean(lizardCommand());
    for (const [layerId, list] of layerSourceFiles) {
      const L = layers[layerId];
      if (!hasLizard) { L.cc = null; continue; }
      const fns = lizardOnFiles(root, list, languageOf) ?? [];
      let maxCc = 0; let overCc = 0; let maxFnNloc = 0;
      for (const f of fns) {
        if (f.ccn > maxCc) maxCc = f.ccn;
        if (f.nloc > maxFnNloc) maxFnNloc = f.nloc;
        const ceiling = TH.functionCc.ceiling[languageOf(f.file)] ?? TH.functionCc.ceiling.default;
        if (f.ccn > ceiling) overCc++;
      }
      L.cc = { maxCc, functionsOverCc: overCc, maxFnNloc };
    }
    for (const L of Object.values(layers)) if (!('cc' in L)) L.cc = null;
  }

  return {
    _comment: 'Baseline do ratchet global (QUALITY.md §3/§6). Gere com: node quality/baseline.mjs --write. Só desce; nunca altere à mão para fazer um gate passar.',
    generated: new Date().toISOString().slice(0, 10),
    layers,
    repo: {
      suppressions: sumValues(byKind),
      suppressionsByKind: byKind,
      dartBoundaries: sumValues(byRule),
      dartBoundariesByRule: byRule,
      apiFallbacks,
      functionsExports,
      flutterFeaturesNoTest: noTest.count,
      flutterFeaturesNoTestList: noTest.list,
    },
  };
}

// ── comparação ─────────────────────────────────────────────────────────────────
const REPORT_ONLY = new Set(['sourceFiles', 'functionsExports', 'flutterFeaturesNoTestList']);
const RATCHET_KEYS = new Set([
  'maxNloc', 'filesOverNloc', 'suppressions', 'dartBoundaries', 'apiFallbacks',
  'flutterFeaturesNoTest', 'maxCc', 'functionsOverCc', 'maxFnNloc',
]);

function isRatchetKey(key, pathStr) {
  if (REPORT_ONLY.has(key)) return false;
  return RATCHET_KEYS.has(key) || pathStr.includes('ByKind') || pathStr.includes('ByRule');
}

/** Registra "sem valor no baseline" quando a métrica existia mas não pôde ser medida. */
function missingBaseline(out, before, beforeVal, pathStr) {
  if (before == null || beforeVal != null) return;
  out.skipped.push({ metric: pathStr, reason: 'sem valor no baseline' });
}

/** Compara uma folha numérica com o baseline e registra o veredito em `out`. */
function judgeLeaf(out, before, key, pathStr, afterVal) {
  if (!isRatchetKey(key, pathStr) || typeof afterVal !== 'number') return;
  const beforeVal = before?.[key];
  if (typeof beforeVal !== 'number') {
    missingBaseline(out, before, beforeVal, pathStr);
    return;
  }
  out.checked++;
  if (afterVal > beforeVal) {
    out.regressions.push({ metric: pathStr, before: beforeVal, after: afterVal });
    return;
  }
  if (afterVal < beforeVal) {
    out.improvements.push({ metric: pathStr, before: beforeVal, after: afterVal });
  }
}

export function compare(before, after, prefix = '') {
  const out = { regressions: [], improvements: [], skipped: [], checked: 0 };
  for (const [key, afterVal] of Object.entries(after ?? {})) {
    const pathStr = prefix ? `${prefix}.${key}` : key;
    const isBranch = afterVal !== null && typeof afterVal === 'object';
    if (!isBranch) {
      judgeLeaf(out, before, key, pathStr, afterVal);
      continue;
    }
    const sub = compare(before?.[key], afterVal, pathStr);
    for (const k of ['regressions', 'improvements', 'skipped']) out[k].push(...sub[k]);
    out.checked += sub.checked;
  }
  return out;
}

// ── relatório (pt-BR) ──────────────────────────────────────────────────────────
function label(metric) {
  return metric.replace(/^layers\./, '').replace(/^repo\./, 'repo/');
}

function ccLabel(L) {
  if (L.cc == null) return '';
  return `, CC máx ${L.cc.maxCc}, funções acima do teto ${L.cc.functionsOverCc}`;
}

function renderCheckReport(result, generated) {
  const lines = [`Baseline: quality/baseline.json (gerado em ${generated})`];
  for (const r of result.regressions) {
    lines.push(`❌ REPROVADO [${label(r.metric)}] ${r.before} → ${r.after}. O ratchet global não permite piora; reverta ou melhore na causa.`);
  }
  for (const i of result.improvements) {
    lines.push(`💡 MELHORIA  [${label(i.metric)}] ${i.before} → ${i.after}. Rode node quality/baseline.mjs --write para registrar o ganho.`);
  }
  for (const s of result.skipped) {
    lines.push(`⚠️ ALERTA    [${label(s.metric)}] ${s.reason}; métrica não verificada nesta execução.`);
  }
  lines.push(`Resultado (--check): ${result.checked} métrica(s) em ratchet — ${result.regressions.length} reprovada(s), ${result.improvements.length} melhoria(s), ${result.skipped.length} não verificada(s).`);
  return lines.join('\n');
}

function renderWriteReport(result) {
  const lines = [
    `Baseline gravado em quality/baseline.json (gerado em ${result.generated}).`,
    'O ratchet global só desce: para registrar uma melhoria, rode --write de novo depois do refactor.',
  ];
  for (const [id, L] of Object.entries(result.layers ?? {})) {
    lines.push(`• ${id}: ${L.sourceFiles} arquivo(s) de fonte, maior arquivo ${L.maxNloc} linhas, ${L.filesOverNloc} acima de ${NLOC_LIMIT}, ${L.suppressions} supressão(ões)${ccLabel(L)}`);
  }
  const r = result.repo ?? {};
  lines.push(`• repo: ${r.suppressions} supressão(ões), ${r.dartBoundaries} violação(ões) de fronteira (estoque), ${r.apiFallbacks} fallback(s) REST→Firestore, ${r.functionsExports ?? '—'} export(s) em functions/src/index.ts, ${r.flutterFeaturesNoTest} feature(s) Flutter sem teste`);
  return lines.join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────────
function helpText() {
  return [
    'Uso: node quality/baseline.mjs --write [--full] | --check [--full] [--json] [--migration-override [motivo]]',
    '  --write  mede e grava quality/baseline.json (o ratchet só desce)',
    '  --check  compara a medição atual com o baseline; exit 1 se alguma métrica piorou',
    '  --full   inclui complexidade por função via lizard (lento)',
    '  --migration-override [motivo]  (com --check) modo migração: não compara com o baseline (merge/migração',
    '                                 completa); exit 0 com resultado IGNORADO; o baseline permanece inalterado',
  ].join('\n');
}

function runWrite(args, current) {
  const previous = readJson(BASELINE_FILE, null);
  let regressionNote = '';
  if (previous) {
    const cmp = compare(previous, current);
    if (cmp.regressions.length > 0) {
      regressionNote = ` ATENÇÃO: a medição atual é PIOR que o baseline em ${cmp.regressions.length} métrica(s); o --write desce o ratchet, nunca sobe — esses valores NÃO foram ampliados.`;
    }
  }
  writeJson(BASELINE_FILE, current);
  if (args.json) console.log(JSON.stringify({ wrote: true, baseline: current, regressionNote }, null, 2));
  else console.log(renderWriteReport(current) + regressionNote);
  return 0;
}

function runCheck(args, current) {
  const baseline = readJson(BASELINE_FILE, null);
  if (!baseline || !baseline.layers || !baseline.repo) {
    console.error('Erro de configuração: quality/baseline.json não encontrado ou inválido. Gere primeiro com: node quality/baseline.mjs --write');
    return 2;
  }
  const result = compare(baseline, current);
  if (args.json) console.log(JSON.stringify({ ok: result.regressions.length === 0, ...result }, null, 2));
  else console.log(renderCheckReport(result, baseline.generated ?? '—'));
  return result.regressions.length > 0 ? 1 : 0;
}

// Modo migração (--migration-override): num merge/migração completa o ratchet de
// baseline reprova por construção (todo o estoque chega de uma vez), então a
// comparação é IGNORADA em vez de reprovar. O baseline não é alterado.
function runCheckMigration(args) {
  const reason = args.migrationReason || 'merge/migração completa';
  if (args.json) {
    console.log(JSON.stringify({ ok: true, migration: true, reason, checked: 0, regressions: [], improvements: [], skipped: [{ metric: 'ratchet-global', reason: 'modo migração' }] }, null, 2));
  } else {
    console.log(`⏭️ IGNORADO [ratchet-global] modo migração ativo (motivo: ${reason}) — a comparação com o baseline não se aplica a merge/migração completa. O baseline permanece inalterado; rode --check sem a flag para validar incrementos.`);
  }
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.unknown || (!args.write && !args.check)) {
    console.log(helpText());
    return args.unknown ? 2 : 0;
  }
  if (args.check && args.migration) return runCheckMigration(args);
  const current = measure(repoRoot(), { full: Boolean(args.full) });
  return args.write ? runWrite(args, current) : runCheck(args, current);
}

// Só executa como CLI; a importação pelo teste não pode derrubar o runner.
const __isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (__isMain) process.exit(main());



