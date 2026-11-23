// Gates BIL-009 — rotas e telas administrativas de assinaturas, faturas, webhooks e reprocessamento.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-31-billing-asaas-mercadopago BIL-009 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BILLING_DIR, read, runAdminVitest, runDotnetGate, runVitestTemplates } from './bil-gate-helper.mjs';

const OPTIONS = { support: ['GateBil007Support.cs', 'GateBil009Support.cs'], excludeBroken: false };
const PRESENTATION = 'admin-web/src/modules/billing/presentation';

test('BIL-009 dotnet-testes: permissões, regras de escrita, cursor, busca e saúde', () => {
  runDotnetGate({
    GateBil009AdminTests: [
      'Read_routes_answer_403_without_billing_read_and_200_with_it', 'Write_routes_demand_their_own_permission_and_recent_login',
      'Reason_outside_10_to_500_is_refused_without_audit', 'Mark_paid_demands_evidence_up_to_500_characters',
      'Mark_paid_closes_the_invoice_activates_and_audits_as_manual', 'Void_closes_the_invoice_with_audit', 'Refund_refuses_an_unpaid_charge_and_marks_a_paid_one',
      'Replay_accepts_only_the_recoverable_statuses', 'Cursor_walks_every_row_once_even_if_a_new_row_arrives', 'Search_finds_by_business_external_id_and_document_hmac',
      'Reconcile_records_its_run_and_health_shows_it',
    ],
  }, OPTIONS);
});

test('BIL-009 sem-psp-no-handler: gateway que falha ao ser tocado não é tocado por nenhuma escrita', () => {
  runDotnetGate({ GateBil009NoPspTests: ['No_write_route_touches_the_gateway'] }, OPTIONS);
});

test('BIL-009 sem-psp-no-handler: rotas e consultas não dependem de IBillingGateway', () => {
  for (const file of ['AdminBillingModule.cs', 'Application/AdminBillingQueries.cs']) {
    assert.doesNotMatch(read(`${BILLING_DIR}/${file}`), /IBillingGateway/, file);
  }
});

test('BIL-009 sem-dado-fiscal: nenhuma rota nem log traz corpo do webhook ou documento claro', () => {
  runDotnetGate({
    GateBil009FiscalTests: ['No_route_or_log_carries_raw_body_or_clear_document', 'Subscription_detail_shows_the_mask', 'Webhook_list_has_only_the_operational_fields'],
  }, OPTIONS);
});

test('BIL-009 admin-vitest: telas com e sem cada permissão, pelo template do gate', () => {
  runVitestTemplates('admin-web', { 'GateBil009Admin.test.tsx': 'src/modules/billing/presentation/GateBil009Admin.test.tsx' }, 8);
});

test('BIL-009 admin-vitest: testes de tela do implementador seguem verdes', () => {
  for (const page of ['SubscriptionsPage', 'WebhooksPage', 'InvoicesPage']) {
    const rel = `src/modules/billing/presentation/${page}.test.tsx`;
    runAdminVitest(rel, 2);
    assert.match(read(`admin-web/${rel}`), /billing\.read/, `${page}: cenário só leitura`);
  }
});

test('BIL-009 admin-vitest: rotas protegidas, menu, ações pelo cliente próprio', () => {
  const router = read('admin-web/src/app/router/AppRouter.tsx');
  for (const route of ['assinaturas/lista', 'assinaturas/:id', 'faturas', 'webhooks-cobranca']) {
    assert.match(router, new RegExp(`path:\\s*"${route}",\\s*element:\\s*protect\\("billing\\.read"`), route);
  }
  const layout = read('admin-web/src/app/layout/AdminLayout.tsx');
  for (const link of ['/assinaturas/lista', '/faturas', '/webhooks-cobranca']) assert.ok(layout.includes(link), `menu sem ${link}`);
  for (const page of ['InvoicesPage', 'WebhooksPage', 'SubscriptionDetailPage']) {
    const source = read(`${PRESENTATION}/${page}.tsx`);
    assert.match(source, /AdminActionButton/, page);
    assert.match(source, /callFn=\{callBillingApi\}/, page);
    assert.match(source, /useAdminPermission/, page);
  }
  assert.match(read(`${PRESENTATION}/WebhooksPage.tsx`), /próximo ciclo/, 'a tela avisa que o processamento fica para o próximo ciclo');
  const card = read(`${PRESENTATION}/BillingHealthCard.tsx`);
  assert.match(card, /24/);
  assert.match(card, /\b3\b/);
});
