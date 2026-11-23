// Gates FC-010 — Creator no app Flutter: aba fora do espelho do golden, kit de marca, prévia em camadas,
// dev-token local. ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-010 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ROOT, exists, read } from './fc-gate-helper.mjs';

const SPEC = 'docs/entregas/2026-11-14-fluxo-creator/specs/FC-010.md';
const PAGES = 'lib/features/fluxo_empresas/presentation/pages/fluxo_empresas_pages.dart';
const WORKSPACE = 'lib/features/fluxo_empresas/domain/business_workspace.dart';
const API_CLIENT = 'lib/core/network/fluxo_api_client.dart';
const FEATURE = 'lib/features/creator';
const LOCAL_README = 'backend/deploy/creator-local/README.md';

const noRealIds = (text, file) => {
  for (const email of text.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g) ?? [])
    assert.ok(email.endsWith('@example.test'), `${file}: e-mail fora do domínio reservado`);
  for (const hex of text.match(/\b[0-9a-f]{28,}\b/gi) ?? [])
    assert.ok(false, `${file}: literal longo demais parece identificador real: ${hex.slice(0, 8)}…`);
};

test('FC-010 flutter: analyze limpo nos arquivos novos e testes de parse dos models verdes', () => {
  assert.ok(exists(`${FEATURE}/domain/creator_models.dart`), 'creator_models.dart ausente');
  assert.ok(exists(`${FEATURE}/data/creator_repository.dart`), 'creator_repository.dart ausente');
  const analyze = spawnSync('flutter', ['analyze', '--no-pub', FEATURE, API_CLIENT, PAGES], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024,
  });
  const errors = (analyze.stdout ?? '').split('\n').filter((line) => /\berror\b\s*•|^\s*error\s*:/i.test(line));
  assert.deepEqual(errors, [], `flutter analyze com erros:\n${errors.join('\n')}`);
  assert.equal(analyze.status, 0, `flutter analyze saiu com ${analyze.status}:\n${(analyze.stdout ?? '').split('\n').slice(-15).join('\n')}`);
  const testDir = 'test/features/creator';
  assert.ok(exists(testDir), `pasta de testes ausente: ${testDir}`);
  const flutterTest = spawnSync('flutter', ['test', testDir, '--reporter', 'compact'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CI: '1' },
  });
  assert.equal(flutterTest.status, 0, `flutter test falhou:\n${((flutterTest.stdout ?? '') + (flutterTest.stderr ?? '')).split('\n').slice(-15).join('\n')}`);
});

test('FC-010 aba: entrada condicionada à config (404 silencioso), fora do enum BusinessTab do espelho', () => {
  // O espelho dart menciona "digitalCreator" (tipo de conta) desde sempre — o que não pode
  // existir lá é o MÓDULO creator: nem import da feature, nem aba no enum BusinessTab.
  const workspace = read(WORKSPACE);
  assert.ok(!/features\/creator/.test(workspace), 'business_workspace.dart importou a feature creator (paridade BIL-017)');
  const tabEnum = workspace.match(/enum BusinessTab \{([^}]*)\}/)?.[1] ?? '';
  assert.ok(!/creator/i.test(tabEnum), 'BusinessTab ganhou creator — quebraria o golden BIL-017');
  const pages = read(PAGES);
  assert.match(pages, /CreatorEntryButton|Fluxo Creators/i, 'workspace sem a entrada do Creator');
  const page = `${FEATURE}/presentation/fluxo_creator_page.dart`;
  assert.ok(exists(page), `página ausente: ${page}`);
  const src = read(page);
  assert.match(src, /fetchConfig/, 'página sem o GET config (via repositório)');
  assert.match(src, /pop|Navigator/, '404 não volta em silêncio (pop)');
  const repo = `${FEATURE}/data/creator_repository.dart`;
  const repoSrc = read(repo);
  for (const rota of ['creator/config', 'creator/brand-kit', 'creator/projects'])
    assert.ok(repoSrc.includes(rota), `repositório sem a rota ${rota}`);
});

test('FC-010 dev-token: override Bearer dev.<uid> só em kDebugMode com FLUXO_DEV_UID do dart-define', () => {
  const src = read(API_CLIENT);
  assert.ok(src.includes('FLUXO_DEV_UID'), 'dev-token ausente no client do app');
  assert.match(src, /kDebugMode/, 'dev-token sem guarda kDebugMode');
  assert.match(src, /fromEnvironment/, 'FLUXO_DEV_UID não vem de String.fromEnvironment (dart-define)');
  const guarded =
    src.match(/_devOverrideActive\s*=>\s*kDebugMode\s*&&\s*_devUid/) ??
    src.match(/kDebugMode[^;\n]*FLUXO_DEV_UID/);
  assert.ok(guarded, 'guarda kDebugMode não cobre o dev-token');
  assert.match(src, /if\s*\(_devOverrideActive\)/, 'override não é aplicado via _devOverrideActive');
  noRealIds(src, API_CLIENT);
});

test('FC-010 golden: paridade de workspace BIL-017 segue verde com a entrada nova', () => {
  const golden = spawnSync('node', ['--test', 'quality/test/delivery/bil-017.test.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 110_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(golden.status, 0, `golden BIL-017 falhou:\n${((golden.stdout ?? '') + (golden.stderr ?? '')).split('\n').slice(-20).join('\n')}`);
});

test('FC-010 docs: roteiro Flutter no README local e spec alinhada', () => {
  const readme = read(LOCAL_README);
  assert.match(readme, /FLUXO_DEV_UID|dart-define/i, 'README local sem o roteiro Flutter (dart-define)');
  const spec = read(SPEC);
  assert.match(spec, /Status: ready/, 'spec sem Status: ready');
  assert.match(spec, /camadas/i, 'spec sem as camadas de prévia');
  noRealIds(readme + spec, LOCAL_README);
});
