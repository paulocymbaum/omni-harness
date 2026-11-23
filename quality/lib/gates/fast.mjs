import { loadConfig, run, countNonBlank, countMatches, repoRoot } from '../util.mjs';
import { PROFILE } from '../profile.mjs';
import { isGenerated, isTest, isSource, languageOf } from '../layers.mjs';
import { lizardCommand, lizardOnText, lizardHalsteadOnText, which } from '../tools.mjs';
import { result } from '../report.mjs';
import { t } from '../messages.mjs';
import { stripLiterals } from '../sanitize.mjs';
import { secretsGate, optionalChainingGate } from './hygiene.mjs';

const TH = loadConfig('thresholds');

// ---------------------------------------------------------------- tamanho de arquivo
export function sizeGate(e) {
  if (!isSource(e.path) || isTest(e.path) || e.newText == null) return [];
  const { limit, tolerance } = TH.fileNloc;
  const value = countNonBlank(e.newText);
  const previous = e.oldText == null ? 0 : countNonBlank(e.oldText);
  const p = { file: e.path, value, previous, limit, tolerance };
  if (value <= limit) return [result('tamanho', 'pass', 'size.pass', p)];
  const over = value - Math.max(limit, previous);
  if (over <= 0) return [result('tamanho', 'pass', 'size.passLegacy', p)];
  if (over <= tolerance) return [result('tamanho', 'warn', 'size.warn', { ...p, delta: value - previous })];
  return [result('tamanho', 'fail', 'size.fail', p)];
}

// ---------------------------------------------------------------- complexidade / tamanho de função
function byName(fns) {
  const m = new Map();
  for (const f of fns ?? []) {
    const cur = m.get(f.name);
    if (!cur) m.set(f.name, { ...f });
    else { cur.ccn = Math.max(cur.ccn, f.ccn); cur.nloc = Math.max(cur.nloc, f.nloc); cur.params = Math.max(cur.params, f.params); }
  }
  return m;
}

/** Regra de ratchet por função: nova acima do teto reprova; legada só reprova se piorar além da tolerância. */
function judge(value, prev, target, ceiling, tol) {
  if (value <= target) return null;
  if (prev != null && value <= prev) return null;
  if (prev == null) return value > ceiling ? ['fail', 'failNew', ceiling] : ['warn', 'warn', target];
  if (value <= ceiling) return ['warn', 'warn', target];
  if (prev > ceiling && value - prev <= tol) return ['warn', 'warnLegacy', ceiling];
  return ['fail', 'failGrew', ceiling];
}

/** O lizard existe mas não conseguiu medir (timeout ou erro): NÃO pode ser pulado em silêncio. */
function unmeasured(e, gate) {
  return [result(gate, 'warn', 'lizard.unmeasured', { file: e.path })];
}

export function complexityGate(e) {
  if (!isSource(e.path) || isTest(e.path) || e.newText == null) return [];
  if (!lizardCommand()) return [];
  const ext = e.path.slice(e.path.lastIndexOf('.'));
  const lang = languageOf(e.path);
  const now = lizardOnText(e.newText, ext, lang);
  if (now == null) return unmeasured(e, 'complexidade');
  const before = byName((e.oldText == null ? [] : lizardOnText(e.oldText, ext, lang)) ?? []);
  const cc = TH.functionCc;
  const ceilingCc = cc.ceiling[lang] ?? cc.ceiling.default;
  const fl = TH.functionNloc;
  const out = [];
  for (const [name, f] of byName(now)) {
    const prev = before.get(name);
    const base = { function: name, file: e.path, line: f.start, tolerance: 0 };
    const c = judge(f.ccn, prev?.ccn, cc.target, ceilingCc, cc.legacyTolerance);
    if (c) out.push(result('complexidade', c[0], `cc.${c[1]}`, { ...base, value: f.ccn, previous: prev?.ccn, limit: c[2], tolerance: cc.legacyTolerance }));
    const n = judge(f.nloc, prev?.nloc, fl.target, fl.ceiling, fl.legacyTolerance);
    if (n) out.push(result('tamanho-funcao', n[0], `fnloc.${n[1]}`, { ...base, value: f.nloc, previous: prev?.nloc, limit: n[2], tolerance: fl.legacyTolerance }));
    if (f.params > TH.params.limit && (prev == null || f.params > prev.params)) {
      out.push(result('parametros', 'warn', 'params.warn', { ...base, value: f.params, limit: TH.params.limit }));
    }
  }
  if (!out.some((r) => r.gate === 'complexidade')) out.push(result('complexidade', 'pass', 'cc.pass', { file: e.path, limit: cc.target }));
  return out;
}

// ---------------------------------------------------------------- formatação (Dart)
function dartFormatState(text, file) {
  const r = run('dart', ['format', '--output=none', '--set-exit-if-changed', `--stdin-name=${file}`], {
    input: text, cwd: repoRoot(), timeoutMs: 30_000,
  });
  if (r.missing || r.timedOut) return 'unknown';
  if (r.code === 0) return 'ok';
  if (r.code === 1) return 'changed';
  return 'syntax';
}

export function formatGate(e) {
  if (!e.path.endsWith('.dart') || isGenerated(e.path) || e.newText == null || !which('dart')) return [];
  const now = dartFormatState(e.newText, e.path);
  if (now === 'unknown') return [];
  if (now === 'ok') return [result('formato', 'pass', 'format.pass', { file: e.path })];
  if (now === 'syntax') return [result('formato', 'warn', 'format.syntax', { file: e.path })];
  const before = e.oldText == null ? 'ok' : dartFormatState(e.oldText, e.path);
  if (before === 'ok') return [result('formato', 'fail', 'format.fail', { file: e.path })];
  return [result('formato', 'pass', 'format.passLegacy', { file: e.path })];
}

// ---------------------------------------------------------------- fronteiras de arquitetura
const DART_IMPORT = /^\s*(?:import|export)\s+['"]([^'"]+)['"]/gm;
const TS_IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
// Package Dart interno do projeto hospedeiro (perfil; ex.: package:fluxo/).
const APP_PACKAGE = PROFILE.dartPackage || 'package:app/';

export function imports(text, dart) {
  const out = [];
  if (text == null) return out;
  const re = new RegExp((dart ? DART_IMPORT : TS_IMPORT).source, 'gm');
  let m;
  while ((m = re.exec(text))) {
    const at = m.index + m[0].lastIndexOf(m[1]);
    out.push({ uri: m[1], line: text.slice(0, at).split('\n').length });
  }
  return out;
}

const internal = (u) => u.startsWith(APP_PACKAGE) || !u.includes(':');
const internalPath = (u) => (u.startsWith(APP_PACKAGE) ? u.slice(APP_PACKAGE.length) : u);

// Regras declarativas do perfil: { rule, dart, applies, bad[], internalBad[] }.
// bad testa o URI bruto do import; internalBad testa o caminho interno (pós-strip do package)
// e só quando o import é interno. O fallback legado morre na R5 (hosts ainda sem perfil).
const BOUNDARIES_LEGACY = [
  {
    rule: 'rule.domainInfra', dart: true, applies: '^lib/features/[^/]+/domain/',
    bad: ['^package:(cloud_firestore|firebase_[a-z_]+)/', '^package:flutter/(?!foundation\\.dart$)'],
    internalBad: ['(^|/)(data|presentation)/'],
  },
  { rule: 'rule.dataPresentation', dart: true, applies: '^lib/features/[^/]+/data/', internalBad: ['(^|/)presentation/'] },
  { rule: 'rule.sharedFeatures', dart: true, applies: '^lib/(shared|core)/', internalBad: ['(^|/)features/'] },
  {
    rule: 'rule.routerThin', dart: false, applies: '^OCR_webscraper_crawler/apps/router/src/',
    bad: ['^@menu-extractor/(ocr|scraper|structurer)(/|$)', '^cheerio$', '^@google-cloud/(documentai|vertexai)', '^@google/genai', '^firecrawl', '(^|/)packages/(ocr|scraper|structurer)/'],
  },
  { rule: 'rule.adminFirestore', dart: false, applies: '^admin-web/src/', bad: ['^firebase/firestore(/|$)', '^@firebase/firestore$'] },
];

export function compileRules(defs) {
  return defs.map((d) => {
    const appliesRe = new RegExp(d.applies);
    const badRes = (d.bad || []).map((re) => new RegExp(re));
    const internalRes = (d.internalBad || []).map((re) => new RegExp(re));
    return {
      rule: d.rule,
      dart: !!d.dart,
      applies: (f) => appliesRe.test(f),
      bad: (u) => badRes.some((x) => x.test(u))
        || (internalRes.length > 0 && internal(u) && internalRes.some((x) => x.test(internalPath(u)))),
    };
  });
}

export const RULES = compileRules(
  PROFILE.boundaries && PROFILE.boundaries.length > 0 ? PROFILE.boundaries : BOUNDARIES_LEGACY,
);

export function boundaryGate(e) {
  if (e.newText == null || isGenerated(e.path)) return [];
  const rules = RULES.filter((r) => r.applies(e.path) && (r.dart ? e.path.endsWith('.dart') : /\.(t|j)sx?$|\.m?js$/.test(e.path)));
  if (rules.length === 0) return [];
  const dart = e.path.endsWith('.dart');
  const oldCount = new Map();
  for (const i of imports(e.oldText, dart)) oldCount.set(i.uri, (oldCount.get(i.uri) ?? 0) + 1);
  const out = [];
  for (const i of imports(e.newText, dart)) {
    const rule = rules.find((r) => r.bad(i.uri));
    if (!rule) continue;
    const left = oldCount.get(i.uri) ?? 0;
    if (left > 0) { oldCount.set(i.uri, left - 1); continue; } // já existia no HEAD: legado, não é novo
    out.push(result('fronteiras', 'fail', 'boundary.fail', { file: e.path, line: i.line, rule: t(rule.rule), import: i.uri }));
  }
  return out.length ? out : [result('fronteiras', 'pass', 'boundary.pass', { file: e.path })];
}

// ---------------------------------------------------------------- supressões
// Diretivas reais: o marcador precisa abrir o comentário/atributo, como as ferramentas exigem.
export const SUPPRESSIONS = {
  '// ignore:': /\/\/\s*ignore:/, 'ignore_for_file': /\/\/\s*ignore_for_file:/, 'eslint-disable': /(\/\/|\/\*)\s*eslint-disable/,
  '@ts-ignore': /\/\/\s*@ts-ignore/, '@ts-expect-error': /\/\/\s*@ts-expect-error/, '@ts-nocheck': /\/\/\s*@ts-nocheck/,
  '#pragma warning disable': /#pragma\s+warning\s+disable/, 'ExcludeFromCodeCoverage': /\[\s*(assembly:\s*)?ExcludeFromCodeCoverage/,
  'SuppressMessage': /\[\s*(assembly:\s*)?SuppressMessage/, '# noqa': /#\s*noqa/, '# type: ignore': /#\s*type:\s*ignore/,
  'c8/istanbul ignore': /(\/\/|\/\*)\s*(c8|istanbul|v8)\s+ignore/, 'coverage:ignore': /\/\/\s*coverage:ignore/,
};

export function suppressionGate(e) {
  if (!isSource(e.path) || e.newText == null) return [];
  // Só comentários/atributos reais: marcadores dentro de strings não contam.
  const lang = languageOf(e.path);
  const now = stripLiterals(e.newText, lang);
  const before = stripLiterals(e.oldText, lang);
  let value = 0;
  const kinds = [];
  for (const [kind, re] of Object.entries(SUPPRESSIONS)) {
    const delta = countMatches(now, re) - countMatches(before, re);
    if (delta > 0) { value += delta; kinds.push(kind); }
  }
  return value > 0
    ? [result('supressoes', 'warn', 'suppress.warn', { file: e.path, value, kinds: kinds.join(', ') })]
    : [result('supressoes', 'pass', 'suppress.pass', { file: e.path })];
}

// ---------------------------------------------------------------- Halstead
export function halsteadGate(e) {
  if (!isSource(e.path) || isTest(e.path) || e.newText == null) return [];
  if (!lizardCommand()) return [];
  const ext = e.path.slice(e.path.lastIndexOf('.'));
  const lang = languageOf(e.path);
  const now = lizardHalsteadOnText(e.newText, ext, lang);
  if (now == null) return unmeasured(e, 'halstead-volume');
  if (now.length === 0) return []; // arquivo sem funções: nada a medir
  const before = byName((e.oldText == null ? [] : lizardHalsteadOnText(e.oldText, ext, lang)) ?? []);
  const hv = TH.halsteadVolume;
  const hd = TH.halsteadDifficulty;
  const out = [];
  for (const [name, f] of byName(now)) {
    if (f.hVolume == null) continue;
    const prev = before.get(name);
    const base = { function: name, file: e.path, line: f.start, tolerance: hv.legacyTolerance };
    const v = judge(f.hVolume, prev?.hVolume, hv.target, hv.ceiling, hv.legacyTolerance);
    if (v) out.push(result('halstead-volume', v[0], `hv.${v[1]}`, { ...base, value: Math.round(f.hVolume), previous: prev?.hVolume != null ? Math.round(prev.hVolume) : undefined, limit: v[2] }));
    const d = judge(f.hDifficulty, prev?.hDifficulty, hd.target, hd.ceiling, hd.legacyTolerance);
    if (d) out.push(result('halstead-difficulty', d[0], `hd.${d[1]}`, { ...base, value: Number(f.hDifficulty.toFixed(1)), previous: prev?.hDifficulty != null ? Number(prev.hDifficulty.toFixed(1)) : undefined, limit: d[2] }));
  }
  if (!out.some((r) => r.gate === 'halstead-volume')) out.push(result('halstead-volume', 'pass', 'hv.pass', { file: e.path, limit: hv.target }));
  return out;
}

// ---------------------------------------------------------------- fallback REST → Firestore
const FALLBACK = /API fallback to Firestore/;

export function fallbackGate(e) {
  if (!/^lib\/.*\.dart$/.test(e.path) || e.newText == null) return [];
  const value = countMatches(e.newText, FALLBACK) - countMatches(e.oldText, FALLBACK);
  return value > 0
    ? [result('fallback-api', 'fail', 'fallback.fail', { file: e.path, value })]
    : [result('fallback-api', 'pass', 'fallback.pass', { file: e.path })];
}

// ---------------------------------------------------------------- exports de functions/src/index.ts
export function exportedNames(text) {
  const names = new Set();
  if (!text) return names;
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  for (const m of text.matchAll(/export\s*\*\s*(?:as\s+(\w+)\s+)?from\s*['"]([^'"]+)['"]/g)) names.add(m[1] ?? `* from ${m[2]}`);
  return names;
}

export function removedExports(e) {
  if (e.path !== 'functions/src/index.ts' || e.oldText == null) return [];
  const now = exportedNames(e.newText);
  return [...exportedNames(e.oldText)].filter((n) => !now.has(n));
}

export function exportsGate(e) {
  if (e.path !== 'functions/src/index.ts') return [];
  const removed = removedExports(e);
  return removed.length
    ? [result('exports', 'warn', 'exports.warn', { file: e.path, names: removed.join(', ') })]
    : [result('exports', 'pass', 'exports.pass', { file: e.path })];
}

/** Todos os gates rápidos de um arquivo. */
export function fastGates(e) {
  if (e.status === 'D' || isGenerated(e.path)) return [];
  return [
    ...sizeGate(e), ...complexityGate(e), ...halsteadGate(e), ...formatGate(e),
    ...boundaryGate(e), ...suppressionGate(e), ...fallbackGate(e), ...exportsGate(e),
    ...secretsGate(e), ...optionalChainingGate(e),
  ];
}
