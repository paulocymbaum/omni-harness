import { loadConfig, LEVELS, maxLevel, countMatches } from './util.mjs';
import { PROFILE } from './profile.mjs';
import { matchAny } from './glob.mjs';
import { layerOf, isTest, isSource } from './layers.mjs';
import { removedExports } from './gates/fast.mjs';
import { jobFlightSignals } from './cost-job.mjs';
import { t, levelLabel, tierLabel } from './messages.mjs';

// Matriz de risco do projeto hospedeiro (perfil). Fallback: config/risk-matrix.json legado;
// host novo sem nenhum dos dois = matriz vazia (gates de risco apenas registram, não inventam).
const RISK_LEGACY = (() => {
  try { return loadConfig('risk-matrix'); } catch {
    return { levels: ['baixo', 'medio', 'alto', 'critico'], ignoreGlobs: [], breakage: [], cost: [] };
  }
})();
const MATRIX = PROFILE.riskMatrix || RISK_LEGACY;
const COSTS = loadConfig('cost-table');

const bump = (level) => LEVELS[Math.min(LEVELS.length - 1, LEVELS.indexOf(level) + 1)];
const tierForLevel = (level) => ({ baixo: 'rapido', medio: 'rotina', alto: 'completo', critico: 'completo' })[level];

class Axis {
  constructor() { this.level = 'baixo'; this.reasons = new Map(); }
  raise(level, reason, file) {
    this.level = maxLevel(this.level, level);
    if (!this.reasons.has(reason)) this.reasons.set(reason, { level, files: new Set() });
    const r = this.reasons.get(reason);
    r.level = maxLevel(r.level, level);
    if (file) r.files.add(file);
  }
  list() {
    return [...this.reasons.entries()]
      .sort((a, b) => LEVELS.indexOf(b[1].level) - LEVELS.indexOf(a[1].level))
      .map(([reason, r]) => {
        const files = [...r.files];
        const shown = files.slice(0, 3).join(', ') + (files.length > 3 ? ` +${files.length - 3}` : '');
        return { level: r.level, text: files.length ? `${reason} (${shown})` : reason };
      });
  }
}

// ------------------------------------------------------------ capacidade (instâncias)
const MIN_RE = /(?:--min-instances[= ]|min_instance_count\s*=\s*|minScale["']?\s*[:=]\s*["']?|\bmin[-_]?instances["']?\s*[:=]\s*["']?|\bminInstances\s*[:=]\s*)(\d+)/gi;
const MAX_RE = /(?:--max-instances[= ]|max_instance_count\s*=\s*|maxScale["']?\s*[:=]\s*["']?|\bmax[-_]?instances["']?\s*[:=]\s*["']?|\bmaxInstances\s*[:=]\s*)(\d+)/gi;

function sumCaptures(lines, re) {
  let sum = 0;
  let found = false;
  for (const line of lines) {
    // matchAll clona o regex (sem lastIndex compartilhado): sem `new RegExp` por linha (perf).
    for (const m of line.matchAll(re)) { sum += Number(m[1]); found = true; }
  }
  return found ? sum : null;
}

// ------------------------------------------------------------ agendamentos (cron)
function fieldCount(field, min, max) {
  let total = 0;
  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isFinite(step) || step <= 0) return null;
    let lo = min;
    let hi = max;
    if (range !== '*' && range !== '?') {
      if (/^[A-Za-z]{3}$/.test(range)) { total += 1; continue; }
      const [a, b] = range.split('-');
      lo = Number(a);
      hi = b !== undefined ? Number(b) : stepStr ? max : lo;
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    }
    total += Math.floor((hi - lo) / step) + 1;
  }
  return total;
}

/** Execuções por dia de uma expressão cron de 5 campos ou "every N minutes/hours". null se não interpretável. */
export function runsPerDay(expr) {
  const e = expr.trim();
  const every = /^every\s+(\d+)\s+(minute|minutes|hour|hours)$/i.exec(e);
  if (every) return /hour/i.test(every[2]) ? 24 / Number(every[1]) : 1440 / Number(every[1]);
  const f = e.split(/\s+/);
  if (f.length !== 5) return null;
  const minutes = fieldCount(f[0], 0, 59);
  const hours = fieldCount(f[1], 0, 23);
  const dom = fieldCount(f[2], 1, 31);
  const dow = fieldCount(f[4], 0, 6);
  if ([minutes, hours, dom, dow].some((v) => v == null)) return null;
  let dayFactor = 1;
  if (f[2] !== '*' && f[2] !== '?') dayFactor = Math.min(1, dom / 30);
  if (f[4] !== '*' && f[4] !== '?') dayFactor = Math.min(dayFactor, dow / 7);
  return minutes * hours * dayFactor;
}

const SCHEDULE_LINE = /schedule|cron|every\s+\d+\s+(minute|hour)/i;
const CRON_EXPR = /["'`]((?:[\d*?/,\-A-Za-z]+\s+){4}[\d*?/,\-A-Za-z]+|every\s+\d+\s+(?:minutes?|hours?))["'`]/g;

function cronExprs(lines) {
  const out = [];
  for (const line of lines) {
    if (!SCHEDULE_LINE.test(line)) continue;
    for (const m of line.matchAll(CRON_EXPR)) out.push(m[1]);
  }
  return out;
}

const money = (value) => (value == null ? '' : `; ≈ R$ ${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(value)}/mês`);

// ------------------------------------------------------------ classificação
// Regexes da matriz de custo pré-compiladas UMA vez (perf: antes eram `new RegExp` por linha × regra).
const REGRAS_COST = MATRIX.cost.map((r) => ({
  ...r,
  regexes: r.added ? r.added.map((re) => new RegExp(re)) : undefined,
  netRegexes: r.netIncrease ? Object.entries(r.netIncrease).map(([api, re]) => [api, new RegExp(re)]) : undefined,
}));

function costRuleSignals(e, addedText, cost) {
  for (const r of REGRAS_COST) {
    if (r.globs && !matchAny(e.path, r.globs)) continue;
    if (r.regexes && addedText.some((line) => r.regexes.some((re) => re.test(line)))) cost.raise(r.level, r.reason, e.path);
    for (const [api, re] of r.netRegexes ?? []) {
      const delta = countMatches(e.newText, re) - countMatches(e.oldText, re);
      if (delta > 0) cost.raise(r.level, `${r.reason} — ${t('cost.paidApi', { api, delta, file: e.path })}`);
    }
  }
}

function capacitySignals(e, addedText, cost) {
  const minNew = sumCaptures(addedText, MIN_RE);
  const minOld = sumCaptures(e.removed, MIN_RE) ?? 0;
  if (minNew != null && minNew > minOld) {
    const delta = minNew - minOld;
    const monthly = COSTS.cloudRunMinInstancePerMonth == null ? null : delta * COSTS.cloudRunMinInstancePerMonth;
    cost.raise('critico', t('cost.minInstances', { previous: minOld, value: minNew, delta, hours: delta * 730, money: money(monthly) }), e.path);
  }
  const maxNew = sumCaptures(addedText, MAX_RE);
  const maxOld = sumCaptures(e.removed, MAX_RE) ?? 0;
  if (maxNew != null && maxNew > maxOld) cost.raise('alto', t('cost.maxInstances', { previous: maxOld, value: maxNew }), e.path);
}

function cronSignals(e, addedText, cost) {
  const cronAdded = cronExprs(addedText);
  if (!cronAdded.length) return;
  const after = cronAdded.map(runsPerDay);
  const before = cronExprs(e.removed).map(runsPerDay);
  const unknown = cronAdded.filter((_, i) => after[i] == null);
  if (unknown.length) cost.raise('alto', t('cost.cronUnknown', { expr: unknown.join(' | ') }), e.path);
  const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
  const delta = sum(after) - sum(before);
  if (delta <= 0) return;
  const monthly = COSTS.schedulerRunCost == null ? null : delta * 30 * COSTS.schedulerRunCost;
  cost.raise('critico', t('cost.cron', { previous: sum(before), value: sum(after), delta, money: money(monthly) }), e.path);
}

/** Modificadores sobem o eixo de quebra no máximo um nível, somados ou não. */
function applyModifiers(breakage, { sourceLines, layers, testsRemoved }) {
  const mods = MATRIX.modifiers;
  const reasons = [];
  if (LEVELS.indexOf(breakage.level) >= 1) {
    if (sourceLines > mods.maxSourceLines) reasons.push(t('risk.modifier.lines', { value: sourceLines, limit: mods.maxSourceLines }));
    if (layers.size >= mods.maxLayers) reasons.push(t('risk.modifier.layers', { value: layers.size, limit: mods.maxLayers }));
  }
  for (const f of testsRemoved) reasons.push(t('risk.modifier.testsRemoved', { file: f }));
  const bumped = bump(breakage.level);
  for (const reason of reasons) breakage.raise(bumped, reason);
}

/** Quebra de um arquivo; devolve as linhas de código que contam para o modificador de tamanho. */
function breakageSignals(e, breakage) {
  const rule = MATRIX.breakage.find((r) => matchAny(e.path, r.globs));
  if (rule) breakage.raise(rule.level, rule.reason, e.path);
  const removed = removedExports(e);
  if (removed.length) breakage.raise('critico', t('risk.exportRemoved', { names: removed.join(', ') }), e.path);
  return isSource(e.path) || rule ? e.added.length + e.removed.length : 0;
}

/** Sinais de UMA entrada (não-ignore): quebra, custo, camadas e linhas-fonte do modificador. */
function sinaisPorEntrada(e, ctx, breakage, cost) {
  if (isTest(e.path)) {
    if (e.status === 'D') ctx.testsRemoved.push(e.path);
    return 0;
  }
  const layer = layerOf(e.path).id;
  if (!['docs', 'quality', 'outros'].includes(layer)) ctx.layers.add(layer);
  const addedText = e.added.map((a) => a.text);
  ctx.sourceLines += breakageSignals(e, breakage);
  costRuleSignals(e, addedText, cost);
  capacitySignals(e, addedText, cost);
  cronSignals(e, addedText, cost);
  jobFlightSignals(e, addedText, cost, { runsPerDay, money });
  return 0;
}

export function classifyRisk(entries) {
  const breakage = new Axis();
  const cost = new Axis();
  const ctx = { sourceLines: 0, layers: new Set(), testsRemoved: [] };
  for (const e of entries) {
    if (matchAny(e.path, MATRIX.ignoreGlobs)) continue;
    sinaisPorEntrada(e, ctx, breakage, cost);
  }
  applyModifiers(breakage, ctx);
  const level = maxLevel(breakage.level, cost.level);
  return {
    level,
    requiredTier: tierForLevel(level),
    breakage: { level: breakage.level, reasons: breakage.list() },
    cost: { level: cost.level, reasons: cost.list() },
    layers: [...ctx.layers].sort(),
    files: entries.length,
  };
}

export function renderRisk(risk) {
  const axis = (key, a) => t('risk.line', {
    axis: t(`risk.axis.${key}`),
    level: levelLabel(a.level),
    reasons: a.reasons.length ? a.reasons.map((r) => r.text).join('; ') : t('risk.none'),
  });
  return [
    t('risk.summary', { level: levelLabel(risk.level), breakage: levelLabel(risk.breakage.level), cost: levelLabel(risk.cost.level), tier: tierLabel(risk.requiredTier) }),
    `  • ${axis('breakage', risk.breakage)}`,
    `  • ${axis('cost', risk.cost)}`,
  ].join('\n');
}

export function riskReasonsShort(risk) {
  return [...risk.breakage.reasons, ...risk.cost.reasons]
    .filter((r) => r.level === risk.level)
    .map((r) => r.text)
    .slice(0, 3)
    .join('; ');
}
