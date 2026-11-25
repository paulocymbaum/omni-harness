// Gate EG-MARK — testa backlog.mjs mark
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BACKLOG_MJS = path.resolve(import.meta.dirname, '..', '..', 'delivery', 'backlog.mjs');

// Credenciais falsas numa porta fechada: o .env real só preenche variável AUSENTE, então um vazamento
// de espelhamento vira "Jira sync falhou" (visível no teste) em vez de card no Jira de verdade.
const FAKE_JIRA = {
  JIRA_BASE_URL: 'http://127.0.0.1:1', JIRA_EMAIL: 'teste@example.com', JIRA_API_TOKEN: 'falso', JIRA_PROJECT_KEY: 'TST',
};

// Perfil de fixture com tracker jira: o perfil deste hospedeiro é tracker none (nada espelha);
// o teste do espelhamento precisa do provider jira ligado para exercitar o caminho de falha.
function perfilJira() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-mark-perfil-'));
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ name: 'eg-mark', locale: 'pt-BR', tracker: { provider: 'jira' } }));
  return dir;
}

function run(args) {
  const perfil = perfilJira();
  const r = spawnSync(process.execPath, [BACKLOG_MJS, ...args], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, ...FAKE_JIRA, HARNESS_PROFILE_DIR: perfil },
  });
  fs.rmSync(perfil, { recursive: true, force: true });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tmpDir(backlog) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-mark-')));
  fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));
  return dir;
}

function readBacklog(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'backlog.json'), 'utf8'));
}

const BASE = {
  id: 'test', title: 'Teste', created: '2026-10-01',
  tasks: [
    { id: 'T-001', title: 'First', status: 'done', depends_on: [] },
    { id: 'T-002', title: 'Second', status: 'pending', depends_on: ['T-001'] },
    { id: 'T-003', title: 'Third', status: 'pending', depends_on: ['T-002'] },
  ],
  gates: [
    // gate that always passes
    { id: 'EG-OK', type: 'command', task: 'T-002', command: ['node', '--version'] },
  ],
};

test('mark in_progress: transição válida quando dependências done', () => {
  const dir = tmpDir(BASE);
  const r = run(['mark', dir, 'T-002', '--status', 'in_progress']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readBacklog(dir).tasks[1].status, 'in_progress');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mark in_progress: falha se dependência pending', () => {
  const dir = tmpDir(BASE);
  const r = run(['mark', dir, 'T-003', '--status', 'in_progress']);
  assert.notEqual(r.code, 0);
  assert.ok(/depend/i.test(r.stderr));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mark in_progress: falha se outra tarefa já in_progress', () => {
  const bl = JSON.parse(JSON.stringify(BASE));
  bl.tasks[1].status = 'in_progress';
  const dir = tmpDir(bl);
  // T-003 can't go in_progress: T-002 still pending AND another in_progress
  const r = run(['mark', dir, 'T-003', '--status', 'in_progress']);
  assert.notEqual(r.code, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mark done: gates passam → status done', () => {
  const bl = JSON.parse(JSON.stringify(BASE));
  bl.tasks[1].status = 'in_progress';
  const dir = tmpDir(bl);
  const r = run(['mark', dir, 'T-002', '--status', 'done']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readBacklog(dir).tasks[1].status, 'done');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mark done: gates falham → status não muda', () => {
  const bl = JSON.parse(JSON.stringify(BASE));
  bl.tasks[1].status = 'in_progress';
  bl.gates = [{ id: 'EG-FAIL', type: 'command', task: 'T-002', command: ['node', '-e', 'process.exit(1)'] }];
  const dir = tmpDir(bl);
  const r = run(['mark', dir, 'T-002', '--status', 'done']);
  assert.notEqual(r.code, 0);
  assert.notEqual(readBacklog(dir).tasks[1].status, 'done');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mark blocked: exige --motivo', () => {
  const dir = tmpDir(BASE);
  const rFail = run(['mark', dir, 'T-002', '--status', 'blocked']);
  assert.notEqual(rFail.code, 0);
  const rOk = run(['mark', dir, 'T-002', '--status', 'blocked', '--motivo', 'esperando externo']);
  assert.equal(rOk.code, 0, rOk.stderr);
  assert.equal(readBacklog(dir).tasks[1].motivo, 'esperando externo');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mark: id inexistente sai com erro', () => {
  const dir = tmpDir(BASE);
  const r = run(['mark', dir, 'NOPE', '--status', 'done']);
  assert.notEqual(r.code, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mark em backlog fora do repositório NUNCA espelha no Jira (já criou cards T-002 Second no Jira real)', () => {
  const dir = tmpDir(BASE);
  const r = run(['mark', dir, 'T-002', '--status', 'in_progress']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /jira/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sair de blocked apaga o motivo (senão o card seguia dizendo "bloqueada")', () => {
  const dir = tmpDir(BASE);
  run(['mark', dir, 'T-002', '--status', 'blocked', '--motivo', 'aguarda parecer']);
  assert.equal(readBacklog(dir).tasks[1].motivo, 'aguarda parecer');
  const r = run(['mark', dir, 'T-002', '--status', 'in_progress']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal('motivo' in readBacklog(dir).tasks[1], false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('next: com tarefa executável sai 0; só bloqueios restando sai 3 e lista motivo e tarefas presas', () => {
  const dir = tmpDir(BASE);
  const livre = run(['next', dir]);
  assert.equal(livre.code, 0);
  assert.match(livre.stdout, /Próxima: T-002/);
  run(['mark', dir, 'T-002', '--status', 'blocked', '--motivo', 'aguarda decisão do usuário']);
  const travada = run(['next', dir]);
  assert.equal(travada.code, 3, 'travada não pode parecer "nada a fazer"');
  assert.match(travada.stdout, /T-002[^\n]*\n\s+motivo: aguarda decisão do usuário/);
  assert.match(travada.stdout, /T-003 espera T-002/);
  assert.match(travada.stdout, /TRAVADA[^\n]*NÃO está concluída/);
  assert.match(run(['status', dir]).stdout, /Bloqueadas[\s\S]*aguarda decisão do usuário[\s\S]*TRAVADA/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('next: tudo done ou cancelled é concluída (exit 0)', () => {
  const bl = JSON.parse(JSON.stringify(BASE));
  bl.tasks.forEach((t) => { t.status = 'done'; });
  const dir = tmpDir(bl);
  const r = run(['next', dir]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Entrega concluída/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mark com Jira inalcançável: grava o backlog, sai 1 e diz como reparar (antes: aviso ignorável, exit 0)', () => {
  const base = path.resolve(import.meta.dirname, '..', '..', '.state');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'mark-jira-')); // dentro do repo: o espelhamento vale
  try {
    fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(BASE));
    const r = run(['mark', dir, 'T-002', '--status', 'in_progress']); // FAKE_JIRA: porta fechada
    assert.equal(r.code, 1);
    assert.equal(readBacklog(dir).tasks[1].status, 'in_progress', 'o backlog já foi gravado');
    assert.match(r.stderr, /Jira NÃO atualizado \(T-002/);
    assert.match(r.stderr, /Repare com: node scripts\/tracker\/sync-context\.mjs .* T-002/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
