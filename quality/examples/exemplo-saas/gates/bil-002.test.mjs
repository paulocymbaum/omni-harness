// Gates BIL-002 — módulo Billing: domínio, esquema, API, nomes, entitlements, risco e enums.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-31-billing-asaas-mercadopago BIL-002 --baseline
// .NET exige FLUXO_TEST_POSTGRES (PostgreSQL 17 com pgvector); o gate de acesso legado exige também FIRESTORE_EMULATOR_HOST.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BILLING_DIR, ROOT, exists, read, requireEnv, runDotnetGate, walk } from './bil-gate-helper.mjs';

const ENUM_FILES = [
  'backend/src/Exemplo SaaS.Api/Modules/Billing/Domain/BillingEnums.cs',
  'admin-web/src/modules/billing/domain/enums.ts',
  'ofluxo_site/src/platform/domain/billing-enums.ts',
];
const ENUMS = ['BillingSubscriptionStatus', 'BillingRail', 'BillingInvoiceStatus', 'BillingChargeStatus', 'BillingProductKind', 'BillingAudience'];
const SCHEMA_FILES = ['backend/deploy/sql/billing-mvp.sql', 'backend/src/Exemplo SaaS.Api/Infrastructure/Persistence/BillingConfigurations.cs'];

test('BIL-002 dotnet-testes: domínio, API e testes do implementador', () => {
  runDotnetGate({
    GateBil002DomainTests: [
      'Enums_have_exactly_the_specified_values', 'State_machine_allows_exactly_the_specified_transitions',
      'Subscription_status_has_no_public_setter', 'Gateway_port_and_stub_match_the_contract',
      'Billing_is_off_by_default_with_the_stub_provider', 'Business_team_exposes_require_manager_without_opening_require_access',
      'Production_refuses_to_start_with_stub_provider_and_starts_when_billing_is_off',
    ],
    GateBil002ApiTests: [
      'Catalog_is_anonymous_and_lists_only_active_products', 'Catalog_stays_read_only_for_anonymous_callers',
      'Subject_routes_answer_401_to_anonymous_and_200_to_owner_and_admin_member',
      'Subject_types_other_than_business_are_not_supported', 'Business_without_subscription_resolves_to_presenca_by_default',
    ],
  }, {
    implementerPrefix: 'Billing',
    existing: ['ApiBoundaryTests.Unknown_future_paths_are_not_anonymous', 'ApiBoundaryTests.Every_module_denies_anonymous_requests'],
  });
});

test('BIL-002 dotnet-testes: só o catálogo fica anônimo e Billing nasce desligado', () => {
  const settings = JSON.parse(read('backend/src/Exemplo SaaS.Api/appsettings.json'));
  assert.deepEqual(settings.Firebase.AnonymousPaths.filter((p) => p.includes('billing')), ['/api/v1/billing/catalog']);
  assert.deepEqual(settings.Billing, { Enabled: false, Provider: 'stub', CheckoutEnabled: false });
  assert.match(read('backend/README.md'), /^#+ .*Billing/m, 'backend/README.md sem seção Billing');
});

test('BIL-002 acesso-legado: EDITOR e VIEWER recebem 403 e empresa só no Firestore autoriza pelo fallback', () => {
  requireEnv('FIRESTORE_EMULATOR_HOST', 'emulador Firestore para o fallback legado');
  runDotnetGate({
    GateBil002LegacyTests: ['Members_below_admin_are_forbidden', 'Business_only_in_firestore_authorizes_through_the_legacy_fallback'],
  });
});

test('BIL-002 esquema-espelho: migration e SQL geram o mesmo esquema, com travas e grants', () => {
  runDotnetGate({
    GateBil002SchemaTests: [
      'Migration_creates_foundation_tables_and_leaves_out_excluded_ones',
      'Duplicate_live_subscription_is_blocked_by_partial_unique_index', 'Every_enum_column_has_a_check_constraint',
      'Subject_has_no_foreign_key_and_is_unique_per_type_and_id', 'Customer_is_born_with_nullable_fiscal_columns',
      'Money_is_stored_in_bigint_cents_and_never_as_float',
      'Mvp_sql_is_idempotent_matches_ef_migration_and_seeds_inactive_paid_plans',
      'Runtime_role_only_reads_and_appends_billing_audit_events',
    ],
  });
});

test('BIL-002 esquema-espelho: migrator aplica billing-mvp.sql antes de grant-runtime.sql', () => {
  const entry = read('backend/deploy/migrator/entrypoint.sh');
  const mvp = entry.indexOf('apply_with_role "${SQL_DIR}/billing-mvp.sql"');
  assert.notEqual(mvp, -1, 'entrypoint.sh sem billing-mvp.sql');
  assert.ok(mvp < entry.indexOf('apply_with_role "${SQL_DIR}/grant-runtime.sql"'), 'billing-mvp.sql antes de grant-runtime.sql');
});

test('BIL-002 esquema-espelho: REVOKE explícito protege billing_audit_events dos privilégios padrão', () => {
  // ALTER DEFAULT PRIVILEGES dá UPDATE e DELETE ao runtime em tabela criada pelo migrator: não basta ficar fora da lista.
  const statements = read('backend/deploy/sql/grant-runtime.sql').split(';').filter((s) => s.includes('billing_audit_events'));
  const revoke = statements.find((s) => /^\s*REVOKE\s+(ALL|UPDATE,\s*DELETE)\b/m.test(s));
  assert.ok(revoke, 'grant-runtime.sql sem REVOKE UPDATE, DELETE em billing_audit_events');
  const broad = statements.filter((s) => /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE/.test(s) && s.indexOf('GRANT') < s.indexOf('billing_audit_events'));
  assert.deepEqual(broad, [], 'billing_audit_events não pode receber UPDATE ou DELETE');
});

test('BIL-002 sem-payments: nenhum nome payment no módulo nem na persistência de Billing', () => {
  const files = walk(BILLING_DIR, (f) => !f.startsWith(`${BILLING_DIR}/Gateways/Asaas/`));
  assert.ok(files.includes(`${BILLING_DIR}/BillingModule.cs`), 'módulo Billing ausente');
  const offenders = [...files, ...SCHEMA_FILES].filter((f) => /payment/i.test(f) || /payment/i.test(read(f)));
  assert.deepEqual(offenders, [], 'Billing não usa a palavra payment fora de Gateways/Asaas/');
});

test('BIL-002 sem-payments: Billing não lê os domínios de pagamento', () => {
  const files = walk(BILLING_DIR);
  assert.ok(files.length > 0, 'módulo Billing ausente');
  const offenders = files.filter((f) => /payment_requests|functions\/src\/payments|user_coordinated_payments/.test(read(f)));
  assert.deepEqual(offenders, []);
});

test('BIL-002 entitlement-sem-corte: EntitlementService existe e nenhum módulo fora de Billing o consome', () => {
  assert.ok(exists(`${BILLING_DIR}/Application/EntitlementService.cs`), 'EntitlementService ausente');
  const outside = walk('backend/src/Exemplo SaaS.Api', (f) => f.endsWith('.cs') && !f.startsWith(`${BILLING_DIR}/`))
    .filter((f) => /EntitlementService|ResolvedEntitlements/.test(read(f)));
  assert.deepEqual(outside, [], 'entitlement não corta recurso existente nesta entrega');
});

test('BIL-002 risco-critico: a matriz classifica cobrança como crítica', async () => {
  const { classifyRisk } = await import(pathToFileURL(path.join(ROOT, 'quality/lib/risk.mjs')).href);
  const files = [
    `${BILLING_DIR}/Application/InvoiceService.cs`,
    'backend/src/Exemplo SaaS.Api/Infrastructure/Persistence/BillingConfigurations.cs',
    'admin-web/src/modules/billing/domain/enums.ts',
    'ofluxo_site/src/platform/domain/billing-enums.ts',
  ];
  for (const file of files) {
    const risk = classifyRisk([{ path: file, status: 'M', added: [], removed: [] }]);
    assert.equal(risk.breakage.level, 'critico', file);
    assert.match(JSON.stringify(risk.breakage.reasons), /cobrança \(Billing\)/, file);
  }
});

test('BIL-002 enums-canonicos: enums de cobrança registrados com os três arquivos', async () => {
  const { CANONICAL_ENUMS } = await import(pathToFileURL(path.join(ROOT, '.claude/hooks/lib/regras.mjs')).href);
  for (const name of ENUMS) assert.deepEqual(CANONICAL_ENUMS[name], ENUM_FILES, name);
});

test('BIL-002 enums-canonicos: BillingEnums.cs é a fonte dos seis enums', () => {
  const source = read(ENUM_FILES[0]);
  for (const name of ENUMS) assert.match(source, new RegExp(`\\benum\\s+${name}\\b`), name);
});
