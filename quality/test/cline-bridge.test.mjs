// Paridade Claude ↔ Cline: o Cline roda os MESMOS scripts de hook do Claude através de quality/lib/cline-bridge.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo, runScript, QUALITY_DIR } from './helpers.mjs';
import { SCRIPTS, claudeCalls, shellCommands, kindOf } from '../lib/cline-bridge.mjs';

const REPO = path.dirname(QUALITY_DIR);
const pre = (repo, payload) => runScript(repo, 'hooks/cline-pre-tool-use.mjs', { taskId: 'tp', ...payload });
const post = (repo, payload) => runScript(repo, 'hooks/cline-post-tool-use.mjs', { taskId: 'tq', ...payload });
const life = (repo, event, payload = {}) => runScript(repo, 'hooks/cline-lifecycle.mjs', { taskId: 'tl', ...payload }, [event]);

const BACKLOG = 'docs/entregas/2026-01-01-x/backlog.json';
const BACKLOG_TEXT = '{\n  "tasks": [\n    { "id": "A-1", "status": "pending" }\n  ]\n}\n';

test('todos os scripts do Claude usados pela ponte existem', () => {
  for (const rel of Object.values(SCRIPTS)) assert.ok(fs.existsSync(path.join(REPO, rel)), rel);
});

test('hooks do Cline existem, executáveis e com o nome exato que o Cline descobre', () => {
  for (const name of ['PreToolUse', 'PostToolUse', 'TaskStart', 'TaskResume', 'TaskComplete']) {
    const f = path.join(REPO, '.clinerules', 'hooks', name);
    assert.ok(fs.existsSync(f), name);
    assert.ok(fs.statSync(f).mode & 0o111, `${name} sem permissão de execução`);
  }
});

test('tradução: ferramentas do Cline viram Bash/Write/Edit/MultiEdit do Claude', () => {
  assert.equal(kindOf('run_commands'), 'shell');
  assert.equal(kindOf('write_to_file'), 'edit');
  assert.equal(kindOf('read_files'), null);
  assert.deepEqual(shellCommands({ commands: ['ls', 'pwd'] }), ['ls', 'pwd']);
  assert.deepEqual(shellCommands(JSON.stringify({ command: 'git status' })), ['git status']);
  const w = claudeCalls('write_to_file', { path: 'a.mjs', content: 'x' }, '/r')[0];
  assert.deepEqual([w.tool_name, w.tool_input.content], ['Write', 'x']);
  const e = claudeCalls('editor', { command: 'str_replace', path: 'a.mjs', old_str: 'a', new_str: 'b' }, '/r')[0];
  assert.deepEqual([e.tool_name, e.tool_input.old_string, e.tool_input.new_string], ['Edit', 'a', 'b']);
  const m = claudeCalls('replace_in_file', { path: 'a.mjs', diff: '<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE' }, '/r')[0];
  assert.deepEqual([m.tool_name, m.tool_input.edits], ['MultiEdit', [{ old_string: 'x', new_string: 'y' }]]);
  const p = claudeCalls('apply_patch', { input: '*** Begin Patch\n*** Update File: a.mjs\n+linha nova\n*** End Patch' }, '/r')[0];
  assert.equal(p.tool_input.new_string, 'linha nova');
});

test('PreToolUse (SDK): gitflow nega comando de shell de forma suave (overrideInput, sem cancelar a tarefa)', () => {
  const repo = tempRepo({ 'README.md': '#\n' });
  try {
    const r = pre(repo, { tool_call: { name: 'run_commands', input: { commands: ['git switch -c tarefa-livre'] } } });
    assert.equal(r.json.cancel, false);
    assert.match(r.json.overrideInput.commands[0], /exit 1/);
    assert.match(r.json.context, /BLOQUEADO pelo harness/);
  } finally { repo.cleanup(); }
});

test('PreToolUse (extensão): sem overrideInput, a negação usa cancel com errorMessage', () => {
  const repo = tempRepo({ 'README.md': '#\n' });
  try {
    const r = pre(repo, { preToolUse: { toolName: 'execute_command', parameters: { command: 'git switch -c tarefa-livre' } } });
    assert.equal(r.json.cancel, true);
    assert.match(r.json.errorMessage, /BLOQUEADO pelo harness/);
  } finally { repo.cleanup(); }
});

test('PreToolUse: editar status no backlog.json é negado (guarda-backlog), editar outro campo passa', () => {
  const repo = tempRepo({ [BACKLOG]: BACKLOG_TEXT });
  try {
    const bad = pre(repo, { tool_call: { name: 'editor', input: { command: 'str_replace', path: BACKLOG, old_str: '"status": "pending"', new_str: '"status": "done"' } } });
    assert.equal(bad.json.cancel, true);
    assert.match(bad.json.errorMessage, /backlog\.mjs mark/);
    const ok = pre(repo, { tool_call: { name: 'editor', input: { command: 'str_replace', path: BACKLOG, old_str: '"id": "A-1"', new_str: '"id": "A-1", "title": "t"' } } });
    assert.equal(ok.json.cancel, false);
  } finally { repo.cleanup(); }
});

test('PreToolUse: comando comum não é negado', () => {
  const repo = tempRepo({ 'README.md': '#\n' });
  try {
    const r = pre(repo, { tool_call: { name: 'run_commands', input: { commands: ['ls -la'] } } });
    assert.equal(r.json.cancel, false);
  } finally { repo.cleanup(); }
});

test('PostToolUse: regras de domínio (CPF literal) voltam como contexto, igual ao exit 2 do Claude', () => {
  const repo = tempRepo({ 'README.md': '#\n' });
  try {
    repo.write('lib/x.dart', "const cpf = '529.982.247-25';\n");
    const r = post(repo, { tool_call: { name: 'write_to_file', input: { path: 'lib/x.dart', content: "const cpf = '529.982.247-25';\n" } }, tool_result: { name: 'write_to_file' } });
    assert.match(r.json.contextModification, /regras de domínio/i);
  } finally { repo.cleanup(); }
});

test('PostToolUse: gates rápidos do Claude também rodam (tamanho de arquivo novo reprova)', () => {
  const repo = tempRepo({ 'README.md': '#\n' });
  try {
    const big = Array.from({ length: 600 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
    repo.write('functions/src/big.ts', big);
    const r = post(repo, { postToolUse: { toolName: 'write_to_file', parameters: { path: 'functions/src/big.ts' }, success: true } });
    assert.match(r.json.contextModification, /REPROVADO|reprovado/i);
  } finally { repo.cleanup(); }
});

test('TaskStart/TaskResume entregam o inventário de gates; TaskComplete responde JSON válido', () => {
  const repo = tempRepo({ 'README.md': '#\n' });
  try {
    for (const ev of ['TaskStart', 'TaskResume']) assert.match(life(repo, ev).json.context, /Gates de qualidade ativos/);
    const done = life(repo, 'TaskComplete');
    assert.equal(done.code, 0);
    assert.ok(done.json && typeof done.json === 'object');
  } finally { repo.cleanup(); }
});

test('TaskComplete roda os gates da sessão: arquivo tocado com falha volta como contexto', () => {
  const repo = tempRepo({ 'lib/features/feed/domain/post.dart': 'class Post {}\n' });
  try {
    repo.write('lib/features/feed/domain/post.dart', "import 'package:cloud_firestore/cloud_firestore.dart';\nclass Post {}\n");
    post(repo, { taskId: 'tz', postToolUse: { toolName: 'editor', parameters: { path: 'lib/features/feed/domain/post.dart' }, success: true } });
    const done = life(repo, 'TaskComplete', { taskId: 'tz' });
    assert.ok(done.json?.context, done.stdout);
  } finally { repo.cleanup(); }
});
