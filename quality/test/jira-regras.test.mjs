// SUÍTE FUNCIONAL do Jira (offline, Jira falso): nomenclatura, status, descrição legível do épico,
// BRD e fluxo do usuário, anexos e resiliência a falhas. A integração REAL fica em
// quality/integration/ (node scripts/tracker/test-integracao.mjs). Regras: docs/jira/regras-de-epicos-e-cards.md
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeJira, DIRECTED_WORKFLOW } from './jira-fake.mjs';
import { readJiraKey } from '../delivery/lib.mjs';
import { featureDocs } from '../delivery/feature-docs.mjs';

Object.assign(process.env, { JIRA_RETRY_BASE_MS: '1', JIRA_BASE_URL: 'https://jira.test', JIRA_EMAIL: 'teste@exemplo.test', JIRA_API_TOKEN: 'token-falso', JIRA_PROJECT_KEY: 'OFLUXO' });
const sync = await import('../../scripts/tracker/sync-context.mjs');
const { epicSummary, cardSummary, EPIC_SUMMARY_MAX, CARD_SUMMARY_MAX } = await import('../../scripts/tracker/naming.mjs');
const { jiraStatusFor, epicStatusFor, STATUS_MAP, HOMOLOGATION } = await import('../../scripts/tracker/status.mjs');
const { epicDescription, progressLine, embed } = await import('../../scripts/tracker/epic-description.mjs');
const { adfTextLength } = await import('../../scripts/tracker/jira-client.mjs');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const quieto = { log() {}, error() {} };

const task = (id, status, extra = {}) => ({ id, title: `Tarefa ${id}`, status, depends_on: [], ...extra });
const backlog = (tasks, extra = {}) => ({ id: 'feat', title: 'Feature Teste', created: '2026-11-14', featureSlug: 'feat', tasks, gates: [], ...extra });
const PRONTO = (text = '# Doc\nStatus: ready\n\ncorpo') => ({ state: 'ready', file: 'doc.md', text, findings: [] });
const FALTA = { state: 'missing', file: 'doc.md', findings: [] };
const docs = (over = {}) => ({ brd: PRONTO('# BRD — Feature\nStatus: ready\n\n## Regras de negócio\n- RN-01 só business cria post\n\n## Cenários\n```gherkin\nDado X\nQuando Y\nEntão Z\n```'), fluxo: PRONTO('# Exemplo SaaS\nStatus: ready\n\n1. Abrir a área\n\n```mermaid\nflowchart TD\n  A --> B\n```'), images: [], ...over });

function workspace(b, files = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'regras-'));
  const dir = path.join(base, 'entrega');
  fs.mkdirSync(path.join(dir, 'diagramas'), { recursive: true });
  const write = (next) => fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(next));
  write(b);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return { dir, write, read: () => JSON.parse(fs.readFileSync(path.join(dir, 'backlog.json'), 'utf8')), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
const READY_DOCS = { 'brd.md': '# BRD\nStatus: ready\n\n## Regras\n- RN-01 regra\n', 'fluxo-usuario.md': '# Exemplo SaaS\nStatus: ready\n\n1. passo\n' };

// ── nomenclatura ────────────────────────────────────────────────────────────

test('nome do épico: título da feature, limpo; sem id de backlog, data ou prefixo', () => {
  const casos = [
    [{ title: 'Exemplo SaaS Creator' }, 'Exemplo SaaS Creator'],
    [{ title: 'Backlog — Exemplo SaaS Creator' }, 'Exemplo SaaS Creator'],
    [{ title: 'Entrega: Pulso  Flutter\n nativo' }, 'Pulso Flutter nativo'],
    [{ title: '  ', id: '2026-11-14-feat' }, '2026-11-14-feat'],
    [{}, 'Feature sem título'],
  ];
  for (const [b, esperado] of casos) assert.equal(epicSummary(b), esperado);
  const longo = epicSummary({ title: 'x'.repeat(300) });
  assert.equal(longo.length, EPIC_SUMMARY_MAX);
  assert.ok(longo.endsWith('…'));
});

test('nome do card: "<ID> — <título>" cabendo no limite, sem quebra de linha', () => {
  assert.equal(cardSummary({ id: 'FC-001', title: 'Base do render' }), 'FC-001 — Base do render');
  assert.equal(cardSummary({ id: 'FC-002', title: 'duas\nlinhas   juntas' }), 'FC-002 — duas linhas juntas');
  assert.ok(cardSummary({ id: 'FC-003', title: 'y'.repeat(500) }).length <= CARD_SUMMARY_MAX);
});

// ── status ──────────────────────────────────────────────────────────────────

test('status do card: tabela completa (status da tarefa × estado da homologação)', () => {
  const esperado = {
    pending: ['To Do', 'To Do', 'To Do', 'To Do', 'To Do'],
    in_progress: ['In Progress', 'In Progress', 'In Progress', 'In Progress', 'In Progress'],
    blocked: ['Blocked', 'Blocked', 'Blocked', 'Blocked', 'Blocked'],
    cancelled: ['Cancelled', 'Cancelled', 'Cancelled', 'Cancelled', 'Cancelled'],
    done: ['Done', HOMOLOGATION, 'Production', 'In Progress', 'Done'],
  };
  const estados = ['pendente', 'em_homologacao', 'aprovada', 'reprovada', 'implantada'];
  for (const [status, linha] of Object.entries(esperado)) {
    estados.forEach((estado, i) => assert.equal(jiraStatusFor(task('T-1', status), backlog([], { homologacao: { estado } })), linha[i], `${status} / ${estado}`));
  }
  assert.deepEqual(Object.keys(STATUS_MAP).sort(), Object.keys(esperado).sort());
  assert.equal(jiraStatusFor(task('T-1', 'done'), backlog([])), 'Done', 'sem homologação definida');
});

test('status do épico: tabela de situações da entrega', () => {
  const H = (estado) => ({ homologacao: { estado } });
  const casos = [
    ['sem tarefas', backlog([]), 'To Do'],
    ['nada iniciado', backlog([task('A', 'pending'), task('B', 'pending')]), 'To Do'],
    ['uma em andamento', backlog([task('A', 'in_progress'), task('B', 'pending')]), 'In Progress'],
    ['uma pronta, outras a fazer', backlog([task('A', 'done'), task('B', 'pending')]), 'In Progress'],
    ['bloqueada mas há trabalho executável', backlog([task('A', 'done'), task('B', 'blocked', { motivo: 'x' }), task('C', 'pending')]), 'In Progress'],
    ['travada: só bloqueios', backlog([task('A', 'done'), task('B', 'blocked', { motivo: 'x' })]), 'Blocked'],
    ['travada: pendente presa à bloqueada', backlog([task('A', 'blocked', { motivo: 'x' }), task('B', 'pending', { depends_on: ['A'] })]), 'Blocked'],
    ['tudo done, sem homologação definida', backlog([task('A', 'done'), task('B', 'done')]), 'Done'],
    ['tudo done, homologação ainda não iniciada', backlog([task('A', 'done')], H('pendente')), 'In Progress'],
    ['em homologação', backlog([task('A', 'done')], H('em_homologacao')), HOMOLOGATION],
    ['homologação aprovada: em Production, Done só após o deploy', backlog([task('A', 'done')], H('aprovada')), 'Production'],
    ['homologação reprovada: volta a In Progress para correção', backlog([task('A', 'done')], H('reprovada')), 'In Progress'],
    ['implantada: Done', backlog([task('A', 'done')], H('implantada')), 'Done'],
    ['tudo cancelado', backlog([task('A', 'cancelled'), task('B', 'cancelled')]), 'Cancelled'],
    ['done + cancelled, sem homologação', backlog([task('A', 'done'), task('B', 'cancelled')]), 'Done'],
  ];
  for (const [nome, b, esperado] of casos) assert.equal(epicStatusFor(b), esperado, nome);
});

// ── descrição legível ───────────────────────────────────────────────────────

const ordem = (text, titulos) => titulos.map((t) => text.indexOf(`## ${t}`));

test('descrição: seções na ordem para pessoas, técnica por último; "Atenção" só quando há bloqueio', () => {
  const b = backlog([task('A', 'done'), task('B', 'blocked', { motivo: 'aguarda parecer jurídico' }), task('C', 'pending', { depends_on: ['A'] })], { objetivo: 'Permitir que businesses gerem posts.' });
  const text = epicDescription(b, null, docs());
  const posicoes = ordem(text, ['Visão geral', 'Atenção: precisa de ação', 'BRD — requisitos e regras de negócio', 'Exemplo SaaS do usuário', 'Como testar (homologação)', 'Tarefas', 'Referência técnica (definição do backlog.json)']);
  assert.ok(posicoes.every((p) => p >= 0), `seção ausente: ${posicoes}`);
  assert.deepEqual(posicoes, [...posicoes].sort((x, y) => x - y), 'ordem das seções');
  assert.ok(text.indexOf('Permitir que businesses gerem posts.') < text.indexOf('Situação:'), 'objetivo vem primeiro');
  assert.match(text, /- B — Tarefa B: aguarda parecer jurídico/);
  const semBloqueio = epicDescription(backlog([task('A', 'done')]), null, docs());
  assert.doesNotMatch(semBloqueio, /## Atenção/);
});

test('descrição: progresso, situação e tarefas agrupadas por status com checkbox', () => {
  const b = backlog([task('A', 'done'), task('B', 'done'), task('C', 'in_progress'), task('D', 'pending', { depends_on: ['C'] }), task('E', 'cancelled')]);
  const text = epicDescription(b, null, docs());
  assert.match(text, /Situação: Em andamento/);
  assert.match(text, /Progresso: ▰▰▰▰▰▱▱▱▱▱ 2\/4 \(50%\)/, 'cancelada não entra na conta');
  for (const g of ['### Em andamento (1)', '### A fazer (1)', '### Concluídas (2)', '### Canceladas (1)']) assert.ok(text.includes(g), g);
  assert.doesNotMatch(text, /### Bloqueadas/, 'grupo vazio não aparece');
  assert.match(text, /- \[x\] A — Tarefa A/);
  assert.match(text, /- \[ \] D — Tarefa D \(depende de: C\)/);
  assert.equal(progressLine([]), '▱▱▱▱▱▱▱▱▱▱ 0/0 (0%)');
});

test('descrição: BRD e fluxo embutidos (títulos rebaixados, sem Status:, blocos de código intactos)', () => {
  const text = epicDescription(backlog([task('A', 'done')]), null, docs());
  assert.match(text, /### BRD — Feature/, 'o # do documento vira ###');
  assert.match(text, /#### Regras de negócio/);
  assert.match(text, /- RN-01 só business cria post/);
  assert.ok(text.includes('```gherkin\nDado X\nQuando Y\nEntão Z\n```'));
  assert.ok(text.includes('```mermaid\nflowchart TD\n  A --> B\n```'));
  assert.doesNotMatch(text, /^Status: (ready|draft)$/m);
  assert.equal(embed('```\n# não é título\n```\n# título', 1), '```\n# não é título\n```\n## título');
});

test('descrição: BRD ou fluxo ausentes/rascunho/com dado pessoal viram aviso, nunca o texto', () => {
  const text = epicDescription(backlog([task('A', 'done')]), null, docs({ brd: FALTA, fluxo: { state: 'draft', file: 'fluxo-usuario.md', findings: [] } }));
  assert.match(text, /Ainda não escrito: `doc\.md`/);
  assert.match(text, /Em rascunho: `fluxo-usuario\.md`/);
  const pii = epicDescription(backlog([task('A', 'done')]), null, docs({ brd: { state: 'blocked', file: 'brd.md', findings: [{ kind: 'e-mail', masked: 'ma***br', line: 3 }] } }));
  assert.match(pii, /Não enviado: dados pessoais detectados \(e-mail \(ma\*\*\*br, linha 3\)\)/);
});

test('descrição vira ADF com checkboxes de verdade e cabe no limite do Jira, cortando só a referência técnica', () => {
  const muitas = Array.from({ length: 150 }, (_, i) => task(`T-${String(i).padStart(3, '0')}`, i % 3 ? 'pending' : 'done', { title: 'tarefa longa '.repeat(3) }));
  const b = backlog(muitas, { gates: muitas.map((t) => ({ id: `G-${t.id}`, type: 'command', task: t.id, command: ['node', '--test', 'x'.repeat(150)] })) });
  const adf = sync.markdownToAdf(epicDescription(b, null, docs()), null);
  const json = JSON.stringify(adf);
  assert.ok(json.includes('☑ T-000') && json.includes('☐ T-001'), 'checkbox vira ☑/☐ na lista');
  assert.ok(adfTextLength(adf) <= 32767, 'cabe no limite do campo');
  assert.ok(json.includes('RN-01 só business cria post'), 'BRD sobrevive ao corte');
  assert.ok(json.includes('Concluídas'), 'lista de tarefas sobrevive');
  assert.ok(!json.includes('Outros campos') && !json.includes(`G-T-149`), 'o que sai primeiro é o fim da referência técnica');
  assert.match(json, /truncad|cortad|limite/i, 'o corte é avisado');
});

// ── épico no Jira: BRD, fluxo, labels e anexos ──────────────────────────────

const labelsOfEpic = (jira) => jira.epics()[0].fields.labels;

test('épico no Jira traz BRD e fluxo; sem eles nasce com labels brd-pendente e fluxo-pendente, que saem quando ficam prontos', async () => {
  const jira = fakeJira(); const w = workspace(backlog([task('A', 'pending')]));
  try {
    await sync.syncEpicOf(w.dir);
    assert.deepEqual(['brd-pendente', 'fluxo-pendente'].filter((l) => labelsOfEpic(jira).includes(l)), ['brd-pendente', 'fluxo-pendente']);
    assert.match(JSON.stringify(jira.epics()[0].fields.description), /Ainda não escrito/);
    for (const [name, content] of Object.entries(READY_DOCS)) fs.writeFileSync(path.join(w.dir, name), content);
    await sync.syncEpicOf(w.dir);
    assert.ok(!labelsOfEpic(jira).includes('brd-pendente') && !labelsOfEpic(jira).includes('fluxo-pendente'));
    assert.match(JSON.stringify(jira.epics()[0].fields.description), /RN-01 regra/);
    assert.equal(jira.epics().length, 1);
  } finally { w.cleanup(); }
});

test('PNG do fluxo do usuário é anexado ao épico uma vez; tamanho novo troca o anexo; sem duplicar', async () => {
  const jira = fakeJira(); const w = workspace(backlog([task('A', 'pending')]), READY_DOCS);
  const png = path.join(w.dir, 'diagramas', 'fluxo-usuario.png');
  try {
    fs.writeFileSync(png, Buffer.alloc(100, 1));
    await sync.syncEpicOf(w.dir);
    await sync.syncEpicOf(w.dir);
    assert.deepEqual(jira.epics()[0].fields.attachment.map((a) => a.filename), ['fluxo-usuario.png']);
    fs.writeFileSync(png, Buffer.alloc(250, 2));
    await sync.syncEpicOf(w.dir);
    assert.deepEqual(jira.epics()[0].fields.attachment.map((a) => `${a.filename}:${a.size}`), ['fluxo-usuario.png:250']);
    assert.equal(jira.calls.filter((c) => c.endsWith('/attachments')).length, 2, 'subiu só quando mudou');
    assert.match(JSON.stringify(jira.epics()[0].fields.description), /Diagrama\(s\) anexado\(s\) ao épico: fluxo-usuario\.png/);
  } finally { w.cleanup(); }
});

test('só imagens fluxo-usuario*.png entram; outros diagramas ficam de fora', () => {
  const w = workspace(backlog([]), READY_DOCS);
  try {
    for (const f of ['fluxo-usuario.png', 'fluxo-usuario-2.png', 'arquitetura.png', 'fluxo-usuario.mmd']) fs.writeFileSync(path.join(w.dir, 'diagramas', f), 'x');
    assert.deepEqual(featureDocs(w.dir).images.map((f) => path.basename(f)), ['fluxo-usuario-2.png', 'fluxo-usuario.png']);
  } finally { w.cleanup(); }
});

test('retitular a feature atualiza o título do épico', async () => {
  const jira = fakeJira(); const w = workspace(backlog([task('A', 'pending')]));
  try {
    await sync.syncEpicOf(w.dir);
    assert.equal(jira.epics()[0].fields.summary, 'Feature Teste');
    w.write({ ...w.read(), title: 'Backlog — Novo nome' });
    await sync.syncEpicOf(w.dir);
    assert.equal(jira.epics()[0].fields.summary, 'Novo nome');
  } finally { w.cleanup(); }
});

// ── resiliência ─────────────────────────────────────────────────────────────

test('idempotência: sincronizar o lote duas vezes mantém 1 épico, N cards e nenhuma criação nova', async () => {
  const jira = fakeJira(); const w = workspace(backlog([task('A', 'done'), task('B', 'pending'), task('C', 'blocked', { motivo: 'm' })]), READY_DOCS);
  try {
    await sync.syncMany(w.dir, ['A', 'B', 'C'], null, {}, quieto);
    const criacoes = () => jira.calls.filter((c) => c === 'POST /rest/api/3/issue').length;
    const antes = criacoes();
    await sync.syncMany(w.dir, ['A', 'B', 'C'], null, {}, quieto);
    assert.equal(criacoes(), antes);
    assert.equal(jira.epics().length, 1);
    assert.equal(jira.cards().length, 3);
  } finally { w.cleanup(); }
});

test('sem a chave gravada, o épico é achado pela label da feature (não duplica)', async () => {
  const jira = fakeJira(); const w = workspace(backlog([task('A', 'pending')]));
  try {
    await sync.syncEpicOf(w.dir);
    fs.rmSync(path.join(w.dir, 'jira-keys', '_epic.txt'));
    const key = await sync.syncEpicOf(w.dir);
    assert.equal(jira.epics().length, 1);
    assert.equal(key, jira.epics()[0].key);
    assert.equal(readJiraKey(w.dir, { id: '_epic' }), key);
  } finally { w.cleanup(); }
});

test('épico apagado no Jira (404 pela chave): recria e os cards voltam a ser filhos dele', async () => {
  const jira = fakeJira(); const w = workspace(backlog([task('A', 'pending'), task('B', 'pending')]));
  try {
    await sync.syncMany(w.dir, ['A', 'B'], null, {}, quieto);
    const antigo = jira.epics()[0].key;
    jira.issues.delete(antigo);
    await sync.syncMany(w.dir, ['A', 'B'], null, {}, quieto);
    assert.equal(jira.epics().length, 1);
    assert.notEqual(jira.epics()[0].key, antigo);
    assert.ok(jira.cards().every((c) => c.fields.parent.key === jira.epics()[0].key));
  } finally { w.cleanup(); }
});

function flaky(status, vezes, casa) {
  const real = globalThis.fetch; let falhas = 0;
  globalThis.fetch = async (url, init) => (casa(String(url), init?.method ?? 'GET') && falhas++ < vezes ? new Response('{}', { status, headers: { 'retry-after': '0' } }) : real(url, init));
}

test('429 e 503 na criação do épico: repete com backoff e conclui', async () => {
  for (const status of [429, 503]) {
    const jira = fakeJira(); const w = workspace(backlog([task('A', 'pending')]));
    try {
      flaky(status, 2, (u, m) => m === 'POST' && u.endsWith('/rest/api/3/issue'));
      await sync.syncEpicOf(w.dir);
      assert.equal(jira.epics().length, 1, `HTTP ${status}`);
    } finally { w.cleanup(); }
  }
});

test('erro na busca do épico (500 persistente) aborta SEM criar épico nem card duplicado', async () => {
  const jira = fakeJira({ search: 500 }); const w = workspace(backlog([task('A', 'pending')]));
  try {
    await assert.rejects(() => sync.syncTask(w.dir, 'A'), /busca no Jira falhou/);
    assert.equal(jira.issues.size, 0);
  } finally { w.cleanup(); }
});

test('falha ao mover o card: o erro nomeia o status e a ação; o card existe, é filho do épico e fica no status anterior', async () => {
  const jira = fakeJira({ workflow: ['To Do', 'In Progress', 'Done'] }); // sem Blocked
  const w = workspace(backlog([task('A', 'pending'), task('B', 'blocked', { motivo: 'm' }), task('C', 'pending')]));
  try {
    await assert.rejects(() => sync.syncTask(w.dir, 'B'), /Blocked[\s\S]*ensure-statuses/);
    assert.equal(jira.cards()[0].fields.status.name, 'To Do');
    assert.equal(jira.cards()[0].fields.parent.key, jira.epics()[0].key);
  } finally { w.cleanup(); }
});

test('dado pessoal no BRD: nada do documento vai ao épico', async () => {
  const jira = fakeJira(); const w = workspace(backlog([task('A', 'pending')]), { ...READY_DOCS, 'brd.md': '# BRD\nStatus: ready\n\ncontato maria.silva@empresa.com.br\n' });
  try {
    await sync.syncEpicOf(w.dir);
    const texto = JSON.stringify(jira.epics()[0].fields.description);
    assert.doesNotMatch(texto, /maria\.silva/);
    assert.match(texto, /Não enviado: dados pessoais detectados/);
  } finally { w.cleanup(); }
});

// ── workflow direcionado (o do Jira real, v4) ────────────────────────────────

test('workflow direcionado: o sync anda por mais de um passo e chega em QUALQUER status, de QUALQUER status', async () => {
  const todos = ['To Do', 'In Progress', 'Blocked', 'Homologation', 'Done', 'Cancelled'];
  const taskStatus = { 'To Do': 'pending', 'In Progress': 'in_progress', Blocked: 'blocked', Done: 'done', Cancelled: 'cancelled' };
  for (const de of todos) {
    for (const para of todos) {
      if (de === para) continue;
      const jira = fakeJira({ graph: DIRECTED_WORKFLOW }); const w = workspace(backlog([task('A', 'pending')]));
      try {
        await sync.syncTask(w.dir, 'A'); // cria o card em To Do
        const card = jira.card();
        card.fields.status = { name: de };
        const homologando = para === 'Homologation';
        const b = w.read();
        b.tasks[0] = task('A', homologando ? 'done' : taskStatus[para], para === 'Blocked' ? { motivo: 'm' } : {});
        b.homologacao = homologando ? { estado: 'em_homologacao' } : undefined;
        w.write(b);
        await sync.syncTask(w.dir, 'A');
        assert.equal(jira.card().fields.status.name, para, `${de} → ${para}`);
      } finally { w.cleanup(); }
    }
  }
});

test('workflow direcionado: transição só por nome do status destino (nomes das transições são livres: Iniciado, Aprovado…)', async () => {
  const jira = fakeJira({ graph: DIRECTED_WORKFLOW }); const w = workspace(backlog([task('A', 'in_progress')]));
  try {
    await sync.syncTask(w.dir, 'A');
    assert.equal(jira.card().fields.status.name, 'In Progress');
    assert.ok(jira.calls.some((c) => c.includes('/transitions')));
  } finally { w.cleanup(); }
});

test('workflow direcionado sem caminho até o status: falha alto listando o que alcança', async () => {
  const jira = fakeJira({ graph: { 'To Do': ['In Progress'], 'In Progress': [], '*': ['To Do'] } }); const w = workspace(backlog([task('A', 'pending'), task('B', 'blocked', { motivo: 'm' })]));
  try {
    await assert.rejects(() => sync.syncTask(w.dir, 'B'), /Blocked[\s\S]*ensure-statuses/);
    assert.equal(jira.card().fields.status.name, 'To Do', 'não deixa o card parado no passo intermediário: volta à origem');
  } finally { w.cleanup(); }
});

test('conta em pt_PT: status de sistema traduzidos ("A fazer", "Em Progresso", "Concluído") não quebram o caminho', async () => {
  const localize = { 'To Do': 'A fazer', 'In Progress': 'Em Progresso', Done: 'Concluído' };
  const jira = fakeJira({ graph: DIRECTED_WORKFLOW, localize }); const w = workspace(backlog([task('A', 'pending')]));
  try {
    await sync.syncTask(w.dir, 'A');
    for (const [st, esperado] of [['in_progress', 'In Progress'], ['blocked', 'Blocked'], ['done', 'Done']]) {
      const b = w.read(); b.tasks[0] = task('A', st, st === 'blocked' ? { motivo: 'm' } : {}); w.write(b);
      await sync.syncTask(w.dir, 'A');
      assert.equal(jira.card().fields.status.name, esperado);
    }
  } finally { w.cleanup(); }
});

// ── responsável pelo card: quem move com o token pessoal (.env.local) ────────

async function assigneeAfterMove(source, extra = {}) {
  const jira = fakeJira({ graph: DIRECTED_WORKFLOW }); const w = workspace(backlog([task('A', 'pending')]));
  const saved = { s: process.env.FLUXO_JIRA_CRED_SOURCE, a: process.env.FLUXO_JIRA_ASSIGN };
  try {
    process.env.FLUXO_JIRA_CRED_SOURCE = source; delete process.env.FLUXO_JIRA_ASSIGN; Object.assign(process.env, extra);
    await sync.syncTask(w.dir, 'A');
    const b = w.read(); b.tasks[0] = task('A', 'in_progress'); w.write(b);
    await sync.syncTask(w.dir, 'A');
    return jira.card().fields.assignee?.accountId ?? null;
  } finally {
    for (const [k, v] of [['FLUXO_JIRA_CRED_SOURCE', saved.s], ['FLUXO_JIRA_ASSIGN', saved.a]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    w.cleanup();
  }
}

test('token do .env.local: quem move o card vira o responsável', async () => {
  assert.equal(await assigneeAfterMove('.env.local'), 'acc-dev');
});

test('token compartilhado (.env) ou do ambiente: o responsável não muda; FLUXO_JIRA_ASSIGN força', async () => {
  assert.equal(await assigneeAfterMove('.env'), null);
  assert.equal(await assigneeAfterMove('ambiente'), null);
  assert.equal(await assigneeAfterMove('.env', { FLUXO_JIRA_ASSIGN: '1' }), 'acc-dev');
  assert.equal(await assigneeAfterMove('.env.local', { FLUXO_JIRA_ASSIGN: '0' }), null);
});

test('falha ao atribuir só avisa: o status mudou e o sync segue', async () => {
  const { claimCard } = await import('../../scripts/tracker/status.mjs');
  const jira = { getMyself: async () => ({ accountId: 'x' }), assignIssue: async () => { throw new Error('403 sem permissão'); } };
  const warn = console.warn; const out = []; console.warn = (m) => out.push(m);
  try { await claimCard(jira, 'OFLUXO-1', { FLUXO_JIRA_ASSIGN: '1' }); } finally { console.warn = warn; }
  assert.match(out.join(''), /responsável não foi atualizado/);
});
