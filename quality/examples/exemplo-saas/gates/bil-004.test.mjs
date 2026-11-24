// Gates BIL-004 — borda do webhook: bypass exato, token em tempo constante, rate limit sem IP e ingestão idempotente.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-31-billing-asaas-mercadopago BIL-004 --baseline
// Sem PSP real: o token é fictício e o processador falso é local. Exige FLUXO_TEST_POSTGRES.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BILLING_DIR, read, runDotnetGate, walk } from './bil-gate-helper.mjs';

const AUTHENTICATOR = `${BILLING_DIR}/Gateways/Asaas/AsaasWebhookAuthenticator.cs`;
const TRAFFIC = 'backend/src/Exemplo SaaS.Api/Infrastructure/Traffic/ApiTrafficControlExtensions.cs';

test('BIL-004 borda-exata: só o POST exato passa e as rotas futuras seguem fechadas', () => {
  runDotnetGate({
    GateBil004EdgeTests: [
      'Only_the_exact_post_reaches_the_webhook', 'Other_methods_stay_behind_firebase',
      'Other_paths_stay_behind_firebase', 'Webhook_paths_are_a_fixed_constant',
    ],
  }, { existing: ['ApiBoundaryTests.Unknown_future_paths_are_not_anonymous', 'ApiBoundaryTests.Every_module_denies_anonymous_requests'] });
});

test('BIL-004 borda-exata: rota fora do grupo v1 e exceção documentada', () => {
  const program = read('backend/src/Exemplo SaaS.Api/Program.cs');
  assert.match(program, /^\s*app\.MapBillingWebhookEndpoints\(\);/m);
  assert.doesNotMatch(program, /v1\.MapBillingWebhookEndpoints/);
  assert.match(read('backend/src/Exemplo SaaS.Api/Infrastructure/Security/FirebaseSecurityMiddleware.cs'), /PspWebhookPaths\.IsPspWebhook\(context\.Request\)/);
  assert.match(read('backend/README.md'), /\/webhooks\/billing\/asaas/);
  assert.match(read('.claude/skills/contratos-backend/SKILL.md'), /\/webhooks\/billing\/asaas/);
});

test('BIL-004 token-tempo-constante: rotação, recusa sem gravar e falha fechada', () => {
  runDotnetGate({
    GateBil004TokenTests: [
      'Missing_or_wrong_token_is_refused_without_a_row', 'Current_and_previous_tokens_are_accepted',
      'Without_configured_token_the_route_fails_closed',
    ],
  });
});

test('BIL-004 token-tempo-constante: compara hash em tempo constante, sem HMAC e sem ler o corpo', () => {
  const source = read(AUTHENTICATOR);
  assert.match(source, /CryptographicOperations\.FixedTimeEquals/);
  assert.match(source, /SHA256/);
  assert.match(source, /"asaas-access-token"/);
  assert.doesNotMatch(source, /HMAC/i, 'o webhook do Asaas não usa HMAC');
  assert.doesNotMatch(source, /Request\.Body|BodyReader|EnableBuffering|ReadFromJson/, 'autentica só por cabeçalho');
  assert.doesNotMatch(source, /\b\w*(token|received|recebido|header|provided)\w*\s*[!=]=\s*(?!null\b)/i, 'nada de == sobre o token');
});

test('BIL-004 rate-limit-sem-xff: partição por provedor e resultado, nunca por IP', () => {
  runDotnetGate({
    GateBil004RateLimitTests: [
      'Thirty_rejections_do_not_block_the_next_authentic_call', 'Forwarded_for_does_not_change_the_rejected_partition',
      'Forwarded_for_does_not_change_the_authentic_partition',
    ],
  });
});

test('BIL-004 rate-limit-sem-xff: política psp-webhooks com os limites padrão', () => {
  const traffic = read(TRAFFIC);
  const start = traffic.indexOf('"psp-webhooks"');
  assert.notEqual(start, -1, 'política psp-webhooks ausente');
  const options = read('backend/src/Exemplo SaaS.Api/Infrastructure/Traffic/ApiTrafficOptions.cs');
  assert.match(options, /AuthenticPermitLimit\s*\{[^}]*\}\s*=\s*600/);
  assert.match(options, /RejectedPermitLimit\s*\{[^}]*\}\s*=\s*30/);
  assert.match(read(`${BILLING_DIR}/BillingWebhooksModule.cs`), /RequireRateLimiting\(/);
});

test('BIL-004 dedup: idempotência sob concorrência, com chave por id ou hash do corpo', () => {
  runDotnetGate({
    GateBil004DedupTests: [
      'Same_event_twice_keeps_one_row_and_answers_200_twice', 'Concurrent_deliveries_of_one_event_keep_one_row',
      'Row_keeps_raw_body_and_provider_and_is_left_pending_without_a_processor', 'Event_without_id_is_deduplicated_by_body_hash',
      'Table_has_the_unique_key_and_the_status_index',
    ],
  });
});

test('BIL-004 corpo-e-falhas: limite de corpo, JSON inválido, falha do processador e banco fora', () => {
  runDotnetGate({
    GateBil004FailureTests: [
      'Body_above_one_mebibyte_is_refused', 'Authentic_invalid_json_is_kept_as_parse_failed_and_never_logged',
      'Processor_failure_answers_200_and_keeps_the_event_pending_without_body_in_last_error',
      'Database_down_answers_503_so_the_psp_retries',
    ],
  });
});

test('BIL-004 sem-outbox: a ingestão aplica na requisição, sem outbox nem segundo plano', () => {
  const files = [
    `${BILLING_DIR}/BillingWebhooksModule.cs`,
    `${BILLING_DIR}/Application/WebhookIngestionService.cs`,
    `${BILLING_DIR}/Application/IBillingEventProcessor.cs`,
  ];
  for (const file of files) {
    assert.doesNotMatch(read(file), /Outbox|Task\.Run\(|BackgroundService/, file);
  }
  // BIL-007 substitui o processador adiado de BIL-004 por BillingEventProcessor (ver specs/BIL-004.md).
  const processors = walk(BILLING_DIR, (f) => f.endsWith('.cs')).filter((f) => /class\s+\w+\s*(\([^)]*\))?\s*:\s*IBillingEventProcessor\b/.test(read(f)));
  assert.ok(processors.length >= 1, 'implementação de IBillingEventProcessor ausente');
  for (const file of processors) assert.doesNotMatch(read(file), /Outbox/, file);
});
