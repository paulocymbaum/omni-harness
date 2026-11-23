// Gate R-PERFIL — dois mundos desde que o harness foi APARTADO do Fluxo:
//   1) perfil ATIVO deste repositório = o genérico do núcleo (sem host, sem produto);
//   2) perfil de EXEMPLO `quality/examples/fluxo/profile` = um host multi-stack completo, fora do
//      discovery (`HARNESS_PROFILE_DIR` aponta para ele nos testes de motor). Regra-mãe:
//      docs/parking-lot/harness-agnostico.md (R0: modelo híbrido; apartamento em 2026-11-22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProfile, validateProfile } from '../lib/profile.mjs';
import { PROFILE, PROFILE_ERRORS, PROFILE_FILE } from '../lib/profile.mjs';
import { repoRoot } from '../lib/util.mjs';
import { compileRules } from '../lib/gates/fast.mjs';
import { mirrorsToJira } from '../delivery/jira-mirror.mjs';
import { PERMANENT } from '../lib/gitflow.mjs';
import { envOff, harnessEnv } from '../lib/env.mjs';

const ROOT = repoRoot();
const EXAMPLE_ROOT = path.join(ROOT, 'quality', 'examples', 'fluxo');
const EXAMPLE_DIR = path.join(EXAMPLE_ROOT, 'profile');
// No pacote npm (pnpx/npm) o exemplo do Fluxo não viaja: os testes de exemplo são pulados
// com motivo (skip condicional — nunca skip incondicional, regra anti-force-pass).
const TEM_EXEMPLO = fs.existsSync(path.join(EXAMPLE_DIR, 'profile.json'));
const SEM_EXEMPLO = TEM_EXEMPLO ? false : 'quality/examples/fluxo não incluído no pacote npm';
const exemplo = loadProfile({ dir: EXAMPLE_DIR, env: {} });

test('perfil ATIVO é o genérico do núcleo: sem host, sem produto, sem erro', () => {
  assert.deepEqual(PROFILE_ERRORS, []);
  assert.equal(PROFILE.name, 'default');
  assert.deepEqual(PROFILE.layers, []);
  assert.deepEqual(PROFILE.boundaries, []);
  assert.deepEqual(PROFILE.pii.literalPatterns, []);
  assert.equal(PROFILE.tracker.provider, 'none');
  assert.equal(PROFILE.gitflow, null);
  assert.equal(PROFILE.prompt.overlay, '', 'núcleo não carrega overlay de produto');
  assert.equal(PROFILE_FILE, null);
});

test('perfil de EXEMPLO (fluxo) valida contra o schema v1 — nenhum erro', { skip: SEM_EXEMPLO }, () => {
  assert.deepEqual(exemplo.errors, []);
  assert.equal(exemplo.profile.name, 'fluxo');
  assert.equal(exemplo.profile.schemaVersion, 1);
  assert.ok(exemplo.file.endsWith('profile.json'));
  assert.ok(exemplo.profile.layers.length >= 10);
  assert.equal(exemplo.profile.boundaries.length, 5);
  assert.equal(exemplo.profile.dartPackage, 'package:fluxo/');
  assert.equal(exemplo.profile.tracker.provider, 'jira');
  assert.deepEqual(exemplo.profile.gitflow.permanent, ['main', 'develop', 'RELEASE']);
  assert.equal(exemplo.profile.metrics.exportsEntry, 'functions/src/index.ts');
});

test('PII: pack pii-br ficou genérico; camadas públicas do exemplo vêm do perfil', { skip: SEM_EXEMPLO }, () => {
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'quality', 'packs', 'pii-br.json'), 'utf8'));
  assert.equal(pack.publicLayers, undefined, 'pack não carrega dado de host');
  assert.ok(exemplo.profile.pii.publicLayers.length >= 2);
  assert.equal(PROFILE.pii.publicLayers.length, 0, 'núcleo sem PII de host');
});

test('fronteiras: compileRules do exemplo mantém os vereditos', { skip: SEM_EXEMPLO }, () => {
  const rules = compileRules(exemplo.profile.boundaries);
  assert.equal(rules.length, 5);
  const domain = rules.find((r) => r.rule === 'rule.domainInfra');
  assert.equal(domain.applies('lib/features/feed/domain/x.dart'), true);
  assert.equal(domain.bad('package:cloud_firestore/x.dart'), true);
  assert.equal(domain.bad('package:flutter/foundation.dart'), false);
  const admin = rules.find((r) => r.rule === 'rule.adminFirestore');
  assert.equal(admin.bad('firebase/firestore'), true);
  assert.equal(admin.bad('firebase/auth'), false);
});

test('tracker plugável: exemplo=jira espelha; núcleo=none desliga; fora do repo nunca', { skip: SEM_EXEMPLO }, () => {
  const dir = path.join(EXAMPLE_ROOT, 'gates');
  assert.equal(mirrorsToJira(dir, {}, exemplo.profile), true);
  assert.equal(mirrorsToJira(dir, {}, PROFILE), false, 'ativo sem tracker não espelha');
  assert.equal(mirrorsToJira(path.join(os.tmpdir(), 'fora'), {}, exemplo.profile), false);
});

test('gitflow: exemplo traz RELEASE permanente; núcleo cai no fallback legado', () => {
  assert.deepEqual(exemplo.profile.gitflow.permanent, ['main', 'develop', 'RELEASE']);
  assert.deepEqual(PERMANENT, ['main', 'develop', 'RELEASE'], 'fallback legado do gitflow.mjs');
});

test('overlay: exemplo tem fonte viva, pack e skills; núcleo não espelha overlay nenhum', { skip: SEM_EXEMPLO }, () => {
  assert.ok(fs.existsSync(path.join(EXAMPLE_ROOT, 'PROJETO.md')), 'overlay do exemplo existe');
  assert.ok(fs.existsSync(path.join(EXAMPLE_ROOT, 'pack-fluxo-domain.json')), 'manifest do pack de domínio no exemplo');
  for (const tema of exemplo.profile.prompt.domainSkills) {
    assert.ok(fs.existsSync(path.join(EXAMPLE_ROOT, 'skills', tema, 'SKILL.md')), `skill do exemplo: ${tema}`);
  }
  assert.equal(fs.existsSync(path.join(ROOT, '.clinerules', '85-projeto.md')), false, 'núcleo não espelha overlay de produto');
});

test('repo hospedeiro sem perfil → defaults genéricos (sem layers/pii, locale pt-BR)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perfil-vazio-'));
  try {
    const r = loadProfile({ root: tmp, env: {} });
    assert.deepEqual(r.errors, []);
    assert.equal(r.file, null);
    assert.equal(r.profile.name, 'default');
    assert.deepEqual(r.profile.layers, []);
    assert.deepEqual(r.profile.pii.literalPatterns, []);
    assert.equal(r.profile.locale, 'pt-BR');
    assert.ok(r.profile.generatedGlobs.length > 0, 'defaults de gerados não vazios');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('HARNESS_PROFILE_DIR aponta o dir de perfis; HARNESS_PROFILE escolhe o arquivo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perfil-multi-'));
  try {
    const dir = path.join(root, 'quality', 'profile');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'alfa.json'), JSON.stringify({ schemaVersion: 1, name: 'alfa', locale: 'pt-BR', packs: [] }));
    fs.writeFileSync(path.join(dir, 'beta.json'), JSON.stringify({ schemaVersion: 1, name: 'beta', locale: 'en', packs: [] }));
    const viaEnvDir = loadProfile({ env: { HARNESS_PROFILE_DIR: dir, HARNESS_PROFILE: 'beta' } });
    assert.equal(viaEnvDir.profile.name, 'beta');
    assert.deepEqual(viaEnvDir.errors, []);
    const viaRoot = loadProfile({ root, env: { HARNESS_PROFILE: 'alfa' } });
    assert.equal(viaRoot.profile.name, 'alfa');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('schema v1 reprova perfil inválido; erro aparece em loadProfile sem derrubar o motor', () => {
  assert.ok(validateProfile({ schemaVersion: 2 }).length > 0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perfil-invalido-'));
  try {
    const dir = path.join(root, 'quality', 'profile');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'quebrado.json'), '{"schemaVersion": 99, "name": "q"}');
    const r = loadProfile({ root, env: {} });
    assert.ok(r.errors.length >= 1);
    assert.equal(r.profile.schemaVersion, 1, 'motor segue nos defaults do schema');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R5: namespace HARNESS_* canônico com alias FLUXO_* (transição)', () => {
  const env1 = { HARNESS_AUTOFIX: '0', FLUXO_JIRA_SYNC: '0' };
  const env2 = { FLUXO_AUTOFIX: '0', FLUXO_JIRA_SYNC: '0' };
  assert.equal(envOff('AUTOFIX', env1), true, 'HARNESS_ canônico');
  assert.equal(envOff('AUTOFIX', env2), true, 'FLUXO_ alias');
  assert.equal(envOff('AUTOFIX', {}), false);
  assert.equal(harnessEnv('AUTOFIX', { HARNESS_AUTOFIX: '1', FLUXO_AUTOFIX: '0' }), '1', 'HARNESS_ precede o alias');
});
