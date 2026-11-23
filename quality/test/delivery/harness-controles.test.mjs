// Controles do harness: timeout por gate, congelamento de gates (anti-afrouxamento) e o hook que nega
// edição direta de `status` no backlog.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gateTimeoutMs, DEFAULT_GATE_TIMEOUT_MS, MAX_GATE_TIMEOUT_MS } from '../../delivery/eval.mjs';
import { statusChanges, textAfter, evaluate } from '../../delivery/guarda-backlog.mjs';

const DELIVERY = path.resolve(import.meta.dirname, '..', '..', 'delivery');
const FAKE_JIRA = { JIRA_BASE_URL: 'http://127.0.0.1:1', JIRA_EMAIL: 'teste@example.com', JIRA_API_TOKEN: 'falso', JIRA_PROJECT_KEY: 'TST' };
const mark = (dir, ...args) => {
  const r = spawnSync(process.execPath, [path.join(DELIVERY, 'backlog.mjs'), 'mark', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...FAKE_JIRA } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
function entrega(gate = { id: 'EG-1', type: 'command', task: 'H-001', command: ['node', '--version'] }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctrl-')));
  fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify({ id: 'f', title: 'F', created: '2026-11-14', tasks: [{ id: 'H-001', title: 'T', status: 'pending', depends_on: [] }], gates: [gate] }));
  return { dir, read: () => JSON.parse(fs.readFileSync(path.join(dir, 'backlog.json'), 'utf8')), edit: (fn) => { const b = JSON.parse(fs.readFileSync(path.join(dir, 'backlog.json'), 'utf8')); fn(b); fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(b)); }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('timeout do gate: 120 s por padrão, `timeout_ms` do próprio gate entre 1 s e 15 min', () => {
  assert.equal(gateTimeoutMs({}), DEFAULT_GATE_TIMEOUT_MS);
  assert.equal(gateTimeoutMs({ timeout_ms: 'x' }), DEFAULT_GATE_TIMEOUT_MS);
  assert.equal(gateTimeoutMs({ timeout_ms: -5 }), DEFAULT_GATE_TIMEOUT_MS);
  assert.equal(gateTimeoutMs({ timeout_ms: 600_000 }), 600_000, 'suíte .NET pesada');
  assert.equal(gateTimeoutMs({ timeout_ms: 10 }), 1000);
  assert.equal(gateTimeoutMs({ timeout_ms: 9_999_999 }), MAX_GATE_TIMEOUT_MS);
});

test('gate com timeout_ms curto estoura e reprova (o timeout é aplicado de verdade)', () => {
  const e = entrega({ id: 'EG-1', type: 'command', task: 'H-001', command: ['node', '-e', 'setTimeout(()=>{},30000)'], timeout_ms: 1000 });
  assert.equal(mark(e.dir, 'H-001', '--status', 'in_progress').code, 0);
  const r = mark(e.dir, 'H-001', '--status', 'done');
  assert.equal(r.code, 1);
  assert.match(r.err, /Gates não passaram/);
  e.cleanup();
});

test('congelamento: in_progress grava a impressão dos gates; done sem mudança passa', () => {
  const e = entrega();
  mark(e.dir, 'H-001', '--status', 'in_progress');
  assert.match(e.read().tasks[0].gates_sha, /^[0-9a-f]{16}$/);
  assert.equal(mark(e.dir, 'H-001', '--status', 'done').code, 0);
  e.cleanup();
});

test('congelamento: gate alterado depois do in_progress NÃO passa no done sem --correcao; com ela passa e registra a nota', () => {
  const e = entrega();
  mark(e.dir, 'H-001', '--status', 'in_progress');
  e.edit((b) => { b.gates[0].command = ['node', '--help']; }); // afrouxar/trocar o gate
  const bloqueado = mark(e.dir, 'H-001', '--status', 'done');
  assert.equal(bloqueado.code, 1);
  assert.match(bloqueado.err, /gates de H-001 mudaram depois do in_progress/);
  assert.equal(e.read().tasks[0].status, 'in_progress');
  const ok = mark(e.dir, 'H-001', '--status', 'done', '--correcao', 'comando trocado: --help é o que o gate deveria rodar');
  assert.equal(ok.code, 0, ok.err);
  assert.equal(e.read().tasks[0].gates_nota, 'comando trocado: --help é o que o gate deveria rodar');
  e.cleanup();
});

// ── guarda-backlog ──────────────────────────────────────────────────────────

const B = (...t) => JSON.stringify({ id: 'f', title: 'F', tasks: t.map(([id, status]) => ({ id, title: id, status })), gates: [] });

test('statusChanges: só mudança de status conta; tarefa nova só como pending', () => {
  assert.deepEqual(statusChanges(B(['A', 'pending']), B(['A', 'done'])), [{ id: 'A', de: 'pending', para: 'done' }]);
  assert.deepEqual(statusChanges(B(['A', 'pending']), B(['A', 'pending'], ['B', 'pending'])), []);
  assert.deepEqual(statusChanges(B(['A', 'pending']), B(['A', 'pending'], ['B', 'done'])), [{ id: 'B', de: '(nova)', para: 'done' }]);
  assert.deepEqual(statusChanges(B(['A', 'pending']), 'não é json'), []);
  assert.deepEqual(statusChanges('', B(['A', 'pending'])), []);
});

function arquivo(texto) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-'));
  const rel = 'docs/entregas/x/backlog.json';
  fs.mkdirSync(path.join(dir, 'docs/entregas/x'), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), texto);
  return { dir, rel, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('hook: Edit, MultiEdit e Write que mudam status são NEGADOS; os que não mudam passam', () => {
  const a = arquivo(B(['A', 'pending']));
  const negou = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';
  const ctx = { file_path: a.rel };
  assert.ok(negou(evaluate({ tool_name: 'Edit', tool_input: { ...ctx, old_string: '"status":"pending"', new_string: '"status":"done"' } }, a.dir)));
  assert.ok(negou(evaluate({ tool_name: 'MultiEdit', tool_input: { ...ctx, edits: [{ old_string: '"title":"F"', new_string: '"title":"G"' }, { old_string: '"status":"pending"', new_string: '"status":"done"' }] } }, a.dir)));
  assert.ok(negou(evaluate({ tool_name: 'Write', tool_input: { ...ctx, content: B(['A', 'in_progress']) } }, a.dir)));
  assert.equal(evaluate({ tool_name: 'Edit', tool_input: { ...ctx, old_string: '"gates":[]', new_string: '"gates":[{"id":"G","type":"command","task":"A","command":["node","-v"]}]' } }, a.dir), null);
  assert.equal(evaluate({ tool_name: 'Write', tool_input: { ...ctx, content: B(['A', 'pending'], ['B', 'pending']) } }, a.dir), null, 'tarefa nova pending');
  assert.equal(evaluate({ tool_name: 'Edit', tool_input: { file_path: 'docs/entregas/x/specs/A.md', old_string: 'a', new_string: 'b' } }, a.dir), null, 'outro arquivo');
  assert.equal(evaluate({ tool_name: 'Edit', tool_input: { ...ctx, old_string: 'NÃO EXISTE', new_string: 'x' } }, a.dir), null, 'edição que não casa: falha aberta');
  assert.match(evaluate({ tool_name: 'Write', tool_input: { ...ctx, content: B(['A', 'done']) } }, a.dir).hookSpecificOutput.permissionDecisionReason, /A: pending → done[\s\S]*backlog\.mjs mark/);
  a.cleanup();
});

test('hook como processo: payload do Claude Code em stdin vira deny; lixo em stdin falha aberto', () => {
  const a = arquivo(B(['A', 'pending']));
  const run = (stdin) => spawnSync(process.execPath, [path.join(DELIVERY, 'guarda-backlog.mjs')], { input: stdin, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: a.dir } });
  const negado = run(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(a.dir, a.rel), old_string: '"pending"', new_string: '"done"' } }));
  assert.equal(negado.status, 0);
  assert.equal(JSON.parse(negado.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const lixo = run('{{{');
  assert.equal(lixo.status, 0);
  assert.equal(lixo.stdout, '');
  a.cleanup();
});

test('textAfter: aplica Edit e MultiEdit em sequência e devolve null quando não casa', () => {
  assert.equal(textAfter('Edit', { old_string: 'a', new_string: 'b' }, 'aa'), 'ba');
  assert.equal(textAfter('Edit', { old_string: 'a', new_string: 'b', replace_all: true }, 'aa'), 'bb');
  assert.equal(textAfter('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'b', new_string: 'c' }] }, 'a'), 'c');
  assert.equal(textAfter('Edit', { old_string: 'z', new_string: 'b' }, 'aa'), null);
});
