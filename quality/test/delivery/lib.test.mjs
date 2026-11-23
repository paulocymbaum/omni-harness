// Gate EG-LIB — testa quality/delivery/lib.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIB = path.resolve(import.meta.dirname, '..', '..', 'delivery', 'lib.mjs');

const {
  STATUSES, GATE_TYPES,
  backlogPath, readBacklog, writeBacklog,
  taskById, gatesForTask, dependenciesMet, nextPending, validateBacklog,
} = await import(LIB);

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-lib-')));
}

const SAMPLE = {
  id: 'test-backlog',
  title: 'Teste',
  created: '2026-10-01',
  tasks: [
    { id: 'T-001', title: 'Primeira', status: 'done', depends_on: [] },
    { id: 'T-002', title: 'Segunda', status: 'pending', depends_on: ['T-001'] },
    { id: 'T-003', title: 'Terceira', status: 'pending', depends_on: ['T-002'] },
  ],
  gates: [
    { id: 'EG-A', type: 'command', task: 'T-001', command: ['node', '--version'] },
    { id: 'EG-B', type: 'command', task: 'T-002', command: ['node', '--version'] },
  ],
};

test('STATUSES e GATE_TYPES exportados', () => {
  assert.ok(Array.isArray(STATUSES));
  assert.ok(STATUSES.includes('pending') && STATUSES.includes('done'));
  assert.ok(Array.isArray(GATE_TYPES));
  assert.ok(GATE_TYPES.includes('command') && GATE_TYPES.includes('manual'));
});

test('writeBacklog / readBacklog ida e volta', () => {
  const dir = tmpDir();
  writeBacklog(dir, SAMPLE);
  assert.ok(fs.existsSync(backlogPath(dir)));
  const loaded = readBacklog(dir);
  assert.equal(loaded.id, 'test-backlog');
  assert.equal(loaded.tasks.length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readBacklog lança se não existe', () => {
  assert.throws(() => readBacklog('/nao-existe-xyz'), /backlog\.json/);
});

test('taskById localiza e devolve null se ausente', () => {
  assert.equal(taskById(SAMPLE, 'T-001').title, 'Primeira');
  assert.equal(taskById(SAMPLE, 'NOPE'), null);
});

test('gatesForTask filtra por tarefa', () => {
  assert.equal(gatesForTask(SAMPLE, 'T-001').length, 1);
  assert.equal(gatesForTask(SAMPLE, 'T-003').length, 0);
});

test('dependenciesMet: done satisfaz; pending não satisfaz', () => {
  assert.ok(dependenciesMet(SAMPLE, 'T-002'));   // T-001 está done
  assert.ok(!dependenciesMet(SAMPLE, 'T-003'));  // T-002 está pending
});

test('nextPending devolve primeira tarefa desbloqueada', () => {
  const next = nextPending(SAMPLE);
  assert.equal(next?.id, 'T-002');
});

test('validateBacklog: backlog válido sem erros', () => {
  assert.deepEqual(validateBacklog(SAMPLE), []);
});

test('validateBacklog: detecta erros estruturais', () => {
  const bad = { id: '', tasks: [{ id: 'A', status: 'xxx', depends_on: [] }], gates: [] };
  const errs = validateBacklog(bad);
  assert.ok(errs.some((e) => /id obrigatório/.test(e)), 'deve detectar id vazio');
  assert.ok(errs.some((e) => /title obrigatório/.test(e)), 'deve detectar title faltando');
  assert.ok(errs.some((e) => /status inválido/.test(e)), 'deve detectar status inválido');
});

test('validateBacklog: detecta depends_on para id inexistente', () => {
  const bad = {
    id: 'x', title: 'X', created: '2026-10-01',
    tasks: [{ id: 'A', title: 'A', status: 'pending', depends_on: ['NOPE'] }],
    gates: [],
  };
  const errs = validateBacklog(bad);
  assert.ok(errs.some((e) => /NOPE/.test(e)));
});
