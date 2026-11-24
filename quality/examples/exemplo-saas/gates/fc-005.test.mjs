// Gates FC-005 — limites de taxa, timeouts, expiração com estorno e push, guarda de memória do worker.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-005 --baseline
// .NET exige o SDK e FLUXO_TEST_POSTGRES (banco fluxo_debates_test); os gates do worker rodam o Vitest DENTRO de
// services/creator-worker (templates em quality/test/delivery/fc-worker/, padrão FC-004), com npm ci se faltar
// node_modules. Nunca tocam em services/debate-worker. Valores sintéticos (`gate-*`).
// Fora do eval (manual-pendente): calibração dos valores no piloto C0 e envio FCM (não existe no repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPSETTINGS, exists, read, requireEnv, runDotnetGate, runPackageVitest, stripComments, walk,
} from './fc-gate-helper.mjs';

const WORKER = 'services/creator-worker';
const GUARD = `${WORKER}/src/guard/memory-guard.ts`;
const CONFIG = `${WORKER}/src/config.ts`;
const ADMISSION = 'backend/src/Exemplo SaaS.Api/Modules/Creator/Application/CreatorJobAdmission.cs';
const NOTIFIER = 'backend/src/Exemplo SaaS.Api/Modules/Creator/Application/CreatorJobExpiryNotifier.cs';
const TRAFFIC = 'backend/src/Exemplo SaaS.Api/Infrastructure/Traffic/ApiTrafficControlExtensions.cs';
const TRAFFIC_CREATOR = 'backend/src/Exemplo SaaS.Api/Infrastructure/Traffic/ApiTrafficCreatorPolicies.cs';
const SPEC = 'docs/entregas/2026-11-14-fluxo-creator/specs/FC-005.md';
const SUPPORT = ['GateFc002Support.cs'];
const gate = (classes, options = {}) => runDotnetGate(classes, { byMethod: true, support: SUPPORT, postgres: true, ...options });
const vitest = (files, minimum) => runPackageVitest(WORKER, 'fc-worker',
  Object.fromEntries(['gate-fc004-support.ts', ...files].map((f) => [f, `src/${f}`])), minimum);
const code = (file) => stripComments(read(file));
const appsettingsFiles = () => walk('backend/src/Exemplo SaaS.Api', (f) => /(^|\/)appsettings[^/]*\.json$/.test(f));

// ───────────────────────── guarda de memória ─────────────────────────

test('FC-005 memoria: guard de cgroup v2/v1 com pausa em 85%, fail-open com aviso único, e ligado só na pista render', () => {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL de teste para a integração do worker');
  assert.ok(exists(GUARD), 'src/guard/memory-guard.ts ausente');
  const guard = code(GUARD);
  assert.match(guard, /memory\.max/, 'guard sem leitura do cgroup v2 (memory.max)');
  assert.match(guard, /memory\.limit_in_bytes|memory\.usage_in_bytes/, 'guard sem fallback do cgroup v1');
  assert.match(guard, /onFallback|fallback/i, 'guard sem aviso único de fail-open');
  const config = code(CONFIG);
  assert.match(config, /CREATOR_MEMORY_PAUSE_PERCENT/, 'config sem CREATOR_MEMORY_PAUSE_PERCENT');
  const worker = code(`${WORKER}/src/worker.ts`);
  assert.match(worker, /renderClaimGuard/, 'worker sem a guarda própria da pista render');
  assert.match(code(`${WORKER}/src/index.ts`), /[Mm]emory[Gg]uard/, 'index.ts não constrói a guarda de memória');
  vitest(['gate-fc005-memory.test.ts'], 6);
});

// ───────────────────────── timeouts por trecho ─────────────────────────

test('FC-005 timeouts: teto por kind (45/30/30/20/3/20 s) aborta o handler com kind_timeout; deadline aborta job_deadline', () => {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL de teste para a integração do worker');
  const config = code(CONFIG);
  for (const variable of ['CREATOR_TIMEOUT_STRATEGY_MS', 'CREATOR_TIMEOUT_SLIDE_COPY_MS', 'CREATOR_TIMEOUT_VISION_MS',
    'CREATOR_TIMEOUT_RENDER_MS', 'CREATOR_TIMEOUT_PREVIEW_MS', 'CREATOR_TIMEOUT_ADAPT_VIEWPORT_MS'])
    assert.match(config, new RegExp(variable), `config sem ${variable}`);
  const runner = code(`${WORKER}/src/lanes/lane-runner.ts`);
  assert.match(runner, /kind_timeout/, 'runner sem falha kind_timeout');
  assert.match(runner, /job_deadline/, 'runner sem abort por deadline_at');
  vitest(['gate-fc005-timeouts.test.ts'], 5);
});

// ───────────────────────── orçamento do LLM ─────────────────────────

test('FC-005 llm-rate: cooldown da pista llm pós Retry-After do provedor, com teto configurado e render segue', () => {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL de teste para a integração do worker');
  const config = code(CONFIG);
  assert.match(config, /CREATOR_LLM_COOLDOWN_CAP_MS/, 'config sem o teto do cooldown pós-provedor');
  const runner = code(`${WORKER}/src/lanes/lane-runner.ts`);
  assert.match(runner, /llm_cooldown|cooldown/i, 'runner sem cooldown pós-provedor');
  assert.doesNotMatch(config, /CREATOR_LLM_CLAIM_INTERVAL_MS/, 'o orçamento de 2/s é do cliente LLM (FC-012), não da retirada');
  vitest(['gate-fc005-llm-rate.test.ts'], 1);
});

// ───────────────────────── admissão ─────────────────────────

test('FC-005 admissao: teto de 30 por conta vira 429 creator.queue_full com Retry-After; ETA global e teto absoluto viram 503 creator.capacity', () => {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL 17 descartável com pgvector');
  assert.ok(exists(ADMISSION), 'Modules/Creator/Application/CreatorJobAdmission.cs ausente');
  assert.match(code(ADMISSION), /creator\.queue_full/, 'admissão sem o código creator.queue_full');
  assert.match(code(ADMISSION), /creator\.capacity/, 'admissão sem o código creator.capacity');
  gate({
    GateFc005AdmissionTests: [
      'Queue_full_at_the_cap_answers_429_with_retry_after_and_previews_do_not_count',
      'Below_the_cap_is_allowed_with_eta_seconds_from_the_lane_default',
      'Capacity_by_eta_answers_503_with_half_eta_retry_after',
      'Absolute_queue_cap_scales_with_replicas_and_answers_503',
      'Lane_history_drives_the_eta_instead_of_the_default',
    ],
  }, { requiredFiles: [ADMISSION, CONFIG] });
});

// ───────────────────────── políticas de taxa ─────────────────────────

test('FC-005 taxa: quatro políticas creator-preview/status/enqueue/upload com os valores do desenho, validadas na subida', () => {
  const settings = JSON.parse(read(APPSETTINGS));
  const creator = settings.RateLimiting?.Creator ?? {};
  for (const [name, expected] of Object.entries({
    Preview: { TokensPerSecond: 2, BurstTokens: 4 },
    Status: { TokensPerSecond: 2, BurstTokens: 4 },
    Enqueue: { TokensPerSecond: 1, BurstTokens: 3 },
    Upload: { TokensPerSecond: 1, ReplenishSeconds: 2, BurstTokens: 3 },
  })) {
    const bucket = creator[name];
    assert.ok(bucket, `RateLimiting:Creator:${name} ausente no appsettings.json`);
    for (const [key, value] of Object.entries(expected))
      assert.equal(bucket[key], value, `RateLimiting:Creator:${name}:${key} devia ser ${value}`);
  }
  assert.equal(creator.Geo?.TokensPerSecond, 8, 'creator-geo não pode mudar');
  for (const file of appsettingsFiles()) {
    if (file.endsWith('appsettings.json')) continue;
    const json = JSON.parse(read(file));
    assert.equal(json.RateLimiting?.Creator?.Enqueue, undefined, `${file}: políticas de taxa novas em arquivo de ambiente`);
  }
  const extensions = code(TRAFFIC);
  for (const name of ['creator-preview', 'creator-status', 'creator-enqueue', 'creator-upload'])
    assert.match(extensions, new RegExp(name), `ApiTrafficControlExtensions sem a política ${name}`);
  assert.match(code(TRAFFIC_CREATOR), /ReplenishSeconds/, 'balde sem período configurável (upload é 0,5 req/s)');
  gate({
    GateFc005RateTests: [
      'Startup_with_an_invalid_creator_bucket_fails_citing_the_rate_limiting_key',
      'Startup_with_the_design_defaults_boots',
      'The_four_new_creator_policy_names_exist_and_follow_the_wire_format',
      'Creator_queue_capacity_config_is_validated_at_startup_citing_the_key',
    ],
  }, { postgres: false });
});

// ───────────────────────── push de expiração ─────────────────────────

test('FC-005 notificacao: job expirado cria uma notificação por dono com id determinístico e nunca duplica', () => {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL 17 descartável com pgvector');
  assert.ok(exists(NOTIFIER), 'Modules/Creator/Application/CreatorJobExpiryNotifier.cs ausente');
  const notifier = code(NOTIFIER);
  assert.match(notifier, /creator_job_expired/, 'notificador sem o tipo creator_job_expired');
  assert.match(notifier, /ON CONFLICT/i, 'notificador sem INSERT idempotente (ON CONFLICT DO NOTHING)');
  gate({
    GateFc005NotifierTests: [
      'Expired_queue_job_notifies_each_owner_once_with_a_deterministic_id',
      'Terminal_and_non_expired_states_are_never_notified',
      'Expiry_older_than_one_day_is_ignored',
    ],
  }, { requiredFiles: [NOTIFIER] });
});

// ───────────────────────── regressão ─────────────────────────

test('FC-005 regressao: os gates da FC-004 (fila, schema e worker) e do FC-001 seguem verdes com as mudanças', () => {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL 17 descartável com pgvector');
  // Presença das entregas desta tarefa (falha na linha de base por design): sem elas, não é regressão desta tarefa.
  assert.match(code(CONFIG), /CREATOR_MEMORY_PAUSE_PERCENT/, 'config do worker sem a guarda de memória');
  assert.ok(exists(ADMISSION), 'CreatorJobAdmission.cs ausente');
  const settings = JSON.parse(read(APPSETTINGS));
  assert.ok(settings.RateLimiting?.Creator?.Enqueue, 'RateLimiting:Creator:Enqueue ausente');
  gate({
    GateFc004QueueTests: ['Same_idempotency_key_creates_one_row_and_keys_are_scoped_by_business',
      'Lane_comes_from_the_kind_and_expiry_attempts_and_deadline_come_from_creator_queue_options',
      'Cancel_marks_only_queued_jobs_of_the_project_and_lets_running_ones_finish',
      'Jobs_ahead_counts_older_queued_jobs_of_the_same_lane_that_are_ready'],
    GateFc004SchemaTests: ['Table_columns_checks_and_indexes_match_the_contract_and_invalid_rows_hit_the_right_constraint',
      'Idempotency_and_dedupe_keys_are_unique_where_the_contract_says_and_businesses_cascade'],
    GateFc001ApiTests: ['Anonymous_gets_401_and_missing_business_gets_422', 'Disabled_feature_answers_404_creator_disabled'],
  }, { requiredFiles: [ADMISSION, CONFIG] });
  vitest(['gate-fc004-worker.test.ts'], 6);
});

// ───────────────────────── documentação ─────────────────────────

test('FC-005 docs: README do worker com as variáveis novas e backend README apontando a admissão; nenhum identificador real', () => {
  const readme = read(`${WORKER}/README.md`);
  for (const variable of ['CREATOR_MEMORY_PAUSE_PERCENT', 'CREATOR_TIMEOUT_STRATEGY_MS', 'CREATOR_LLM_COOLDOWN_CAP_MS'])
    assert.ok(readme.includes(variable), `README do worker sem ${variable}`);
  assert.ok(!readme.includes('CREATOR_LLM_CLAIM_INTERVAL_MS'), 'README do worker cita o intervalo de retirada removido');
  const envExample = read(`${WORKER}/.env.example`);
  assert.ok(envExample.includes('CREATOR_MEMORY_PAUSE_PERCENT'), '.env.example sem a guarda de memória');
  const backend = read('backend/README.md');
  assert.match(backend, /CreatorJobAdmission|admiss[aã]o .*FC-005|FC-005/i, 'backend/README.md sem o ponteiro da admissão (FC-005)');
  const files = [SPEC, CONFIG, GUARD, ADMISSION, NOTIFIER, `${WORKER}/README.md`, `${WORKER}/.env.example`, 'backend/README.md', 'quality/test/delivery/fc-005.test.mjs'];
  for (const file of files) {
    assert.ok(exists(file), `arquivo ausente: ${file}`);
    // URLs postgres (usuario:senha@host) não são e-mail: o host precisa terminar em ponto + letras.
    for (const email of read(file).match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g) ?? [])
      assert.ok(email.endsWith('@example.test'), `${file}: e-mail fora do domínio reservado`);
  }
});


