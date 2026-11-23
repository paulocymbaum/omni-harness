// Gate EG-GUARDA — testa quality/delivery/guarda-entrega.mjs (hook de edição)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const GUARDA = path.resolve(import.meta.dirname, '..', '..', 'delivery', 'guarda-entrega.mjs');

function run(input, env = {}) {
  const r = spawnSync(process.execPath, [GUARDA], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, ...env },
  });
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { /* */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function tmpState(dir, state) {
  const stateDir = path.join(dir, 'quality', '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  if (state) fs.writeFileSync(path.join(stateDir, 'entrega-ativa.json'), JSON.stringify(state));
  return dir;
}

test('sem entrega-ativa.json: não bloqueia', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-guard-')));
  const r = run(
    { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'lib/foo.dart') } },
    { CLAUDE_PROJECT_DIR: dir, QUALITY_ROOT: dir },
  );
  assert.equal(r.code, 0);
  assert.equal(r.json, null); // sem output = sem bloqueio
  fs.rmSync(dir, { recursive: true, force: true });
});

test('com entrega-ativa: bloqueia edição fora do escopo da tarefa', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-guard-')));
  tmpState(dir, {
    taskId: 'RB-009',
    scope: ['quality/delivery/integridade.mjs', 'quality/test/delivery/integridade.test.mjs'],
  });
  const r = run(
    { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'lib/unrelated.dart') } },
    { CLAUDE_PROJECT_DIR: dir, QUALITY_ROOT: dir },
  );
  // pode bloquear (code 2 + stderr) ou só avisar (json com additionalContext)
  // o importante é que não retorne code 0 sem aviso quando fora do escopo
  const blocked = r.code === 2 || (r.json?.decision === 'block');
  const warned = r.json?.hookSpecificOutput?.additionalContext != null;
  assert.ok(blocked || warned, `esperava bloqueio ou aviso; code=${r.code} json=${JSON.stringify(r.json)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('com entrega-ativa: permite edição dentro do escopo', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-guard-')));
  tmpState(dir, {
    taskId: 'RB-009',
    scope: ['quality/delivery/integridade.mjs'],
  });
  const r = run(
    { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'quality/delivery/integridade.mjs') } },
    { CLAUDE_PROJECT_DIR: dir, QUALITY_ROOT: dir },
  );
  assert.equal(r.code, 0);
  assert.ok(!r.json?.decision, 'não deve bloquear arquivo dentro do escopo');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ferramenta que não é edição nunca é bloqueada', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-guard-')));
  tmpState(dir, { taskId: 'RB-009', scope: [] });
  const r = run(
    { tool_name: 'Bash', tool_input: { command: 'ls' } },
    { CLAUDE_PROJECT_DIR: dir, QUALITY_ROOT: dir },
  );
  assert.equal(r.code, 0);
  assert.ok(!r.json?.decision);
  fs.rmSync(dir, { recursive: true, force: true });
});
