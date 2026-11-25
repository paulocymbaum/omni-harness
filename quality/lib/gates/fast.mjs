import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, run, countNonBlank, countMatches, repoRoot } from '../util.mjs';
import { PROFILE } from '../profile.mjs';
import { isGenerated, isTest, isSource, languageOf } from '../layers.mjs';
import { lizardCommand, lizardOnText, lizardHalsteadOnText, lizardBatch, which } from '../tools.mjs';
import { result } from '../report.mjs';
import { t } from '../messages.mjs';
import { stripLiterals } from '../sanitize.mjs';
import { secretsGate, optionalChainingGate } from './hygiene.mjs';
import { duplicacaoGateLote } from './duplicacao.mjs';

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
  const lang = languageOf(e.path);
  const ext = e.path.slice(e.path.lastIndexOf('.'));
  const now = lizardOnText(e.newText, ext, lang);
  if (now == null) return unmeasured(e, 'complexidade');
  const before = byName((e.oldText == null ? [] : lizardOnText(e.oldText, ext, lang)) ?? []);
  return julgaComplexity(e, now, before);
}

/** Veredito de complexidade/tamanho-função/params com métricas prontas (sem spawn). */
function julgaComplexity(e, now, before) {
  const cc = TH.functionCc;
  const cfg = { cc, fl: TH.functionNloc, ceilingCc: cc.ceiling[languageOf(e.path)] ?? cc.ceiling.default, paramsLimit: TH.params.limit };
  const out = [];
  for (const [name, f] of byName(now)) out.push(...julgaFuncaoComplexity(e, name, f, before.get(name), cfg));
  if (!out.some((r) => r.gate === 'complexidade')) out.push(result('complexidade', 'pass', 'cc.pass', { file: e.path, limit: cc.target }));
  return out;
}

/** Ratchet por função: cc/nloc com judge e params com aviso só de crescimento. */
function julgaFuncaoComplexity(e, name, f, prev, cfg) {
  const item = { function: name, file: e.path, line: f.start, tolerance: 0 };
  const out = [];
  julgaRatchet(out, 'complexidade', 'cc', { ...item, valor: f.ccn, prevValor: valorDe(prev, 'ccn') }, { ...cfg.cc, ceiling: cfg.ceilingCc });
  julgaRatchet(out, 'tamanho-funcao', 'fnloc', { ...item, valor: f.nloc, prevValor: valorDe(prev, 'nloc') }, { ...cfg.fl, ceiling: cfg.fl.ceiling });
  if (f.params > cfg.paramsLimit && (prev == null || f.params > prev.params)) {
    out.push(result('parametros', 'warn', 'params.warn', { ...item, value: f.params, limit: cfg.paramsLimit }));
  }
  return out;
}

const valorDe = (prev, campo) => (prev != null ? prev[campo] : undefined);

/** 1 métrica de ratchet: judge + resultado (item = { name, file, line, tolerance, valor, prevValor }; regra = cfg + ceiling). */
function julgaRatchet(out, gate, prefixo, item, regra) {
  const v = judge(item.valor, item.prevValor, regra.target, regra.ceiling, regra.legacyTolerance);
  if (!v) return;
  item.value = item.valor;
  item.previous = item.prevValor;
  item.limit = v[2];
  out.push(result(gate, v[0], `${prefixo}.${v[1]}`, item));
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
  const before = byName((e.oldText == null ? [] : lizardHalsteadOnText(e.oldText, ext, lang)) ?? []);
  return julgaHalstead(e, now, before);
}

/** Veredito de volume/dificuldade Halstead com métricas prontas (sem spawn). */
function julgaHalstead(e, now, before) {
  const hv = TH.halsteadVolume;
  const out = [];
  for (const [name, f] of byName(now)) {
    if (f.hVolume != null) out.push(...julgaParHalstead(e, name, f, before.get(name)));
  }
  if (!out.some((r) => r.gate === 'halstead-volume')) out.push(result('halstead-volume', 'pass', 'hv.pass', { file: e.path, limit: hv.target }));
  return out;
}

/** Par volume+dificuldade de uma função contra os thresholds. */
function julgaParHalstead(e, name, f, prev) {
  const item = { function: name, file: e.path, line: f.start, tolerance: TH.halsteadVolume.legacyTolerance };
  const out = [];
  julgaRatchet(out, 'halstead-volume', 'hv', { ...item, valor: f.hVolume, prevValor: valorDe(prev, 'hVolume') }, TH.halsteadVolume);
  julgaRatchet(out, 'halstead-difficulty', 'hd', { ...item, valor: f.hDifficulty, prevValor: valorDe(prev, 'hDifficulty') }, TH.halsteadDifficulty);
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

/** Todos os gates rápidos de um arquivo (caminho unitário — hooks pós-edição de 1 arquivo). */
export function fastGates(e) {
  if (e.status === 'D' || isGenerated(e.path)) return [];
  return [
    ...sizeGate(e), ...complexityGate(e), ...halsteadGate(e), ...formatGate(e),
    ...boundaryGate(e), ...suppressionGate(e), ...fallbackGate(e), ...exportsGate(e),
    ...secretsGate(e), ...optionalChainingGate(e),
  ];
}

// ---------------------------------------------------------------- lote do tier rápido (P0)
const ehAlvoLizard = (e) => isSource(e.path) && !isTest(e.path) && e.newText != null;

/** Alguma função acima de algum alvo? Só esses arquivos precisam do oldText (ratchet exato). */
function suspeitoDeRatchet(fns) {
  const cc = TH.functionCc;
  const fl = TH.functionNloc;
  const hv = TH.halsteadVolume;
  const hd = TH.halsteadDifficulty;
  return fns.some((f) => f.ccn > cc.target || f.nloc > fl.target || f.params > TH.params.limit
    || (f.hVolume != null && f.hVolume > hv.target) || (f.hDifficulty != null && f.hDifficulty > hd.target));
}

/** fastGates em LOTE: gates puros por arquivo + lizard/dart format agregados (1 spawn por chunk). */
export function batchFastGates(live) {
  const out = [];
  for (const e of live) out.push(...gatesPuros(e));
  const alvo = live.filter(ehAlvoLizard);
  const lizard = lizardGates(alvo);
  out.push(...lizard.out);
  out.push(...duplicacaoGateLote(alvo, lizard.nowC));
  out.push(...formatGatesBatch(live));
  return out;
}

const gatesPuros = (e) => [...sizeGate(e), ...boundaryGate(e), ...suppressionGate(e), ...fallbackGate(e), ...exportsGate(e), ...secretsGate(e), ...optionalChainingGate(e)];

/** Lizard de todo o lote: 4 spawns por chunk (cc raw/san + halstead raw/san) + old só dos suspeitos. Devolve { out, nowC } — nowC é reusado pelo gate de duplicação (sem spawn extra). */
function lizardGates(alvo) {
  if (!alvo.length || !lizardCommand()) return { out: [], nowC: null };
  const items = alvo.map((e) => ({ path: e.path, text: e.newText }));
  const nowC = lizardBatch(items, languageOf);
  const nowH = lizardBatch(items, languageOf, { halstead: true });
  const suspeitos = alvo.filter((e) => suspeitoNoLote(nowC, nowH, e)).filter((e) => e.oldText != null);
  const olds = suspeitos.map((e) => ({ path: e.path, text: e.oldText }));
  const beforeC = suspeitos.length ? lizardBatch(olds, languageOf) ?? new Map() : new Map();
  const beforeH = suspeitos.length ? lizardBatch(olds, languageOf, { halstead: true }) ?? new Map() : new Map();
  return { out: julgaLoteLizard(alvo, nowC, nowH, beforeC, beforeH), nowC };
}

/** Veredito por arquivo; chunk não medido vira lizard.unmeasured (nunca silêncio). */
function julgaLoteLizard(alvo, nowC, nowH, beforeC, beforeH) {
  const out = [];
  for (const e of alvo) {
    const nc = nowC ? nowC.get(e.path) : null;
    const nh = nowH ? nowH.get(e.path) : null;
    if (nc == null) out.push(...unmeasured(e, 'complexidade'));
    else out.push(...julgaComplexity(e, nc, byName(beforeC.get(e.path) ?? [])));
    if (nh == null) out.push(...unmeasured(e, 'halstead-volume'));
    else out.push(...julgaHalstead(e, nh, byName(beforeH.get(e.path) ?? [])));
  }
  return out;
}

function suspeitoNoLote(nowC, nowH, e) {
  const nc = nowC ? nowC.get(e.path) : null;
  const nh = nowH ? nowH.get(e.path) : null;
  return (nc != null && suspeitoDeRatchet(nc)) || (nh != null && suspeitoDeRatchet(nh));
}

/** Formatação Dart em lote: 1 spawn por chunk de 100 paths; stdin individual só nos reprovados/divergentes. */
export function formatGatesBatch(live) {
  const alvo = live.filter((e) => e.path.endsWith('.dart') && e.newText != null && !isGenerated(e.path));
  if (!alvo.length || !which('dart')) return [];
  const out = [];
  for (let i = 0; i < alvo.length; i += 100) formatChunkDart(alvo.slice(i, i + 100), out);
  return out;
}

function formatChunkDart(chunk, out) {
  const noDisco = chunk.filter(discoIgualAoDiff);
  const divergentes = chunk.filter((e) => !noDisco.includes(e));
  if (noDisco.length) {
    const r = run('dart', ['format', '--output=none', '--set-exit-if-changed', ...noDisco.map((e) => e.path)], { cwd: repoRoot(), timeoutMs: 60_000 });
    if (r.missing || r.timedOut || (r.code !== 0 && r.code !== 1)) divergentes.push(...noDisco);
    else if (r.code === 1) divergentes.push(...noDisco); // algum(s) mudaria(m): classificar individual (fail vs legacy)
    else for (const e of noDisco) out.push(result('formato', 'pass', 'format.pass', { file: e.path }));
  }
  for (const e of divergentes) out.push(...formatGate(e));
}

/** O texto no disco é igual ao newText do diff? Divergente cai no caminho stdin (fiel ao diff). */
function discoIgualAoDiff(e) {
  try { return fs.readFileSync(path.join(repoRoot(), e.path), 'utf8') === e.newText; } catch { return false; }
}
