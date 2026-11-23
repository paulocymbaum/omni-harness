// Gate QG-023 — o summary do card Jira ("<ID> — <título>") acompanha o re-sync.
// Offline: fakeJira em memória (nenhuma chamada sai do processo). O fake aplica PUT fields.summary,
// então dá para provar "PUT só quando diverge" contando os PUTs no card.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeJira } from '../jira-fake.mjs';

Object.assign(process.env, { JIRA_RETRY_BASE_MS: '1', JIRA_BASE_URL: 'https://jira.test', JIRA_EMAIL: 'teste@exemplo.test', JIRA_API_TOKEN: 'token-falso', JIRA_PROJECT_KEY: 'OFLUXO' });
const sync = await import('../../../scripts/tracker/sync-context.mjs');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qg023-'));
  const dir = path.join(base, '2026-11-22-qg023');
  fs.mkdirSync(dir, { recursive: true });
  const write = (titulo) => fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify({
    id: 'qg023', title: 'Board QG-023', created: '2026-11-22', featureSlug: 'qg023',
    tasks: [{ id: 'QX-001', title: titulo, status: 'pending', depends_on: [] }],
    gates: [],
  }));
  write('Título original');
  return { dir, write, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const putsNoCard = (jira, key) => jira.calls.filter((c) => c === `PUT /rest/api/3/issue/${key}`).length;

test('criação grava o summary "<ID> — <título>"', async () => {
  const jira = fakeJira();
  const s = setup();
  try {
    await sync.syncTask(s.dir, 'QX-001');
    assert.equal(jira.card().fields.summary, 'QX-001 — Título original');
  } finally { s.cleanup(); }
});

test('re-sync sem retitular: só o PUT da description — summary intocado', async () => {
  const jira = fakeJira();
  const s = setup();
  try {
    await sync.syncTask(s.dir, 'QX-001');
    const key = jira.card().key;
    const antes = putsNoCard(jira, key);
    await sync.syncTask(s.dir, 'QX-001');
    assert.equal(jira.card().fields.summary, 'QX-001 — Título original');
    assert.equal(putsNoCard(jira, key) - antes, 1, 'PUT a mais = summary reenviado sem divergência');
  } finally { s.cleanup(); }
});

test('tarefa retitulada: o summary do card acompanha no re-sync', async () => {
  const jira = fakeJira();
  const s = setup();
  try {
    await sync.syncTask(s.dir, 'QX-001');
    const key = jira.card().key;
    const antes = putsNoCard(jira, key);
    s.write('Título novo da tarefa');
    await sync.syncTask(s.dir, 'QX-001');
    assert.equal(jira.card().fields.summary, 'QX-001 — Título novo da tarefa');
    assert.equal(putsNoCard(jira, key) - antes, 2, 'description + summary divergente');
  } finally { s.cleanup(); }
});

test('card achado por busca (sem jira_key gravado) também recebe o summary novo, sem duplicar', async () => {
  const jira = fakeJira();
  const s = setup();
  try {
    await sync.syncTask(s.dir, 'QX-001');
    fs.rmSync(path.join(s.dir, 'jira-keys', 'QX-001.txt'), { force: true });
    s.write('Título via busca');
    await sync.syncTask(s.dir, 'QX-001');
    assert.equal(jira.card().fields.summary, 'QX-001 — Título via busca');
    assert.equal(jira.cards().length, 1, 'nenhum card duplicado');
  } finally { s.cleanup(); }
});
