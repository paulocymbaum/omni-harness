// Gate FC-011-FILTROS (template Vitest, copiado para ofluxo_site/src/platform/domain/ só durante o gate).
// Contrato fixado pelo gate (a spec só descreve o caso eleitoral): filterIndicatorCatalog(manifest, opts) devolve
//   demographic/all -> { available: true, indicators: [{ contextId, id, label, unit, polarity, periods, defaultPeriod, source,
//                        coverage: { available, total } | null, selectable: boolean, reason?: string }] }
//   electoral       -> { available: false, reason: 'electoral_disabled' | 'electoral_offline' | 'electoral_pending_legal' }
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { civicContextManifestSchema, type CivicContextManifest } from './civic-context';
import { filterIndicatorCatalog } from './creator-pulso-catalog';

const real = civicContextManifestSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../public/data/civic/contexts/manifest.json'), 'utf8')),
);
const withElectoral = (status: 'published' | 'offline' | undefined): CivicContextManifest => civicContextManifestSchema.parse({
  ...real, contexts: real.contexts.map((c) => (c.kind === 'electoral' ? { ...c, status } : c)),
});
type Listed = { available: true; indicators: Array<Record<string, unknown> & { contextId: string; id: string; label: string; selectable: boolean }> };
const listed = (result: unknown): Listed => {
  const r = result as { available?: boolean };
  expect(r.available).toBe(true);
  return result as Listed;
};
const on = { electoralContextEnabled: true };
const off = { electoralContextEnabled: false };

describe('FC-011 filtros do catálogo: demográfico', () => {
  it('lista os contextos indicators do manifest real e exclui politica e eleitoral', () => {
    const expected = real.contexts.filter((c) => c.kind === 'indicators').map((c) => c.id);
    expect(expected).toHaveLength(10);
    const { indicators } = listed(filterIndicatorCatalog(real, { family: 'demographic', ...off }));
    expect([...new Set(indicators.map((i) => i.contextId))].sort()).toEqual([...expected].sort());
    expect(indicators.some((i) => ['politica', 'eleitoral'].includes(i.contextId))).toBe(false);
    const total = real.contexts.flatMap((c) => (c.kind === 'indicators' ? c.indicators : [])).length;
    expect(indicators).toHaveLength(total);
  });

  it('cada indicador traz rótulo, unidade, polaridade, períodos, fonte e a cobertura do período padrão', () => {
    const { indicators } = listed(filterIndicatorCatalog(real, { family: 'demographic', ...off }));
    const esgoto = indicators.find((i) => i.contextId === 'saneamento' && i.id === 'esgoto_adequado')!;
    const source = real.contexts.flatMap((c) => (c.kind === 'indicators' ? c.indicators : [])).find((i) => i.id === 'esgoto_adequado')!;
    expect(esgoto).toMatchObject({
      label: 'Esgoto adequado', unit: '%', polarity: 'higher_is_better', periods: [2022], defaultPeriod: 2022, source: 'censo2022', selectable: true,
      coverage: source.coverage['2022'],
    });
  });

  it('família all também não inclui contexto eleitoral nem politica', () => {
    const { indicators } = listed(filterIndicatorCatalog(real, { family: 'all', ...on }));
    expect(indicators.some((i) => ['politica', 'eleitoral'].includes(i.contextId))).toBe(false);
    expect(indicators.length).toBeGreaterThan(40);
  });

  it('filtra por contexto', () => {
    const { indicators } = listed(filterIndicatorCatalog(real, { family: 'demographic', contextId: 'saude', ...off }));
    expect(new Set(indicators.map((i) => i.contextId))).toEqual(new Set(['saude']));
    expect(indicators).toHaveLength(4);
  });

  it('busca por palavras no rótulo, sem acento e sem diferença de maiúsculas', () => {
    const find = (query: string) => listed(filterIndicatorCatalog(real, { family: 'demographic', query, ...off })).indicators.map((i) => `${i.contextId}.${i.id}`);
    expect(find('agua')).toContain('saneamento.agua_rede');
    expect(find('ÁGUA')).toEqual(find('agua'));
    expect(find('Agua da rede')).toContain('saneamento.agua_rede');
    expect(find('esgoto adequado')).toContain('saneamento.esgoto_adequado');
    expect(find('esgoto')).toEqual(expect.arrayContaining(['saneamento.esgoto_adequado', 'saneamento.tratamento_esgoto']));
    expect(find('quilombolas')).toEqual(['territorio.pop_quilombola']);
    expect(find('zzzxyz')).toEqual([]);
  });

  it('indicador sem cobertura no período padrão sai selectable false, com motivo', () => {
    const broken = civicContextManifestSchema.parse({
      ...real, contexts: real.contexts.map((c) => (c.kind === 'indicators' && c.id === 'saneamento'
        ? { ...c, indicators: c.indicators.map((i) => (i.id === 'esgoto_adequado' ? { ...i, coverage: { 2022: { available: 0, total: 5570 } } }
          : i.id === 'agua_rede' ? { ...i, coverage: {} } : i)) } : c)),
    });
    const { indicators } = listed(filterIndicatorCatalog(broken, { family: 'demographic', contextId: 'saneamento', ...off }));
    for (const id of ['esgoto_adequado', 'agua_rede']) {
      const item = indicators.find((i) => i.id === id)!;
      expect(item.selectable, id).toBe(false);
      expect(typeof item.reason === 'string' && (item.reason as string).length > 0, id).toBe(true);
    }
    expect(indicators.find((i) => i.id === 'lixo_coletado')!.selectable).toBe(true);
  });
});

describe('FC-011 filtros do catálogo: eleitoral fechado', () => {
  it('flag desligada: electoral_disabled, mesmo com o contexto publicado', () => {
    expect(filterIndicatorCatalog(real, { family: 'electoral', ...off })).toEqual({ available: false, reason: 'electoral_disabled' });
    expect(filterIndicatorCatalog(withElectoral('published'), { family: 'electoral', ...off })).toEqual({ available: false, reason: 'electoral_disabled' });
  });

  it('flag ligada e contexto offline: electoral_pending_legal (FC-014: sem a injeção o fechamento é jurídico)', () => {
    expect(real.contexts.find((c) => c.kind === 'electoral')).toMatchObject({ status: 'offline' });
    expect(filterIndicatorCatalog(real, { family: 'electoral', ...on })).toEqual({ available: false, reason: 'electoral_pending_legal' });
  });

  it('flag ligada e contexto publicado: ainda fechado (electoral_pending_legal), sem listar indicador eleitoral', () => {
    for (const status of ['published', undefined] as const) {
      expect(filterIndicatorCatalog(withElectoral(status), { family: 'electoral', ...on })).toEqual({ available: false, reason: 'electoral_pending_legal' });
    }
  });
});

describe('FC-011 filtros do catálogo: módulo puro', () => {
  it('sem fetch, DOM, React nem import.meta.env', () => {
    const code = fs.readFileSync(path.resolve(__dirname, 'creator-pulso-catalog.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/\bfetch\s*\(|\bdocument\b|\bwindow\b|from ['"]react|import\.meta\.env/);
  });
});
