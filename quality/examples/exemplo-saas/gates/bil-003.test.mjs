// Gates BIL-003 — permissões billing.* nos cinco lugares e plano manual para o piloto.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-31-billing-asaas-mercadopago BIL-003 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { BILLING_DIR, ROOT, read, runAdminVitest, runDotnetGate, runOk } from './bil-gate-helper.mjs';

const BILLING = ['billing.read', 'billing.manage', 'billing.refund'];
const found = (text) => [...new Set(text.match(/billing\.[a-z_.]*[a-z]/g) ?? [])].sort();
const assertExactlyBilling = (text, where) => assert.deepEqual(found(text), [...BILLING].sort(), where);
const between = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

test('BIL-003 permissoes-cinco-lugares: Functions e admin-web listam as três permissões, sem extras', () => {
  const admin = read('functions/src/admin/shared/admin.ts');
  assertExactlyBilling(between(admin, 'export type AdminPermission', 'export type AdminRole'), 'tipo AdminPermission');
  assertExactlyBilling(between(admin, 'allAdminPermissions', '];'), 'allAdminPermissions');
  assert.deepEqual(found(between(admin, 'legalPermissions', '];')), [], 'legalPermissions não recebe billing.*');
  const access = read('functions/src/admin/access.ts');
  assertExactlyBilling(between(access, 'const permissionSchema', '])'), 'permissionSchema');
  assertExactlyBilling(between(read('admin-web/src/shared/domain/contracts.ts'), 'adminPermissionSchema', '])'), 'adminPermissionSchema');
});

test('BIL-003 permissoes-cinco-lugares: tela de acesso marca a dependência de billing.read e tem rótulos', () => {
  const page = read('admin-web/src/modules/admin-access/presentation/AdminAccessPage.tsx');
  for (const permission of ['billing.manage', 'billing.refund']) {
    const entry = page.slice(page.indexOf(`"${permission}"`), page.indexOf('}', page.indexOf(`"${permission}"`)));
    assert.match(entry, /dependsOn:\s*"billing\.read"/, permission);
  }
  const labels = [...page.matchAll(/value:\s*"billing\.[a-z]+"[^}]*?label:\s*"([^"]+)"[^}]*?description:\s*"([^"]+)"/g)].flatMap((m) => [m[1], m[2]]);
  assert.equal(labels.length, 6, 'três permissões com rótulo e descrição');
  const i18n = read('admin-web/src/shared/presentation/i18n/i18n.tsx');
  for (const key of labels) assert.ok(i18n.includes(key), `i18n sem ${key}`);
});

test('BIL-003 permissoes-cinco-lugares: .NET implica billing.read por duas origens e BillingPermissions segue o padrão', () => {
  const registry = read('backend/src/Exemplo SaaS.Api/Modules/Admin/AdminAccessRegistry.cs');
  assert.match(registry, /string\[\]\??\s+ImpliedBy\(/, 'ImpliedBy deve devolver string[]');
  const origins = registry.match(/"billing\.read"\s*=>\s*(?:new\s*(?:string)?\[\]\s*\{|\[)[^\]}]*/)?.[0] ?? '';
  for (const source of ['billing.manage', 'billing.refund']) assert.ok(origins.includes(`"${source}"`), `billing.read sem a origem ${source}`);
  assertExactlyBilling(read(`${BILLING_DIR}/BillingPermissions.cs`), 'BillingPermissions.cs');
});

test('BIL-003 functions: sanitizer implica billing.read e papel legal fica sem billing.*', () => {
  runOk('npm', ['--prefix', 'functions', 'run', 'build'], { label: 'build das Functions', timeout: 100_000 });
  const probe = spawnSync(process.execPath, ['-e', `
    const a = require('./functions/lib/admin/shared/admin');
    console.log(JSON.stringify({
      all: a.allAdminPermissions,
      manage: a.sanitizeAdminPermissions(['billing.manage']),
      refund: a.sanitizeAdminPermissions(['billing.refund']),
      legal: a.permissionsForRole('legal', ${JSON.stringify(BILLING)}),
      unknown: a.sanitizeAdminPermissions(['billing.catalog.manage']),
    }));
  `], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  assert.equal(probe.status, 0, `não carregou functions/lib/admin/shared/admin:\n${probe.stderr}`);
  const out = JSON.parse(probe.stdout.trim().split('\n').pop());
  for (const permission of BILLING) assert.ok(out.all.includes(permission), `allAdminPermissions sem ${permission}`);
  assert.ok(out.all.length <= 32, 'saveAccessSchema aceita até 32 permissões');
  assert.ok(out.manage.includes('billing.read'), 'billing.manage implica billing.read');
  assert.ok(out.refund.includes('billing.read'), 'billing.refund implica billing.read');
  assert.equal(out.refund.includes('billing.manage'), false, 'refund não implica manage');
  assert.deepEqual(out.legal.filter((p) => p.startsWith('billing.')), [], 'legal não recebe billing.*');
  assert.deepEqual(out.unknown.filter((p) => p.startsWith('billing.')), [], 'billing.catalog.manage não existe');
});

test('BIL-003 dotnet-testes: autorização, plano manual e auditoria', () => {
  runDotnetGate({
    GateBil003AdminTests: [
      'Billing_read_is_implied_by_manage_and_refund_and_denied_to_legal', 'Previous_implications_stay_the_same',
      'Manual_plan_routes_enforce_permissions_and_recent_auth', 'Short_reason_is_refused_without_audit_or_subscription',
      'Manual_plan_activates_inactive_product_audits_and_can_be_canceled',
    ],
  });
});

test('BIL-003 admin-vitest: ManualPlanPage cobre os cenários com e sem permissão', () => {
  const rel = 'src/modules/billing/presentation/ManualPlanPage.test.tsx';
  runAdminVitest(rel, 2);
  const source = read(`admin-web/${rel}`);
  assert.match(source, /billing\.read/, 'cenário só leitura');
  assert.match(source, /billing\.manage/, 'cenário com escrita');
});

test('BIL-003 admin-vitest: rota protegida, menu e cliente próprio', () => {
  assert.match(read('admin-web/src/app/router/AppRouter.tsx'), /path:\s*"assinaturas",\s*element:\s*protect\("billing\.read"/);
  assert.match(read('admin-web/src/app/layout/AdminLayout.tsx'), /\/assinaturas/);
  assert.match(read('admin-web/src/modules/auth/domain/landing.ts'), /billing\.read/);
  const page = read('admin-web/src/modules/billing/presentation/ManualPlanPage.tsx');
  assert.match(page, /AdminActionButton/);
  assert.match(page, /callFn=\{callBillingApi\}/);
  assert.match(read('admin-web/src/modules/billing/infrastructure/billingApi.ts'), /export async function callBillingApi/);
});
