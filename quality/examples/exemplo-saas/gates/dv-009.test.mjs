// Gates DV-009 — pós-debate: reprocessamento Soniox assíncrono, relatório do debate, job de cards e debate_costs;
// e as pendências herdadas da DV-005 (webSearchRequests persistido) e da DV-007 (custos, latência fala→afirmação e
// taxa de correção da IA no relatório operacional e na DebateReportPage).
// ANTES da implementação cada gate DEVE falhar:
//   node quality/delivery/eval.mjs docs/entregas/2026-10-21-debate-ao-vivo DV-009 --baseline
//
// Escopo: DebateStatus/DebateStateMachine (reprocessing, revised, archive), debate_costs, IDebateOutboxHandler,
// DebateOutboxPump, a timeline e o relatório operacional base já existem (DV-002, DV-007, DV-008) e têm testes próprios.
// Tudo offline: Soniox falso (fixture de tokens), gcloud falso no PATH, Postgres descartável em FLUXO_TEST_POSTGRES,
// emulador Firestore em FIRESTORE_EMULATOR_HOST, fetch falso no Vitest.
// Templates do próprio gate: dv-009-dotnet/ (copiados só durante a execução).
// Casos nomeados são escritos pelo implementador com o título/método exato listado aqui.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, runDotnetWithTemplate, runFakeGcloud } from './dv-009-gate-helper.mjs';
import { runVitestMarkers, WORKER } from './dv-worker-gate-helper.mjs';
import { runSiteNamedCases } from './dv-008-gate-helper.mjs';
import { runNamedCases } from './dv-006-vitest-helper.mjs';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const D = 'src/platform/domain';
const I = 'src/platform/infrastructure';
const P = 'src/platform/presentation/pages';

// ── DV-009-REVISION-LINKS ────────────────────────────────────────────────────

test('DV-009 revision-links: casamento revisada→ao vivo e reprocessamento sem quebrar afirmações e checagens', () => {
  runDotnetWithTemplate('DebateDv009RevisionGateTests.cs', 'DebateDv009RevisionGateTests', {
    DebateUtteranceRevisionMatcherTests: [
      'Partial_overlap_above_threshold_links_to_live',
      'Overlap_below_0_3_s_or_half_of_shorter_is_unlinked',
      'One_revised_covering_two_live_maps_both_live_to_it',
      'Revised_without_overlap_has_no_participant_and_needs_confirmation',
      'Tie_picks_lowest_live_seq',
      'Speaker_is_majority_by_time_of_overlapping_live',
    ],
    DebateReprocessJourneyTests: [
      'Claims_and_checks_keep_ids_after_reprocess',
      'No_live_utterance_is_deleted_or_changed',
      'Rerun_with_same_provider_job_id_replaces_revised_set',
      'Quote_mismatch_created_for_validated_card_with_diverging_number_or_name',
    ],
  });
});

// ── DV-009-REPORT-VALIDATED-ONLY ─────────────────────────────────────────────

test('DV-009 report-validated-only: relatório permanente só com cards validados; archive, snapshot e 404 de teste', () => {
  runDotnetWithTemplate('DebateDv009ReportGateTests.cs', 'DebateDv009ReportGateTests', {
    DebateReportTests: [
      'Only_validated_cards_enter_report',
      'Balloon_expired_not_validated_unpublished_discarded_and_unvalidated_manual_are_absent',
      'Corrections_are_listed_with_reason',
      'Stretch_without_revised_falls_back_to_live_marked_origin_live',
      'Replies_are_empty_until_dv011',
      'Test_debate_report_is_404',
      'Archive_without_revised_and_without_skip_reason_returns_409',
    ],
  }, { firestore: true });
});

// ── DV-009-COSTS ─────────────────────────────────────────────────────────────

test('DV-009 costs: consolidação de debate_costs, webSearchRequests persistido e relatório operacional com custos', () => {
  const appsettings = JSON.parse(read('backend/src/Exemplo SaaS.Api/appsettings.json'));
  const rates = appsettings?.Debates?.CostRates;
  assert.ok(rates && typeof rates === 'object', 'appsettings.json sem Debates:CostRates (tabela de preços versionada)');
  assert.ok(typeof (rates.Version ?? rates.version ?? rates.RatesVersion) === 'string', 'Debates:CostRates sem versão');
  runDotnetWithTemplate('DebateDv009CostsGateTests.cs', 'DebateDv009CostsGateTests', {
    DebateCostConsolidatorTests: [
      'Sums_asr_live_and_async_minutes',
      'Groups_input_and_output_tokens_by_model',
      'Counts_searches_including_web_search_requests',
      'Prices_each_item_with_versioned_rates',
      'Upsert_by_debate_and_rates_version_is_idempotent',
    ],
    DebateReportTests: [
      'Operational_report_brings_detailed_costs',
      'Operational_report_brings_utterance_to_claim_latency',
      'Operational_report_brings_ai_correction_rate',
    ],
  });
});

// ── DV-009-SCHEMA ────────────────────────────────────────────────────────────

test('DV-009 schema: debates-post.sql e migration DebatesPost com snapshot do relatório, debate_cards e grants', () => {
  const sql = read('backend/deploy/sql/debates-post.sql');
  assert.match(sql, /create table[^;]*\bdebate_report_snapshots\b[\s\S]*?\breport_json\b[\s\S]*?\bjsonb\b/i);
  assert.match(sql, /create table[^;]*\bdebate_cards\b[\s\S]*?\bsha256\b[\s\S]*?\bobject_path\b|create table[^;]*\bdebate_cards\b[\s\S]*?\bobject_path\b[\s\S]*?\bsha256\b/i);
  assert.match(sql, /\bweb_search_requests\b/i, 'coluna aditiva web_search_requests em debate_ai_runs (pendência DV-005)');
  const grants = read('backend/deploy/sql/grant-runtime.sql');
  assert.match(grants, /debate_report_snapshots/);
  assert.match(grants, /debate_cards/);
  const migrations = fs.readdirSync(path.join(ROOT, 'backend/src/Exemplo SaaS.Api/Infrastructure/Persistence/Migrations'));
  assert.ok(migrations.some((f) => /^\d+_DebatesPost\.cs$/.test(f)), 'migration EF DebatesPost ausente');
});

// ── DV-009-WORKER ────────────────────────────────────────────────────────────

test('DV-009 worker: soniox-async com fixture, conversão em falas, envio à API e cards PNG sem balão', () => {
  for (const rel of ['src/asr/soniox-async.ts', 'src/reprocess/index.ts']) {
    assert.ok(fs.existsSync(path.join(WORKER, rel)), `services/debate-worker/${rel} ausente`);
  }
  assert.ok(fs.existsSync(path.join(WORKER, 'src/cards')), 'services/debate-worker/src/cards ausente');
  assert.match(fs.readFileSync(path.join(WORKER, '.env.example'), 'utf8'), /^SONIOX_ASYNC_MODEL=stt-async-v5$/m);
  const pkg = JSON.parse(fs.readFileSync(path.join(WORKER, 'package.json'), 'utf8'));
  for (const dep of ['satori', '@resvg/resvg-js']) assert.ok(pkg.dependencies?.[dep], `dependência ${dep} ausente no worker`);
  assert.match(JSON.stringify(pkg.scripts ?? {}), /debate:reprocess/, 'comando debate:reprocess ausente');
  runVitestMarkers([
    'DV-009 SONIOX-ASYNC-REQUEST',
    'DV-009 SONIOX-ASYNC-POLL',
    'DV-009 SONIOX-ASYNC-CLEANUP',
    'DV-009 REPROCESS-UTTERANCES',
    'DV-009 REPROCESS-API',
    'DV-009 REPROCESS-AI-RUN',
    'DV-009 REPROCESS-CLI-FAKE-ASR',
    'DV-009 CARDS-PNG-DIMENSIONS',
    'DV-009 CARDS-NO-BALLOON',
    'DV-009 CARDS-PALETTE-TOKENS',
    'DV-009 CARDS-UPLOAD',
  ]);
});

// ── DV-009-WEB-REPORT ────────────────────────────────────────────────────────

/** Trecho do JSX a partir do atributo path até o próximo path. */
function routeSegment(src, routePath) {
  const re = new RegExp(`path=\\{?["'\`]/?${routePath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}["'\`]`);
  const m = re.exec(src);
  assert.ok(m, `fluxo-platform.tsx sem a rota ${routePath}`);
  const rest = src.slice(m.index + m[0].length);
  const next = rest.search(/\bpath=/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('DV-009 web-report: schema sem balão, leitura com ETag, visão arquivada sem polling e página de metodologia', () => {
  const segment = routeSegment(read('ofluxo_site/src/platform/fluxo-platform.tsx'), 'pulso/debates/:slug/metodologia');
  assert.match(segment, /<RequireIdentityVerified\b/, 'metodologia precisa de RequireIdentityVerified');
  runSiteNamedCases({
    [`${D}/debate-report.test.ts`]: [
      'relatório com display balloon é rejeitado',
      'relatório com card validado, correção e replies vazio é aceito',
    ],
    [`${I}/debate-report.test.ts`]: [
      'envia If-None-Match e 304 mantém o relatório anterior',
    ],
    [`${P}/debate-report-view.test.tsx`]: [
      'mostra a transcrição revisada por bloco e marca trecho ao vivo',
      'cards validados aparecem no minuto original',
      'seção Correções lista selo anterior, novo e motivo',
      'não faz polling',
      'link Metodologia e correções aponta para methodology_url',
    ],
    [`${P}/debate-timeline-page.test.tsx`]: [
      'public_mode archived renderiza a visão do relatório e para o polling',
    ],
    [`${P}/debate-methodology-page.test.tsx`]: [
      'mostra a metodologia e o histórico de correções do debate',
    ],
  });
});

// ── DV-009-ADMIN-REPORT ──────────────────────────────────────────────────────

test('DV-009 admin-report: DebateReportPage com custos, latência, correção da IA, reprocessar, arquivar e cards', () => {
  assert.ok(exists('admin-web/src/modules/debates/presentation/DebateReportPage.tsx'));
  runNamedCases({
    'src/modules/debates/presentation/DebateReportPage.test.tsx': [
      'costs null mostra estado vazio sem erro',
      'mostra custos de ASR ao vivo e assíncrono, tokens por modelo e buscas',
      'mostra latência fala→afirmação e taxa de correção da IA',
      'Reprocessar chama reprocess com Idempotency-Key e mostra o estado do reprocessamento',
      'Arquivar sem revisada exige skip_reason',
      'Cards pede download-url só ao baixar',
      'link para a página permanente do debate',
    ],
  });
});

// ── DV-009-JOB-DEPLOY ────────────────────────────────────────────────────────

test('DV-009 job-deploy: deploy-debates.sh implanta fluxo-debate-cards com a SA recebida e sem acesso público', () => {
  const script = 'backend/deploy/jobs/deploy-debates.sh';
  assert.ok(exists(script), `${script} ausente`);
  assert.doesNotMatch(read(script), /--allow-unauthenticated/);
  const bad = runFakeGcloud(script, ['proj']);
  assert.notEqual(bad.status, 0, 'sem os 4 argumentos o script deve sair com erro');
  assert.equal(bad.calls.length, 0, 'sem os 4 argumentos nada é implantado');

  const r = runFakeGcloud(script, ['gate-proj', 'southamerica-east1', 'gate-registry/worker:sha', 'cards-sa@gate.iam.gserviceaccount.com']);
  assert.equal(r.status, 0, `deploy-debates.sh falhou: ${r.stderr}`);
  const call = r.calls.find((a) => a.slice(0, 3).join(' ') === 'run jobs deploy' && a[3] === 'fluxo-debate-cards');
  assert.ok(call, `gcloud run jobs deploy fluxo-debate-cards não foi chamado: ${JSON.stringify(r.calls)}`);
  const text = call.join(' ');
  const flag = (name, value) => new RegExp(`--${name}(=| )${value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\s|$)`).test(text);
  assert.ok(flag('service-account', 'cards-sa@gate.iam.gserviceaccount.com'), 'usa a SA recebida');
  assert.ok(flag('image', 'gate-registry/worker:sha'), 'usa a imagem do worker recebida');
  assert.ok(flag('project', 'gate-proj') && flag('region', 'southamerica-east1'));
  assert.ok(flag('tasks', '1') && flag('memory', '1Gi') && flag('task-timeout', '15m'));
  assert.match(text, /--max-retries(=| )\d/);
  assert.match(text, /--mode=cards/, 'o job roda a imagem do worker em --mode=cards');
  assert.ok(!r.calls.flat().includes('--allow-unauthenticated'));
  assert.match(read('backend/deploy/jobs/deploy.sh'), /usage: deploy\.sh PROJECT_ID REGION IMAGE JOBS_RUNTIME_SA/,
    'deploy.sh existente mantém a assinatura');
});
