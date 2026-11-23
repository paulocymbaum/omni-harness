import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedText, checkContent, missingDocs } from '../lib/regras.mjs';

test('bloqueia CPF literal em código', () => {
  const r = checkContent('lib/features/identity/data/x.dart', "const doc = '123.456.789-09';");
  assert.equal(r.bloqueios.length, 1);
  assert.ok(!r.bloqueios[0].includes('123.456.789-09'), 'a mensagem não repete o documento');
});

test('bloqueia CNPJ literal em código', () => {
  assert.equal(checkContent('backend/src/Fluxo.Api/Modules/Businesses/X.cs', 'var c = "12.345.678/0001-95";').bloqueios.length, 1);
});

test('placeholder, testes e l10n não bloqueiam', () => {
  assert.deepEqual(checkContent('lib/features/identity/presentation/f.dart', "hint: '000.000.000-00'").bloqueios, []);
  assert.deepEqual(checkContent('functions/test/identity.test.js', "'123.456.789-09'").bloqueios, []);
  assert.deepEqual(checkContent('lib/l10n/app_pt.arb', '"123.456.789-09"').bloqueios, []);
});

test('CPF em .md só avisa', () => {
  const r = checkContent('docs/identidade/x.md', 'exemplo 123.456.789-09');
  assert.equal(r.bloqueios.length, 0);
  assert.equal(r.avisos.length, 1);
});

test('campo cpf bruto em camada pública avisa; cpfHash não', () => {
  assert.equal(checkContent('functions/src/http/profile.routes.ts', 'res.json({ cpf: user.cpf })').avisos.length, 1);
  assert.equal(checkContent('functions/src/http/profile.routes.ts', 'res.json({ cpfHash: h })').avisos.length, 0);
  assert.equal(checkContent('backend/src/Fluxo.Api/Modules/Profiles/ProfileResponse.cs', 'public string? Cpf { get; init; }').avisos.length, 1);
});

test('formulário em que o usuário digita o documento não avisa', () => {
  assert.equal(checkContent('lib/features/identity/presentation/front_cpf_gate.dart', 'cpf: value').avisos.length, 0);
  assert.equal(checkContent('ofluxo_site/src/platform/presentation/pages/domain-pages.tsx', "cpf: cpf.replace(/\\D/g, '')").avisos.length, 0);
  assert.equal(checkContent('backend/src/Fluxo.Api/Modules/Identity/VerifyCpfRequest.cs', 'public string Cpf { get; init; }').avisos.length, 0);
});

test('enum de domínio redefinido fora do canônico avisa; em .md não', () => {
  assert.equal(checkContent('admin-web/src/shared/types.ts', "export type AccountKind = 'person';").avisos.length, 1);
  assert.equal(checkContent('functions/src/identity/shared/types.ts', 'export type AccountKind = "person";').avisos.length, 0);
  assert.equal(checkContent('docs/empresas/FLUXO_EMPRESAS.md', "export type AccountKind = 'person';").avisos.length, 0);
});

test('dependência de blockchain em manifesto avisa', () => {
  assert.equal(checkContent('ofluxo_site/package.json', '"ethers": "^6.0.0",').avisos.length, 1);
  assert.equal(checkContent('ofluxo_site/src/x.ts', 'const ethers = 1').avisos.length, 0);
});

test('addedText cobre Edit, MultiEdit e Write', () => {
  assert.equal(addedText({ new_string: 'a' }), 'a');
  assert.equal(addedText({ edits: [{ new_string: 'a' }, { new_string: 'b' }] }), 'a\nb');
  assert.equal(addedText({ content: 'c' }), 'c');
});

test('missingDocs: arquivo novo de domínio sem .md', () => {
  const r = missingDocs(['?? lib/features/events/domain/model/novo.dart', ' M lib/features/events/presentation/p.dart']);
  assert.equal(r.length, 1);
  assert.equal(r[0].label, 'domínio do app');
});

test('missingDocs: .md tocado, arquivo modificado ou gerado não lembram', () => {
  assert.deepEqual(missingDocs(['?? lib/features/events/domain/model/novo.dart', ' M docs/eventos/TEST_GUIDE.md']), []);
  assert.deepEqual(missingDocs([' M backend/src/Fluxo.Api/Modules/Events/EventEndpoints.cs']), []);
  assert.deepEqual(missingDocs(['?? lib/features/events/domain/model/novo.g.dart']), []);
  assert.equal(missingDocs(['A  backend/deploy/sql/novo.sql']).length, 1);
});

test('enums do Debate ao Vivo: Verdict fora dos quatro arquivos canônicos avisa; neles não', () => {
  const fora = checkContent('ofluxo_site/src/platform/pulso/outro.ts', 'export type Verdict = "true" | "false";');
  assert.ok(fora.avisos.some((a) => a.includes('Verdict')));
  for (const arquivo of [
    'backend/src/Fluxo.Api/Modules/Debates/DebateEnums.cs',
    'admin-web/src/modules/debates/domain/enums.ts',
    'ofluxo_site/src/platform/domain/debate-enums.ts',
    'services/debate-worker/src/domain/debate-enums.ts',
  ]) {
    assert.deepEqual(checkContent(arquivo, 'export enum Verdict { True, False }').avisos, []);
  }
  assert.deepEqual(checkContent('admin-web/src/x.ts', 'type VerdictLabel = string;').avisos, []);
});
