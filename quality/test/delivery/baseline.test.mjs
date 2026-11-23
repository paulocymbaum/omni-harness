// Gate EG-BASELINE — testa que eval.mjs --baseline sai sempre com código 0
// (a saída documenta quais gates passam/falham antes da implementação)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const EVAL_MJS = path.resolve(import.meta.dirname, '..', '..', 'delivery', 'eval.mjs');

function run(args) {
  const r = spawnSync(process.execPath, [EVAL_MJS, ...args], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tmpDir(backlog) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-base-')));
  fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));
  return dir;
}

const BACKLOG = {
  id: 'test', title: 'T', created: '2026-10-01',
  tasks: [{ id: 'T-001', title: 'A', status: 'pending', depends_on: [] }],
  gates: [
    { id: 'EG-PASS', type: 'command', task: 'T-001', command: ['node', '--version'] },
    { id: 'EG-FAIL', type: 'command', task: 'T-001', command: ['node', '-e', 'process.exit(1)'] },
  ],
};

test('--baseline sempre sai com código 0 (independente dos gates)', () => {
  const dir = tmpDir(BACKLOG);
  const r = run([dir, 'T-001', '--baseline']);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--baseline reporta quais passaram e quais falharam', () => {
  const dir = tmpDir(BACKLOG);
  const r = run([dir, 'T-001', '--baseline']);
  assert.ok(r.stdout.includes('EG-PASS') || r.stdout.includes('EG-FAIL'),
    'deve listar gates no stdout');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sem --baseline: gates falhando sai com código != 0', () => {
  const dir = tmpDir({
    id: 'test', title: 'T', created: '2026-10-01',
    tasks: [{ id: 'T-001', title: 'A', status: 'pending', depends_on: [] }],
    gates: [{ id: 'EG-F', type: 'command', task: 'T-001', command: ['node', '-e', 'process.exit(1)'] }],
  });
  const r = run([dir, 'T-001']);
  assert.notEqual(r.code, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
