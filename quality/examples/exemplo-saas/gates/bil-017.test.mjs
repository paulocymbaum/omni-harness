// Gates BIL-017 — site do Exemplo SaaS Empresa com os dados registrados visíveis, interface por tipo de empresa e paridade do app.
// Emulador: portas livres e projeto demo-*, sem credencial nem produção; sem JDK 21+ falha, não pula. .NET exige FLUXO_TEST_POSTGRES. Nenhum gate fala com GCP nem com PSP.
// Templates só existem no app durante o gate. Cenários longos ficam em bil-017-scenarios/. O golden nasce de bil-017-workspace-golden.mjs, e o hash abaixo impede retoque.
// BIL-017-PILOTO-MANUAL é manual.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-31-billing-asaas-mercadopago BIL-017 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, exists, read, requireEnv, runDotnetGate, runVitestTemplates, walk } from './bil-gate-helper.mjs';
import { collector, withEmulators } from './bil-017-gate-helper.mjs';
import { runRegrasConsultas } from './bil-017-scenarios/regras-consultas.mjs';
import { runIndices } from './bil-017-scenarios/indices.mjs';
import { runMerchantSoPostgres } from './bil-017-scenarios/merchant-so-postgres.mjs';
import { runAuditoria } from './bil-017-scenarios/auditoria.mjs';
import { runExemplo SaaSCompleto } from './bil-017-scenarios/fluxo-completo.mjs';
import { CANONICAL_ENUMS, checkContent } from '../../../.claude/hooks/lib/regras.mjs';

const SITE = 'ofluxo_site';
const PLATFORM = `${SITE}/src/platform`;
const BUSINESS = `${PLATFORM}/presentation/pages/business`;
const DOMAIN_PAGES = `${PLATFORM}/presentation/pages/domain-pages.tsx`;
const WORKSPACE_TS = `${PLATFORM}/domain/business-workspace.ts`;
const WORKSPACE_DART = 'lib/features/fluxo_empresas/domain/business_workspace.dart';
const OPERATIONS_TS = `${PLATFORM}/domain/business-operations.ts`;
const RECORDS_TS = `${PLATFORM}/domain/business-records.ts`;
const CUBIT = 'lib/features/fluxo_empresas/presentation/bloc/fluxo_empresas_cubit.dart';
const GOLDEN = 'quality/test/delivery/fixtures/bil-017-workspace.golden.json';
const GOLDEN_SHA256 = 'a026a710b9bb799142b7472f38c571ef426deefa6bd27ed042f437eaa1b651dc';
const DOMAIN_PAGES_LINES_BEFORE = 1953;
const SUPPORT = { 'GateBil017Support.tsx': 'src/platform/presentation/pages/GateBil017Support.tsx' };
const DOTNET = { support: ['GateBil007Support.cs', 'GateBil016Support.cs'], excludeBroken: false };
const FLUTTER_DIR = 'test/features/fluxo_empresas';
const tail = (text, lines = 30) => text.split('\n').slice(-lines).join('\n');
const nloc = (rel) => read(rel).split('\n').filter((line) => line.trim() && !/^\s*(\/\/|\*|\/\*)/.test(line)).length;
const businessFiles = () => walk(BUSINESS, (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

function requireBusinessFiles() {
  const files = businessFiles();
  assert.ok(files.length > 0, `pasta ${BUSINESS} ausente ou vazia: varredura vazia não prova nada`);
  return files;
}

/** Copia o template Flutter, roda e remove. Exige `minimum` verdes e nenhum pulado. */
function runFlutterTemplate(file, minimum) {
  const copy = `${FLUTTER_DIR}/gate_bil017_${file.replace('GateBil017', '').replace('_test.dart', '').toLowerCase()}_test.dart`;
  fs.copyFileSync(path.join(ROOT, 'quality/test/delivery/bil-flutter', file), path.join(ROOT, copy));
  try {
    const r = spawnSync('flutter', ['test', '--no-pub', '--reporter=compact', copy], { cwd: ROOT, encoding: 'utf8', timeout: 100_000, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(r.error, undefined, `flutter não executou: ${r.error?.message}`);
    const output = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 0, `flutter test falhou:\n${tail(output, 40)}`);
    const counts = [...output.matchAll(/\+(\d+)(?: ~(\d+))?(?: -(\d+))?:/g)].at(-1);
    assert.ok(counts, `sem contagem de testes:\n${tail(output)}`);
    assert.ok(Number(counts[1]) >= minimum, `esperava ao menos ${minimum} testes verdes, houve ${counts[1]}`);
    assert.equal(Number(counts[2] ?? 0), 0, 'teste pulado não conta como evidência');
  } finally {
    fs.rmSync(path.join(ROOT, copy), { force: true });
  }
}

test('BIL-017 regras-consultas: consultas reais do app e do site para membro, intruso, revogado e escrita de cliente', async () => {
  await runRegrasConsultas();
});

test('BIL-017 indices: toda consulta composta do app e do site tem índice', () => {
  runIndices();
});

test('BIL-017 merchant-so-postgres: pedido, serviço e agendamento sem merchants/{id}', async () => {
  await runMerchantSoPostgres();
});

test('BIL-017 catalogo-acesso-legado: dono e membro só no Firestore leem o catálogo, e estranho recebe 403', async () => {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL 17 descartável com pgvector');
  await withEmulators(['firestore'], async ({ firestore }) => {
    process.env.FIRESTORE_EMULATOR_HOST = firestore;
    runDotnetGate({
      GateBil017CatalogTests: ['Owner_only_in_firestore_reads_the_catalog', 'Active_admin_only_in_firestore_reads_the_catalog', 'Other_roles_only_in_firestore_follow_the_policy_and_read_the_catalog', 'Stranger_and_revoked_member_get_403', 'Legacy_role_keeps_the_permissions_of_the_policy_on_write', 'Postgres_owner_and_member_stay_the_same'],
    }, DOTNET);
  });
});

test('BIL-017 registros-visiveis: cada recurso mostra o dado registrado, por tipo, e erro de permissão aparece', () => {
  runVitestTemplates(SITE, { ...SUPPORT, 'GateBil017Records.test.tsx': 'src/platform/presentation/pages/GateBil017Records.test.tsx' }, 29);
});

test('BIL-017 auditoria-sem-apagar: dry-run não escreve e --apply só preenche ausente', async () => {
  await runAuditoria();
});

test('BIL-017 plano-no-app: painel real traz o cartão do plano e a seção de Pix', () => {
  runFlutterTemplate('GateBil017Plan_test.dart', 3);
});

test('BIL-017 paridade-workspace: o golden é o do commit e não foi retocado', () => {
  assert.equal(createHash('sha256').update(read(GOLDEN)).digest('hex'), GOLDEN_SHA256);
  assert.ok(exists(WORKSPACE_DART), `arquivo ausente: ${WORKSPACE_DART}`);
  const pages = read('lib/features/fluxo_empresas/presentation/pages/fluxo_empresas_pages.dart');
  assert.match(pages, /domain\/business_workspace\.dart/, 'a tela usa a regra do domínio');
  assert.doesNotMatch(pages, /_hybridWorkspace|_typeForCnae|const _foodWorkspace/, 'regra por tipo não fica na tela');
});

test('BIL-017 paridade-workspace: Dart produz o golden', () => {
  runFlutterTemplate('GateBil017Workspace_test.dart', 30);
});

test('BIL-017 paridade-workspace: TypeScript produz o golden', () => {
  runVitestTemplates(SITE, { 'GateBil017Workspace.test.ts': 'src/platform/domain/GateBil017Workspace.test.ts' }, 31);
});

test('BIL-017 enum-unico: BusinessType só em CANONICAL_ENUMS e merchantTypeFromBusinessType sem cópia', () => {
  const { check, done } = collector();
  const canonical = CANONICAL_ENUMS.BusinessType;
  check('site em CANONICAL_ENUMS.BusinessType', canonical.includes(WORKSPACE_TS));
  check('skill modelo-de-contas registra o espelho', read('.claude/skills/modelo-de-contas/SKILL.md').includes('business-workspace.ts'));
  const code = ['lib', `${SITE}/src`, 'functions/src'].flatMap((dir) => walk(dir, (f) => /\.(dart|tsx?)$/.test(f)));
  assert.ok(code.length > 500, 'varredura vazia não prova nada');
  const definers = code.filter((f) => /\b(?:enum|type|class|const)\s+BusinessType\b/.test(read(f)));
  check('BusinessType definido só nos arquivos canônicos', definers.every((f) => canonical.includes(f)), definers.filter((f) => !canonical.includes(f)).join());
  check('o espelho do site define o tipo', definers.includes(WORKSPACE_TS));
  check('sem cópia em domain-pages.tsx', !read(DOMAIN_PAGES).includes('merchantTypeFromBusinessType'));
  check('sem cópia no cubit', !/String\s+_?merchantTypeFromBusinessType\s*\(/.test(read(CUBIT)));
  for (const file of [WORKSPACE_TS, WORKSPACE_DART]) {
    if (!exists(file)) { check(`arquivo presente: ${file}`, false); continue; }
    check(`definição em ${file}`, /merchantTypeFromBusinessType\s*\(/.test(read(file)));
    check(`hook sem aviso em ${file}`, checkContent(file, read(file)).avisos.length === 0, checkContent(file, read(file)).avisos.join());
  }
  done();
});

test('BIL-017 camadas: pages/business sem Firestore, regra em domain/, sem escrita direta e dentro do limite', () => {
  const files = requireBusinessFiles();
  const { check, done } = collector();
  for (const file of [OPERATIONS_TS, RECORDS_TS, WORKSPACE_TS, WORKSPACE_DART, `${BUSINESS}/business-records.tsx`]) check(`arquivo presente: ${file}`, exists(file));
  for (const file of files) {
    const source = read(file);
    check(`${file} não importa firebase/firestore`, !/from 'firebase\/firestore'|getExemplo SaaSFirebase/.test(source));
    check(`${file} sem regra de status, abas ou merchant`, !/function\s+(nextOrderStatus|nextAppointmentStatus|workspaceFor|merchantTypeFromBusinessType)\b/.test(source));
    check(`${file} sem soma de receita`, !/\.reduce\([\s\S]{0,120}(amount|total)/.test(source));
    check(`${file} sem documento legal`, !/\.document\b|\b(cpf|cnpj)\b/i.test(source));
    check(`${file} dentro do limite de NLOC`, nloc(file) <= 400, String(nloc(file)));
  }
  const site = walk(PLATFORM, (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
  assert.ok(site.length > 50, 'varredura vazia não prova nada');
  const write = /(?:setDoc|addDoc|updateDoc|deleteDoc)\(\s*(?:doc|collection)\(\s*\w+\s*,\s*'(?:orders|services|appointments)'/;
  check('site sem escrita direta em orders, services, appointments', !site.some((f) => write.test(read(f))), site.filter((f) => write.test(read(f))).join());
  for (const file of [OPERATIONS_TS, RECORDS_TS, WORKSPACE_TS]) {
    if (exists(file)) {
      check(`${file} sem Firebase e sem React`, !/from '(firebase|react)/.test(read(file)));
      check(`${file} dentro do limite de NLOC`, nloc(file) <= 400, String(nloc(file)));
    }
  }
  if (exists(WORKSPACE_DART)) {
    check('domínio Dart sem Flutter', !/package:flutter\/|IconData/.test(read(WORKSPACE_DART)));
    check(`${WORKSPACE_DART} dentro do limite de NLOC`, nloc(WORKSPACE_DART) <= 400, String(nloc(WORKSPACE_DART)));
  }
  const domainPages = read(DOMAIN_PAGES);
  check('domain-pages.tsx encolheu', domainPages.split('\n').length - 1 < DOMAIN_PAGES_LINES_BEFORE, String(domainPages.split('\n').length - 1));
  check('resourceConfig saiu', !domainPages.includes('resourceConfig'));
  done();
});

test('BIL-017 modulos-site: ações chamam o callable ou endpoint certo e transições seguem o cubit', () => {
  runVitestTemplates(SITE, { ...SUPPORT, 'GateBil017Modules.test.tsx': 'src/platform/presentation/pages/GateBil017Modules.test.tsx' }, 11);
});

test('BIL-017 modulos-site: painel sem o rótulo enganoso do app e rotas antigas preservadas', () => {
  const files = requireBusinessFiles();
  assert.deepEqual(files.filter((f) => /M[eê]s atual/.test(read(f))), [], 'monthRevenue soma todo o ledger carregado');
  const platform = read(`${PLATFORM}/fluxo-platform.tsx`);
  assert.match(platform, /path="business\/:businessId\/:module"/, 'link salvo não quebra');
  assert.match(platform, /path="business\/:businessId"/, 'rota do painel');
});

test('BIL-017 fluxo-completo: sete tipos e um híbrido, do handler real à tela do membro, e nada para o intruso', async () => {
  await runExemplo SaaSCompleto();
});

test('BIL-017 sem-corte: os módulos novos do site não dependem de plano', () => {
  const files = requireBusinessFiles();
  assert.deepEqual(files.filter((f) => /entitlement|planCode|useBusinessPlan|integracao_psp|billing-api/i.test(read(f))), [], 'BIL-016 proíbe cortar recurso existente');
  assert.doesNotMatch(read(DOMAIN_PAGES), /entitlement/i);
});

test('BIL-017 sem-corte: BIL-016-SO-RECURSO-NOVO e BIL-016-RECURSOS-EXISTENTES-INTACTOS seguem verdes', async () => {
  requireBusinessFiles();
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL 17 descartável com pgvector');
  // Sem o emulador, GET /businesses/{id}/team vai ao Firestore real pelo LegacyFirestoreDirectory: nenhum gate daqui fala com GCP.
  await withEmulators(['firestore'], async ({ firestore }) => {
    process.env.FIRESTORE_EMULATOR_HOST = firestore;
    runDotnetGate({
      GateBil016RoutesTests: ['Marked_routes_are_exactly_the_manifest', 'No_marked_or_planned_route_existed_at_the_reference_commit', 'A_route_of_the_baseline_with_the_marker_is_caught', 'Planned_routes_are_the_two_of_the_spec_and_carry_the_marker_once_they_exist'],
      GateBil016ExistingTests: ['Existing_routes_answer_the_same_with_no_plan_presenca_canceled_and_paid', 'Catalog_limit_of_the_matrix_is_not_applied_to_the_existing_menu'],
    }, DOTNET);
  });
});
