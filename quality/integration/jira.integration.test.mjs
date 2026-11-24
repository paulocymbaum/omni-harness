// INTEGRAÇÃO REAL com o Jira (escreve no projeto JIRA_PROJECT_KEY e limpa tudo no fim).
// Não roda no glob normal (quality/test/*.test.mjs). Execute: node scripts/tracker/test-integracao.mjs
// Sandbox: feature `teste-integracao-<id da rodada>` com a label `harness-teste`; o `after` apaga os
// cards e o épico dessa rodada (filhos primeiro) e CONFERE que não sobrou nada. Sem credenciais, falha
// alto (nada de skip silencioso).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalStatus } from '../../scripts/tracker/workflow.mjs';

assert.equal(process.env.JIRA_INTEGRATION_RUN, '1', 'rode por: node scripts/tracker/test-integracao.mjs (carrega o .env e valida as credenciais)');

const { createClient } = await import('../../scripts/tracker/jira-client.mjs');
const sync = await import('../../scripts/tracker/sync-context.mjs');
const { epicSummary } = await import('../../scripts/tracker/naming.mjs');

const RUN = `t${Date.now().toString(36)}`;
const SLUG = `teste-integracao-${RUN}`;
const SANDBOX_LABEL = 'harness-teste';
const jira = createClient();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const quiet = { log() {}, error: (m) => console.error(m) };

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-int-'));
const dir = path.join(base, SLUG);
const IDS = ['IT-001', 'IT-002', 'IT-003'];
let epicKey;

const backlog = (tasks, homologacao) => ({
  id: SLUG, title: `Backlog — Teste de integração ${RUN}`, created: '2026-11-14', featureSlug: SLUG, categories: [SANDBOX_LABEL],
  objetivo: 'Rodada automática de teste do harness; pode ser apagada.',
  tasks: tasks.map(([id, status, extra]) => ({ id, title: `Tarefa ${id}`, status, depends_on: [], ...extra })),
  gates: [{ id: 'EG-IT', type: 'command', task: 'IT-001', command: ['node', '--version'] }],
  ...(homologacao ? { homologacao } : {}),
});
const save = (b) => fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(b));
const HOM = (estado) => ({ estado, compose: 'c.yml', up: 'sh up.sh', url: 'http://127.0.0.1:18080', roteiro: ['Abrir a tela', 'Gerar um post'] });

async function issues(jql, fields = 'summary,status,labels,parent,issuetype,attachment,description') {
  const u = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=50&fields=${fields}`;
  return (await jira.raw('GET', u)).issues ?? [];
}
const status = async (key) => canonicalStatus((await jira.getIssue(key, 'status')).fields.status.name);
const text = (issue) => JSON.stringify(issue.fields.description);

async function resync() { return sync.syncMany(dir, IDS, null, {}, quiet); }

before(async () => {
  const have = new Set((await jira.raw('GET', `/rest/api/3/statuses/search?projectId=${(await jira.getProject(process.env.JIRA_PROJECT_KEY)).id}&maxResults=200`)).values.map((s) => s.name));
  for (const need of ['Blocked', 'Homologation']) assert.ok(have.has(need), `o projeto não tem o status ${need}: rode node scripts/tracker/ensure-statuses.mjs`);
  fs.mkdirSync(path.join(dir, 'diagramas'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'brd.md'), '# BRD — teste\nStatus: ready\n\n## Regras de negócio\n- RN-01 regra de teste\n\n## Cenários\n### Cenário: caminho feliz\n- Dado um negócio\n- Quando gera um post\n- Então o post aparece\n');
  fs.writeFileSync(path.join(dir, 'fluxo-usuario.md'), '# Exemplo SaaS — teste\nStatus: ready\n\n1. Abrir a área\n\n```mermaid\nflowchart TD\n  A --> B\n```\n');
  fs.writeFileSync(path.join(dir, 'diagramas', 'fluxo-usuario.png'), PNG);
  save(backlog([['IT-001', 'done'], ['IT-002', 'blocked', { motivo: 'aguarda decisão de teste' }], ['IT-003', 'pending', { depends_on: ['IT-001'] }]], HOM('pendente')));
});

after(async () => {
  // limpeza: só o que carrega a label da rodada E a label de sandbox; filhos antes do épico
  const mine = await issues(`labels = "feature-${SLUG}" AND labels = "${SANDBOX_LABEL}"`, 'issuetype');
  for (const i of [...mine].sort((a, b) => Number(a.fields.issuetype.name === 'Epic') - Number(b.fields.issuetype.name === 'Epic'))) {
    await jira.raw('DELETE', `/rest/api/3/issue/${i.key}?deleteSubtasks=true`);
  }
  const left = await issues(`labels = "feature-${SLUG}"`, 'summary');
  fs.rmSync(base, { recursive: true, force: true });
  assert.equal(left.length, 0, `sobraram ${left.length} issue(s) da rodada ${RUN}: ${left.map((i) => i.key).join(', ')}`);
});

test('épico: tipo Epic, título pela regra, labels, anexo do fluxo e seções na ordem para pessoas', async () => {
  const failures = await resync();
  assert.deepEqual(failures, []);
  const [epic, ...extra] = await issues(`labels = "feature-${SLUG}" AND issuetype = Epic`);
  assert.equal(extra.length, 0, 'um épico só');
  epicKey = epic.key;
  assert.equal(epic.fields.summary, epicSummary(backlog([])), 'regra de nome');
  assert.equal(epic.fields.summary, `Teste de integração ${RUN}`);
  for (const l of [`feature-${SLUG}`, SANDBOX_LABEL]) assert.ok(epic.fields.labels.includes(l), l);
  assert.ok(!epic.fields.labels.includes('brd-pendente') && !epic.fields.labels.includes('fluxo-pendente'));
  const body = text(epic);
  const order = ['Visão geral', 'Atenção: precisa de ação', 'BRD — requisitos e regras de negócio', 'Exemplo SaaS do usuário', 'Como testar (homologação)', 'Tarefas', 'Referência técnica'].map((t) => body.indexOf(t));
  assert.ok(order.every((p) => p >= 0) && order.every((p, i) => !i || p > order[i - 1]), `ordem das seções: ${order}`);
  for (const t of ['RN-01 regra de teste', 'Dado um negócio', 'flowchart TD', 'Rodada automática de teste', 'aguarda decisão de teste', 'Progresso: ']) assert.ok(body.includes(t), t);
  assert.deepEqual(epic.fields.attachment.map((a) => a.filename), ['fluxo-usuario.png']);
});

test('todos os cards são filhos do épico e cada um está no status do backlog', async () => {
  const children = await issues(`parent = ${epicKey}`);
  assert.equal(children.length, 3);
  const by = Object.fromEntries(children.map((c) => [c.fields.summary.split(' ')[0], canonicalStatus(c.fields.status.name)]));
  assert.deepEqual(by, { 'IT-001': 'Done', 'IT-002': 'Blocked', 'IT-003': 'To Do' });
  assert.equal(await status(epicKey), 'In Progress', 'bloqueada mas com trabalho executável');
  assert.match(text(children.find((c) => c.fields.summary.startsWith('IT-002'))), /Motivo de bloqueio: aguarda decisão de teste/);
});

test('idempotência: sincronizar de novo não cria issue, não duplica anexo e mantém os status', async () => {
  const before = (await issues(`labels = "feature-${SLUG}"`, 'summary')).length;
  await resync();
  assert.equal((await issues(`labels = "feature-${SLUG}"`, 'summary')).length, before);
  assert.equal((await jira.getIssue(epicKey, 'attachment')).fields.attachment.length, 1);
});

test('ciclo da entrega: In Progress → travada (Blocked) → desbloqueio limpa o motivo → tudo done', async () => {
  save(backlog([['IT-001', 'done'], ['IT-002', 'blocked', { motivo: 'm' }], ['IT-003', 'blocked', { motivo: 'm2' }]], HOM('pendente')));
  await resync();
  assert.equal(await status(epicKey), 'Blocked', 'só restam bloqueios');
  save(backlog([['IT-001', 'done'], ['IT-002', 'in_progress'], ['IT-003', 'pending', { depends_on: ['IT-002'] }]], HOM('pendente')));
  await resync();
  const card = (await issues(`parent = ${epicKey} AND summary ~ "IT-002"`))[0];
  assert.equal(canonicalStatus(card.fields.status.name), 'In Progress');
  assert.doesNotMatch(text(card), /Motivo de bloqueio/, 'motivo antigo saiu do card');
  assert.equal(await status(epicKey), 'In Progress');
});

test('homologação: todos os cards e o épico vão para Homologation; reprovada volta; aprovada fecha em Done', async () => {
  const allDone = (estado) => backlog([['IT-001', 'done'], ['IT-002', 'done'], ['IT-003', 'done']], HOM(estado));
  const snapshot = async () => [...(await issues(`parent = ${epicKey}`)).map((c) => canonicalStatus(c.fields.status.name)), await status(epicKey)];
  save(allDone('pendente')); await resync();
  assert.deepEqual(await snapshot(), ['Done', 'Done', 'Done', 'In Progress'], 'pronta, mas ainda não homologada');
  save(allDone('em_homologacao')); await resync();
  assert.deepEqual(await snapshot(), Array(4).fill('Homologation'));
  const epic = (await issues(`issuetype = Epic AND labels = "feature-${SLUG}"`))[0];
  assert.match(text(epic), /Em homologação/);
  save(allDone('reprovada')); await resync();
  assert.deepEqual(await snapshot(), ['Done', 'Done', 'Done', 'In Progress']);
  save(allDone('em_homologacao')); await resync();
  save(allDone('aprovada')); await resync();
  assert.deepEqual(await snapshot(), Array(4).fill('Done'));
});

test('descrição sem dado pessoal: o BRD com e-mail NÃO vai ao épico', async () => {
  fs.writeFileSync(path.join(dir, 'brd.md'), '# BRD\nStatus: ready\n\nfalar com maria.silva@empresa.com.br\n');
  await sync.syncEpicOf(dir);
  const epic = (await issues(`issuetype = Epic AND labels = "feature-${SLUG}"`))[0];
  assert.doesNotMatch(text(epic), /maria\.silva/);
  assert.match(text(epic), /Não enviado: dados pessoais detectados/);
});
