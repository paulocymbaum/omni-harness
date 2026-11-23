// Gates BIL-016 — matriz de entitlements e aplicação só em recurso novo. BIL-002-ENTITLEMENT-SEM-CORTE fica como está e roda de novo aqui.
// .NET exige FLUXO_TEST_POSTGRES. Rotas de BIL-013 e BIL-014 ainda não existem: o marcador é provado em rota de mentira pelo pipeline real
// (GateBil016Support.cs), e a lista de rotas previstas fica em `planned` de quality/config/plan-gated-routes.json.
// quality/config/plan-baseline-routes.json nasce de bil-016-baseline-routes.mjs, no commit a3f4b116, e o hash abaixo impede retoque depois.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-31-billing-asaas-mercadopago BIL-016 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { BILLING_DIR, DELIVERY, ROOT, exists, read, runDotnetGate, runVitestTemplates, walk } from './bil-gate-helper.mjs';

const OPTIONS = { support: ['GateBil007Support.cs', 'GateBil016Support.cs'], excludeBroken: false };
const API = 'backend/src/Fluxo.Api';
const BASELINE = 'quality/config/plan-baseline-routes.json';
const MARKER = `${API}/Infrastructure/Security/RequiresPlanFeature.cs`;
const BASELINE_SHA256 = '8ae3d44ec07e2dbc052e433d60da5c0c250b7198ad32452f0646e0baa3e1d307';
const MVP_SQL_SHA256 = 'a8768bae8369456527a8af29d08ee1befd5d764cfb2f22638a5c46be79c998c9';
const sha256 = (rel) => createHash('sha256').update(read(rel)).digest('hex');

function requireMarker() {
  assert.ok(exists(MARKER), `arquivo ausente: ${MARKER}`);
}

test('BIL-016 so-recurso-novo: marcação só nas rotas do manifesto, nenhuma delas anterior a a3f4b116', () => {
  runDotnetGate({
    GateBil016RoutesTests: [
      'Marked_routes_are_exactly_the_manifest', 'No_marked_or_planned_route_existed_at_the_reference_commit',
      'A_route_of_the_baseline_with_the_marker_is_caught', 'Planned_routes_are_the_two_of_the_spec_and_carry_the_marker_once_they_exist',
    ],
  }, OPTIONS);
});

test('BIL-016 so-recurso-novo: a base de rotas é a do commit a3f4b116, sem retoque', () => {
  requireMarker();
  const baseline = JSON.parse(read(BASELINE));
  assert.equal(baseline.commit, execFileSync('git', ['rev-parse', 'a3f4b116'], { cwd: ROOT, encoding: 'utf8' }).trim());
  assert.match(baseline.command, /bil-016-baseline-routes\.mjs/, 'o arquivo registra o comando que o gerou');
  assert.equal(sha256(BASELINE), BASELINE_SHA256);
  assert.deepEqual(baseline.routes.filter((route) => /mercado-pago|merchant-pix/.test(route)), []);
});

test('BIL-016 so-recurso-novo: BIL-002-ENTITLEMENT-SEM-CORTE segue igual e verde', () => {
  requireMarker();
  const rel = 'quality/test/delivery/bil-002.test.mjs';
  const block = (source) => source.slice(source.indexOf("test('BIL-002 entitlement-sem-corte:"), source.indexOf("test('BIL-002 risco-critico:"));
  const original = execFileSync('git', ['show', `a3f4b116:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.ok(block(original).length > 100, 'bloco do gate não encontrado no commit de referência');
  assert.equal(block(read(rel)), block(original), 'o teste do gate não pode mudar');
  const backlog = JSON.parse(read(`${DELIVERY}/backlog.json`));
  assert.deepEqual(backlog.gates.find((g) => g.id === 'BIL-002-ENTITLEMENT-SEM-CORTE'), {
    id: 'BIL-002-ENTITLEMENT-SEM-CORTE', task: 'BIL-002', type: 'command',
    command: ['node', '--test', '--test-name-pattern=^BIL-002 entitlement-sem-corte:', rel],
  });
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const run = spawnSync('node', ['--test', '--test-name-pattern=^BIL-002 entitlement-sem-corte:', rel], { cwd: ROOT, encoding: 'utf8', env, timeout: 30_000 });
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /# pass 1\b/, 'o gate precisa ter rodado de verdade');
});

test('BIL-016 so-recurso-novo: fora de Billing ninguém conhece Billing, nem por fachada', () => {
  requireMarker();
  assert.match(read(MARKER), /record\s+RequiresPlanFeature\s*\(\s*string\s+Key\s*,\s*string\s+BusinessIdRouteValue\s*=\s*"businessId"\s*\)/);
  assert.doesNotMatch(read(MARKER), /Modules\.Billing|Entitlement/, 'o marcador é neutro');
  // Persistência mapeia as tabelas e Program registra o módulo: o que já era assim antes desta entrega.
  const allowed = (f) => f === `${API}/Program.cs` || f.startsWith(`${API}/Infrastructure/Persistence/`);
  const outside = walk(API, (f) => f.endsWith('.cs') && !f.startsWith(`${BILLING_DIR}/`) && !allowed(f));
  assert.ok(outside.length > 100, 'varredura vazia não prova nada');
  assert.deepEqual(outside.filter((f) => /Modules\.Billing/.test(read(f))), [], 'consumir Billing por outro nome contorna BIL-002-ENTITLEMENT-SEM-CORTE');
});

test('BIL-016 so-recurso-novo: nenhuma regra por nome de plano em código de produto', () => {
  requireMarker();
  const modules = walk(`${API}/Modules`, (f) => f.endsWith('.cs') && !f.startsWith(`${BILLING_DIR}/`));
  assert.ok(modules.length > 50, 'varredura vazia não prova nada');
  assert.deepEqual(modules.filter((f) => /PlanCode ==|planCode ===|"pro"|"rede"/.test(read(f))), []);
});

test('BIL-016 so-recurso-novo: arquitetura e runbook registram que limite de recurso existente não é aplicado', () => {
  requireMarker();
  assert.match(read('docs/billing/FLUXO_BILLING_ARQUITETURA.md'), /limites? de recurso existente/i);
  assert.match(read('docs/billing/RUNBOOK_BILLING.md'), /billing-entitlement-matrix\.sql/);
});

test('BIL-016 recursos-existentes-intactos: rota existente responde igual em todo estado de plano', () => {
  runDotnetGate({
    GateBil016ExistingTests: ['Existing_routes_answer_the_same_with_no_plan_presenca_canceled_and_paid', 'Catalog_limit_of_the_matrix_is_not_applied_to_the_existing_menu'],
  }, OPTIONS);
});

test('BIL-016 recursos-existentes-intactos: modo manual de Pix e Functions não conhecem a chave nova', () => {
  requireMarker();
  const code = walk('functions/src', (f) => f.endsWith('.ts'));
  assert.ok(code.length > 20, 'varredura vazia não prova nada');
  assert.deepEqual(code.filter((f) => /integracao_psp/.test(read(f))), []);
});

test('BIL-016 middleware-falha-fechada: libera por plano, recusa por plano, e falha fechada sem Billing ou sem banco', () => {
  runDotnetGate({
    GateBil016MiddlewareTests: [
      'Local_opens_and_presenca_is_refused_with_the_key_and_plan', 'No_subscription_is_refused_as_presenca', 'Past_due_keeps_the_new_feature_and_canceled_loses_it_keeping_the_data',
      'Manual_plan_opens_the_feature_for_the_pilot', 'Values_decide_true_or_nonzero_open_the_rest_refuses', 'Billing_off_refuses_with_feature_unavailable_without_opening_the_database',
      'Database_down_fails_closed_with_503_and_unmarked_route_does_not_touch_it', 'Plan_feature_value_is_neutral_and_lives_with_the_marker',
    ],
  }, OPTIONS);
});

test('BIL-016 middleware-falha-fechada: ordem no Program, depois do worker e antes do limite de corpo', () => {
  const program = read(`${API}/Program.cs`);
  const at = (name) => program.search(new RegExp(`app\\.UseMiddleware<[\\w.]*\\b${name}>\\(\\)`));
  assert.notEqual(at('PlanFeatureMiddleware'), -1, 'Program.cs sem PlanFeatureMiddleware');
  assert.ok(at('WorkerOidcMiddleware') < at('PlanFeatureMiddleware'));
  assert.ok(at('PlanFeatureMiddleware') < at('RequestBodyLimitMiddleware'));
});

test('BIL-016 matriz-idempotente: carga exata, repetível, sem tocar produto nem preço', () => {
  runDotnetGate({
    GateBil016MatrixTests: ['Load_has_exactly_the_matrix_of_the_spec', 'Second_run_keeps_changed_values_and_restores_only_what_is_missing', 'Load_does_not_touch_products_or_prices'],
  }, OPTIONS);
});

test('BIL-016 matriz-idempotente: SQL em transação, sem esquema, depois de billing-mvp.sql, e billing-mvp.sql intacto', () => {
  const sql = read('backend/deploy/sql/billing-entitlement-matrix.sql');
  assert.match(sql, /^\s*BEGIN;/m);
  assert.match(sql, /^\s*COMMIT;/m);
  assert.match(sql, /ON CONFLICT\s*\(\s*product_id\s*,\s*key\s*\)\s*DO NOTHING/i);
  assert.doesNotMatch(sql, /\b(ALTER|CREATE|DROP)\s+TABLE\b|\bUPDATE\s+fluxo\.billing_(products|prices)\b/i);
  assert.equal(sha256('backend/deploy/sql/billing-mvp.sql'), MVP_SQL_SHA256, 'billing-mvp.sql não muda, para não mexer em BIL-002-ESQUEMA-ESPELHO');
  const entrypoint = read('backend/deploy/migrator/entrypoint.sh');
  const matrix = entrypoint.indexOf('billing-entitlement-matrix.sql');
  assert.notEqual(matrix, -1, 'entrypoint.sh sem a carga');
  assert.ok(entrypoint.indexOf('billing-mvp.sql') < matrix);
  assert.ok(matrix < entrypoint.indexOf('"${SQL_DIR}/grant-runtime.sql"'));
});

test('BIL-016 catalogo-sem-promessa: catálogo anônimo só com chave aplicada e admin com a matriz', () => {
  runDotnetGate({
    GateBil016CatalogTests: [
      'Anonymous_catalog_brings_only_the_sellable_features_and_keeps_the_prices', 'Catalog_without_a_token_still_answers_200_and_inactive_plan_stays_out',
      'Admin_subject_shows_the_matrix_with_its_class_under_billing_read',
    ],
  }, OPTIONS);
});

test('BIL-016 catalogo-sem-promessa: site mostra só o que features traz', () => {
  assert.match(read('ofluxo_site/src/platform/domain/billing-contracts.ts'), /features\s*:/, 'contrato do site sem features');
  runVitestTemplates('ofluxo_site', { 'GateBil016Plans.test.tsx': 'src/platform/presentation/pages/billing/GateBil016Plans.test.tsx' }, 4);
});

test('BIL-016 catalogo-sem-promessa: portal e admin leem a mesma matriz', () => {
  assert.match(read('ofluxo_site/src/platform/presentation/pages/billing/subscription-portal-page.tsx'), /features/, 'portal sem features');
  assert.match(read('admin-web/src/modules/billing/domain/contracts.ts'), /entitlements\s*:/, 'contrato do admin sem entitlements');
  assert.match(read('admin-web/src/modules/billing/presentation/ManualPlanPage.tsx'), /entitlements/, 'admin sem a matriz em leitura');
});
