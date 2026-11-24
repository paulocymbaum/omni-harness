// Gates BIL-005 — cifragem e HMAC de dados fiscais. Chaves geradas no teste e documento fictício.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-31-billing-asaas-mercadopago BIL-005 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BILLING_DIR, read, runDotnetGate, walk } from './bil-gate-helper.mjs';

const PROTECTOR = 'backend/src/Exemplo SaaS.Api/Infrastructure/Security/SensitiveDataProtector.cs';

test('BIL-005 cripto: ida e volta, adulteração, AAD, rotação e envelope da Function', () => {
  runDotnetGate({
    GateBil005CryptoTests: [
      'Round_trip_preserves_text_and_keeps_the_envelope_format', 'Same_value_gives_distinct_envelopes_and_same_blind_value',
      'Wrong_aad_tampering_and_unknown_header_are_refused', 'Old_key_still_decrypts_after_rotation_and_new_envelopes_use_the_active_key',
      'Envelope_built_like_the_function_is_accepted_with_the_key_id_added', 'Business_exposes_normalize_and_mask_with_the_current_format',
    ],
  }, {
    existing: [
      'DomainTests.Verification_request_requires_a_valid_cnpj', 'DomainTests.Verification_request_moves_business_to_pending',
      'DomainTests.Verification_request_accepts_alphanumeric_cnpj', 'DomainTests.Verification_request_normalizes_case_and_punctuation_of_alphanumeric_cnpj',
      'DomainTests.Verification_request_rejects_alphanumeric_cnpj_with_invalid_length',
    ],
  });
});

test('BIL-005 cripto: usa AesGcm, sem Data Protection nem Cloud KMS', () => {
  const source = read(PROTECTOR);
  assert.match(source, /\bAesGcm\b/);
  assert.doesNotMatch(source, /DataProtection|Google\.Cloud\.Kms|KeyManagementService/);
});

test('BIL-005 so-mascara: resposta, log, banco e auditoria nunca trazem o valor claro', () => {
  runDotnetGate({
    GateBil005MaskTests: [
      'Put_and_get_expose_only_the_mask_and_never_log_the_value',
      'Database_keeps_ciphertext_hmac_and_mask_and_audit_keeps_only_the_mask',
      'Invalid_tax_id_is_refused', 'Same_tax_id_may_belong_to_more_than_one_registration',
    ],
  });
});

test('BIL-005 so-mascara: só BillingCustomerService decifra e DTO usa taxId', () => {
  const files = walk('backend/src/Exemplo SaaS.Api', (f) => f.endsWith('.cs'));
  const callers = files.filter((f) => /\.Unprotect\(/.test(read(f)));
  assert.deepEqual(callers, [`${BILLING_DIR}/Application/BillingCustomerService.cs`]);
  const contracts = `${read(`${BILLING_DIR}/Contracts/Requests.cs`)}\n${read(`${BILLING_DIR}/Contracts/Responses.cs`)}`;
  assert.match(contracts, /\bTaxIdMasked\b/);
  assert.doesNotMatch(contracts, /\b[Cc]npj\b/, 'DTO usa taxId, nunca cnpj');
});

test('BIL-005 falha-fechada: produção com Billing ligado não sobe sem chave válida', () => {
  runDotnetGate({
    GateBil005BootTests: [
      'Production_with_billing_on_refuses_to_start_without_keys', 'Production_with_billing_on_refuses_a_short_encryption_key',
      'Production_with_billing_on_refuses_a_short_hmac_key', 'Production_with_billing_off_starts_without_keys',
    ],
  });
});
