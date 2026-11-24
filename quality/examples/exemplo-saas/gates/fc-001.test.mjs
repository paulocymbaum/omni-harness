// Gates FC-001 — contrato do Creator: enums, política de papéis, GET /api/v1/creator/config, zero hardcode, fronteira e privacidade.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-001 --baseline
// .NET exige o SDK; os gates de API exigem também FLUXO_TEST_POSTGRES (PostgreSQL 17 com pgvector).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CREATOR_DIR, ROOT, exists, read, runDotnetGate, walk } from './fc-001-gate-helper.mjs';

const CS_ENUMS = `${CREATOR_DIR}/Domain/CreatorEnums.cs`;
const TS_ENUMS = 'ofluxo_site/src/platform/domain/creator-enums.ts';
const POLICY = `${CREATOR_DIR}/Application/CreatorAccessPolicy.cs`;
const APPSETTINGS = 'backend/src/Exemplo SaaS.Api/appsettings.json';

const WIRE = {
  CreatorViewportPreset: ['feed_square', 'feed_portrait', 'story', 'landscape'],
  WatermarkCorner: ['top_left', 'top_right', 'bottom_left', 'bottom_right'],
  CreatorProjectKind: ['single', 'carousel'],
  SlideRole: ['hook', 'context', 'data', 'body', 'cta'],
  SlideTaskStatus: ['queued', 'running', 'validated', 'rendered', 'failed'],
  CreatorMemberRole: ['owner', 'admin', 'editor', 'viewer'],
  CreatorPermission: ['creator.read', 'creator.create', 'creator.export', 'creator.brandkit.manage'],
};

const norm = (s) => s.replace(/[_.]/g, '').toLowerCase();
const sameWire = (cs, wire) => norm(cs) === norm(wire) || `creator${norm(cs)}` === norm(wire);
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function csEnumNames(src, name) {
  const m = src.match(new RegExp(`enum\\s+${name}\\b[^{]*\\{([^}]*)\\}`));
  assert.ok(m, `enum ${name} ausente em ${CS_ENUMS}`);
  return stripComments(m[1]).split(',').map((s) => s.trim().split(/[\s=]/)[0]).filter(Boolean);
}

function tsEnumValues(src, name) {
  const m = src.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  assert.ok(m, `const ${name} ausente em ${TS_ENUMS}`);
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

function leaves(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => leaves(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => leaves(v, out));
  else out.push(value);
  return out;
}

test('FC-001 enums: C# e TS têm exatamente os valores wire das 7 enums', () => {
  const cs = read(CS_ENUMS);
  const ts = read(TS_ENUMS);
  for (const [name, wire] of Object.entries(WIRE)) {
    const csNames = csEnumNames(cs, name);
    const csWire = wire.filter((w) => csNames.some((n) => sameWire(n, w)));
    assert.equal(csNames.length, wire.length, `${name} C#: esperava ${wire.length} valores, houve ${csNames.length}`);
    assert.deepEqual(csWire, wire, `${name} C#: valores divergem do wire`);
    assert.deepEqual([...tsEnumValues(ts, name)].sort(), [...wire].sort(), `${name} TS: valores divergem do wire`);
  }
});

test('FC-001 enums: CANONICAL_ENUMS lista as 7 enums com C# e TS, e Flutter/Functions não as redefinem', async () => {
  const { CANONICAL_ENUMS } = await import(pathToFileURL(path.join(ROOT, '.claude/hooks/lib/regras.mjs')).href);
  for (const name of Object.keys(WIRE)) {
    assert.ok(CANONICAL_ENUMS[name], `CANONICAL_ENUMS sem ${name}`);
    assert.ok(CANONICAL_ENUMS[name].includes(CS_ENUMS), `${name} sem ${CS_ENUMS}`);
    assert.ok(CANONICAL_ENUMS[name].includes(TS_ENUMS), `${name} sem ${TS_ENUMS}`);
  }
  const def = new RegExp(`\\b(?:enum|class|type|interface)\\s+(${Object.keys(WIRE).join('|')})\\b`);
  const offenders = [...walk('lib', (f) => f.endsWith('.dart')), ...walk('functions/src', (f) => f.endsWith('.ts'))]
    .filter((f) => def.test(read(f)));
  assert.deepEqual(offenders, [], 'enums do Creator redefinidas fora das fontes canônicas');
});

test('FC-001 registro: Program.cs, appsettings, README e desenho registram o módulo', () => {
  const program = read('backend/src/Exemplo SaaS.Api/Program.cs');
  const add = program.indexOf('AddCreatorModule(');
  assert.ok(add > program.indexOf('AddBillingModule('), 'Program.cs sem AddCreatorModule após AddBillingModule');
  const map = program.indexOf('MapCreatorEndpoints(');
  assert.ok(map > program.indexOf('MapAdminBillingEndpoints('), 'Program.cs sem MapCreatorEndpoints após MapAdminBillingEndpoints');
  for (const file of [`${CREATOR_DIR}/CreatorModule.cs`, `${CREATOR_DIR}/CreatorOptions.cs`, `${CREATOR_DIR}/Contracts/Responses.cs`,
    `${CREATOR_DIR}/Application/CreatorAccess.cs`]) assert.ok(exists(file), `arquivo ausente: ${file}`);
  const settings = JSON.parse(read(APPSETTINGS));
  assert.equal(settings.Creator?.Enabled, false, 'Creator:Enabled deve nascer false em appsettings.json (RN-04)');
  assert.equal(settings.Creator?.ElectoralContextEnabled, false);
  const dev = JSON.parse(read('backend/src/Exemplo SaaS.Api/appsettings.Development.json'));
  assert.equal(dev.Creator?.Enabled, true, 'Creator:Enabled deve ser true em appsettings.Development.json');
  assert.match(read('backend/README.md'), /^#+ .*Creator/m, 'backend/README.md sem seção Creator');
  assert.match(read('docs/parking-lot/fluxo-creator.md'), /FC-001/, 'desenho sem o ponteiro "contrato implementado em FC-001"');
});

test('FC-001 zero-hardcode: limites só em CreatorOptions e appsettings, e o appsettings traz todos', () => {
  const files = walk(CREATOR_DIR, (f) => f.endsWith('.cs') && !f.endsWith('/CreatorOptions.cs'));
  assert.ok(files.length > 0, `módulo Creator ausente em ${CREATOR_DIR}`);
  const literals = /\b(10485760|2000|0\.12|0\.04|0\.90?)\b|"image\/svg\+xml"/;
  const offenders = files.filter((f) => literals.test(stripComments(read(f))));
  assert.deepEqual(offenders, [], 'limite como literal fora de CreatorOptions.cs');
  const flat = leaves(JSON.parse(read(APPSETTINGS)).Creator ?? null);
  for (const value of [10, 10485760, 2, 5, 10, 6, 2000, 30, 90, 15, 250, 3, 0.05, 0.3, 0.12, 0.02, 0.1, 0.04, 0.9, 'image/svg+xml', 'image/webp']) {
    assert.ok(flat.some((v) => v === value), `appsettings.json Creator sem o valor ${value}`);
  }
});

test('FC-001 zero-hardcode: faixa invertida (min > max) derruba a inicialização', () => {
  runDotnetGate({ GateFc001ApiTests: ['Inverted_limit_range_stops_the_startup'] }, { requiredFiles: [`${CREATOR_DIR}/CreatorOptions.cs`] });
});

test('FC-001 fronteira: a rota não é anônima e o teste de fronteira a cobre', () => {
  const settings = JSON.parse(read(APPSETTINGS));
  const anonymous = settings.Firebase?.AnonymousPaths ?? [];
  assert.ok(anonymous.length > 0, 'AnonymousPaths ausente: o gate não leria a lista real');
  assert.deepEqual(anonymous.filter((p) => p.includes('creator')), [], 'rota do Creator não pode ser anônima');
  assert.match(read('backend/tests/Exemplo SaaS.Api.Tests/ApiBoundaryTests.cs'),
    /InlineData\("\/api\/v1\/creator\/config\?businessId=test-business"\)/, 'ApiBoundaryTests sem a rota do Creator no Theory');
  assert.ok(exists(`${CREATOR_DIR}/CreatorModule.cs`), 'módulo Creator ausente');
});

test('FC-001 politica-papeis: matriz 4 papéis x 4 permissões e papel desconhecido sem permissão', () => {
  runDotnetGate({
    GateFc001PolicyTests: ['Can_follows_the_role_matrix_for_all_sixteen_cells', 'PermissionsFor_lists_exactly_the_granted_permissions', 'Unknown_role_gets_no_permission'],
  }, { requiredFiles: [POLICY] });
});

test('FC-001 config-api: 401, 422, 403, 200 por papel, 404 desligado e payload completo', () => {
  runDotnetGate({
    GateFc001ApiTests: [
      'Anonymous_gets_401_and_missing_business_gets_422', 'Caller_without_membership_gets_403',
      'Owner_admin_editor_viewer_get_200_with_their_permissions', 'Unrecognized_member_role_gets_403_creator_access_denied',
      'Disabled_feature_answers_404_creator_disabled', 'Payload_carries_every_limit_viewport_and_enum_from_the_spec',
    ],
  }, { requiredFiles: [`${CREATOR_DIR}/CreatorModule.cs`], postgres: true });
});

test('FC-001 sem-regressao-team: RequireMemberAsync público, RequireAccessAsync fechado e permissões do time intactas', () => {
  const team = read('backend/src/Exemplo SaaS.Api/Modules/Exemplo SaaSEmpresas/BusinessTeamService.cs');
  assert.match(team, /RequireMemberAsync/, 'BusinessTeamService sem RequireMemberAsync');
  const offenders = walk('backend/src/Exemplo SaaS.Api/Modules/Exemplo SaaSEmpresas', (f) => f.endsWith('.cs') && /creator\./i.test(read(f)));
  assert.deepEqual(offenders, [], 'permissões creator.* não podem entrar em BusinessTeamPolicy (vivem no módulo Creator)');
  runDotnetGate({ GateFc001TeamTests: ['RequireMemberAsync_is_public_and_RequireAccessAsync_stays_closed'] });
});

test('FC-001 privacidade: resposta sem campos de documento, e-mail ou uid de membro', () => {
  runDotnetGate({ GateFc001ApiTests: ['Response_never_exposes_document_or_email_fields'] },
    { requiredFiles: [`${CREATOR_DIR}/CreatorModule.cs`], postgres: true });
});
