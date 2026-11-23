// Gate EG-BACKLOG — testa backlog.mjs init / status / render
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BACKLOG_MJS = path.resolve(import.meta.dirname, '..', '..', 'delivery', 'backlog.mjs');

function run(args, { input } = {}) {
  const r = spawnSync(process.execPath, [BACKLOG_MJS, ...args], {
    encoding: 'utf8', input, timeout: 30_000,
    env: { ...process.env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-bkl-')));
}

test('init: cria backlog.json', () => {
  const dir = tmpDir();
  const r = run(['init', dir]);
  assert.equal(r.code, 0, r.stderr);
  const p = path.join(dir, 'backlog.json');
  assert.ok(fs.existsSync(p));
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(Array.isArray(data.tasks));
  assert.ok(Array.isArray(data.gates));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('init: falha se já existe (sem --force)', () => {
  const dir = tmpDir();
  run(['init', dir]);
  const r = run(['init', dir]);
  assert.notEqual(r.code, 0);
  assert.ok(/já existe|already exists/i.test(r.stderr));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('init --force: sobrescreve', () => {
  const dir = tmpDir();
  run(['init', dir]);
  const r = run(['init', dir, '--force']);
  assert.equal(r.code, 0, r.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status: exibe resumo', () => {
  const dir = tmpDir();
  const backlog = {
    id: 'test', title: 'Meu Backlog', created: '2026-10-01',
    tasks: [
      { id: 'T-001', title: 'Alpha', status: 'done', depends_on: [] },
      { id: 'T-002', title: 'Beta', status: 'pending', depends_on: ['T-001'] },
    ],
    gates: [],
  };
  fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(backlog));
  const r = run(['status', dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('T-001'));
  assert.ok(r.stdout.includes('T-002'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('render: saída markdown com tabela', () => {
  const dir = tmpDir();
  const backlog = {
    id: 'test', title: 'Meu Backlog', created: '2026-10-01',
    tasks: [{ id: 'T-001', title: 'Alpha', status: 'pending', depends_on: [] }],
    gates: [{ id: 'EG-A', type: 'command', task: 'T-001', command: ['node', '--version'] }],
  };
  fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(backlog));
  const r = run(['render', dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('# Backlog'));
  assert.ok(r.stdout.includes('T-001'));
  assert.ok(r.stdout.includes('EG-A'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('comando desconhecido sai com erro', () => {
  const dir = tmpDir();
  const r = run(['nope', dir]);
  assert.notEqual(r.code, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
