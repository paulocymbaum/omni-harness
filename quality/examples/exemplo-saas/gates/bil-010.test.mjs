// Gates BIL-010 — Pix Automático, QR de contingência, retentativas e inadimplência. Asaas de mentira em memória e HTTP falso em host .invalid: nenhum gate
// fala com o Asaas. O que depende de Pix Automático real fica em BIL-010-CONTA-PIX-AUTOMATICO, manual e sem aprovação aqui.
// Exige FLUXO_TEST_POSTGRES. Compila antes da implementação: tipos novos só por SQL, HTTP e nome de rota.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-31-billing-asaas-mercadopago BIL-010 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { BILLING_DIR, exists, read, runDotnetGate, walk } from './bil-gate-helper.mjs';
import { buildApi, runApi } from './bil-006-gate-helper.mjs';

const OPTIONS = { support: ['GateBil007Support.cs', 'GateBil010Support.cs'], excludeBroken: false };
const SITE = 'ofluxo_site/src/platform/presentation/pages/billing';

test('BIL-010 retentativas-limites: nenhuma sequência passa de 3 datas, de D+7 ou do valor original', () => {
  runDotnetGate({
    GateBil010RetryTests: ['Sequence_stays_inside_the_limits', 'Random_sequences_never_break_the_limits', 'Rejection_400_records_the_code_and_stops_the_invoice', 'Attempts_are_recorded_once_per_number'],
  }, OPTIONS);
});

test('BIL-010 eventos-pix-automatico: Jornada 3 e cada evento da tabela', () => {
  runDotnetGate({
    GateBil010EventTests: [
      'Flag_off_keeps_the_manual_checkout_and_never_opens_an_authorization', 'Authorization_goes_as_manual_without_value_with_three_in_seven_days',
      'Charge_answers_the_qr_of_the_authorization_without_a_psp_id_beyond_it', 'Paid_releases_the_plan_and_only_activated_turns_the_instrument_on',
      'Refused_before_paying_revokes_and_stays_incomplete', 'Refused_after_paying_keeps_the_plan_without_refund_and_falls_back_to_manual',
      'Canceled_at_the_bank_is_reflected_without_a_click_and_never_becomes_past_due_inside_the_paid_cycle', 'Instruction_events_record_the_attempt_and_do_not_move_the_subscription',
      'Ineligible_account_logs_and_blocks_new_authorizations', 'Psp_refusing_the_authorization_is_treated_as_ineligible', 'Repeated_event_makes_one_transition',
      'Past_due_subscription_can_be_canceled_by_the_portal',
    ],
  }, OPTIONS);
});

test('BIL-010 eventos-pix-automatico: flag de Pix Automático nasce desligada, no código', () => {
  const options = read(`${BILLING_DIR}/BillingOptions.cs`);
  assert.match(options, /public\s+bool\s+PixAutomaticoEnabled\s*\{\s*get;\s*set;\s*\}\s*$/m, 'padrão false, sem inicializador');
});

test('BIL-010 correlacao-primeira-cobranca: uma candidata vincula, zero ou duas ficam em quarentena', () => {
  runDotnetGate({
    GateBil010CorrelationTests: [
      'One_candidate_links_and_activates', 'Two_candidates_stay_in_quarantine_without_transition', 'No_candidate_stays_in_quarantine_without_transition',
      'Conciliation_identifier_decides_between_two_candidates', 'Event_of_a_charge_the_psp_does_not_know_is_still_ignored',
    ],
  }, OPTIONS);
});

test('BIL-010 qr-mesma-cobranca: QR sempre da mesma cobrança, sem débito em dobro', () => {
  runDotnetGate({
    GateBil010QrTests: [
      'Charges_on_a_recurrence_invoice_read_the_qr_and_never_create_a_second_charge', 'Qr_stays_available_on_an_overdue_invoice',
      'Answer_warns_when_the_provider_blocks_another_way_of_paying', 'Paying_by_qr_with_both_events_in_any_order_makes_one_transition',
    ],
  }, OPTIONS);
});

test('BIL-010 qr-mesma-cobranca: portal explica a espera e tem o passo de autorização', () => {
  assert.ok(exists(`${SITE}/pix-automatico-step.tsx`), 'pix-automatico-step.tsx ausente');
  assert.match(read(`${SITE}/subscription-portal-page.tsx`), /qrBlockedUntil/);
});

test('BIL-010 carencia-sem-corte: past_due mantém o plano, fim da carência não apaga dado', () => {
  runDotnetGate({
    GateBil010GraceTests: [
      'Day_one_late_is_past_due_with_grace_keeping_the_plan', 'End_of_grace_falls_to_presenca_cancels_at_the_psp_and_erases_nothing',
      'Paying_during_the_grace_returns_to_active_keeps_the_period_start_and_stops_the_retries', 'Manual_rail_has_grace_without_retries',
      'Past_due_notice_reaches_the_owner_once_with_a_stable_id',
    ],
  }, OPTIONS);
});

test('BIL-010 job-idempotente: repetir, perder o dia ou correr junto não duplica', () => {
  runDotnetGate({
    GateBil010JobTests: [
      'Renewal_at_seven_days_charges_on_the_authorization_with_the_period_end_as_due_date', 'Repeating_both_jobs_does_not_duplicate_invoice_charge_or_retry',
      'Period_unique_index_blocks_a_second_invoice_even_without_the_job', 'Late_job_goes_as_manual_for_that_cycle_and_keeps_the_instruction_window', 'Pending_cancellation_does_not_renew',
      'Manual_plan_and_zero_value_do_not_invoice', 'Two_jobs_at_once_make_one_charge', 'Upgrade_makes_a_prorated_invoice_without_touching_the_psp',
      'Downgrade_waits_for_the_end_of_the_cycle_and_past_due_refuses_any_change',
    ],
  }, OPTIONS);
});

test('BIL-010 job-idempotente: migration, SQL espelho, grants e textos exigidos pela arquitetura', () => {
  const sql = read('backend/deploy/sql/billing-recurrence.sql');
  assert.match(sql, /IF NOT EXISTS/, 'SQL do migrador precisa ser idempotente');
  assert.match(sql, /__EFMigrationsHistory/);
  for (const table of ['billing_instruments', 'billing_dunning_attempts']) {
    assert.match(sql, new RegExp(table));
    assert.match(read('backend/deploy/sql/grant-runtime.sql'), new RegExp(table));
  }
  assert.equal(walk('backend/src/Exemplo SaaS.Api', (f) => /_BillingRecurrence\.cs$/.test(f)).length, 1, 'migration <ts>_BillingRecurrence ausente');
  const entrypoint = read('backend/deploy/migrator/entrypoint.sh');
  assert.ok(entrypoint.indexOf('billing-mvp.sql') < entrypoint.indexOf('billing-recurrence.sql'));
  assert.ok(entrypoint.indexOf('billing-recurrence.sql') < entrypoint.indexOf('"${SQL_DIR}/grant-runtime.sql"'));
  const architecture = read('docs/billing/FLUXO_BILLING_ARQUITETURA.md');
  for (const text of ['D-5', 'paymentCreationMode', 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_REFUSED', 'ALLOW_THREE_IN_SEVEN_DAYS']) assert.ok(architecture.includes(text), text);
  const runbook = read('docs/billing/RUNBOOK_BILLING.md');
  for (const job of ['billing-renew', 'billing-dunning']) assert.ok(runbook.includes(job), `RUNBOOK sem ${job}`);
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

test('BIL-010 job-idempotente: desligado encerra com 0 sem conexão, e ligado abre', async () => {
  buildApi();
  for (const job of ['--job=billing-renew', '--job=billing-dunning']) {
    const database = await sentinel();
    try {
      const off = await runApi([job], { environment: 'Testing', waitMs: 12_000, env: { Database__Port: String(database.port), Billing__Enabled: 'false' } });
      const where = `${job}:\n${off.log.split('\n').slice(-8).join('\n')}`;
      assert.equal(off.timedOut, false, `não encerrou em ${where}`);
      assert.equal(off.code, 0, `saiu com ${off.code} em ${where}`);
      assert.equal(database.state.connections, 0, `abriu banco com Billing:Enabled=false em ${where}`);
      await runApi([job], { environment: 'Testing', waitMs: 12_000, env: { Database__Port: String(database.port), Billing__Enabled: 'true', Billing__Provider: 'stub' } });
      assert.ok(database.state.connections > 0, `job ligado não abriu banco em ${job}`);
    } finally {
      await database.close();
    }
  }
});

test('BIL-010 psp-fora-da-transacao: nenhuma chamada ao PSP com transação aberta', () => {
  runDotnetGate({ GateBil010TransactionTests: ['Sensor_sees_a_transaction_left_open', 'Whole_recurrence_calls_the_psp_with_no_transaction_open'] }, OPTIONS);
});

test('BIL-010 psp-fora-da-transacao: porta nova, nome do Asaas restrito e sem outbox', () => {
  const port = read(`${BILLING_DIR}/Gateways/IBillingGateway.cs`);
  for (const method of ['CreateRecurrenceAuthorizationAsync', 'GetRecurrenceAuthorizationAsync', 'CancelRecurrenceAsync', 'CreateRecurrenceChargeAsync', 'GetRecurrenceInstructionAsync', 'CreateRecurrenceRetryAsync', 'GetChargeQrAsync']) {
    assert.match(port, new RegExp(`\\b${method}\\(`), method);
  }
  const files = walk(BILLING_DIR, (f) => f.endsWith('.cs'));
  assert.deepEqual(files.filter((f) => !f.startsWith(`${BILLING_DIR}/Gateways/Asaas/`) && /payment/i.test(read(f))), []);
  assert.deepEqual(files.filter((f) => /Outbox/.test(read(f))), []);
  assert.ok(files.some((f) => /RecurrenceService|RenewalService|DunningService/.test(f)), 'serviços de recorrência ausentes');
});
