// Gate EG-COMPACTA — testa quality/delivery/compactar-entregas.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { compactarEntrega } = await import(
  path.resolve(import.meta.dirname, '..', '..', 'delivery', 'compactar-entregas.mjs')
);

function tmpDir(backlog) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-comp-')));
  fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));
  return dir;
}

const BACKLOG = {
  id: 'test', title: 'Entrega Teste', created: '2026-10-01',
  tasks: [
    { id: 'T-001', title: 'Alpha', status: 'done', depends_on: [], done_at: '2026-10-01T10:00:00Z' },
    { id: 'T-002', title: 'Beta', status: 'blocked', depends_on: ['T-001'], motivo: 'aguardando externo' },
  ],
  gates: [
    { id: 'EG-A', type: 'command', task: 'T-001', command: ['node', '--version'] },
  ],
};

test('gera SUMMARY.md com tabela de tarefas', async () => {
  const dir = tmpDir(BACKLOG);
  const result = await compactarEntrega(dir);
  assert.ok(fs.existsSync(result.summaryPath));
  const content = fs.readFileSync(result.summaryPath, 'utf8');
  assert.ok(content.includes('Entrega Teste'));
  assert.ok(content.includes('T-001'));
  assert.ok(content.includes('T-002'));
  assert.ok(content.includes('done'));
  assert.ok(content.includes('blocked'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inclui seção de bloqueios quando há tarefas blocked', async () => {
  const dir = tmpDir(BACKLOG);
  const result = await compactarEntrega(dir);
  const content = fs.readFileSync(result.summaryPath, 'utf8');
  assert.ok(content.includes('aguardando externo'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('counts corretos no resultado', async () => {
  const dir = tmpDir(BACKLOG);
  const result = await compactarEntrega(dir);
  assert.equal(result.counts.done, 1);
  assert.equal(result.counts.blocked, 1);
  assert.equal(result.counts.pending, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('spec existente recebe link na tabela', async () => {
  const dir = tmpDir(BACKLOG);
  fs.mkdirSync(path.join(dir, 'specs'));
  fs.writeFileSync(path.join(dir, 'specs', 'T-001.md'), '# T-001\nStatus: ready\n');
  const result = await compactarEntrega(dir);
  const content = fs.readFileSync(result.summaryPath, 'utf8');
  assert.ok(content.includes('specs/T-001.md'));
  fs.rmSync(dir, { recursive: true, force: true });
});
