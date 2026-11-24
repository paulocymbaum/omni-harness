// Gates FC-012 — post único com IA: copy via LLM com JSON schema, validação determinística e checagem de fatos.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-012 --baseline
// SQL/API/worker: três testes neste arquivo; API roda o gate .NET com PG (padrão FC-004/FC-005) e worker roda o
// Vitest DENTRO de services/creator-worker (templates em fc-worker/, npm ci se faltar node_modules). Nunca toca
// em services/debate-worker. Sem rede: o LLM é sempre falso nos testes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exists, read, requireEnv, runDotnetGate, runPackageVitest, stripComments, walk,
} from './fc-gate-helper.mjs';

const WORKER = 'services/creator-worker';
const CREATOR = 'backend/src/Exemplo SaaS.Api/Modules/Creator';
const SQL = 'backend/deploy/sql/creator-projects.sql';
const code = (file) => stripComments(read(file));
const vitest = (files, minimum) => runPackageVitest(WORKER, 'fc-worker',
  Object.fromEntries(files.map((f) => [f, `src/${f}`])), minimum);
const gate = (classes) => runDotnetGate(classes, { byMethod: true, support: ['GateFc002Support.cs'], postgres: true });

// ───────────────────────── schema do projeto ─────────────────────────

test('FC-012 sql: creator_projects idempotente e aditivo com FK de creator_jobs e espelho EF', () => {
  assert.ok(exists(SQL), 'deploy/sql/creator-projects.sql ausente');
  const sql = read(SQL);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fluxo\.creator_projects/, 'tabela creator_projects ausente ou não idempotente');
  for (const column of ['business_id', 'created_by', 'recorte', 'context_id', 'indicator_ids', 'prompt', 'viewport',
    'copy', 'copy_edited', 'result_ref', 'status'])
    assert.match(sql, new RegExp(`\\b${column}\\b`), `coluna ${column} ausente em creator-projects.sql`);
  assert.match(sql, /'copying','copy_ready','rendering','done','failed'/, 'status CHECK ausente ou incompleto');
  assert.match(sql, /fk_creator_jobs_projects/, 'FK de creator_jobs.project_id ausente');
  assert.match(sql, /REFERENCES fluxo\.businesses/, 'FK de businesses ausente');
  const migrations = walk('backend/src/Exemplo SaaS.Api', (f) => /CreatorProjects/i.test(f));
  assert.ok(migrations.length >= 1, 'migration EF de CreatorProjects ausente');
});

// ───────────────────────── rotas do projeto ─────────────────────────

test('FC-012 api: rotas com admissão antes do enqueue na mesma transação, rates, Idempotency-Key e RenderSpec do POST render', () => {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL de teste para os gates .NET do Creator');
  assert.ok(exists(`${CREATOR}/CreatorProjectEndpoints.cs`), 'CreatorProjectEndpoints.cs ausente');
  assert.ok(exists(`${CREATOR}/Application/CreatorProjectService.cs`), 'CreatorProjectService.cs ausente');
  const endpoints = code(`${CREATOR}/CreatorProjectEndpoints.cs`);
  assert.match(endpoints, /MapGroup\("\/projects"\)/, 'grupo /projects ausente');
  assert.match(endpoints, /MapPost\(""/, 'POST /projects ausente');
  assert.match(endpoints, /MapGet\("\/\{id:guid\}"/, 'GET /projects/{id} ausente');
  assert.match(endpoints, /MapGet\("\/\{id:guid\}\/copy"/, 'GET copy ausente');
  assert.match(endpoints, /MapPut\("\/\{id:guid\}\/copy"/, 'PUT copy ausente');
  assert.match(endpoints, /MapPost\("\/\{id:guid\}\/render"/, 'POST render ausente');
  assert.match(endpoints, /MapGet\("\/\{id:guid\}\/jobs\/\{jobId:guid\}\/result"/, 'GET result ausente');
  assert.match(endpoints, /CreatorEnqueuePolicyName/, 'POST sem rate creator-enqueue');
  assert.match(endpoints, /CreatorStatusPolicyName/, 'GET sem rate creator-status');
  const service = code(`${CREATOR}/Application/CreatorProjectService.cs`);
  const admitAt = service.search(/AdmitAsync/);
  const enqueueAt = service.search(/EnqueueAsync/);
  assert.ok(admitAt >= 0, 'serviço sem CreatorJobAdmission.AdmitAsync');
  assert.ok(enqueueAt > admitAt, 'admissão precisa vir ANTES do EnqueueAsync (contrato FC-005)');
  assert.match(service, /CreatorJobKind\.SlideCopy|slide_copy/, 'serviço não enfileira kind slide_copy');
  assert.match(service, /factSheetInput/, 'payload do job sem factSheetInput (a ficha é montada pelo worker)');
  assert.match(service, /IndicatorsPerSingle/, 'teto de indicadores do post único não citado');
  const options = code(`${CREATOR}/CreatorOptions.cs`);
  for (const field of ['RenderOutputDir', 'LlmBaseUrl', 'OriginLabel'])
    assert.match(options, new RegExp(field), `CreatorOptions sem ${field}`);
  assert.match(code(`${CREATOR}/CreatorModule.cs`), /MapProjectEndpoints/, 'CreatorModule sem MapProjectEndpoints');
  gate({
    GateFc012ProjectsTests: [
      'Post_creates_copying_project_and_enqueues_slide_copy_with_facts_payload',
      'Idempotency_key_replays_the_same_project',
      'Non_member_is_forbidden',
      'Copy_is_pending_until_the_job_finishes_then_reads_the_store',
      'Put_copy_marks_edited_and_get_project_lists_jobs',
      'Post_render_enqueues_render_job_with_composed_spec',
      'Result_is_pending_then_served_from_the_store',
    ],
  });
});

// ───────────────────────── worker: LLM + slide_copy ─────────────────────────

test('FC-012 worker: cliente LLM OpenAI-compatible com budget 2/s, handler slide_copy com ficha+validação, termos proibidos e store com extensão', () => {
  assert.ok(exists(`${WORKER}/src/ai/llm-client.ts`), 'src/ai/llm-client.ts ausente');
  assert.ok(exists(`${WORKER}/src/handlers/slide-copy.ts`), 'src/handlers/slide-copy.ts ausente');
  assert.ok(exists(`${WORKER}/src/llm/forbidden-terms.ts`), 'src/llm/forbidden-terms.ts ausente');
  assert.ok(exists(`${WORKER}/src/llm/validate-copy.ts`), 'src/llm/validate-copy.ts ausente');
  const client = code(`${WORKER}/src/ai/llm-client.ts`);
  assert.match(client, /createLlmClient/, 'llm-client sem createLlmClient');
  assert.match(client, /chat\/completions/, 'llm-client sem endpoint chat/completions');
  assert.match(client, /retryAfterMs/, 'llm-client sem Retry-After');
  assert.match(client, /provider/, 'llm-client sem falha de provedor (circuito da pista não conta)');
  const handler = code(`${WORKER}/src/handlers/slide-copy.ts`);
  assert.match(handler, /createSlideCopyHandler/, 'handler sem createSlideCopyHandler');
  assert.match(handler, /allowedNumbers/, 'handler sem checagem contra allowedNumbers da ficha');
  assert.match(handler, /copy_validation_failed/, 'handler sem copy_validation_failed');
  assert.match(handler, /copy_schema_invalid/, 'handler sem copy_schema_invalid');
  const terms = code(`${WORKER}/src/llm/forbidden-terms.ts`);
  assert.match(terms, /FORBIDDEN_TERMS/, 'lista de termos proibidos ausente');
  const validate = code(`${WORKER}/src/llm/validate-copy.ts`);
  assert.match(validate, /number_not_in_facts/, 'validação sem number_not_in_facts');
  assert.match(validate, /chars_over_limit/, 'validação sem chars_over_limit');
  assert.match(validate, /forbidden_term/, 'validação sem forbidden_term');
  const store = code(`${WORKER}/src/render/store.ts`);
  assert.match(store, /ext/, 'store save sem parâmetro de extensão');
  const config = code(`${WORKER}/src/config.ts`);
  for (const variable of ['CREATOR_LLM_BASE_URL', 'CREATOR_LLM_API_KEY', 'CREATOR_LLM_MODEL',
    'CREATOR_LLM_BUDGET_PER_SECOND', 'CREATOR_PULSO_DATA_DIR'])
    assert.match(config, new RegExp(variable), `config sem ${variable}`);
  vitest(['gate-fc012-llm.test.ts', 'gate-fc012-slidecopy.test.ts'], 10);
});

