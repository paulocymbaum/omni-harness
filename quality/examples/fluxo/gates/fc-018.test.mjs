// Gates FC-018 — escala do layout por min(largura, altura)/1080 em formatos largos (FC-018).
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-018 --baseline
// Tudo roda no host: o Vitest DENTRO de packages/creator-render (template em quality/test/delivery/fc-018/,
// copiado para test/ durante o gate; npm ci se faltar node_modules), goldens regenerados com UPDATE_GOLDEN=1
// (mudança consciente, revisão do PNG) e o fc-003.test.mjs com o template de layout atualizado pela FC-018.
// Formatos com altura >= largura são IMUNES (min == largura); só landscape/widescreen mudam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT, exists, read, runPackageVitest, stripComments } from './fc-gate-helper.mjs';

const PKG = 'packages/creator-render';
const COMPUTE = `${PKG}/src/layout/compute.ts`;
const POLICY = `${PKG}/src/policy/layout-policy.ts`;
const SPEC_FC003 = 'docs/entregas/2026-11-14-fluxo-creator/specs/FC-003.md';

const vitestTemplate = (file, minimum) => runPackageVitest(PKG, 'fc-018',
  Object.fromEntries([file].map((f) => [f, `test/${f}`])), minimum);

const vitestPackage = (file, minimum) => {
  const bin = path.join(ROOT, PKG, 'node_modules/.bin/vitest');
  const report = path.join(ROOT, PKG, 'vitest-gate-report.json');
  const r = spawnSync(bin, ['run', file, '--reporter=json', `--outputFile=${report}`], {
    cwd: path.join(ROOT, PKG), encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CI: '1', NODE_ENV: 'test' },
  });
  assert.ok(r.status === 0 || exists(report), `${file}: vitest saiu com ${r.status} e sem relatório:\n${(r.stderr ?? '').split('\n').slice(-20).join('\n')}`);
  assert.ok(exists(path.relative(ROOT, report)), `${file}: sem relatório JSON`);
  const json = JSON.parse(read(path.relative(ROOT, report)));
  // O golden usa it.runIf(UPDATE_GOLDEN): o teste de gravação fica skipped por design — só 'failed' reprova.
  const failures = json.testResults.flatMap((f) => f.assertionResults.filter((t) => t.status === 'failed').map((t) => `${t.title}: ${String(t.failureMessages?.[0]).split('\n')[0].slice(0, 200)}`));
  assert.deepEqual(failures, [], `${file}: testes falharam`);
  assert.ok(json.numPassedTests >= minimum, `${file}: esperava ao menos ${minimum} testes verdes, houve ${json.numPassedTests}`);
  fs.rmSync(report, { force: true });
};

function requirePackage(pkg) {
  assert.ok(exists(`${pkg}/package.json`), `pacote ausente: ${pkg}`);
  assert.ok(exists(`${pkg}/package-lock.json`), `${pkg} sem package-lock.json`);
}

// ───────────────────────── escala ─────────────────────────

test('FC-018 escala: landscape 1920x1080 escala pela altura (u=1), com os mínimos do feed; imunes os formatos com altura >= largura', () => {
  const compute = read(COMPUTE); // o comentário // da FC-018 é a própria evidência
  assert.match(compute, /Math\.min\(spec\.viewport\.width, spec\.viewport\.height\) \/ policy\.referenceWidth/,
    'compute.ts sem a fórmula min(largura, altura)/referenceWidth (FC-018)');
  assert.match(compute, /FC-018/, 'compute.ts sem o comentário da FC-018');
  const policy = read(POLICY); // a fórmula vive no comentário de bloco (stripComments a removeria)
  assert.match(policy, /min\(viewport\.width, viewport\.height\) \/ referenceWidth/, 'layout-policy sem a fórmula nova');
  assert.match(policy, /referenceWidth: 1080/, 'referenceWidth precisa seguir 1080');
  requirePackage(PKG);
  vitestTemplate('gate-fc018-escala.test.ts', 4);
});

// ───────────────────────── goldens ─────────────────────────

test('FC-018 golden: regeneração consciente muda só o landscape; determinismo sem UPDATE_GOLDEN', () => {
  requirePackage(PKG);
  const run = (update) => spawnSync(path.join(ROOT, PKG, 'node_modules/.bin/vitest'),
    ['run', 'test/golden/golden.test.ts', '--reporter=basic'],
    { cwd: path.join(ROOT, PKG), encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: '1', NODE_ENV: 'test', ...(update ? { UPDATE_GOLDEN: '1' } : {}) } });
  const first = run(true);
  assert.equal(first.status, 0, `regeneração de goldens falhou:\n${(first.stdout ?? '').split('\n').slice(-20).join('\n')}`);
  const changed = spawnSync('git', ['status', '--short', `${PKG}/test/golden`], { cwd: ROOT, encoding: 'utf8' });
  const touched = changed.stdout.split('\n').filter((line) => line.trim().length > 0);
  assert.ok(touched.some((line) => line.includes('landscape')), `regeneração sem diff consciente do landscape: ${touched.join(',')}`);
  for (const line of touched) assert.ok(line.includes('landscape'), `regeneração mudou caso imune: ${line}`);
  const second = run(false);
  assert.equal(second.status, 0, 'golden sem UPDATE_GOLDEN falhou (determinismo)');
});

// ───────────────────────── regressão ─────────────────────────

test('FC-018 regressao: pacote inteiro e os gates FC-003 seguem verdes com a escala nova', () => {
  requirePackage(PKG);
  // Presença da entrega (falha na linha de base por design).
  assert.match(stripComments(read(COMPUTE)), /Math\.min\(spec\.viewport\.width, spec\.viewport\.height\) \/ policy\.referenceWidth/,
    'compute.ts sem a fórmula min (FC-018)');
  // O template da escala só existe em quality/test/delivery/fc-018/: copia para o pacote, roda e remove.
  const escalaDest = path.join(ROOT, PKG, 'test/gate-fc018-escala.test.ts');
  fs.copyFileSync(path.join(ROOT, 'quality/test/delivery/fc-018/gate-fc018-escala.test.ts'), escalaDest);
  try {
    vitestPackage('test/assets-embutidos.test.ts', 2);
    vitestPackage('test/golden/golden.test.ts', 2);
    vitestPackage('test/gate-fc018-escala.test.ts', 4);
  } finally { fs.rmSync(escalaDest, { force: true }); }
  const fc003 = spawnSync('node', ['--test', 'quality/test/delivery/fc-003.test.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(fc003.error, undefined, `fc-003.test.mjs não executou: ${fc003.error?.message}`);
  assert.equal(fc003.status, 0, `gates FC-003 falharam com a escala nova:\n${(fc003.stdout ?? '').split('\n').slice(-30).join('\n')}`);
});

// ───────────────────────── documentação ─────────────────────────

test('FC-018 docs: layout-policy com a fórmula min, spec FC-003 com o ponteiro da decisão e nenhum identificador real', () => {
  const policy = read(POLICY);
  assert.match(policy, /FC-018/, 'layout-policy sem o ponteiro da FC-018');
  assert.match(policy, /min\(viewport\.width, viewport\.height\)/, 'layout-policy sem a fórmula min');
  const spec = read(SPEC_FC003);
  assert.match(spec, /FC-018/, 'spec FC-003 sem o ponteiro da decisão (FC-018)');
  const compute = read(COMPUTE); // o comentário // da FC-018 é a própria evidência
  assert.match(compute, /FC-018/, 'compute.ts sem o comentário da FC-018');
  for (const file of [SPEC_FC003, COMPUTE, POLICY, 'quality/test/delivery/fc-018/gate-fc018-escala.test.ts', 'quality/test/delivery/fc-005.test.mjs']) {
    assert.ok(exists(file), `arquivo ausente: ${file}`);
    for (const email of read(file).match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g) ?? [])
      assert.ok(email.endsWith('@example.test'), `${file}: e-mail fora do domínio reservado`);
  }
});
