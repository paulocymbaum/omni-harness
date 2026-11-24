// Gates FC-004 — fila Postgres creator_jobs e worker Node 22 (pistas llm/render, leases, idempotência, rodízio por conta).
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-004 --baseline
// .NET exige o SDK e FLUXO_TEST_POSTGRES. Os gates do worker rodam o Vitest DENTRO de services/creator-worker (templates em
// quality/test/delivery/fc-worker/), com npm ci se faltar node_modules, e falham (não pulam) sem ambiente. Nunca tocam em services/debate-worker.
//
// Contrato de ligação fixado pelos gates (a spec não dá assinaturas; ver os cabeçalhos dos templates):
//   .NET:   CreatorJobQueue.EnqueueAsync/CancelQueuedForProjectAsync/JobsAheadAsync, CreatorJobRequest preenchido por nome (GateFc004QueueTests.cs).
//   worker: loadConfig(env), createPgQueue(pool, config), createWorker({ pool, config, handlers?, workerId? }) com start()/stop(), JobFailure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  APPSETTINGS, CREATOR_DIR, ROOT, assertEnumsEverywhere, ensurePackageInstalled, exists, keyPaths, read, runDotnetGate, runPackageVitest, stripComments, walk,
} from './fc-gate-helper.mjs';

const WORKER = 'services/creator-worker';
const WORKER_ENUMS = `${WORKER}/src/domain/creator-job-enums.ts`;
const SQL = 'backend/deploy/sql/creator-jobs.sql';
const MIGRATIONS = 'backend/src/Exemplo SaaS.Api/Infrastructure/Persistence/Migrations';
const ENTRYPOINT = 'backend/deploy/migrator/entrypoint.sh';
const QUEUE_FILES = [`${CREATOR_DIR}/Application/CreatorJobQueue.cs`, `${CREATOR_DIR}/Domain/CreatorJob.cs`];
const gate = (classes, options = {}) => runDotnetGate(classes, { byMethod: true, support: ['GateFc002Support.cs'], postgres: true, ...options });

const workerSources = () => walk(`${WORKER}/src`, (f) => f.endsWith('.ts') && !/\.test\.ts$/.test(f));
const vitest = (files, minimum, only) => runPackageVitest(WORKER, 'fc-worker',
  Object.fromEntries(['gate-fc004-support.ts', ...files].map((f) => [f, `src/${f}`])), minimum, { only });

const WIRE = {
  CreatorJobKind: ['strategy', 'slide_copy', 'vision', 'render', 'preview', 'adapt_viewport'],
  CreatorJobLane: ['llm', 'render'],
  CreatorJobStatus: ['queued', 'running', 'done', 'failed', 'expired', 'cancelled'],
};
const LANE_OF = { llm: ['strategy', 'slide_copy', 'vision'], render: ['render', 'preview', 'adapt_viewport'] };

function npmRun(script) {
  const r = spawnSync('npm', ['run', script], { cwd: path.join(ROOT, WORKER), encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.error, undefined, `npm run ${script} não executou: ${r.error?.message}`);
  assert.equal(r.status, 0, `npm run ${script} falhou:\n${`${r.stdout}\n${r.stderr}`.split('\n').slice(-30).join('\n')}`);
}

test('FC-004 enums: 3 enums de job em C# e no espelho do worker, em CANONICAL_ENUMS, sem redefinição e com lane_kind vindo de LaneOf', async () => {
  await assertEnumsEverywhere(WIRE, { tsFile: WORKER_ENUMS });
  const cs = read(`${CREATOR_DIR}/Domain/CreatorEnums.cs`);
  assert.match(cs, /CreatorJobKinds/, 'CreatorJobKinds ausente');
  assert.match(cs, /LaneOf\s*\(/, 'CreatorJobKinds.LaneOf ausente');
  assert.match(cs, /CreatorJobPriorities/, 'CreatorJobPriorities ausente');
  const redefinitions = workerSources().filter((f) => f !== WORKER_ENUMS)
    .filter((f) => /\b(?:enum|class|type|interface|const)\s+CreatorJob(?:Kind|Lane|Status)\b/.test(read(f)));
  assert.deepEqual(redefinitions, [], 'o worker redefine enums de job fora de creator-job-enums.ts');
  const sql = read(SQL);
  const start = sql.indexOf('ck_creator_jobs_lane_kind');
  assert.ok(start >= 0, 'creator-jobs.sql sem ck_creator_jobs_lane_kind');
  const block = sql.slice(start, start + 600);
  for (const [lane, kinds] of Object.entries(LANE_OF)) for (const kind of kinds) assert.match(block, new RegExp(`'${kind}'`), `lane_kind sem ${kind} (pista ${lane})`);
});

test('FC-004 schema: tabela, colunas, CHECKs, índices e únicos do contrato, e cada INSERT inválido bate na constraint certa', () => {
  assert.ok(exists(SQL), 'creator-jobs.sql ausente');
  const migrations = walk(MIGRATIONS, (f) => /_CreatorJobs(\.Designer)?\.cs$/.test(f));
  assert.equal(migrations.length, 2, 'migration EF CreatorJobs (.cs e .Designer.cs) ausente');
  assert.match(read(`${MIGRATIONS}/Exemplo SaaSDbContextModelSnapshot.cs`), /creator_jobs/, 'snapshot do EF sem creator_jobs');
  assert.match(read('backend/src/Exemplo SaaS.Api/Infrastructure/Persistence/CreatorConfigurations.cs'), /CreatorJobConfiguration/, 'CreatorJobConfiguration ausente');
  assert.match(read('backend/src/Exemplo SaaS.Api/Infrastructure/Persistence/Exemplo SaaSDbContext.cs'), /DbSet<CreatorJob>\s+CreatorJobs/, 'DbSet CreatorJobs ausente');
  const entry = read(ENTRYPOINT);
  const own = entry.indexOf('apply_with_role "${SQL_DIR}/creator-jobs.sql"');
  assert.ok(own > 0, 'entrypoint.sh não aplica creator-jobs.sql');
  assert.ok(own < entry.indexOf('apply_with_role "${SQL_DIR}/grant-runtime.sql"'), 'creator-jobs.sql precisa vir antes de grant-runtime.sql');
  gate({ GateFc004SchemaTests: ['Table_columns_checks_and_indexes_match_the_contract_and_invalid_rows_hit_the_right_constraint', 'Idempotency_and_dedupe_keys_are_unique_where_the_contract_says_and_businesses_cascade'] },
    { requiredFiles: [`${CREATOR_DIR}/Domain/CreatorJob.cs`] });
});

test('FC-004 sql-paridade: creator-jobs.sql em banco vazio dá o mesmo catálogo da migration e roda duas vezes sem erro', () => {
  assert.ok(exists(SQL), 'creator-jobs.sql ausente');
  gate({ GateFc004SchemaTests: ['Sql_script_is_idempotent_and_produces_the_same_catalog_as_the_migration'] }, { requiredFiles: [`${CREATOR_DIR}/Domain/CreatorJob.cs`] });
});

test('FC-004 grants: worker lê e atualiza só creator_jobs; role ausente não derruba o grant; api runtime tem as quatro operações', () => {
  const bootstrap = read('backend/deploy/sql/bootstrap-roles.sql');
  assert.match(bootstrap, /fluxo_creator_worker_runtime/, 'bootstrap-roles.sql sem o role do worker');
  assert.match(bootstrap, /fluxo_creator_worker_runtime[\s\S]{0,200}NOLOGIN/, 'role do worker deve ser NOLOGIN');
  assert.match(bootstrap, /ALTER ROLE fluxo_creator_worker_runtime SET search_path = pg_catalog/, 'role do worker sem search_path = pg_catalog');
  const grants = read('backend/deploy/sql/grant-runtime.sql');
  assert.match(grants, /fluxo\.creator_jobs/, 'grant-runtime.sql sem creator_jobs na lista do runtime da API');
  assert.match(grants, /IF EXISTS \(SELECT 1 FROM pg_catalog\.pg_roles WHERE rolname = 'fluxo_creator_worker_runtime'\)/, 'GRANT do worker precisa estar sob IF EXISTS do role');
  const tester = read('backend/deploy/migrator/test-entrypoint.sh');
  for (const piece of ['creator_jobs', 'fluxo_creator_worker_runtime', 'has_table_privilege']) assert.ok(tester.includes(piece), `test-entrypoint.sh sem ${piece}`);
  gate({ GateFc004SchemaTests: ['Worker_role_reads_and_updates_only_creator_jobs_and_a_missing_role_never_breaks_the_grant'] }, { requiredFiles: [`${CREATOR_DIR}/Domain/CreatorJob.cs`] });
});

test('FC-004 idempotencia-dedupe: mesma chave cria 1 linha, escopo por conta, pista pelo kind, expiração da configuração, dedupe e corrida', () => {
  gate({
    GateFc004QueueTests: ['Same_idempotency_key_creates_one_row_and_keys_are_scoped_by_business', 'Lane_comes_from_the_kind_and_expiry_attempts_and_deadline_come_from_creator_queue_options',
      'Dedupe_key_cancels_the_queued_job_as_superseded_and_never_touches_a_running_one', 'Replaying_an_idempotent_request_that_carries_a_dedupe_key_returns_the_live_job_and_does_not_supersede_it', 'Racing_enqueues_with_one_dedupe_key_end_with_exactly_one_queued_job_and_no_error',
      'Oversized_payload_and_unknown_business_are_refused_without_leaving_a_row'],
  }, { requiredFiles: QUEUE_FILES });
});

test('FC-004 cancelar: CancelQueuedForProjectAsync cancela só queued da conta e do projeto, e JobsAheadAsync conta quem está na frente', () => {
  gate({ GateFc004QueueTests: ['Cancel_marks_only_queued_jobs_of_the_project_and_lets_running_ones_finish', 'Jobs_ahead_counts_older_queued_jobs_of_the_same_lane_that_are_ready'] },
    { requiredFiles: QUEUE_FILES });
});

test('FC-004 claim-concorrente: N workers disputando M jobs, cada um sai uma vez com attempts 1, e o teto por conta é estrito entre réplicas', () => {
  vitest(['gate-fc004-queue.test.ts'], 2, 'FC-004 claim-concorrente');
});

test('FC-004 pistas: pico de 4 na llm e 1 na render, pista cheia não bloqueia a outra, e o registro padrão falha com handler_not_implemented', () => {
  vitest(['gate-fc004-worker.test.ts'], 3, 'FC-004 pistas');
});

test('FC-004 rodizio: conta pequena é atendida antes de a grande esgotar e conta com 3 running não recebe o 4º', () => {
  vitest(['gate-fc004-queue.test.ts'], 3, 'FC-004 rodizio');
});

test('FC-004 prioridade: prévia antes de padrão e lote, fora do teto da conta e fora da contagem do rodízio', () => {
  vitest(['gate-fc004-queue.test.ts'], 3, 'FC-004 prioridade');
});

test('FC-004 attempts: tentativa sobe na retirada, worker que morre vira worker_crash, retentável volta com backoff 2 s e 6 s', () => {
  vitest(['gate-fc004-queue.test.ts'], 4, 'FC-004 attempts');
});

test('FC-004 lease: batimento renova, lease perdida é ignorada, queued vencido vira expired, release não gasta tentativa', () => {
  vitest(['gate-fc004-queue.test.ts'], 5, 'FC-004 lease');
});

test('FC-004 circuito: 5 falhas de provedor abrem o llm, render segue, meio-aberto testa com 1 job e falha de validação não conta', () => {
  vitest(['gate-fc004-worker.test.ts'], 5, 'FC-004 circuito');
});

test('FC-004 parada-graciosa: SIGTERM para de retirar, devolve o job em voo com attempts decrementado e encerra dentro da espera', () => {
  vitest(['gate-fc004-worker.test.ts'], 3, 'FC-004 parada-graciosa');
});

test('FC-004 sem-hardcode: padrões só em config.ts, variável citada na falha, Creator:Queue validado e /config inalterado', () => {
  assert.ok(exists(`${WORKER}/src/config.ts`), 'config.ts ausente');
  const others = workerSources().filter((f) => !/\/(config|index)\.ts$/.test(f));
  const envReaders = others.filter((f) => /process\.env/.test(stripComments(read(f))));
  assert.deepEqual(envReaders, [], 'process.env só em config.ts e index.ts');
  const literals = others.filter((f) => /['"]2,\s*6['"]|\[\s*2\s*,\s*6\s*\]|\b(60_?000|15_?000|45_?000|30_?000)\b/.test(stripComments(read(f))));
  assert.deepEqual(literals, [], 'padrão de tempo ou de backoff fora de config.ts');
  const queue = JSON.parse(read(APPSETTINGS)).Creator?.Queue;
  // Chaves canônicas do Creator:Queue (FC-004: fila/prazo; FC-005: capacidade/ETA/varredura/concorrência).
  assert.deepEqual(queue, {
    MaxAttempts: 3, JobExpiryMinutes: 15, PreviewExpirySeconds: 10, JobDeadlineSeconds: 120,
    CapacityEtaSeconds: 450, CapacityMaxQueuedPerReplica: 150, Replicas: 1, EtaWindowMinutes: 10,
    EtaDefaultLlmSeconds: 30, EtaDefaultRenderSeconds: 20, LaneConcurrencyLlm: 4, LaneConcurrencyRender: 1,
    ExpiryPollSeconds: 15,
  }, 'appsettings Creator:Queue');
  assert.match(read(`${CREATOR_DIR}/CreatorOptions.cs`), /CreatorQueueOptions/, 'CreatorQueueOptions ausente');
  const jobFiles = walk(CREATOR_DIR, (f) => /\/CreatorJob[^/]*\.cs$/.test(f));
  assert.ok(jobFiles.length > 0, 'arquivos CreatorJob* ausentes');
  // CreatorJobAdmission.cs (FC-005) carrega o clamp 1..900 do Retry-After — outro 900, documentado na spec da
  // FC-005 e em CreatorOptions (não é prazo nem expiração de job). Os demais 120/900 continuam proibidos fora de CreatorOptions.cs.
  const hardcodeFiles = jobFiles
    .filter((f) => !f.endsWith('CreatorJobAdmission.cs'))
    .filter((f) => /\b(120|900)\b/.test(stripComments(read(f))));
  assert.deepEqual(hardcodeFiles, [], 'prazo ou expiração como literal fora de CreatorOptions.cs');
  gate({
    GateFc004QueueTests: ['Invalid_creator_queue_options_stop_the_startup', 'Config_response_does_not_gain_queue_fields'],
    GateFc001ApiTests: ['Payload_carries_every_limit_viewport_and_enum_from_the_spec'],
  }, { requiredFiles: QUEUE_FILES });
  vitest(['gate-fc004-config.test.ts'], 4, 'FC-004 sem-hardcode');
});

test('FC-004 privacidade: nada de payload em log, erro sem corpo do provedor e payload acima de 64 KiB rejeitado', () => {
  const offenders = workerSources().filter((f) => stripComments(read(f)).split('\n').some((line) => /\b(console|logger|log)\b[^;]*\bpayload\b/i.test(line)));
  assert.deepEqual(offenders, [], 'linha de log que menciona payload');
  assert.ok(workerSources().length > 0, 'código do worker ausente');
  vitest(['gate-fc004-worker.test.ts'], 1, 'FC-004 privacidade');
  gate({ GateFc004SchemaTests: ['Table_columns_checks_and_indexes_match_the_contract_and_invalid_rows_hit_the_right_constraint'] }, { requiredFiles: [`${CREATOR_DIR}/Domain/CreatorJob.cs`] });
});

test('FC-004 qualidade-worker: typecheck, lint e build verdes e dist/index.js gerado', () => {
  ensurePackageInstalled(WORKER);
  const pkg = JSON.parse(read(`${WORKER}/package.json`));
  assert.equal(pkg.name, '@fluxo/creator-worker');
  assert.equal(pkg.type, 'module');
  assert.match(pkg.engines?.node ?? '', /22/);
  // FC-006: o motor de render entra no worker — @fluxo/creator-render (file:), satori, react e @resvg/resvg-js
  // (peer deps do pacote, agora dependencies aqui). sharp segue proibido: o selo IA é TS puro.
  for (const dep of ['pg', 'zod', '@fluxo/creator-render', 'satori', '@resvg/resvg-js', 'react']) assert.ok(pkg.dependencies?.[dep], `dependência ${dep} ausente`);
  for (const forbidden of ['sharp']) assert.ok(!pkg.dependencies?.[forbidden], `${forbidden} não entra no worker nesta tarefa`);
  assert.ok(!exists(`${WORKER}/Dockerfile`), 'Dockerfile é de FC-007');
  for (const script of ['typecheck', 'lint', 'build']) npmRun(script);
  assert.ok(exists(`${WORKER}/dist/index.cjs`), 'build não gerou dist/index.cjs');
});

test('FC-004 testes-do-pacote: npm test do worker verde com ao menos um teste do implementador', () => {
  ensurePackageInstalled(WORKER);
  const r = spawnSync('npm', ['test', '--', '--reporter=json', `--outputFile=${path.join(ROOT, WORKER, 'node_modules/.gate-report.json')}`], { cwd: path.join(ROOT, WORKER), encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.status, 0, `npm test falhou:\n${`${r.stdout}\n${r.stderr}`.split('\n').slice(-30).join('\n')}`);
  const report = JSON.parse(fs.readFileSync(path.join(ROOT, WORKER, 'node_modules/.gate-report.json'), 'utf8'));
  assert.ok(report.numPassedTests >= 1, 'o pacote precisa ter testes próprios');
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests ?? 0, 0, 'teste pulado não conta');
});

test('FC-004 camada: creator-worker registrado em quality/config (layers e thresholds) com README próprio', () => {
  const layers = JSON.parse(read('quality/config/layers.json')).layers;
  const index = layers.findIndex((l) => l.id === 'creator-worker');
  assert.ok(index >= 0, 'layers.json sem a camada creator-worker');
  assert.deepEqual(layers[index].globs, [`${WORKER}/**`]);
  assert.equal(layers[index].doc, `${WORKER}/README.md`);
  assert.ok(index < layers.findIndex((l) => l.id === 'docs'), 'a camada precisa vir antes de docs (a primeira que casa vence)');
  assert.equal(JSON.parse(read('quality/config/thresholds.json')).diffCoverage?.['creator-worker'], 85);
  const readme = read(`${WORKER}/README.md`);
  for (const piece of ['FC-005', 'FC-006', 'FC-012', 'CREATOR_DATABASE_URL']) assert.ok(readme.includes(piece), `README do worker sem ${piece}`);
});

test('FC-004 docs: README do backend, ponteiro e correções no desenho (§5.5.3)', () => {
  assert.match(read('backend/README.md'), /^#+ .*Creator.*FC-004/m, 'backend/README.md sem a seção "Creator — FC-004 (fila creator_jobs)"');
  const design = read('docs/parking-lot/fluxo-creator.md');
  assert.match(design, /FC-004/, 'desenho sem o ponteiro "implementado em FC-004"');
  assert.match(design, /deadline_at[^\n]*(primeira retirada|first)/i, 'desenho sem a correção de deadline_at (preenchido na primeira retirada)');
  assert.match(design, /business_id[^\n]*(varchar|character varying)/i, 'desenho sem a correção de business_id (varchar)');
  assert.ok(keyPaths(JSON.parse(read(APPSETTINGS)).Creator ?? {}).includes('Queue'), 'appsettings sem Creator:Queue');
});

test('FC-004 sem-regressao-fc001: os 7 enums do FC-001, o config-api, a política de papéis e o contrato do módulo seguem verdes', async () => {
  await assertEnumsEverywhere({
    CreatorViewportPreset: ['feed_square', 'feed_portrait', 'story', 'landscape'], WatermarkCorner: ['top_left', 'top_right', 'bottom_left', 'bottom_right'],
    CreatorProjectKind: ['single', 'carousel'], SlideRole: ['hook', 'context', 'data', 'body', 'cta'], SlideTaskStatus: ['queued', 'running', 'validated', 'rendered', 'failed'],
    CreatorMemberRole: ['owner', 'admin', 'editor', 'viewer'], CreatorPermission: ['creator.read', 'creator.create', 'creator.export', 'creator.brandkit.manage'],
  });
  assert.ok(exists(`${CREATOR_DIR}/Domain/CreatorEnums.cs`));
  assert.ok(exists(`${CREATOR_DIR}/Domain/CreatorJob.cs`), 'FC-004 ainda não implementada: o gate só vale com o módulo de jobs presente');
  runDotnetGate({
    GateFc001ApiTests: ['Payload_carries_every_limit_viewport_and_enum_from_the_spec', 'Response_never_exposes_document_or_email_fields', 'Owner_admin_editor_viewer_get_200_with_their_permissions'],
    GateFc001PolicyTests: ['Can_follows_the_role_matrix_for_all_sixteen_cells'],
    GateFc001TeamTests: ['RequireMemberAsync_is_public_and_RequireAccessAsync_stays_closed'],
  }, { byMethod: true, postgres: true });
});
