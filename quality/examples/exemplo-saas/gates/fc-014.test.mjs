// Gates FC-014 — contexto eleitoral fechado e o que o parecer preliminar já destravou.
// O parecer (docs/entregas/2026-11-14-fluxo-creator/parecer-juridico-eleitoral.md) concluiu:
// pode com condições (agregado municipal público, rótulo histórico, janela eleitoral, k=25 de
// seção, rotulagem IA). Este gate prova que a área PERMANECE fechada por padrão (flag fail-closed,
// catálogo web sem eleitoral, lista de apelo eleitoral no worker) e que os parâmetros da decisão
// existem no backend. Dataset municipal e UI continuam nas fatias 2/3 da spec (Status: ready).
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-014
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { read } from './fc-gate-helper.mjs';

const OPTIONS = 'backend/src/Exemplo SaaS.Api/Modules/Creator/CreatorOptions.cs';
const TERMS = 'services/creator-worker/src/llm/forbidden-terms.ts';
const CATALOG = 'ofluxo_site/src/platform/domain/creator-pulso-catalog.ts';
const FACTS = 'ofluxo_site/src/platform/domain/creator-fact-sheet.ts';
const GENERATOR = 'backend/tools/creator-electoral/build-election.mjs';
const DATASET = 'backend/src/Exemplo SaaS.Api/Modules/Creator/Data/election-br-2026.json.gz';
const ELECTION_JSON = 'ofluxo_site/public/data/civic/contexts/eleicao-2026.json';
const PARECER = 'docs/entregas/2026-11-14-fluxo-creator/parecer-juridico-eleitoral.md';
const SPEC = 'docs/entregas/2026-11-14-fluxo-creator/specs/FC-014.md';

test('FC-014 eleitoral: flag fail-closed e parâmetros do parecer no backend', () => {
  const options = read(OPTIONS);
  // Default false SEM atribuição no código: a flag só liga por configuração (RN-14).
  assert.match(options, /public bool ElectoralContextEnabled \{ get; set; \}/, 'flag sem forma fail-closed');
  assert.ok(!/= true/.test(options.replace(/\/\/[^\n]*\n/g, '')), 'ElectoralContextEnabled ligado no código');
  assert.match(options, /ElectoralWindowFrom/, 'janela do pleito ausente');
  assert.match(options, /ElectoralSectionMinElectors \{ get; set; \} = 25/, 'k=25 do parecer ausente');
  assert.match(options, /parecer-juridico-eleitoral\.md/, 'opção sem rastro do parecer');
});

test('FC-014 eleitoral: lista de apelo eleitoral ampliada no worker (Lei 9.504/97, arts. 26/26-A/36)', () => {
  const terms = read(TERMS);
  for (const literal of ['/\\bcampanha\\b/i', '/\\bsufr', '/\\bsegundo\\s+turno\\b/i', '/\\beleitor', '/\\beleic']) {
    assert.ok(terms.includes(literal), `termo de apelo ausente: ${literal}`);
  }
  assert.match(terms, /parecer-juridico-eleitoral\.md/, 'lista sem rastro do parecer');
});

test('FC-014 eleitoral: catálogo web continua fechado sem a flag (FC-011)', () => {
  const catalog = read(CATALOG);
  assert.match(catalog, /electoralContextEnabled/, 'catálogo sem ler a flag do config');
  assert.match(catalog, /electoral_pending_legal/, 'motivo de fechamento jurídico ausente');
  assert.match(catalog, /!filter\.electoralContextEnabled\)\s*return \{ available: false/, 'catálogo aberto sem flag');
});

test('FC-014 eleitoral: parecer APROVADO pelo responsável e recomendação OAB mantida', () => {
  const parecer = read(PARECER);
  assert.match(parecer, /APROVADO — decisão interna do responsável do projeto/, 'parecer sem a aprovação');
  assert.match(parecer, /PRELIMINAR/, 'parecer sem a marcação honesta de preliminar de IA');
  assert.match(parecer, /8\.906\/1994, art\. 2/, 'parecer sem o aviso da Lei da OAB');
  assert.match(parecer, /k = 25|k≥25/, 'parecer sem o k de seção');
  assert.match(parecer, /\[CONFERIR/, 'parecer sem marcar dispositivos não conferidos');
  for (const pergunta of ['P1', 'P2', 'P3', 'P4', 'P5']) {
    assert.ok(parecer.includes(`### ${pergunta} —`), `parecer sem a pergunta ${pergunta}`);
  }
});

test('FC-014 eleitoral: spec completa com aprovação e contrato das fatias 2/3', () => {
  const spec = read(SPEC);
  assert.match(spec, /Status: done — parecer APROVADO/, 'spec sem o estado de aprovação e execução');
  assert.match(spec, /## Aprovação \(2026-11-15\)/, 'spec sem a seção de aprovação');
  assert.match(spec, /Execução \(2026-11-15\)/, 'spec sem a seção de execução');
  assert.match(spec, /1º turno/, 'spec sem a correção do turno do dataset');
  assert.match(spec, /ElectoralSectionMinElectors ≥ 25|k ≥ 25|k=25/, 'spec sem o k do parecer');
  assert.match(spec, /build-election\.mjs/, 'spec sem o gerador do dataset');
  assert.match(spec, /election-br-20(22|26)\.json\.gz/, 'spec sem o arquivo do dataset');
  assert.match(spec, /leaderName[\s\S]{0,200}nunca|nunca[\s\S]{0,200}leaderName/i, 'spec sem a vedação de leaderName/leaderNumber');
  assert.match(spec, /fonte TSE/, 'spec sem o rótulo histórico de fonte');
});

test('FC-014 dataset: geração determinística (byte a byte) e lista branca sem candidato individual', () => {
  const before = fs.readFileSync(DATASET);
  const site = JSON.parse(fs.readFileSync(ELECTION_JSON, 'utf8'));
  assert.equal(site.contextId, 'eleitoral', 'values sem o contexto eleitoral');
  assert.ok(site.territories.length >= 5570, `territórios insuficientes: ${site.territories.length}`);
  assert.ok(!JSON.stringify(site).includes('leaderName'), 'dataset do site com leaderName');
  const generator = read(GENERATOR);
  assert.match(generator, /NUNCA leaderName/, 'gerador sem a lista branca declarada');
  const run = spawnSync(process.execPath, [GENERATOR], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, `gerador falhou: ${run.stderr}`);
  assert.deepEqual(fs.readFileSync(DATASET), before, 'regeneração não é byte a byte (dataset instável)');
});

test('FC-014 backend: endpoint e config eleitorais fail-closed com metadados do dataset', () => {
  const options = read(OPTIONS);
  // Dataset atualizado para o pleito corrente (2026, 1º turno — ver docs/entregas/2026-11-16-creator-pos-epico).
  assert.match(options, /ElectionYear \{ get; set; \} = 2026/, 'ano do pleito ausente');
  assert.match(options, /ElectionLabel \{ get; set; \} = "Eleição 2026 \(1º turno\), fonte TSE"/, 'rótulo de fonte ausente');
  const responses = read('backend/src/Exemplo SaaS.Api/Modules/Creator/Contracts/Responses.cs');
  assert.match(responses, /CreatorElectionDto\? Election = null/, 'config sem o bloco election opcional');
  const endpoints = read('backend/src/Exemplo SaaS.Api/Modules/Creator/CreatorElectionEndpoints.cs');
  assert.match(endpoints, /creator_electoral_disabled/, 'endpoint sem fail-closed');
  assert.match(endpoints, /election\/\{ibge\}/, 'endpoint sem a rota por IBGE');
  const catalog = read('backend/src/Exemplo SaaS.Api/Modules/Creator/Application/CreatorElectionCatalog.cs');
  assert.match(catalog, /election-br-2026\.json\.gz/, 'catálogo sem o recurso embutido');
  assert.match(catalog, /agregados anônimos por município/, 'catálogo sem a declaração de anonimato');
  const module = read('backend/src/Exemplo SaaS.Api/Modules/Creator/CreatorModule.cs');
  assert.match(module, /MapElectionEndpoints/, 'endpoint não registrado no módulo');
  assert.match(module, /AddSingleton<CreatorElectionCatalog>/, 'catálogo fora do DI');
});

test('FC-014 worker: ficha injeta o contexto eleitoral só com a flag', () => {
  const facts = read('services/creator-worker/src/llm/facts.ts');
  assert.match(facts, /withElectoralContext/, 'builder sem a injeção do contexto');
  assert.match(facts, /eleicao-2026\.json/, 'builder sem o dataset do site');
  const config = read('services/creator-worker/src/config.ts');
  assert.match(config, /CREATOR_ELECTORAL_ENABLED.*default\('false'\)/, 'flag do worker não é default false');
  const compose = read('backend/deploy/docker-compose.creator-local.yml');
  assert.match(compose, /Creator__ElectoralContextEnabled: "true"/, 'homologação local sem a flag da API');
  assert.match(compose, /CREATOR_ELECTORAL_ENABLED: "true"/, 'homologação local sem a flag do worker');
});
