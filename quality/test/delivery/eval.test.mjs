// Gate EG-EVAL — testa quality/delivery/eval.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EVAL = path.resolve(import.meta.dirname, '..', '..', 'delivery', 'eval.mjs');
const { evalTask } = await import(EVAL);

function tmpDir(backlog) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-eval-')));
  fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));
  return dir;
}

const BACKLOG_PASS = {
  id: 'test', title: 'Teste', created: '2026-10-01',
  tasks: [{ id: 'T-001', title: 'A', status: 'pending', depends_on: [] }],
  gates: [
    { id: 'EG-A', type: 'command', task: 'T-001', command: ['node', '--version'] },
  ],
};

const BACKLOG_FAIL = {
  id: 'test', title: 'Teste', created: '2026-10-01',
  tasks: [{ id: 'T-001', title: 'A', status: 'pending', depends_on: [] }],
  gates: [
    { id: 'EG-A', type: 'command', task: 'T-001', command: ['node', '-e', 'process.exit(1)'] },
  ],
};

const BACKLOG_NO_GATES = {
  id: 'test', title: 'Teste', created: '2026-10-01',
  tasks: [{ id: 'T-001', title: 'A', status: 'pending', depends_on: [] }],
  gates: [],
};

test('evalTask: tarefa com gate que passa', async () => {
  const dir = tmpDir(BACKLOG_PASS);
  const result = await evalTask(dir, 'T-001');
  assert.ok(result.passed);
  assert.equal(result.results.length, 1);
  assert.ok(result.results[0].passed);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('evalTask: tarefa com gate que falha', async () => {
  const dir = tmpDir(BACKLOG_FAIL);
  const result = await evalTask(dir, 'T-001');
  assert.ok(!result.passed);
  assert.equal(result.results.length, 1);
  assert.ok(!result.results[0].passed);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('evalTask: tarefa sem gates retorna passed=true', async () => {
  const dir = tmpDir(BACKLOG_NO_GATES);
  const result = await evalTask(dir, 'T-001');
  assert.ok(result.passed);
  assert.equal(result.results.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('evalTask: tarefa inexistente retorna passed=false', async () => {
  const dir = tmpDir(BACKLOG_PASS);
  const result = await evalTask(dir, 'NOPE');
  assert.ok(!result.passed);
  assert.ok(/não encontrada|not found/i.test(result.error ?? ''));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('evalTask: gates manuais são ignorados no runner', async () => {
  const backlog = {
    id: 'test', title: 'Teste', created: '2026-10-01',
    tasks: [{ id: 'T-001', title: 'A', status: 'pending', depends_on: [] }],
    gates: [
      { id: 'EG-M', type: 'manual', task: 'T-001', description: 'Verificação visual' },
    ],
  };
  const dir = tmpDir(backlog);
  const result = await evalTask(dir, 'T-001');
  assert.ok(result.passed); // nenhum gate de command → passa
  assert.equal(result.results.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
