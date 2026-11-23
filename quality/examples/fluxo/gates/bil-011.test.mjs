// Gates BIL-011 — NFS-e por cobrança e falha fiscal visível. Asaas de mentira e configuração fictícia: nenhum gate fala com o Asaas nem com prefeitura.
// Emissão real depende de inscrição municipal e dos dados do contador: fica em BIL-011-SANDBOX-NFSE, manual e sem aprovação aqui.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-31-billing-asaas-mercadopago BIL-011 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BILLING_DIR, exists, read, runDotnetGate, walk } from './bil-gate-helper.mjs';

const FISCAL = `${BILLING_DIR}/Fiscal`;
const OPTIONS = { support: ['GateBil007Support.cs', 'GateBil009Support.cs', 'GateBil010Support.cs', 'GateBil011Support.cs'], excludeBroken: false };
// Mesmos arquivos da spec, menos o emissor do Asaas: ver handoff, ele não pode citar `payment` fora de Gateways/Asaas.
const FILES = ['IFiscalDocumentIssuer.cs', 'NoopFiscalDocumentIssuer.cs', 'FiscalOptions.cs', 'FiscalDocumentService.cs'].map((f) => `${FISCAL}/${f}`);

function assertFiles() {
  assert.deepEqual(FILES.filter((f) => !exists(f)), [], 'arquivos fiscais ausentes');
}

test('BIL-011 eventos-fiscais: cada evento aplica o estado consultado, com quarentena e visão do admin', () => {
  runDotnetGate({
    GateBil011EventTests: [
      'Each_event_applies_the_consulted_state', 'Authorized_records_number_and_links_and_the_portal_sees_the_link_only_then', 'Divergence_from_the_local_document_goes_to_quarantine',
      'Out_of_order_events_follow_the_consulted_state_and_repeating_changes_nothing', 'Admin_list_shows_the_fiscal_state_under_billing_read',
    ],
  }, OPTIONS);
});

test('BIL-011 eventos-fiscais: envelope lê a nota, telas mostram o estado e o RUNBOOK assina os eventos', () => {
  assert.match(read(`${BILLING_DIR}/Gateways/Asaas/AsaasWebhookEnvelope.cs`), /"invoice"/, 'envelope não lê invoice');
  assert.match(read('admin-web/src/modules/billing/presentation/InvoicesPage.tsx'), /fiscalStatus/);
  assert.match(read('ofluxo_site/src/platform/presentation/pages/billing/subscription-portal-page.tsx'), /fiscalPdfUrl/);
  const runbook = read('docs/billing/RUNBOOK_BILLING.md');
  assert.match(runbook, /INVOICE_AUTHORIZED/);
  assert.match(read('docs/billing/FLUXO_BILLING_ARQUITETURA.md'), /POST \/v3\/invoices/);
});

test('BIL-011 emissao-unica: uma nota por fatura paga, com retomada e fora de transação', () => {
  runDotnetGate({
    GateBil011EmissionTests: [
      'Paid_invoice_gets_one_pending_document_and_the_job_emits_with_the_contract_body', 'Offset_of_the_effective_date_comes_from_configuration', 'Repeated_event_and_repeated_job_make_one_document_and_one_note',
      'Failure_after_creating_resumes_without_a_second_note', 'Disabled_uses_the_noop_issuer_writes_nothing_and_turning_it_on_is_not_retroactive', 'Zero_value_and_manual_plan_generate_no_document',
      'Provider_is_called_with_no_transaction_open',
    ],
  }, OPTIONS);
});

test('BIL-011 emissao-unica: migration, SQL espelho, grants, e nenhum nome do Asaas fora de Gateways/Asaas', () => {
  const sql = read('backend/deploy/sql/billing-fiscal.sql');
  assert.match(sql, /IF NOT EXISTS/);
  assert.match(sql, /__EFMigrationsHistory/);
  assert.match(read('backend/deploy/sql/grant-runtime.sql'), /billing_fiscal_documents/);
  assert.equal(walk('backend/src/Fluxo.Api', (f) => /_BillingFiscalDocuments\.cs$/.test(f)).length, 1, 'migration <ts>_BillingFiscalDocuments ausente');
  const entrypoint = read('backend/deploy/migrator/entrypoint.sh');
  assert.ok(entrypoint.indexOf('billing-mvp.sql') < entrypoint.indexOf('billing-fiscal.sql'));
  assert.ok(entrypoint.indexOf('billing-fiscal.sql') < entrypoint.indexOf('"${SQL_DIR}/grant-runtime.sql"'));
  assert.match(read(`${BILLING_DIR}/Domain/BillingEnums.cs`), /enum\s+BillingFiscalDocumentStatus\b/);
  const outside = walk(BILLING_DIR, (f) => f.endsWith('.cs') && !f.startsWith(`${BILLING_DIR}/Gateways/Asaas/`));
  assert.deepEqual(outside.filter((f) => /payment/i.test(read(f))), [], 'mesma regra de BIL-002-SEM-PAYMENTS e BIL-007-CONTRATO-GATEWAY');
  assert.deepEqual(walk(BILLING_DIR, (f) => f.endsWith('.cs')).filter((f) => /Outbox/.test(read(f))), []);
});

test('BIL-011 falha-nao-corta: falha fiscal nunca altera assinatura, fatura paga nem plano', () => {
  runDotnetGate({
    GateBil011FailureTests: [
      'Fiscal_error_changes_neither_subscription_nor_invoice_nor_plan', 'Five_network_failures_exhaust_the_attempts_without_touching_the_plan_or_logging_personal_data',
      'Admin_retry_returns_to_pending_with_permission_reason_audit_and_no_provider_call',
    ],
  }, OPTIONS);
});

test('BIL-011 sem-aliquota-literal: nenhuma alíquota nem código de serviço em código ou appsettings', () => {
  assertFiles();
  const code = walk(FISCAL, (f) => f.endsWith('.cs'));
  assert.ok(code.length >= FILES.length, 'varredura vazia não prova nada');
  assert.deepEqual(code.filter((f) => /"(iss|cofins|csll|inss|ir|pis)"\s*[:=]|[0-9]+[.,][0-9]+ *%/.test(read(f))), []);
  for (const file of ['appsettings.json', 'appsettings.Development.json']) {
    assert.doesNotMatch(read(`backend/src/Fluxo.Api/${file}`), /MunicipalService|"Taxes"|"Fiscal"/, file);
  }
});

test('BIL-011 config-falha-fechada: ligada com configuração incompleta não sobe', () => {
  runDotnetGate({
    GateBil011ConfigTests: [
      'Enabled_with_a_missing_field_refuses_to_start', 'Enabled_with_both_service_ids_refuses_to_start', 'Complete_starts_with_the_asaas_issuer_and_disabled_needs_no_field',
    ],
  }, OPTIONS);
});
