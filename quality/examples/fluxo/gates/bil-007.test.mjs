// Gates BIL-007 — gateway Asaas, checkout Pix fora da transação, webhook que não libera sozinho e reconciliação.
// PSP de mentira e HTTP falso em host .invalid: nenhum gate fala com Asaas. A chave chega por configuração comum (Asaas:ApiKey,
// Asaas__ApiKey no Cloud Run); nenhum gate daqui exige secret_key_ref em tempo de execução.
// CHECKOUT-IDEMPOTENTE e ARREPENDIMENTO exigem também FIRESTORE_EMULATOR_HOST, para o caso de quem não é dono.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-31-billing-asaas-mercadopago BIL-007 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { BILLING_DIR, exists, read, requireEnv, runDotnetGate, walk } from './bil-gate-helper.mjs';
import { buildApi, runApi } from './bil-006-gate-helper.mjs';

const ASAAS = `${BILLING_DIR}/Gateways/Asaas`;
const OPTIONS = { support: ['GateBil007Support.cs'], excludeBroken: false };
const JOB = '--job=billing-reconcile';

test('BIL-007 provedor-asaas: produção aceita asaas, recusa stub e provedor desconhecido', () => {
  runDotnetGate({
    GateBil007ProviderTests: [
      'Production_accepts_the_asaas_provider_and_resolves_its_gateway', 'Production_keeps_refusing_the_stub',
      'Unknown_provider_is_refused_even_outside_production', 'Testing_with_the_stub_still_resolves_the_stub',
    ],
  }, OPTIONS);
});

test('BIL-007 contrato-gateway: payloads por fixture, access_token, centavos, sem retentativa em POST e timeout próprio', () => {
  runDotnetGate({
    GateBil007GatewayContractTests: [
      'Create_pix_posts_the_payment_reads_the_qr_and_sends_access_token', 'Value_becomes_cents_without_float_error',
      'Asaas_status_maps_to_the_canonical_vocabulary', 'Find_by_reference_uses_the_query_and_tolerates_nothing_found',
      'Customer_goes_with_the_document_and_the_document_never_reaches_logs', 'Refund_posts_once_with_the_value',
      'Post_is_never_retried_on_failure', 'Every_call_has_its_own_timeout_of_about_eight_seconds',
    ],
  }, { ...OPTIONS, implementerPrefix: 'AsaasGatewayContractTests' });
});

test('BIL-007 contrato-gateway: gateway lê IOptions e HttpClient tipado, sem cliente próprio nem Secret Manager', () => {
  const source = read(`${ASAAS}/AsaasBillingGateway.cs`);
  assert.match(source, /\bHttpClient\s+\w+/, 'HttpClient tipado injetado');
  assert.doesNotMatch(source, /new\s+HttpClient\s*\(/, 'cliente próprio escaparia do fake e do tempo limite');
  assert.doesNotMatch(source, /SecretManager/, 'a chave chega por IOptions<AsaasOptions>');
  const options = read(`${ASAAS}/AsaasOptions.cs`);
  for (const property of ['BaseUrl', 'ApiKey']) assert.match(options, new RegExp(`public\\s+string\\??\\s+${property}\\b`), `AsaasOptions sem ${property}`);
});

test('BIL-007 contrato-gateway: testes do backend só usam HTTP falso, nunca o host do Asaas', () => {
  const contract = 'backend/tests/Fluxo.Api.Tests/AsaasGatewayContractTests.cs';
  assert.ok(exists(contract), `arquivo ausente: ${contract}`);
  const files = walk('backend/tests/Fluxo.Api.Tests', (f) => f.endsWith('.cs'));
  assert.deepEqual(files.filter((f) => /\bapi(-sandbox)?\.asaas\.com\b/.test(read(f))), [], 'teste apontando para host real do Asaas');
});

test('BIL-007 contrato-gateway: nomes do Asaas ficam em Gateways/Asaas', () => {
  const outside = walk(BILLING_DIR, (f) => f.endsWith('.cs') && !f.startsWith(`${ASAAS}/`));
  assert.ok(outside.includes(`${BILLING_DIR}/Application/CheckoutService.cs`), 'CheckoutService ausente');
  assert.ok(exists(`${ASAAS}/AsaasEventMapper.cs`), 'AsaasEventMapper ausente');
  assert.deepEqual(outside.filter((f) => /payment/i.test(read(f))), []);
});

test('BIL-007 psp-fora-da-transacao: nenhuma chamada ao PSP com transação aberta, e só a rota de cobrança fica isenta', () => {
  runDotnetGate({
    GateBil007TransactionTests: [
      'Sensor_sees_a_transaction_left_open', 'Checkout_calls_the_psp_with_no_transaction_open', 'Webhook_reads_the_psp_with_no_transaction_open',
      'Charge_route_is_exempt_from_the_middleware_and_still_demands_the_key', 'Subscription_route_stays_under_the_middleware',
    ],
  }, { ...OPTIONS, existing: ['PostgresJourneyTests.Concurrent_profile_requests_commit_once_and_replay_when_postgres_is_available'] });
});

test('BIL-007 checkout-idempotente: dois passos, uma cobrança remota, também sob concorrência e na retomada', () => {
  requireEnv('FIRESTORE_EMULATOR_HOST', 'emulador Firestore: quem não é dono passa pelo fallback legado');
  runDotnetGate({
    GateBil007CheckoutTests: [
      'Flag_off_answers_404_and_writes_nothing', 'First_step_creates_incomplete_and_open_without_touching_the_psp',
      'Same_price_with_another_key_reuses_the_incomplete_subscription', 'Customer_without_fiscal_data_gets_409', 'Blocked_business_gets_409',
      'Price_that_cannot_be_sold_is_refused_and_a_valid_one_is_accepted', 'Same_key_twice_makes_one_remote_charge_and_returns_the_same_qr',
      'Concurrent_requests_with_one_key_make_one_remote_charge', 'Failure_after_remote_creation_resumes_by_reference_without_a_second_charge',
      'Closed_invoice_refuses_a_new_charge', 'Another_person_cannot_charge_the_invoice', 'Schema_has_the_client_key_columns_and_the_unique_index',
    ],
  }, OPTIONS);
});

test('BIL-007 checkout-idempotente: migration e SQL espelho entram no migrador depois da fundação', () => {
  const sql = read('backend/deploy/sql/billing-charges-client-key.sql');
  assert.match(sql, /client_key/);
  assert.match(sql, /IF NOT EXISTS/, 'SQL do migrador precisa ser idempotente');
  assert.match(sql, /__EFMigrationsHistory/);
  const migrations = walk('backend/src/Fluxo.Api', (f) => /_BillingChargeClientKey\.cs$/.test(f));
  assert.equal(migrations.length, 1, 'migration <ts>_BillingChargeClientKey ausente');
  const entrypoint = read('backend/deploy/migrator/entrypoint.sh');
  assert.ok(entrypoint.indexOf('billing-charges-client-key.sql') > entrypoint.indexOf('billing-mvp.sql'), 'entrypoint.sh aplica o SQL depois de billing-mvp.sql');
});

test('BIL-007 checkout-idempotente: IsExempt segue lista fixa, sem configuração', () => {
  const source = read('backend/src/Fluxo.Api/Infrastructure/Idempotency/IdempotencyMiddleware.cs');
  const exempt = source.slice(source.indexOf('private static bool IsExempt'), source.indexOf('private static bool IsUnsafeV1Request'));
  assert.match(exempt, /\/api\/v1\/billing\/invoices/);
  assert.match(exempt, /charges/);
  assert.doesNotMatch(exempt, /[Oo]ptions|settings|[Cc]onfiguration/, 'a lista é fixa, não configurável');
});

test('BIL-007 webhook-nao-libera-sozinho: decide pelo estado do PSP, sem outbox', () => {
  runDotnetGate({
    GateBil007WebhookTests: [
      'Paid_at_the_psp_activates_the_plan_for_one_month_with_audit', 'Yearly_price_gets_one_year', 'Divergence_from_the_local_charge_quarantines_without_transition',
      'Event_saying_received_does_not_count_while_the_psp_says_pending', 'Forged_event_with_a_valid_token_and_unknown_id_is_ignored',
      'Psp_down_answers_200_stays_pending_and_the_job_applies_it', 'Repeated_and_out_of_order_events_make_one_transition',
      'Status_follows_the_psp_and_not_the_event_type', 'Late_payment_on_a_canceled_subscription_does_not_reactivate',
      'The_whole_paid_flow_creates_no_outbox_message',
    ],
  }, OPTIONS);
});

test('BIL-007 webhook-nao-libera-sozinho: processador real no lugar do adiado, sem outbox no módulo', () => {
  const module = read(`${BILLING_DIR}/BillingWebhooksModule.cs`);
  assert.match(module, /IBillingEventProcessor,\s*BillingEventProcessor>/);
  assert.deepEqual(walk(BILLING_DIR, (f) => f.endsWith('.cs')).filter((f) => /DeferredBillingEventProcessor|Outbox/.test(read(f))), []);
});

test('BIL-007 reconcile: recolhe eventos e cobranças, expira, estorna, encerra planos e apaga corpo antigo', () => {
  runDotnetGate({
    GateBil007ReconcileTests: [
      'Old_received_events_are_recovered', 'Pending_event_with_ten_attempts_is_left_alone', 'Pending_charge_past_five_minutes_is_read_from_the_psp_and_a_recent_one_is_not',
      'Overdue_qr_expires_unless_the_psp_shows_it_paid', 'Incomplete_past_24_hours_expires_and_voids_the_invoice', 'Manual_plan_past_its_end_date_is_closed_with_audit',
      'Pending_cancellation_closes_only_at_the_end_of_the_period', 'Raw_body_older_than_180_days_is_erased_and_a_newer_one_is_kept', 'Two_jobs_at_once_refund_once',
      'Expired_key_is_logged_as_billing_psp_auth_failed_and_keeps_the_event', 'Hanging_psp_does_not_hold_the_job', 'One_failure_does_not_stop_the_other_charges',
    ],
  }, OPTIONS);
});

test('BIL-007 reconcile: execução única por advisory lock', () => {
  const source = read(`${BILLING_DIR}/Application/BillingReconcileService.cs`);
  assert.match(source, /pg_try_advisory_lock/);
});

test('BIL-007 arrependimento: até 7 dias estorna pelo job; depois, acesso até o fim do período', () => {
  requireEnv('FIRESTORE_EMULATOR_HOST', 'emulador Firestore: quem não é dono passa pelo fallback legado');
  runDotnetGate({
    GateBil007RefundTests: [
      'Within_seven_days_cancels_marks_refund_pending_and_the_job_refunds_once', 'After_seven_days_keeps_access_to_the_end_of_the_period_without_refund',
      'Another_person_cannot_cancel', 'Cancel_route_stays_under_the_middleware',
    ],
  }, OPTIONS);
});

/** Porta que conta conexões e derruba cada uma: prova de banco sem depender de um banco. */
function sentinel() {
  return new Promise((resolve, reject) => {
    const state = { connections: 0 };
    const server = net.createServer((socket) => { state.connections += 1; socket.destroy(); });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ state, port: server.address().port, close: () => new Promise((done) => server.close(done)) }));
  });
}

test('BIL-007 job-desligado: desligado encerra com 0 sem nenhuma conexão ao banco; ligado, abre', async () => {
  buildApi();
  const database = await sentinel();
  try {
    for (const environment of ['Testing', 'Production']) {
      const off = await runApi([JOB], { environment, waitMs: 15_000, env: { Database__Port: String(database.port), Billing__Enabled: 'false' } });
      const where = `${environment}:\n${off.log.split('\n').slice(-12).join('\n')}`;
      assert.equal(off.timedOut, false, `não encerrou em ${where}`);
      assert.equal(off.code, 0, `saiu com ${off.code} em ${where}`);
      assert.equal(database.state.connections, 0, `abriu banco com Billing:Enabled=false em ${where}`);
    }
    // Controle: sem isto, um job que nada faz passaria acima.
    const on = await runApi([JOB], { environment: 'Testing', waitMs: 15_000, env: { Database__Port: String(database.port), Billing__Enabled: 'true', Billing__Provider: 'stub' } });
    assert.ok(database.state.connections > 0, `job ligado não abriu banco, então a reconciliação não rodou:\n${on.log.split('\n').slice(-12).join('\n')}`);
  } finally {
    await database.close();
  }
});
