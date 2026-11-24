// Gate FC-011-FICHA-FATOS (template Vitest, copiado para ofluxo_site/src/platform/domain/ só durante o gate).
// Dados sintéticos pequenos + um caso com os JSONs reais do Pulso. O módulo é TypeScript puro (sem fetch, DOM, React).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  aggregateIndicator, civicContextManifestSchema, civicContextValuesSchema, civicPortesSchema, differenceLabel, formatIndicator, territoryIndex,
  type CivicContextValues, type CivicIndicator,
} from './civic-context';
import { buildFactSheet } from './creator-fact-sheet';

const indicator = (fields: Partial<CivicIndicator>): CivicIndicator => ({
  id: 'x', label: 'X', unit: '%', digits: 1, polarity: 'higher_is_better', source: 'censo2022', aggregation: { kind: 'ratio', factor: 100 },
  methodology: 'm', periods: [2022], defaultPeriod: 2022, breaks: [20, 40], coverage: { 2022: { available: 5, total: 6 } }, ...fields,
});

const esgoto = indicator({ id: 'esgoto', label: 'Esgoto adequado' });
const ideb = indicator({ id: 'ideb', label: 'Ideb', unit: 'nota', aggregation: { kind: 'none' }, source: 'ideb', periods: [2023], defaultPeriod: 2023 });
const mortalidade = indicator({ id: 'mortinf', label: 'Mortalidade infantil', unit: 'por mil', digits: 1, polarity: 'higher_is_worse', source: 'sinasc' });
const semFonte = indicator({ id: 'orfao', label: 'Sem fonte', source: 'nao_existe' });

const manifest = civicContextManifestSchema.parse({
  version: 1, generatedAt: '2026-11-05T18:45:29.779Z', defaultContext: 'saneamento',
  contexts: [
    { kind: 'indicators', id: 'saneamento', label: 'Saneamento', icon: 'water', question: 'q', eventIdea: 'e', file: 'saneamento.json', generatedAt: '2026-11-05', defaultIndicator: 'esgoto', indicators: [esgoto, semFonte] },
    { kind: 'indicators', id: 'educacao', label: 'Educação', icon: 'school', question: 'q', eventIdea: 'e', file: 'educacao.json', generatedAt: '2026-11-05', defaultIndicator: 'ideb', indicators: [ideb] },
    { kind: 'indicators', id: 'saude', label: 'Saúde', icon: 'heart', question: 'q', eventIdea: 'e', file: 'saude.json', generatedAt: '2026-11-05', defaultIndicator: 'mortinf', indicators: [mortalidade] },
    { kind: 'legislative', id: 'politica', label: 'Política', icon: 'gavel', question: 'q' },
    { kind: 'electoral', id: 'eleitoral', status: 'offline', label: 'Eleitoral', icon: 'vote', question: 'q' },
  ],
  sources: {
    censo2022: { org: 'IBGE', name: 'Censo 2022', url: 'https://censo2022.ibge.gov.br', license: 'CC BY 4.0' },
    ideb: { org: 'INEP', name: 'Ideb', url: 'https://inep.gov.br/ideb', license: 'Dados abertos' },
    sinasc: { org: 'Ministério da Saúde', name: 'SINASC', url: 'https://datasus.saude.gov.br/sinasc', license: 'Dados abertos' },
  },
});

const territories = ['3100001', '3100002', '3100003', '3100004', '3500001', '3500002'];
const make = (contextId: string, series: CivicContextValues['series']): CivicContextValues =>
  civicContextValuesSchema.parse({ version: 1, contextId, territories, series, generatedAt: '2026-11-05' });

const values: Record<string, CivicContextValues> = {
  saneamento: make('saneamento', {
    esgoto: { 2022: { v: [10, 90, null, 70, 50, 60], n: [1, 900, null, 7, 5, 6], d: [10, 1000, null, 10, 10, 10] } },
    orfao: { 2022: { v: [1, 1, 1, 1, 1, 1], n: [1, 1, 1, 1, 1, 1], d: [1, 1, 1, 1, 1, 1] } },
  }),
  educacao: make('educacao', { ideb: { 2023: { v: [4, 6, 9, 5, 7, 8] } } }),
  saude: make('saude', {
    // 3100001 tem óbitos suprimidos: v nulo, mas n e d ainda existem na fonte. A ficha nunca recalcula por n.
    mortinf: { 2022: { v: [null, 12, 14, null, 10, 11], n: [3, 12, 14, 2, 10, 11], d: [1000, 1000, 1000, 1000, 1000, 1000] } },
  }),
};

const portes = civicPortesSchema.parse({
  version: 1, year: 2022, classes: [{ id: 'ate20', label: 'até 20 mil hab.' }, { id: 'ate50', label: 'de 20 a 50 mil hab.' }],
  municipalities: { 3100001: 0, 3100002: 0, 3100003: 1, 3100004: 1, 3500001: 0, 3500002: 1 },
});

const base = { manifest, values, portes, area: { uf: 'MG', ibge: '3100001', name: 'Município Um' }, maxIndicators: 3 };
const sel = (contextId: string, indicatorId: string, period?: number) => ({ contextId, indicatorId, ...(period === undefined ? {} : { period }) });
const ok = (result: ReturnType<typeof buildFactSheet>) => {
  if (!('sheet' in result)) throw new Error(`esperava ficha, veio erro: ${result.error}`);
  return result.sheet;
};
const err = (result: ReturnType<typeof buildFactSheet>) => ('error' in result ? result.error : null);
const num = (text: string) => Number(text.replace(/\./g, '').replace(',', '.'));

afterEach(() => vi.useRealTimers());

describe('FC-011 ficha de fatos: contas do Pulso', () => {
  it('razão recompõe numerador e denominador (não é média simples) e carrega fonte, ano e unidade', () => {
    const sheet = ok(buildFactSheet({ ...base, area: { uf: 'MG', ibge: null, name: 'Minas Gerais' }, selections: [sel('saneamento', 'esgoto')] }));
    const fact = sheet.facts.find((f) => f.id === 'saneamento.esgoto')!;
    expect(fact).toBeDefined();
    expect(fact.value).toBeCloseTo((908 / 1020) * 100, 6);
    expect(fact.value).not.toBeCloseTo((10 + 90 + 70) / 3, 1);
    expect(fact.display).toBe('89,0%');
    expect(fact).toMatchObject({ contextId: 'saneamento', indicatorId: 'esgoto', unit: '%', digits: 1, period: 2022, polarity: 'higher_is_better', basis: 'exact', reporting: 3, total: 4 });
    expect(fact.source).toEqual({ key: 'censo2022', org: 'IBGE', name: 'Censo 2022', url: 'https://censo2022.ibge.gov.br', license: 'CC BY 4.0' });
    expect(fact.label).toBe('Esgoto adequado');
    expect(sheet.version).toBe(1);
    expect(sheet.manifestGeneratedAt).toBe('2026-11-05T18:45:29.779Z');
    expect(sheet.area).toEqual({ ibge: null, uf: 'MG', name: 'Minas Gerais' });
    expect(fact.comparisons.municipio).toBeUndefined();
    expect(fact.comparisons.porte).toBeUndefined();
  });

  it('município tem valor exato, e estado e Brasil trazem valor, base e diferença no texto do Pulso', () => {
    const sheet = ok(buildFactSheet({ ...base, selections: [sel('saneamento', 'esgoto')] }));
    const fact = sheet.facts[0];
    expect(fact.value).toBe(10);
    expect(fact.display).toBe('10,0%');
    expect(fact.basis).toBe('exact');
    const def = values.saneamento;
    const index = territoryIndex(def);
    const uf = aggregateIndicator(esgoto, def, index, 2022, def.territories.filter((t) => t.startsWith('31')));
    const brasil = aggregateIndicator(esgoto, def, index, 2022, null);
    expect(brasil.value).toBeCloseTo((919 / 1040) * 100, 6);
    expect(fact.comparisons.uf).toMatchObject({ value: uf.value, display: formatIndicator(esgoto, uf.value), basis: uf.basis });
    expect(fact.comparisons.brasil).toMatchObject({ value: brasil.value, display: formatIndicator(esgoto, brasil.value), basis: brasil.basis });
    expect(fact.comparisons.uf?.differenceText).toBe(differenceLabel(esgoto, 10, uf.value)?.text);
    expect(fact.comparisons.uf?.tone).toBe(differenceLabel(esgoto, 10, uf.value)?.tone);
    expect(fact.comparisons.brasil?.differenceText).toBe(differenceLabel(esgoto, 10, brasil.value)?.text);
    expect(fact.comparisons.brasil?.display).toBe('88,4%');
  });

  it('comparativo de porte só existe com município e faixa conhecida', () => {
    const withPorte = ok(buildFactSheet({ ...base, selections: [sel('saneamento', 'esgoto')] })).facts[0];
    expect(withPorte.comparisons.porte).toBeDefined();
    expect(Number.isFinite(withPorte.comparisons.porte?.value)).toBe(true);
    expect(withPorte.comparisons.porte?.display).toMatch(/%$/);
    const without = ok(buildFactSheet({ ...base, portes: null, selections: [sel('saneamento', 'esgoto')] })).facts[0];
    expect(without.comparisons.porte).toBeUndefined();
  });

  it('índice sem denominador sai como mediana rotulada', () => {
    const fact = ok(buildFactSheet({ ...base, area: { uf: 'MG', ibge: null, name: 'Minas Gerais' }, selections: [sel('educacao', 'ideb')] })).facts[0];
    expect(fact).toMatchObject({ value: 5.5, basis: 'median', period: 2023, unit: 'nota' });
    expect(fact.source.key).toBe('ideb');
  });
});

describe('FC-011 ficha de fatos: falta de dado e privacidade', () => {
  it('município sem dado vai para unavailable e nunca vira zero', () => {
    const sheet = ok(buildFactSheet({ ...base, area: { uf: 'MG', ibge: '3100003', name: 'Município Três' }, selections: [sel('saneamento', 'esgoto')] }));
    expect(sheet.facts).toEqual([]);
    expect(sheet.unavailable).toEqual([{ id: 'saneamento.esgoto', reason: 'no_data' }]);
    expect(sheet.allowedNumbers).not.toContain(0);
    expect(JSON.stringify(sheet.facts)).not.toMatch(/"value":0\b/);
  });

  it('período que o indicador não publica vira period_not_published', () => {
    const sheet = ok(buildFactSheet({ ...base, selections: [sel('saneamento', 'esgoto', 2019)] }));
    expect(sheet.facts).toEqual([]);
    expect(sheet.unavailable).toEqual([{ id: 'saneamento.esgoto', reason: 'period_not_published' }]);
  });

  it('sem period usa o período padrão do indicador', () => {
    const fact = ok(buildFactSheet({ ...base, selections: [sel('educacao', 'ideb')] })).facts[0];
    expect(fact.period).toBe(2023);
  });

  it('supressão do Pulso é respeitada: v nulo com n e d presentes continua sem dado', () => {
    const sheet = ok(buildFactSheet({ ...base, selections: [sel('saude', 'mortinf')] }));
    expect(sheet.facts).toEqual([]);
    expect(sheet.unavailable).toEqual([{ id: 'saude.mortinf', reason: 'no_data' }]);
    expect(JSON.stringify(sheet)).not.toMatch(/0[.,]003|\b3\b.*\b1000\b/);
  });

  it('o resultado nunca carrega n, d, breaks nem lista de municípios', () => {
    const sheet = ok(buildFactSheet({ ...base, area: { uf: 'MG', ibge: null, name: 'Minas Gerais' }, selections: [sel('saneamento', 'esgoto'), sel('educacao', 'ideb'), sel('saude', 'mortinf')] }));
    const json = JSON.stringify(sheet);
    expect(json).not.toMatch(/"(n|d|breaks|territories|ibges|series)"\s*:/);
    for (const code of ['3100002', '3100003', '3100004', '3500001', '3500002']) expect(json).not.toContain(code);
    expect(json).not.toMatch(/"(secao|section|zona|zone|local|candidate|lula|bolsonaro)\w*"\s*:/i);
  });
});

describe('FC-011 ficha de fatos: números permitidos, teto e erros', () => {
  it('allowedNumbers traz os números exibidos e comparativos, sem duplicata e sem número inventado', () => {
    const sheet = ok(buildFactSheet({ ...base, selections: [sel('saneamento', 'esgoto')] }));
    const fact = sheet.facts[0];
    const allowed = sheet.allowedNumbers;
    expect(new Set(allowed).size).toBe(allowed.length);
    const shown = [fact.display, fact.comparisons.uf?.display, fact.comparisons.brasil?.display, fact.comparisons.uf?.differenceText, fact.comparisons.brasil?.differenceText]
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.match(/\d+(?:[.,]\d+)?/)![0])
      .map(num);
    for (const n of shown) expect(allowed.includes(n) || allowed.includes(-n), `número exibido ${n} fora de allowedNumbers`).toBe(true);
    for (const n of [2022, 1]) expect(allowed).toContain(n);
    expect(allowed).not.toContain(52.5);
    expect(allowed).not.toContain(0);
    expect(allowed.every((n) => Number.isFinite(n))).toBe(true);
  });

  it('mais indicadores que o teto retorna too_many_indicators (o teto vem do chamador)', () => {
    const three = [sel('saneamento', 'esgoto'), sel('educacao', 'ideb'), sel('saude', 'mortinf')];
    expect(err(buildFactSheet({ ...base, maxIndicators: 2, selections: three }))).toBe('too_many_indicators');
    expect('sheet' in buildFactSheet({ ...base, maxIndicators: 3, selections: three })).toBe(true);
    expect(err(buildFactSheet({ ...base, maxIndicators: 1, selections: three.slice(0, 2) }))).toBe('too_many_indicators');
  });

  it('contexto politica, eleitoral e inexistente retornam erro; eleitoral offline é context_offline', () => {
    expect(err(buildFactSheet({ ...base, selections: [sel('politica', 'x')] }))).toBe('unknown_context');
    expect(err(buildFactSheet({ ...base, selections: [sel('inexistente', 'x')] }))).toBe('unknown_context');
    expect(err(buildFactSheet({ ...base, selections: [sel('eleitoral', 'x')] }))).toBe('context_offline');
    const published = civicContextManifestSchema.parse({
      ...manifest, contexts: manifest.contexts.map((c) => (c.kind === 'electoral' ? { ...c, status: 'published' } : c)),
    });
    expect(err(buildFactSheet({ ...base, manifest: published, selections: [sel('eleitoral', 'x')] }))).toBe('unknown_context');
  });

  it('indicador inexistente ou sem fonte no manifest retorna unknown_indicator', () => {
    expect(err(buildFactSheet({ ...base, selections: [sel('saneamento', 'nao_existe')] }))).toBe('unknown_indicator');
    expect(err(buildFactSheet({ ...base, selections: [sel('saneamento', 'orfao')] }))).toBe('unknown_indicator');
  });

  it('mesma entrada gera a mesma saída byte a byte, sem relógio', () => {
    const input = { ...base, selections: [sel('saneamento', 'esgoto'), sel('educacao', 'ideb')] };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const first = JSON.stringify(buildFactSheet(input));
    vi.setSystemTime(new Date('2041-06-30T12:00:00Z'));
    const second = JSON.stringify(buildFactSheet(input));
    expect(second).toBe(first);
    expect(first).not.toMatch(/20(30|41)/);
  });

  it('mantém a ordem das seleções', () => {
    const sheet = ok(buildFactSheet({ ...base, area: { uf: 'MG', ibge: null, name: 'Minas Gerais' }, selections: [sel('educacao', 'ideb'), sel('saneamento', 'esgoto')] }));
    expect(sheet.facts.map((f) => f.id)).toEqual(['educacao.ideb', 'saneamento.esgoto']);
  });
});

describe('FC-011 ficha de fatos: dados reais do Pulso', () => {
  const dir = path.resolve(__dirname, '../../../public/data/civic/contexts');
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

  it('esgoto adequado: Brasil 2022 é 75,7% e Divinópolis é do porte ate500', () => {
    const realManifest = civicContextManifestSchema.parse(read('manifest.json'));
    const realPortes = civicPortesSchema.parse(read('portes.json'));
    const sheet = ok(buildFactSheet({
      manifest: realManifest, values: { saneamento: civicContextValuesSchema.parse(read('saneamento.json')) }, portes: realPortes,
      area: { uf: 'MG', ibge: '3122306', name: 'Divinópolis' }, selections: [sel('saneamento', 'esgoto_adequado')], maxIndicators: 3,
    }));
    const fact = sheet.facts[0];
    expect(fact.period).toBe(2022);
    expect(fact.comparisons.brasil?.display).toBe('75,7%');
    expect(fact.source.key).toBe('censo2022');
    expect(fact.source.org.length).toBeGreaterThan(0);
    expect(realPortes.classes[realPortes.municipalities['3122306']].id).toBe('ate500');
    expect(fact.comparisons.porte).toBeDefined();
    expect(sheet.manifestGeneratedAt).toBe(realManifest.generatedAt);
    expect(JSON.stringify(sheet)).not.toMatch(/"(n|d|breaks)"\s*:/);
  });
});

describe('FC-011 ficha de fatos: módulo puro', () => {
  const source = () => fs.readFileSync(path.resolve(__dirname, 'creator-fact-sheet.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('sem fetch, DOM, React nem import.meta.env, e só importa civic-context, creator-enums e zod', () => {
    const code = source();
    expect(code).not.toMatch(/\bfetch\s*\(|\bdocument\b|\bwindow\b|\blocalStorage\b|from ['"]react|import\.meta\.env|Date\.now\s*\(|new Date\s*\(|Math\.random/);
    const imports = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(['./civic-context', './creator-enums', 'zod']).toContain(spec);
    expect(imports).toContain('./civic-context');
  });
});
