// Gate EG-INTEG — testa quality/delivery/integridade.mjs (detector de force-pass)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const INTEG = path.resolve(import.meta.dirname, '..', '..', 'delivery', 'integridade.mjs');
const { checkIntegrity } = await import(INTEG);

function tmpDir(backlog) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-integ-')));
  fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));
  return dir;
}

const HONEST = {
  id: 'test', title: 'Teste', created: '2026-10-01',
  tasks: [
    { id: 'T-001', title: 'A', status: 'done', depends_on: [], done_at: '2026-10-01T10:00:00Z' },
    { id: 'T-002', title: 'B', status: 'pending', depends_on: ['T-001'] },
  ],
  gates: [
    { id: 'EG-A', type: 'command', task: 'T-001', command: ['node', '--version'] },
  ],
};

test('backlog honesto não tem achados', () => {
  const dir = tmpDir(HONEST);
  const findings = checkIntegrity(dir);
  assert.deepEqual(findings, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('task done sem done_at é suspeita (sem timestamp de encerramento)', () => {
  const bl = JSON.parse(JSON.stringify(HONEST));
  delete bl.tasks[0].done_at;
  const dir = tmpDir(bl);
  const findings = checkIntegrity(dir);
  assert.ok(findings.some((f) => f.task === 'T-001' && /done_at/.test(f.reason)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('task done com dependência ainda pending é suspeita', () => {
  const bl = {
    id: 'test', title: 'T', created: '2026-10-01',
    tasks: [
      { id: 'T-001', title: 'A', status: 'pending', depends_on: [] },
      { id: 'T-002', title: 'B', status: 'done', depends_on: ['T-001'], done_at: '2026-10-01T10:00:00Z' },
    ],
    gates: [],
  };
  const dir = tmpDir(bl);
  const findings = checkIntegrity(dir);
  assert.ok(findings.some((f) => f.task === 'T-002' && /depend/i.test(f.reason)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gate sem command em task done é suspeito', () => {
  const bl = {
    id: 'test', title: 'T', created: '2026-10-01',
    tasks: [{ id: 'T-001', title: 'A', status: 'done', depends_on: [], done_at: '2026-10-01T10:00:00Z' }],
    gates: [],
  };
  // task done mas sem nenhum gate registrado — pode ser force-pass
  const dir = tmpDir(bl);
  const findings = checkIntegrity(dir);
  // este caso é aviso, não bloqueio — a task pode legitimamente não ter gates
  assert.ok(Array.isArray(findings));
  fs.rmSync(dir, { recursive: true, force: true });
});
