import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { harness, input, item, net, reset } from './support';

beforeEach(() => reset());
const none = { WEB_SEARCH_PROVIDER: 'none' };
const hits = (re: RegExp) => net.calls.filter((c) => re.test(decodeURIComponent(c.url)));
const officialSources = (h: ReturnType<typeof harness>) =>
  (h.drafts()[0].body.sources as Record<string, any>[]).filter((s) => s.kind === 'official_data');

it('desemprego consulta SIDRA 6381/4099 e vira fonte IBGE com o valor no prompt', async () => {
  const h = harness({ config: none });
  await h.pipeline.check(input());
  expect(hits(/apisidra\.ibge\.gov\.br\/values\/t\/6381\/n1\/all\/v\/4099\/p\/last[ +]1/)).toHaveLength(1);
  expect(JSON.stringify(h.verdictRequests()[0].messages)).toMatch(/5[.,]6/);
  expect(officialSources(h)).toEqual(expect.arrayContaining([expect.objectContaining({ outlet: 'IBGE' })]));
});

it('PIB consulta a tabela 5932 do IBGE', async () => {
  const h = harness({ config: none });
  await h.pipeline.check(input(item({ quote: 'O PIB cresceu 2% no último trimestre', topic: 'economia' })));
  expect(hits(/ibge\.gov\.br\/.*5932/)).toHaveLength(1);
});

it('IPCA e Selic consultam BCB SGS 433/13522 e 432', async () => {
  const ipca = harness({ config: none });
  await ipca.pipeline.check(input(item({ quote: 'A inflação acumulada em 12 meses está em 4,58%', topic: 'economia' })));
  expect(hits(/api\.bcb\.gov\.br\/dados\/serie\/bcdata\.sgs\.(433|13522)\/dados/).length).toBeGreaterThan(0);
  expect(officialSources(ipca)).toEqual(expect.arrayContaining([expect.objectContaining({ outlet: 'Banco Central' })]));
  reset();
  const selic = harness({ config: none });
  await selic.pipeline.check(input(item({ quote: 'A taxa Selic está em 13,75%', topic: 'economia' })));
  expect(hits(/bcdata\.sgs\.432\/dados/)).toHaveLength(1);
  expect(JSON.stringify(selic.verdictRequests()[0].messages)).toMatch(/13[.,]75/);
});

it('abstenção do 1º turno vem do civic publicado, com cache por processo', async () => {
  const h = harness({ config: none });
  const claim = { quote: 'A abstenção no primeiro turno para presidente foi de 20%', topic: 'eleições' };
  await h.pipeline.check(input(item(claim)));
  await h.pipeline.check(input(item({ ...claim, fact: '13131313-1313-4131-8131-131313131315' })));
  const civic = hits(/^https:\/\/ofluxo\.app\/data\/civic\/2026\/national\/br\/meta\.json/i);
  expect(civic).toHaveLength(1);
  expect(JSON.stringify(h.verdictRequests()[0].messages)).toMatch(/32[.\s]?894[.\s]?899|20[.,]84/);
  expect(officialSources(h)).toEqual(expect.arrayContaining([expect.objectContaining({ outlet: 'TSE (via Fluxo)' })]));
});

it('roteamento só para type number e Portal da Transparência desligado sem chave', async () => {
  const promise = harness({ config: none });
  await promise.pipeline.check(input(item({ quote: 'Vou reduzir o desemprego para 5% até 2028', type: 'promise' })));
  expect(hits(/ibge\.gov\.br|bcb\.gov\.br|ofluxo\.app\/data\/civic/)).toEqual([]);
  reset();
  const spending = harness({ config: { ...none, PORTAL_TRANSPARENCIA_API_KEY: undefined } });
  await spending.pipeline.check(input(item({ quote: 'O governo federal gastou 10 bilhões com saúde neste ano', topic: 'gastos públicos' })));
  expect(hits(/portaldatransparencia\.gov\.br/)).toEqual([]);
  expect(spending.drafts()).toHaveLength(1);
});

it('worker não lê BigQuery', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /bigquery/i.test(d))).toEqual([]);
});
