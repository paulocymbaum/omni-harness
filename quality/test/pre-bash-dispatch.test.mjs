// Despachante único do PreToolUse: mesma precedência e mesmos efeitos das 4 entradas anteriores
// (guarda de busca, evidência de testes, gitflow, rtk), em UM processo, com falha aberta por etapa.
import './bootstrap-example-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { QUALITY_DIR, tempRepo, runScript } from './helpers.mjs';
import { dispatch } from '../hooks/pre-bash-dispatch.mjs';

const ROOT = path.dirname(QUALITY_DIR);
const call = (r, input, env = {}) => runScript(r, 'hooks/pre-bash-dispatch.mjs', { session_id: 's1', ...input }, [], env);
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const decisionOf = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? null;

function withGraph(repo) {
  fs.mkdirSync(path.join(repo.dir, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, 'graphify-out', 'graph.json'), '{}');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gbin-'));
  fs.writeFileSync(path.join(bin, 'graphify'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { graphify: path.join(bin, 'graphify'), cleanup: () => fs.rmSync(bin, { recursive: true, force: true }) };
}

function fakeRtk(rewrite) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtkbin-'));
  fs.writeFileSync(path.join(dir, 'rtk'), `#!/bin/sh\ncat >/dev/null\necho '${JSON.stringify(rewrite)}'\n`, { mode: 0o755 });
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('etapa 1: busca bruta é negada para Bash, Grep e Glob; Read e comandos comuns passam', () => {
  const repo = tempRepo({ 'README.md': '# x\n' });
  const cli = withGraph(repo);
  try {
    const env = { GRAPHIFY_BIN: cli.graphify, RTK_DISABLED: '1', GRAPHIFY_HOOK_MODE: 'strict' };
    for (const input of [bash('grep -rn Splash .'), { tool_name: 'Grep', tool_input: { pattern: 'Splash' } }, { tool_name: 'Glob', tool_input: { pattern: '**/*.dart' } }]) {
      const r = call(repo, input, env);
      assert.equal(decisionOf(r), 'deny', JSON.stringify(input));
      assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /chamada separada/);
    }
    assert.equal(call(repo, bash('ls -la'), env).stdout, '');
    assert.equal(call(repo, { tool_name: 'Read', tool_input: { file_path: 'a.dart' } }, env).stdout, '');
    // janela aberta por consulta bem-sucedida (PostToolUse) libera a busca no mesmo despachante
    const post = runScript(repo, 'hooks/post-search-graphify.mjs', { tool_name: 'Bash', tool_input: { command: 'graphify query "X"' }, tool_response: { stdout: 'NODE X [src=a.dart]\n' }, session_id: 's1' }, [], env);
    assert.equal(post.code, 0);
    assert.equal(call(repo, bash('grep -rn Splash .'), env).stdout, '');
  } finally { cli.cleanup(); repo.cleanup(); }
});

test('modo suave (padrão): a busca nunca é negada; a dica por additionalContext convive com a reescrita do rtk', () => {
  const repo = tempRepo({ 'README.md': '# x\n' });
  const cli = withGraph(repo);
  const rtk = fakeRtk({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'rtk rg Splash lib' } } });
  try {
    const base = { GRAPHIFY_BIN: cli.graphify, GRAPHIFY_HOOK_MODE: '' };
    const only = call(repo, bash('rg Splash lib'), { ...base, RTK_DISABLED: '1' });
    assert.equal(decisionOf(only), null);
    assert.match(only.json.hookSpecificOutput.additionalContext, /não bloqueia nada/);
    const withRtk = { ...base, PATH: `${rtk.dir}${path.delimiter}${process.env.PATH}` };
    const both = call(repo, { ...bash('rg Splash lib'), session_id: 's2' }, withRtk);
    assert.equal(decisionOf(both), null);
    assert.equal(both.json.hookSpecificOutput.updatedInput.command, 'rtk rg Splash lib');
    assert.match(both.json.hookSpecificOutput.additionalContext, /graphify query/);
    const again = call(repo, { ...bash('rg Outra lib'), session_id: 's2' }, withRtk);
    assert.equal(again.json.hookSpecificOutput.additionalContext, undefined);
    assert.ok(again.json.hookSpecificOutput.updatedInput);
    assert.match(call(repo, { tool_name: 'Grep', tool_input: { pattern: 'x' }, session_id: 's3' }, { ...base, RTK_DISABLED: '1' }).json.hookSpecificOutput.additionalContext, /graphify query/);
    assert.equal(call(repo, bash('rg Foo docs'), { ...base, RTK_DISABLED: '1' }).stdout, '');
  } finally { rtk.cleanup(); cli.cleanup(); repo.cleanup(); }
});

test('etapa 3: gitflow nega pai errado de branch (mesma mensagem do hook individual)', () => {
  const repo = tempRepo({ 'README.md': '# x\n' }); // nasce em main
  try {
    const env = { RTK_DISABLED: '1' };
    const viaDispatch = call(repo, bash('git switch -c feat/outra'), env);
    const direct = runScript(repo, 'hooks/pre-bash-gitflow.mjs', bash('git switch -c feat/outra'), [], env);
    assert.equal(decisionOf(viaDispatch), 'deny', viaDispatch.stdout);
    assert.match(viaDispatch.json.hookSpecificOutput.permissionDecisionReason, /nasce de develop/);
    assert.deepEqual(viaDispatch.json, direct.json, 'mesma decisão que o hook individual');
    assert.equal(call(repo, bash('git status'), env).stdout, ''); // git inofensivo passa
  } finally { repo.cleanup(); }
});

test('etapa 2: a evidência de testes antes do commit decide igual ao pre-bash individual', () => {
  const repo = tempRepo({ 'backend/src/A.cs': 'class A {}\n', 'README.md': '# x\n' });
  try {
    repo.write('backend/src/A.cs', 'class A { int x; }\n'); // mudança de backend sem evidência
    const env = { RTK_DISABLED: '1' };
    const viaDispatch = call(repo, bash('git commit -m "feat: x"'), env);
    const direct = runScript(repo, 'hooks/pre-bash.mjs', bash('git commit -m "feat: x"'), [], env);
    assert.equal(decisionOf(direct), 'deny', direct.stdout);
    assert.deepEqual(viaDispatch.json, direct.json);
  } finally { repo.cleanup(); }
});

test('etapa 4: rtk só reescreve quando nenhuma etapa decidiu, e nunca --version/--help', () => {
  const repo = tempRepo({ 'README.md': '# x\n' });
  const cli = withGraph(repo);
  const rtk = fakeRtk({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'rtk git status' } } });
  try {
    const env = { PATH: `${rtk.dir}${path.delimiter}${process.env.PATH}`, GRAPHIFY_BIN: cli.graphify };
    assert.equal(JSON.parse(call(repo, bash('git status'), env).stdout).hookSpecificOutput.updatedInput.command, 'rtk git status');
    assert.equal(call(repo, bash('npx eslint --version'), env).stdout, '', '--version não é reescrito');
    assert.equal(call(repo, bash('rg --help'), env).stdout, '');
    // busca negada: a decisão vence e o rtk nem entra
    const denied = call(repo, bash('grep -rn Splash .'), { ...env, GRAPHIFY_HOOK_MODE: 'strict' });
    assert.equal(decisionOf(denied), 'deny');
    assert.equal(denied.json.hookSpecificOutput.updatedInput, undefined);
    assert.equal(call(repo, bash('git status'), { ...env, RTK_DISABLED: '1' }).stdout, '');
    assert.equal(call(repo, { tool_name: 'Grep', tool_input: { pattern: 'x', path: 'a.ts' } }, env).stdout, '', 'rtk não atua em Grep');
  } finally { rtk.cleanup(); cli.cleanup(); repo.cleanup(); }
});

test('falha aberta por etapa: uma etapa que quebra não derruba as outras nem bloqueia', async () => {
  const stderr = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    // payload sem tool_input e entrada inválida: nenhuma etapa pode lançar para fora
    assert.equal(await dispatch({}, '{}', { RTK_DISABLED: '1' }), null);
    assert.equal(await dispatch({ tool_name: 'Bash' }, '{}', { RTK_DISABLED: '1' }), null);
  } finally { process.stderr.write = write; }
  const garbage = spawnSync(process.execPath, [path.join(QUALITY_DIR, 'hooks/pre-bash-dispatch.mjs')], { input: 'não é json', encoding: 'utf8' });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
  const empty = spawnSync(process.execPath, [path.join(QUALITY_DIR, 'hooks/pre-bash-dispatch.mjs')], { input: '', encoding: 'utf8' });
  assert.equal(empty.status, 0);
});

test('settings.json: UMA entrada de PreToolUse para Bash, Grep e Glob; os scripts individuais continuam existindo', () => {
  const pre = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8')).hooks.PreToolUse;
  const search = pre.filter((e) => /Bash/.test(e.matcher));
  assert.equal(search.length, 1, 'um único despachante para Bash, Grep e Glob');
  assert.equal(search[0].matcher, 'Bash|Grep|Glob');
  assert.equal(search[0].hooks.length, 1);
  assert.match(search[0].hooks[0].command, /pre-bash-dispatch\.mjs/);
  const edits = pre.filter((e) => !/Bash/.test(e.matcher));
  assert.deepEqual(edits.map((e) => e.matcher), ['Edit|Write|MultiEdit'], 'a única outra entrada é a guarda do backlog');
  assert.match(edits[0].hooks[0].command, /guarda-backlog\.mjs/);
  for (const stage of ['pre-bash.mjs', 'pre-bash-gitflow.mjs', 'pre-bash-rtk.mjs', 'pre-search-graphify.mjs']) {
    assert.ok(fs.existsSync(path.join(QUALITY_DIR, 'hooks', stage)), stage);
  }
  const source = fs.readFileSync(path.join(QUALITY_DIR, 'hooks/pre-bash-dispatch.mjs'), 'utf8');
  for (const piece of ['search-guard.mjs', 'pre-bash.mjs', 'pre-bash-gitflow.mjs', 'rtk-rewrite.mjs']) assert.match(source, new RegExp(piece.replace('.', '\\.')));
});
