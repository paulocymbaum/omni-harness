// Autocorreção e lint leves de arquivos de gate e teste (lib/autofix.mjs via hook post-edit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo, runScript } from './helpers.mjs';
import { sync } from '../agents/sync-clinerules.mjs';
import { QUALITY_DIR } from './helpers.mjs';
import { normalizeText, autofixApplies, judgeWithGuard } from '../lib/autofix.mjs';

const edit = (repo, rel, session = 's1', env = {}) => runScript(repo, 'hooks/post-edit.mjs', {
  session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(repo.dir, rel) },
}, [], env);

const FILE = 'quality/test/exemplo.test.mjs';
const OK = "import { test } from 'node:test';\ntest('a', () => {});\n";

test('normalizeText: CRLF vira LF, newline final, espaços em literais intactos', () => {
  assert.equal(normalizeText('a\r\nb'), 'a\nb\n');
  assert.equal(normalizeText('const s = `x  \n`;\n'), 'const s = `x  \n`;\n');
  assert.equal(normalizeText(''), '');
});

test('autofixApplies: só gate/teste; FLUXO_AUTOFIX=0 desliga', () => {
  assert.equal(autofixApplies('quality/lib/x.mjs'), true);
  assert.equal(autofixApplies('quality/tools/node_modules/a/b.mjs'), false);
  assert.equal(autofixApplies('lib/main.dart'), false);
  assert.equal(autofixApplies('test/features/a_test.dart'), true);
  process.env.FLUXO_AUTOFIX = '0';
  assert.equal(autofixApplies('quality/lib/x.mjs'), false);
  delete process.env.FLUXO_AUTOFIX;
});

test('judgeWithGuard: bloqueia até o teto e depois só avisa', () => {
  const s = {};
  const bad = { errors: ['x'] };
  for (let i = 0; i < 3; i++) assert.equal(judgeWithGuard(s, 'a', bad).block, true);
  assert.deepEqual(judgeWithGuard(s, 'a', bad), { block: false, exhausted: true });
  assert.equal(judgeWithGuard(s, 'a', { errors: [] }).block, false);
  assert.equal(judgeWithGuard(s, 'a', bad).block, true);
});

test('post-edit: arquivo válido passa sem ruído de autofix', () => {
  const repo = tempRepo({ [FILE]: OK });
  try {
    repo.write(FILE, `${OK}test('b', () => {});\n`);
    const r = edit(repo, FILE);
    assert.equal(r.code, 0, r.stderr);
  } finally { repo.cleanup(); }
});

test('post-edit: CRLF e falta de newline final são corrigidos em disco', () => {
  const repo = tempRepo({ [FILE]: OK });
  try {
    repo.write(FILE, "import { test } from 'node:test';\r\ntest('a', () => {});");
    const r = edit(repo, FILE);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(repo.dir, FILE), 'utf8'), OK);
    assert.match(r.json.hookSpecificOutput.additionalContext, /Autocorreção/);
  } finally { repo.cleanup(); }
});

test('post-edit: erro de sintaxe bloqueia (exit 2) com arquivo e linha, sem reescrever', () => {
  const repo = tempRepo({ [FILE]: OK });
  try {
    const broken = "import { test } from 'node:test';\ntest('a', () => {;\n";
    repo.write(FILE, broken);
    const r = edit(repo, FILE);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /sintaxe/);
    assert.match(r.stderr, /exemplo\.test\.mjs:\d+/);
    assert.equal(fs.readFileSync(path.join(repo.dir, FILE), 'utf8'), broken);
  } finally { repo.cleanup(); }
});

test('post-edit: import não usado bloqueia com linha e regra (não é removido sozinho)', () => {
  const repo = tempRepo({ [FILE]: OK });
  try {
    repo.write(FILE, `import fs from 'node:fs';\n${OK}`);
    const r = edit(repo, FILE);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /exemplo\.test\.mjs:1:8 lint\/correctness\/noUnusedImports/);
  } finally { repo.cleanup(); }
});

test('post-edit: variável não declarada NOVA bloqueia; a mesma legada não', () => {
  const legacy = `${OK}console.log(naoExiste);\n`;
  const repo = tempRepo({ [FILE]: legacy });
  try {
    repo.write(FILE, `${legacy}// toque\n`);
    assert.equal(edit(repo, FILE).code, 0);
    repo.write(FILE, `${legacy}console.log(outraNova);\n`);
    const r = edit(repo, FILE);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /noUndeclaredVariables/);
  } finally { repo.cleanup(); }
});

test('post-edit: após 3 falhas seguidas deixa de bloquear e avisa', () => {
  const repo = tempRepo({ [FILE]: OK });
  try {
    repo.write(FILE, "test('a', () => {;\n");
    for (let i = 0; i < 3; i++) assert.equal(edit(repo, FILE).code, 2);
    const r = edit(repo, FILE);
    assert.equal(r.code, 0);
    assert.match(r.json.hookSpecificOutput.additionalContext, /parei de bloquear/);
  } finally { repo.cleanup(); }
});

test('post-edit: JSON inválido de config bloqueia; FLUXO_AUTOFIX=0 ignora', () => {
  const repo = tempRepo({ 'quality/config/x.json': '{}\n' });
  try {
    repo.write('quality/config/x.json', '{"a":,}\n');
    assert.equal(edit(repo, 'quality/config/x.json').code, 2);
    assert.equal(edit(repo, 'quality/config/x.json', 's2', { FLUXO_AUTOFIX: '0' }).code, 0);
  } finally { repo.cleanup(); }
});

const cline = (repo, payload) => runScript(repo, 'hooks/cline-post-tool-use.mjs', payload);

test('Cline PostToolUse (extensão): erro de sintaxe volta em contextModification', () => {
  const repo = tempRepo({ [FILE]: OK });
  try {
    repo.write(FILE, "test('a', () => {;\n");
    const r = cline(repo, { taskId: 't1', postToolUse: { toolName: 'write_to_file', parameters: { path: FILE }, success: true } });
    assert.equal(r.code, 0);
    assert.match(r.json.contextModification, /sintaxe/);
    assert.match(r.json.contextModification, /exemplo\.test\.mjs:\d+/);
  } finally { repo.cleanup(); }
});

test('Cline PostToolUse (CLI/SDK): corrige EOL em disco e avisa', () => {
  const repo = tempRepo({ [FILE]: OK });
  try {
    repo.write(FILE, "import { test } from 'node:test';\r\ntest('a', () => {});");
    const r = cline(repo, { taskId: 't2', tool_call: { name: 'editor', input: { path: FILE } }, tool_result: { name: 'editor' } });
    assert.equal(fs.readFileSync(path.join(repo.dir, FILE), 'utf8'), OK);
    assert.match(r.json.contextModification, /Autocorreção/);
  } finally { repo.cleanup(); }
});

test('Cline PostToolUse: apply_patch, arquivo fora do escopo e success=false não geram ruído', () => {
  const repo = tempRepo({ [FILE]: OK, 'lib/a.dart': 'class A {}\n' });
  try {
    repo.write(FILE, "test('a', () => {;\n");
    const patch = `*** Begin Patch\n*** Update File: ${FILE}\n*** End Patch`;
    assert.match(cline(repo, { taskId: 't3', postToolUse: { toolName: 'apply_patch', parameters: { input: patch }, success: true } }).json.contextModification, /sintaxe/);
    assert.deepEqual(cline(repo, { taskId: 't4', postToolUse: { toolName: 'editor', parameters: { path: 'lib/a.dart' }, success: true } }).json, {});
    assert.deepEqual(cline(repo, { taskId: 't5', postToolUse: { toolName: 'editor', parameters: { path: FILE }, success: false } }).json, {});
  } finally { repo.cleanup(); }
});

test('Cline: trava de 3 falhas e espelho .clinerules em sincronia', () => {
  const repo = tempRepo({ [FILE]: OK });
  try {
    repo.write(FILE, "test('a', () => {;\n");
    const p = { taskId: 't6', postToolUse: { toolName: 'editor', parameters: { path: FILE }, success: true } };
    for (let i = 0; i < 3; i++) assert.match(cline(repo, p).json.contextModification, /sintaxe/);
    assert.match(cline(repo, p).json.contextModification, /parei de bloquear/);
  } finally { repo.cleanup(); }
});

test('espelho .clinerules da regra de autocorreção está em sincronia', () => {
  assert.deepEqual(sync(path.dirname(QUALITY_DIR), { check: true }), []);
});
