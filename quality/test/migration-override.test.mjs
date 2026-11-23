// Modo migração (--migration-override) — gates que dão falso positivo em
// merge/migração completa viram IGNORADO; gates semânticos permanecem ativos.
// Rode: node --test quality/test/migration-override.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrationOverride, MIGRATION_IGNORED_GATES, MIGRATION_DEFAULT_REASON } from '../lib/migration.mjs';
import { result } from '../lib/report.mjs';
import { tempRepo, runScript } from './helpers.mjs';

const gatesOf = (rs, status) => rs.filter((r) => r.status === status).map((r) => r.gate).sort();

test('modo migração: resultados de gates incrementais viram IGNORADO com motivo e contagem', () => {
  const results = [
    result('formato', 'fail', 'format.fail', { file: 'lib/a.dart' }),
    result('tamanho', 'fail', 'size.fail', { file: 'lib/b.dart' }),
    result('tamanho', 'warn', 'size.warn', { file: 'lib/c.dart' }),
    result('lint', 'fail', 'lint.issue', { file: 'lib/d.dart', line: 1, code: 'X', msg: 'y' }),
  ];
  const { results: out, ignoredGates } = applyMigrationOverride(results, { active: true, reason: 'primeiro release' });
  assert.deepEqual(gatesOf(out, 'fail'), []);
  assert.deepEqual(gatesOf(out, 'skip'), ['formato', 'lint', 'tamanho']);
  for (const s of out.filter((r) => r.status === 'skip')) {
    assert.equal(s.params.reason, 'primeiro release');
    assert.equal(typeof s.params.count, 'number');
    assert.ok(s.params.count >= 1);
  }
  const tamanho = out.find((r) => r.gate === 'tamanho' && r.status === 'skip');
  assert.equal(tamanho.params.count, 2);
  assert.deepEqual(ignoredGates, ['formato', 'lint', 'tamanho']);
});

test('modo migração: gates semânticos (tipos/testes/exports/ferramentas) passam intactos', () => {
  const results = [
    result('tipos', 'fail', 'types.fail', { file: 'functions/src/a.ts' }),
    result('testes', 'pass', 'tests.pass', { value: '12 aprovados' }),
    result('exports', 'warn', 'exports.warn', { file: 'functions/src/index.ts', names: 'x' }),
    result('fronteiras', 'fail', 'boundary.fail', { file: 'lib/x.dart', line: 1 }),
  ];
  const { results: out } = applyMigrationOverride(results, { active: true });
  assert.deepEqual(out.filter((r) => r.gate === 'tipos' || r.gate === 'testes' || r.gate === 'exports'), results.slice(0, 3));
  assert.deepEqual(gatesOf(out, 'skip'), ['fronteiras']);
});

test('modo migração: motivo padrão é usado quando não informado', () => {
  const { results: out } = applyMigrationOverride([result('formato', 'fail', 'format.fail', { file: 'a.dart' })], { active: true });
  assert.equal(out[0].params.reason, MIGRATION_DEFAULT_REASON);
});

test('modo migração inativo: resultados idênticos, nenhum gate ignorado', () => {
  const results = [result('formato', 'fail', 'format.fail', { file: 'a.dart' }), result('tipos', 'pass', 'types.pass', { file: 'a.ts' })];
  const { results: out, ignoredGates } = applyMigrationOverride(results, { active: false });
  assert.equal(out, results);
  assert.deepEqual(ignoredGates, []);
});

test('nenhum gate semântico está na lista de ignoráveis do modo migração', () => {
  for (const g of ['tipos', 'testes', 'exports', 'ferramentas']) {
    assert.ok(!MIGRATION_IGNORED_GATES.has(g), g);
  }
});

test('run.mjs: --migration-override exige --tier (com --risk reprova uso)', () => {
  const repo = tempRepo();
  try {
    const r = runScript(repo, 'run.mjs', '', ['--risk', '--migration-override']);
    assert.equal(r.code, 2);
  } finally { repo.cleanup(); }
});

test('run.mjs: tier com --migration-override aceita motivo e registra no JSON (escopo vazio → pass)', () => {
  const repo = tempRepo();
  try {
    const r = runScript(repo, 'run.mjs', '', ['--tier', 'rapido', '--migration-override', 'primeiro release', '--json']);
    assert.equal(r.code, 0, r.stderr || r.stdout);
    assert.equal(r.json?.migration?.reason, 'primeiro release');
    assert.deepEqual(r.json?.migration?.ignoredGates, []);
    assert.equal(r.json?.status, 'pass');
  } finally { repo.cleanup(); }
});

test('baseline.mjs: --check --migration-override ignora o ratchet mesmo sem baseline (exit 0)', () => {
  const repo = tempRepo(); // sem quality/baseline.json
  try {
    const semFlag = runScript(repo, 'baseline.mjs', '', ['--check']);
    assert.equal(semFlag.code, 2); // configuração ausente continua bloqueando no modo normal
    const comFlag = runScript(repo, 'baseline.mjs', '', ['--check', '--migration-override', 'release completo']);
    assert.equal(comFlag.code, 0);
    assert.match(comFlag.stdout, /IGNORADO/);
    assert.match(comFlag.stdout, /release completo/);
  } finally { repo.cleanup(); }
});
