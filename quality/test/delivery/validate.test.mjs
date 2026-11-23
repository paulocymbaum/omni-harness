// Gate EG-VALIDATE — testa backlog.mjs validate
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BACKLOG_MJS = path.resolve(import.meta.dirname, '..', '..', 'delivery', 'backlog.mjs');

function run(args) {
  const r = spawnSync(process.execPath, [BACKLOG_MJS, ...args], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tmpDir(backlog) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-val-')));
  fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));
  return dir;
}

const VALID = {
  id: 'test', title: 'Teste', created: '2026-10-01',
  tasks: [{ id: 'T-001', title: 'Alpha', status: 'pending', depends_on: [] }],
  gates: [{ id: 'EG-A', type: 'command', task: 'T-001', command: ['node', '--version'] }],
};

test('validate: backlog válido sai 0', () => {
  const dir = tmpDir(VALID);
  const r = run(['validate', dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(/válido|valid/i.test(r.stdout));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validate: detecta status inválido', () => {
  const bad = JSON.parse(JSON.stringify(VALID));
  bad.tasks[0].status = 'flying';
  const dir = tmpDir(bad);
  const r = run(['validate', dir]);
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes('flying'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validate: detecta depends_on para id inexistente', () => {
  const bad = JSON.parse(JSON.stringify(VALID));
  bad.tasks[0].depends_on = ['NOPE'];
  const dir = tmpDir(bad);
  const r = run(['validate', dir]);
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes('NOPE'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validate --require-specs: falha se spec não existe', () => {
  const dir = tmpDir(VALID);
  const r = run(['validate', dir, '--require-specs']);
  assert.notEqual(r.code, 0);
  assert.ok(/spec/i.test(r.stderr));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validate --require-specs: passa se spec existe', () => {
  const dir = tmpDir(VALID);
  fs.mkdirSync(path.join(dir, 'specs'));
  fs.writeFileSync(path.join(dir, 'specs', 'T-001.md'), '# T-001\nStatus: ready\n');
  const r = run(['validate', dir, '--require-specs']);
  assert.equal(r.code, 0, r.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});
