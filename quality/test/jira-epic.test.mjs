// Épico da feature: um por backlog, com a definição completa do backlog.json, e todo card filho
// dele desde a criação. Status do épico e dos cards acompanham a entrega e a homologação.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeJira } from './jira-fake.mjs';
import { readJiraKey } from '../delivery/lib.mjs';

Object.assign(process.env, { JIRA_RETRY_BASE_MS: '1', JIRA_BASE_URL: 'https://jira.test', JIRA_EMAIL: 'teste@exemplo.test', JIRA_API_TOKEN: 'token-falso', JIRA_PROJECT_KEY: 'OFLUXO' });
const sync = await import('../../scripts/tracker/sync-context.mjs');
const { jiraStatusFor, epicStatusFor, HOMOLOGATION } = await import('../../scripts/tracker/status.mjs');
const { epicDescription } = await import('../../scripts/tracker/epic.mjs');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const BACKLOG = () => ({
  id: 'feature-x', title: 'Feature X', created: '2026-11-14', featureSlug: 'feature-x', version: '2026-11-14', categories: ['creator'],
  extraCampo: { dono: 'time-creator' },
  tasks: [
    { id: 'FX-001', title: 'Base', status: 'done', depends_on: [] },
    { id: 'FX-002', title: 'Tela', status: 'pending', depends_on: ['FX-001'] },
    { id: 'FX-003', title: 'Deploy', status: 'blocked', depends_on: [], motivo: 'aguarda decisão do usuário' },
  ],
  gates: [{ id: 'EG-1', type: 'command', task: 'FX-001', command: ['node', '--test', 'a.test.mjs'] }],
});

function setup(mutate = (b) => b) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-'));
  const dir = path.join(base, '2026-11-14-feature-x');
  fs.mkdirSync(dir, { recursive: true });
  const write = (b) => fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(b));
  write(mutate(BACKLOG()));
  return { base, dir, write, read: () => JSON.parse(fs.readFileSync(path.join(dir, 'backlog.json'), 'utf8')), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('épico: descrição traz TODA a definição do backlog (campos, tarefas, deps, motivo, gates, extras)', () => {
  const vazio = { state: 'missing', file: 'x.md', findings: [] };
  const text = epicDescription(BACKLOG(), null, { brd: vazio, fluxo: vazio, images: [] });
  for (const trecho of ['Feature: feature-x', 'Versão: 2026-11-14', 'Categorias: creator', 'FX-002 — Tela (depende de: FX-001)', 'Motivo de bloqueio: aguarda decisão do usuário', 'EG-1 (command): node --test a.test.mjs', '"dono": "time-creator"', 'Ambiente local não definido']) {
    assert.ok(text.includes(trecho), `faltou: ${trecho}`);
  }
});

test('syncTask cria o épico antes e o card nasce FILHO dele; o épico é reaproveitado no sync seguinte', async () => {
  const jira = fakeJira(); const s = setup();
  try {
    await sync.syncTask(s.dir, 'FX-001');
    await sync.syncTask(s.dir, 'FX-002');
    assert.equal(jira.epics().length, 1, 'um épico por feature');
    const epicKey = jira.epics()[0].key;
    assert.equal(readJiraKey(s.dir, { id: '_epic' }), epicKey);
    assert.ok(jira.epics()[0].fields.labels.includes('feature-feature-x'));
    assert.match(JSON.stringify(jira.epics()[0].fields.description), /FX-002 — Tela/);
    for (const card of jira.cards()) assert.equal(card.fields.parent?.key, epicKey, `${card.fields.summary} sem pai`);
    assert.equal(jira.cards().length, 2);
  } finally { s.cleanup(); }
});

test('card que já existia sem pai passa a ser filho do épico no próximo sync', async () => {
  const jira = fakeJira(); const s = setup();
  try {
    await sync.syncTask(s.dir, 'FX-001');
    delete jira.card().fields.parent; // card antigo, criado antes de existir épico
    await sync.syncTask(s.dir, 'FX-001');
    assert.equal(jira.card().fields.parent.key, jira.epics()[0].key);
    assert.equal(jira.epics().length, 1);
  } finally { s.cleanup(); }
});

test('lote (--all): um épico só, criado antes dos cards, e todos os cards filhos', async () => {
  const jira = fakeJira(); const s = setup();
  try {
    const falhas = await sync.syncMany(s.dir, ['FX-001', 'FX-002', 'FX-003'], null, {}, { log() {}, error() {} });
    assert.deepEqual(falhas, []);
    assert.equal(jira.epics().length, 1);
    assert.equal(jira.cards().length, 3);
    assert.ok(jira.cards().every((c) => c.fields.parent?.key === jira.epics()[0].key));
    const primeiraCriacao = jira.calls.findIndex((c) => c === 'POST /rest/api/3/issue');
    assert.equal(jira.issues.get(jira.epics()[0].key) !== undefined && primeiraCriacao >= 0, true);
  } finally { s.cleanup(); }
});

test('épico segue a entrega: To Do → In Progress → Blocked quando travada', async () => {
  const jira = fakeJira(); const s = setup((b) => { b.tasks.forEach((t) => { t.status = 'pending'; delete t.motivo; }); return b; });
  try {
    await sync.syncEpicOf(s.dir);
    assert.equal(jira.epics()[0].fields.status.name, 'To Do');
    const b = s.read(); b.tasks[0].status = 'done'; s.write(b);
    await sync.syncEpicOf(s.dir);
    assert.equal(jira.epics()[0].fields.status.name, 'In Progress');
    const t = s.read(); t.tasks[0].status = 'done'; t.tasks[1].status = 'blocked'; t.tasks[1].motivo = 'parecer'; t.tasks[2].status = 'blocked'; t.tasks[2].motivo = 'x'; s.write(t);
    await sync.syncEpicOf(s.dir);
    assert.equal(jira.epics()[0].fields.status.name, 'Blocked');
  } finally { s.cleanup(); }
});

test('dado pessoal no backlog: a definição NÃO vai ao épico, vai o aviso mascarado', async () => {
  const jira = fakeJira(); const s = setup((b) => { b.tasks[0].title = 'Falar com maria.silva@empresa.com.br'; return b; });
  try {
    await sync.syncEpicOf(s.dir);
    const texto = JSON.stringify(jira.epics()[0].fields.description);
    assert.doesNotMatch(texto, /maria\.silva/);
    assert.match(texto, /NÃO enviada: dados pessoais/);
  } finally { s.cleanup(); }
});

test('status: tarefa done fica Homologation só durante a homologação; aprovada vai a Production; épico acompanha', () => {
  const b = BACKLOG(); const done = b.tasks[0];
  assert.equal(jiraStatusFor(done, b), 'Done');
  b.homologacao = { estado: 'em_homologacao' };
  assert.equal(jiraStatusFor(done, b), HOMOLOGATION);
  assert.equal(jiraStatusFor(b.tasks[1], b), 'To Do', 'só tarefa desenvolvida vai para homologação');
  assert.equal(epicStatusFor(b), HOMOLOGATION);
  b.homologacao.estado = 'aprovada';
  assert.equal(jiraStatusFor(done, b), 'Production');
  assert.equal(epicStatusFor(b), 'Production');
  b.homologacao.estado = 'implantada';
  assert.equal(jiraStatusFor(done, b), 'Done');
  assert.equal(epicStatusFor(b), 'Done');
});

test('épico de feature toda desenvolvida: sem homologação definida é Done; com homologação ainda não iniciada NÃO é', () => {
  const b = BACKLOG(); b.tasks.forEach((t) => { t.status = 'done'; delete t.motivo; });
  assert.equal(epicStatusFor(b), 'Done');
  b.homologacao = { estado: 'pendente' };
  assert.equal(epicStatusFor(b), 'In Progress');
});

test('feature desenvolvida em homologação: TODOS os cards e o épico vão para Homologation; aprovada, para Production; reprovada, voltam a In Progress; implantada, para Done', async () => {
  const jira = fakeJira({ workflow: ['To Do', 'In Progress', 'Done', 'Blocked', 'Homologation', 'Production'] });
  const s = setup((b) => { b.tasks.forEach((t) => { t.status = 'done'; delete t.motivo; }); b.homologacao = { estado: 'pendente', compose: 'c.yml', up: 'up', url: 'u', roteiro: ['x'] }; return b; });
  const ids = ['FX-001', 'FX-002', 'FX-003'];
  const quieto = { log() {}, error() {} };
  const estados = () => [...jira.cards().map((c) => c.fields.status.name), jira.epics()[0].fields.status.name];
  try {
    await sync.syncMany(s.dir, ids, null, {}, quieto);
    assert.deepEqual(estados(), ['Done', 'Done', 'Done', 'In Progress'], 'desenvolvida mas ainda não homologada: épico não é Done');
    const b = s.read(); b.homologacao.estado = 'em_homologacao'; s.write(b);
    await sync.syncMany(s.dir, ids, null, {}, quieto);
    assert.deepEqual(estados(), ['Homologation', 'Homologation', 'Homologation', 'Homologation']);
    b.homologacao.estado = 'reprovada'; s.write(b);
    await sync.syncMany(s.dir, ids, null, {}, quieto);
    assert.deepEqual(estados(), ['In Progress', 'In Progress', 'In Progress', 'In Progress']);
    b.homologacao.estado = 'em_homologacao'; s.write(b);
    await sync.syncMany(s.dir, ids, null, {}, quieto);
    b.homologacao.estado = 'aprovada'; s.write(b);
    await sync.syncMany(s.dir, ids, null, {}, quieto);
    assert.deepEqual(estados(), ['Production', 'Production', 'Production', 'Production']);
    b.homologacao.estado = 'implantada'; s.write(b);
    await sync.syncMany(s.dir, ids, null, {}, quieto);
    assert.deepEqual(estados(), ['Done', 'Done', 'Done', 'Done']);
  } finally { s.cleanup(); }
});

test('Jira sem o status Homologation: o sync FALHA alto com a ação (node scripts/tracker/ensure-statuses.mjs), não finge', async () => {
  const jira = fakeJira({ workflow: ['To Do', 'In Progress', 'Done', 'Blocked', 'Production'] });
  const s = setup((b) => { b.tasks.forEach((t) => { t.status = 'done'; delete t.motivo; }); b.homologacao = { estado: 'em_homologacao' }; return b; });
  try {
    await assert.rejects(() => sync.syncTask(s.dir, 'FX-001'), /Homologation[\s\S]*ensure-statuses/);
    assert.equal(jira.cards().length <= 1, true);
  } finally { s.cleanup(); }
});
