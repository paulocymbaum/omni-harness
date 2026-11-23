import { catalog, t, statusLabel, tierLabel } from './messages.mjs';

/** Um resultado de gate. `key`/`params` referenciam o catálogo pt-BR. */
export function result(gate, status, key, params = {}) {
  return { gate, status, key, params, file: params.file ?? null, line: params.line ?? null };
}

export function counts(results) {
  const c = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const r of results) c[r.status]++;
  return c;
}

const ORDER = { fail: 0, warn: 1, pass: 2, skip: 3 };

export function renderLine(r) {
  const label = statusLabel(r.status).padEnd(9);
  return `${catalog.icon[r.status]} ${label} [${r.gate}] ${t(r.key, r.params)}`;
}

/** Linhas de texto; aprovações repetidas do mesmo gate são agregadas numa linha. */
export function renderResults(results, { aggregateAbove = 3 } = {}) {
  const sorted = [...results].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const lines = [];
  const passByGate = new Map();
  for (const r of sorted) {
    if (r.status === 'pass') {
      if (!passByGate.has(r.gate)) passByGate.set(r.gate, []);
      passByGate.get(r.gate).push(r);
    } else {
      lines.push(renderLine(r));
    }
  }
  for (const [gate, list] of passByGate) {
    const aggKey = `agg.${gate}`;
    if (list.length > aggregateAbove && typeof catalog[aggKey] === 'string') {
      lines.push(renderLine(result(gate, 'pass', aggKey, { count: list.length })));
    } else {
      for (const r of list) lines.push(renderLine(r));
    }
  }
  return lines;
}

export function summaryLine(tier, results) {
  const c = counts(results);
  if (results.length === 0) return t('summary.empty', { tier: tierLabel(tier) });
  const params = { tier: tierLabel(tier), passed: c.pass, failed: c.fail, warned: c.warn, skipped: c.skip };
  return c.fail > 0 ? t('summary.fail', params) : t('summary.pass', params);
}

export function renderReport(tier, results, extraHeader = []) {
  return [...extraHeader, ...renderResults(results), '', summaryLine(tier, results)].join('\n');
}
