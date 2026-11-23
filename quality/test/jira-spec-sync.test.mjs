// Cards do Jira com a spec: card criado antes da spec recebe a label spec-pendente e a chave
// fica gravada na tarefa; ao gravar a spec o sync acha o card pela chave, preenche a description
// e tira a label; erro de busca nunca cria card duplicado. Jira falso em memória (sem rede).
import './bootstrap-example-profile.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { QUALITY_DIR } from './helpers.mjs';
import { labelsRemovePatch } from '../../scripts/tracker/jira-client.mjs';
import { readJiraKey, jiraKeyPath } from '../delivery/lib.mjs';
import { fakeJira } from './jira-fake.mjs';

const ROOT = path.dirname(QUALITY_DIR);
Object.assign(process.env, { JIRA_RETRY_BASE_MS: '1', JIRA_BASE_URL: 'https://jira.test', JIRA_EMAIL: 'teste@exemplo.test', JIRA_API_TOKEN: 'token-falso', JIRA_PROJECT_KEY: 'OFLUXO' });
const sync = await import('../../scripts/tracker/sync-context.mjs');
const hook = await import('../../.claude/hooks/sync-spec-jira.mjs');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function backlogDir({ spec = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jspec-'));
  const dir = path.join(base, '2026-01-01-teste');
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify({ id: 'teste', title: 'Teste', featureSlug: 'teste', tasks: [{ id: 'TT-001', title: 'Tarefa', status: 'pending' }], gates: [] }));
  if (spec) fs.writeFileSync(path.join(dir, 'specs', 'TT-001.md'), '# TT-001\nStatus: ready\nEscopo da spec.\n');
  return { base, dir, key: () => readJiraKey(dir, { id: 'TT-001' }), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const text = (doc) => JSON.stringify(doc);

test('card criado ANTES da spec: placeholder, label spec-pendente e chave gravada na tarefa', async () => {
  const jira = fakeJira(); const b = backlogDir();
  try {
    const r = await sync.syncTask(b.dir, 'TT-001');
    assert.equal(r.key, 'OFLUXO-1');
    const card = jira.card();
    assert.match(text(card.fields.description), /Spec ainda não escrita/);
    assert.ok(card.fields.labels.includes(sync.SPEC_PENDING_LABEL));
    assert.equal(b.key(), 'OFLUXO-1', 'a chave precisa ficar gravada para evitar duplicata');
  } finally { b.cleanup(); }
});

test('spec gravada depois: o MESMO card recebe a spec integral e perde a label (sem duplicar)', async () => {
  const jira = fakeJira(); const b = backlogDir();
  try {
    await sync.syncTask(b.dir, 'TT-001');
    fs.writeFileSync(path.join(b.dir, 'specs', 'TT-001.md'), '# TT-001\nStatus: ready\nEscopo da spec.\n');
    const r = await sync.syncTask(b.dir, 'TT-001');
    assert.equal(r.key, 'OFLUXO-1');
    assert.equal(jira.creates(), 1, 'não pode criar um segundo card');
    const card = jira.card();
    assert.match(text(card.fields.description), /Escopo da spec\./);
    assert.doesNotMatch(text(card.fields.description), /Spec ainda não escrita/);
    assert.ok(!card.fields.labels.includes(sync.SPEC_PENDING_LABEL));
    assert.ok(card.fields.labels.includes('feature-teste'), 'labels manuais e de feature permanecem');
  } finally { b.cleanup(); }
});

test('card nasce já com a spec: sem label de pendência', async () => {
  const jira = fakeJira(); const b = backlogDir({ spec: true });
  try {
    await sync.syncTask(b.dir, 'TT-001');
    const card = jira.card();
    assert.match(text(card.fields.description), /Escopo da spec\./);
    assert.ok(!card.fields.labels.includes(sync.SPEC_PENDING_LABEL));
  } finally { b.cleanup(); }
});

test('atraso de indexação da busca do Jira não gera card duplicado (acha pela chave gravada)', async () => {
  const jira = fakeJira({ search: 'lag' }); const b = backlogDir({ spec: true });
  try {
    await sync.syncTask(b.dir, 'TT-001');
    await sync.syncTask(b.dir, 'TT-001');
    await sync.syncTask(b.dir, 'TT-001');
    assert.equal(jira.creates(), 1);
    // épico (busca + rank da criação) + as duas JQLs do card + a busca do ranking do card criado.
    assert.equal(jira.calls.filter((c) => c.includes('/search/jql')).length, 5, 'só o primeiro sync precisou buscar (épico + 2 JQLs do card + 2 buscas de ranking)');
  } finally { b.cleanup(); }
});

test('erro na busca (429, 500, 401) aborta o sync e NUNCA cria card', async () => {
  for (const status of [429, 500, 401]) {
    const jira = fakeJira({ search: status }); const b = backlogDir({ spec: true });
    try {
      await assert.rejects(() => sync.syncTask(b.dir, 'TT-001'), new RegExp(`HTTP ${status}.*não duplicar`));
      assert.equal(jira.creates(), 0, `HTTP ${status} não pode virar "card inexistente"`);
      assert.equal(b.key(), null);
    } finally { b.cleanup(); }
  }
});

test('card apagado no Jira (404 pela chave): procura de novo e só então cria, regravando a chave', async () => {
  const jira = fakeJira(); const b = backlogDir({ spec: true });
  try {
    await sync.syncTask(b.dir, 'TT-001');
    jira.issues.delete('OFLUXO-1');
    const r = await sync.syncTask(b.dir, 'TT-001');
    assert.equal(r.key, 'OFLUXO-2');
    assert.equal(b.key(), 'OFLUXO-2');
    assert.equal(jira.calls.filter((c) => c.endsWith('POST /rest/api/3/issue') || c === 'POST /rest/api/3/issue').length, 3, '1 épico + o card criado duas vezes (o primeiro foi apagado)');
    assert.equal(jira.epics().length, 1, 'o épico é reaproveitado, não recriado');
  } finally { b.cleanup(); }
});

test('auditSpecs lista só as tarefas sem arquivo de spec; --audit sai com 1 e não usa rede', () => {
  const b = backlogDir();
  try {
    assert.deepEqual(sync.auditSpecs(b.dir).map((m) => m.id), ['TT-001']);
    fs.writeFileSync(path.join(b.dir, 'specs', 'TT-001.md'), 'Status: ready\n');
    assert.deepEqual(sync.auditSpecs(b.dir), []);
    fs.rmSync(path.join(b.dir, 'specs', 'TT-001.md'));
    const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts/tracker/sync-context.mjs'), b.dir, '--audit'], { encoding: 'utf8', env: { ...process.env, JIRA_BASE_URL: 'http://127.0.0.1:9' } });
    assert.equal(cli.status, 1, cli.stderr);
    assert.match(cli.stdout, /TT-001 \(pending\) spec missing/);
  } finally { b.cleanup(); }
});

test('labelsRemovePatch é o inverso aditivo e ignora vazios', () => {
  assert.deepEqual(labelsRemovePatch(['a', ' b ']), { update: { labels: [{ remove: 'a' }, { remove: 'b' }] } });
  assert.equal(labelsRemovePatch([]), null);
  assert.equal(labelsRemovePatch(['', null]), null);
});

// ---- hook que sincroniza quando a spec é gravada ------------------------------------------

test('hook: reconhece só arquivo de spec de entrega e ignora o resto', () => {
  assert.deepEqual(hook.specTarget('docs/entregas/2026-11-14-fluxo-creator/specs/FC-006.md'), { slug: '2026-11-14-fluxo-creator', id: 'FC-006' });
  for (const rel of ['docs/entregas/x/entrega.md', 'docs/entregas/x/specs/notas.md', 'docs/outro/specs/FC-006.md', 'lib/a.dart', 'docs/entregas/x/specs/FC-006.md.bak', '']) {
    assert.equal(hook.specTarget(rel), null, rel);
  }
});

test('hook: dispara o sync, avisa se faltam credenciais, aplica lock e respeita o desligamento', () => {
  const b = backlogDir({ spec: true });
  const rel = 'docs/entregas/2026-01-01-teste/specs/TT-001.md';
  try {
    const root = b.base; // raiz falsa: docs/entregas/<slug> relativo a ela
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.renameSync(b.dir, path.join(root, 'docs', 'entregas-tmp')); fs.mkdirSync(path.join(root, 'docs', 'entregas'));
    fs.renameSync(path.join(root, 'docs', 'entregas-tmp'), path.join(root, 'docs', 'entregas', '2026-01-01-teste'));
    const env = { JIRA_API_TOKEN: 'x' };
    const first = hook.planSync({ root, rel, env, now: 1_000_000 });
    assert.equal(first.action, 'sync');
    assert.match(first.cmd, /sync-context\.mjs docs\/entregas\/2026-01-01-teste TT-001/);
    fs.mkdirSync(path.dirname(first.lock), { recursive: true });
    fs.writeFileSync(first.lock, '1');
    assert.equal(hook.planSync({ root, rel, env, now: Date.now() }).action, 'debounced');
    assert.equal(hook.planSync({ root, rel, env, now: Date.now() + 130_000 }).action, 'sync'); // lock expirou
    const noCreds = hook.planSync({ root, rel, env: {} });
    assert.equal(noCreds.action, 'no-credentials');
    assert.match(noCreds.message, /faltam as credenciais JIRA_\*/);
    assert.doesNotMatch(noCreds.message, /token/i);
    assert.equal(hook.planSync({ root, rel, env: { ...env, FLUXO_JIRA_AUTOSYNC: '0' } }).action, 'ignore');
    assert.equal(hook.planSync({ root, rel: 'docs/entregas/2026-01-01-teste/specs/ZZ-999.md', env }).action, 'ignore'); // tarefa inexistente
    assert.equal(hook.planSync({ root, rel: 'lib/a.dart', env }).action, 'ignore');
    // spec ausente ou em rascunho não dispara sync: o card segue pendente
    fs.writeFileSync(path.join(root, 'docs/entregas/2026-01-01-teste/specs/TT-001.md'), '# TT-001\nStatus: draft\nrascunho\n');
    assert.equal(hook.planSync({ root, rel, env, now: Date.now() + 500_000 }).action, 'not-ready');
  } finally { b.cleanup(); }
});

test('hook de ponta a ponta (dry-run): entrada do Claude Code vira o sync certo, sem spawn nem rede', () => {
  const b = backlogDir({ spec: true });
  try {
    const root = b.base;
    fs.mkdirSync(path.join(root, 'docs', 'entregas'), { recursive: true });
    fs.renameSync(b.dir, path.join(root, 'docs', 'entregas', '2026-01-01-teste'));
    const r = spawnSync(process.execPath, [path.join(ROOT, '.claude/hooks/sync-spec-jira.mjs')], {
      input: JSON.stringify({ tool_input: { file_path: path.join(root, 'docs/entregas/2026-01-01-teste/specs/TT-001.md') }, cwd: root }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, JIRA_API_TOKEN: 'x', FLUXO_JIRA_DRY_RUN: '1' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /\[dry-run\] node scripts\/tracker\/sync-context\.mjs docs\/entregas\/2026-01-01-teste TT-001/);
    const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
    const registered = settings.hooks.PostToolUse.flatMap((e) => e.hooks.map((h) => h.command)).some((c) => c.includes('sync-spec-jira.mjs'));
    assert.ok(registered, 'o hook precisa estar registrado em settings.json');
  } finally { b.cleanup(); }
});

// ---- WP1: nada vai ao Jira sem Status: ready e sem dados pessoais ---------------------------

const { findPersonalData, describeFindings } = await import('../lib/pii-guard.mjs');
const { inspectSpec, writtenPaths, planSync: sharedPlan } = await import('../lib/spec-sync.mjs');

// O token é montado em runtime: um literal ghp_… de 40+ chars no arquivo acionaria o
// check-sensitive-files do CI (padrão gh[pousr]_ + 36 alfanuméricos).
const RAW = { cpf: '123.456.789-09', email: 'maria.silva@gmail.com', uid: 'AbCdEfGhIjKlMnOpQrStUvWxYz12', token: `ghp_${'x'.repeat(36)}` };
const SPEC_COM_PII = `# TT-001\nStatus: ready\nCPF do teste ${RAW.cpf}\nconta ${RAW.email}\nuid: ${RAW.uid}\ntoken=${RAW.token}\n`;

test('pii-guard: acha CPF, e-mail, identificador e token; ignora placeholders; nunca devolve o valor bruto', () => {
  const found = findPersonalData(SPEC_COM_PII);
  assert.deepEqual([...new Set(found.map((f) => f.kind))].sort(), ['CPF', 'e-mail', 'identificador', 'token']);
  const dump = JSON.stringify(found) + describeFindings(found);
  for (const raw of Object.values(RAW)) assert.ok(!dump.includes(raw), `vazou ${raw.slice(0, 6)}…`);
  assert.match(describeFindings(found), /CPF \(12\*\*\*09, linha 3\)/);
  // placeholders e dados fictícios não contam
  const ok = '000.000.000-00 e 00.000.000/0000-00; usuario@example.com e x@exemplo.com.br e a@servico.test; uid: xxxxxxxxxxxxxxxx; uid do usuário <uid>; token=<seu-token>';
  assert.deepEqual(findPersonalData(ok), []);
  assert.deepEqual(findPersonalData(''), []);
  assert.equal(findPersonalData(`${'a@b.co '.repeat(5)}${'12.345.678/0001-95 '.repeat(40)}`).length <= 20, true);
});

test('pii-guard: pacote@versão, conta de serviço do GCP e CNPJ de fixture não são dado pessoal; e-mail real continua sendo', () => {
  const benigno = 'Dependências: pnpm@9.15.0, satori@0.63.2, vertex-sdk@1.0.0. Conta fluxo-api@projeto-x.iam.gserviceaccount.com. Fixtures 11.222.333/0001-81, 12345678000190 e 12ABC34501DE35.';
  assert.deepEqual(findPersonalData(benigno), []);
  assert.equal(findPersonalData('Falar com maria.silva@empresa.com.br').length, 1);
  assert.equal(findPersonalData('Contato fulano@empresa.app').length, 1);
  assert.equal(findPersonalData('CNPJ da loja 45.723.174/0001-10').length, 1);
});

test('inspectSpec: missing, draft, blocked (com achados mascarados) e ready', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-'));
  const write = (text) => { const f = path.join(dir, 'TT.md'); fs.writeFileSync(f, text); return f; };
  try {
    assert.equal(inspectSpec(path.join(dir, 'nao-existe.md')).state, 'missing');
    assert.equal(inspectSpec(write('  \n')).state, 'missing');
    assert.equal(inspectSpec(write('# T\nStatus: draft\ntexto\n')).state, 'draft');
    assert.equal(inspectSpec(write('# T\ntexto sem status\n')).state, 'draft');
    const blocked = inspectSpec(write(SPEC_COM_PII));
    assert.equal(blocked.state, 'blocked');
    assert.ok(blocked.findings.length >= 4 && !('text' in blocked), 'spec com PII nunca expõe o texto');
    const ready = inspectSpec(write('# T\nStatus: ready\nEscopo.\n'));
    assert.deepEqual([ready.state, ready.text.includes('Escopo.')], ['ready', true]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sync com PII: o card NÃO recebe a spec, recebe o aviso, e a label spec-pendente fica', async () => {
  const jira = fakeJira(); const b = backlogDir();
  try {
    fs.writeFileSync(path.join(b.dir, 'specs', 'TT-001.md'), SPEC_COM_PII);
    await sync.syncTask(b.dir, 'TT-001');
    const card = jira.card();
    const description = text(card.fields.description);
    for (const raw of Object.values(RAW)) assert.ok(!description.includes(raw), 'dado pessoal foi para o Jira');
    assert.match(description, /Spec retida/);
    assert.match(description, /CPF \(12\*\*\*09, linha 3\)/);
    assert.ok(card.fields.labels.includes(sync.SPEC_PENDING_LABEL));
    assert.doesNotMatch(JSON.stringify([...jira.issues.values()]), /maria\.silva/);
    // corrigida a spec, o MESMO card recebe o texto e perde a label
    fs.writeFileSync(path.join(b.dir, 'specs', 'TT-001.md'), '# TT-001\nStatus: ready\nCPF de teste 000.000.000-00 e usuario@example.com.\n');
    await sync.syncTask(b.dir, 'TT-001');
    assert.match(text(jira.card().fields.description), /CPF de teste 000\.000\.000-00/);
    assert.ok(!jira.card().fields.labels.includes(sync.SPEC_PENDING_LABEL));
    assert.equal(jira.creates(), 1);
  } finally { b.cleanup(); }
});

test('sync com spec em rascunho: nada do texto vai ao card até virar ready', async () => {
  const jira = fakeJira(); const b = backlogDir();
  try {
    fs.writeFileSync(path.join(b.dir, 'specs', 'TT-001.md'), '# TT-001\nStatus: draft\nIdeia solta ainda não revisada.\n');
    await sync.syncTask(b.dir, 'TT-001');
    const card = jira.card();
    assert.doesNotMatch(text(card.fields.description), /Ideia solta/);
    assert.match(text(card.fields.description), /rascunho/);
    assert.ok(card.fields.labels.includes(sync.SPEC_PENDING_LABEL));
    assert.deepEqual(sync.auditSpecs(b.dir).map((m) => [m.id, m.state]), [['TT-001', 'draft']]);
  } finally { b.cleanup(); }
});

test('hook do Claude com PII: avisa o agente sem o valor e não dispara sync', () => {
  const b = backlogDir();
  try {
    const root = b.base;
    fs.mkdirSync(path.join(root, 'docs', 'entregas'), { recursive: true });
    fs.renameSync(b.dir, path.join(root, 'docs', 'entregas', '2026-01-01-teste'));
    fs.writeFileSync(path.join(root, 'docs/entregas/2026-01-01-teste/specs/TT-001.md'), SPEC_COM_PII);
    const r = spawnSync(process.execPath, [path.join(ROOT, '.claude/hooks/sync-spec-jira.mjs')], {
      input: JSON.stringify({ tool_input: { file_path: path.join(root, 'docs/entregas/2026-01-01-teste/specs/TT-001.md') }, cwd: root }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, JIRA_API_TOKEN: 'x', FLUXO_JIRA_DRY_RUN: '1' },
    });
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /NÃO foi enviada ao Jira/);
    for (const raw of Object.values(RAW)) assert.ok(!ctx.includes(raw));
    assert.ok(!fs.existsSync(path.join(root, '.claude', '.state')), 'sem lock: nada foi disparado');
  } finally { b.cleanup(); }
});

// ---- WP5: o mesmo comportamento no Cline (PostToolUse) --------------------------------------

test('writtenPaths: path/filePath/file_path e cabeçalhos de apply_patch', () => {
  assert.deepEqual(writtenPaths({ path: 'a.md' }), ['a.md']);
  assert.deepEqual(writtenPaths({ filePath: 'b.md', new_text: 'x' }), ['b.md']);
  assert.deepEqual(writtenPaths({ file_path: 'c.md' }), ['c.md']);
  assert.deepEqual(writtenPaths({ input: '*** Begin Patch\n*** Add File: docs/x/specs/A-1.md\n+oi\n*** Update File: lib/y.dart\n*** End Patch' }), ['docs/x/specs/A-1.md', 'lib/y.dart']);
  assert.deepEqual(writtenPaths('*** Update File: z.md\n'), ['z.md']);
  assert.deepEqual(writtenPaths(undefined), []);
});

function clineRoot({ spec }) {
  const b = backlogDir();
  const root = b.base;
  fs.mkdirSync(path.join(root, 'docs', 'entregas'), { recursive: true });
  fs.renameSync(b.dir, path.join(root, 'docs', 'entregas', '2026-01-01-teste'));
  if (spec !== undefined) fs.writeFileSync(path.join(root, 'docs/entregas/2026-01-01-teste/specs/TT-001.md'), spec);
  return { root, cleanup: b.cleanup, lock: path.join(root, '.claude', '.state', 'jira-sync-2026-01-01-teste-TT-001.lock') };
}
const clinePostHook = (root, payload, env = {}) => {
  const r = spawnSync(path.join(ROOT, '.clinerules/hooks/PostToolUse'), [], {
    input: JSON.stringify({ hookName: 'PostToolUse', taskId: 'k1', ...payload }),
    encoding: 'utf8',
    env: { ...process.env, QUALITY_ROOT: root, QUALITY_STATE_DIR: path.join(root, 'quality/.state'), FLUXO_JIRA_DRY_RUN: '1', JIRA_API_TOKEN: 'x', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const SPEC_REL = 'docs/entregas/2026-01-01-teste/specs/TT-001.md';
const sdkWrite = (toolName, parameters, success = true) => ({ tool_result: { name: toolName }, postToolUse: { toolName, parameters, result: 'ok', success, executionTimeMs: 3 } });

test('Cline: gravar spec pronta dispara o sync (lock), em editor, write_to_file e apply_patch', () => {
  const c = clineRoot({ spec: '# TT-001\nStatus: ready\nEscopo.\n' });
  try {
    const writes = [sdkWrite('editor', { path: SPEC_REL, new_text: 'x' }), sdkWrite('write_to_file', { path: SPEC_REL, content: 'x' }), sdkWrite('apply_patch', { input: `*** Begin Patch\n*** Update File: ${SPEC_REL}\n*** End Patch` })];
    for (const payload of writes) {
      assert.deepEqual(clinePostHook(c.root, payload), {}, JSON.stringify(payload).slice(0, 40)); // sem aviso: só dispara
      assert.ok(fs.existsSync(c.lock), `lock criado por ${payload.postToolUse.toolName}`);
      fs.rmSync(c.lock);
    }
    // escrita que falhou, ou em arquivo que não é spec, não dispara
    clinePostHook(c.root, sdkWrite('editor', { path: SPEC_REL }, false));
    clinePostHook(c.root, sdkWrite('editor', { path: 'lib/a.dart' }));
    assert.ok(!fs.existsSync(c.lock));
    clinePostHook(c.root, sdkWrite('editor', { path: SPEC_REL }), { FLUXO_JIRA_AUTOSYNC: '0' });
    assert.ok(!fs.existsSync(c.lock), 'FLUXO_JIRA_AUTOSYNC=0 desliga');
  } finally { c.cleanup(); }
});

test('Cline: spec com PII ou sem credencial volta em contextModification, sem o valor', () => {
  const pii = clineRoot({ spec: SPEC_COM_PII });
  const noCreds = clineRoot({ spec: '# TT-001\nStatus: ready\nEscopo.\n' });
  try {
    const out = clinePostHook(pii.root, sdkWrite('editor', { path: SPEC_REL }));
    assert.match(out.contextModification, /NÃO foi enviada ao Jira/);
    for (const raw of Object.values(RAW)) assert.ok(!out.contextModification.includes(raw));
    assert.ok(!fs.existsSync(pii.lock));
    const semCred = clinePostHook(noCreds.root, sdkWrite('editor', { path: SPEC_REL }), { JIRA_API_TOKEN: '' });
    assert.match(semCred.contextModification, /faltam as credenciais JIRA_\*/);
  } finally { pii.cleanup(); noCreds.cleanup(); }
});

test('planSync compartilhado: Claude e Cline chegam à mesma decisão', () => {
  const c = clineRoot({ spec: '# TT-001\nStatus: ready\nEscopo.\n' });
  try {
    const env = { JIRA_API_TOKEN: 'x' };
    assert.equal(sharedPlan({ root: c.root, rel: SPEC_REL, env }).action, hook.planSync({ root: c.root, rel: SPEC_REL, env }).action);
    assert.equal(sharedPlan({ root: c.root, rel: SPEC_REL, env }).action, 'sync');
  } finally { c.cleanup(); }
});

// ---- WP9: robustez do Jira ----------------------------------------------------------------------

const quiet = { log() {}, error() {} };

test('a chave do card vai para jira-keys/<ID>.txt e o backlog.json NÃO é tocado (sem corrida com o mark)', async () => {
  const jira = fakeJira(); const b = backlogDir({ spec: true });
  try {
    const before = fs.readFileSync(path.join(b.dir, 'backlog.json'), 'utf8');
    await sync.syncTask(b.dir, 'TT-001');
    assert.equal(fs.readFileSync(path.join(b.dir, 'backlog.json'), 'utf8'), before, 'backlog.json intocado');
    assert.equal(fs.readFileSync(jiraKeyPath(b.dir, 'TT-001'), 'utf8').trim(), 'OFLUXO-1');
    const backlog = JSON.parse(before); backlog.tasks[0].status = 'in_progress';
    fs.writeFileSync(path.join(b.dir, 'backlog.json'), JSON.stringify(backlog));
    assert.equal(readJiraKey(b.dir, backlog.tasks[0]), 'OFLUXO-1');
    await sync.syncTask(b.dir, 'TT-001');
    assert.equal(jira.creates(), 1, 'achou o card pela chave, sem duplicar');
    fs.rmSync(path.join(b.dir, 'jira-keys'), { recursive: true });
    assert.equal(readJiraKey(b.dir, { id: 'TT-001', jira_key: 'OFLUXO-9' }), 'OFLUXO-9');
    assert.equal(readJiraKey(b.dir, { id: 'TT-001', jira_key: 'lixo' }), null);
  } finally { b.cleanup(); }
});

test('429 e 5xx: o cliente repete com backoff e o sync conclui; esgotados os retries, aborta sem criar', async () => {
  const b = backlogDir({ spec: true });
  try {
    for (const status of [429, 503]) {
      const jira = fakeJira();
      const real = globalThis.fetch;
      let hits = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url).includes('/search/jql') && hits++ < 2) return new Response('{}', { status, headers: { 'retry-after': '0' } });
        return real(url, init);
      };
      await sync.syncTask(b.dir, 'TT-001');
      assert.equal(hits >= 3, true, `HTTP ${status} repetido até passar (${hits} tentativas)`);
      assert.equal(jira.creates(), 1);
      fs.rmSync(path.join(b.dir, 'jira-keys'), { recursive: true, force: true });
    }
    const jira = fakeJira({ search: 429 });
    await assert.rejects(() => sync.syncTask(b.dir, 'TT-001'), /HTTP 429.*não duplicar/);
    assert.equal(jira.creates(), 0);
    assert.ok(jira.calls.filter((c) => c.includes('/search/jql')).length >= 4, 'tentou de novo antes de desistir');
  } finally { b.cleanup(); }
});

test('--all: uma tarefa que falha não aborta o lote; as demais sincronizam e a falha é devolvida', async () => {
  const jira = fakeJira(); const b = backlogDir({ spec: true });
  try {
    const backlog = JSON.parse(fs.readFileSync(path.join(b.dir, 'backlog.json'), 'utf8'));
    backlog.tasks.push({ id: 'TT-002', title: 'Segunda', status: 'pending' }, { id: 'TT-003', title: 'Terceira', status: 'pending' });
    fs.writeFileSync(path.join(b.dir, 'backlog.json'), JSON.stringify(backlog));
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'POST' && String(url).endsWith('/issue') && JSON.parse(init.body).fields.summary.startsWith('TT-002')) return new Response('{}', { status: 400 });
      return real(url, init);
    };
    const failures = await sync.syncMany(b.dir, ['TT-001', 'TT-002', 'TT-003'], null, {}, quiet);
    assert.deepEqual(failures.map((f) => f.id), ['TT-002']);
    assert.deepEqual(jira.cards().map((i) => i.fields.summary.split(' ')[0]).sort(), ['TT-001', 'TT-003']);
    assert.equal(readJiraKey(b.dir, { id: 'TT-003' }), 'OFLUXO-2');
  } finally { b.cleanup(); }
});

test('tarefa encerrada sem spec é histórico: sem label spec-pendente, e ela sai se o card já a tinha', async () => {
  const jira = fakeJira(); const b = backlogDir();
  try {
    await sync.syncTask(b.dir, 'TT-001');
    assert.ok(jira.card().fields.labels.includes(sync.SPEC_PENDING_LABEL));
    const backlog = JSON.parse(fs.readFileSync(path.join(b.dir, 'backlog.json'), 'utf8'));
    backlog.tasks[0].status = 'done';
    fs.writeFileSync(path.join(b.dir, 'backlog.json'), JSON.stringify(backlog));
    await sync.syncTask(b.dir, 'TT-001');
    assert.ok(!jira.card().fields.labels.includes(sync.SPEC_PENDING_LABEL));
    assert.deepEqual(sync.auditSpecs(b.dir).map((m) => [m.id, m.state]), [['TT-001', 'missing']], 'a auditoria local ainda lista a ausência');
  } finally { b.cleanup(); }
});

test('sync para um status que o Jira NÃO alcança falha alto: antes devolvia "Blocked" e o card ficava parado', async () => {
  const jira = fakeJira({ workflow: ['To Do', 'In Progress', 'Done'] }); // sem Blocked, como o projeto estava
  const b = backlogDir({ spec: true });
  await sync.syncTask(b.dir, 'TT-001');
  const backlog = JSON.parse(fs.readFileSync(path.join(b.dir, 'backlog.json'), 'utf8'));
  backlog.tasks[0].status = 'blocked';
  backlog.tasks[0].motivo = 'aguarda decisão';
  fs.writeFileSync(path.join(b.dir, 'backlog.json'), JSON.stringify(backlog));
  await assert.rejects(() => sync.syncTask(b.dir, 'TT-001'), /Blocked/);
  assert.equal(jira.issues.get(b.key()).fields.status.name, 'To Do');
  b.cleanup();
});

test('sync move o card pelo workflow (To Do → In Progress → Blocked → Done) e é idempotente no mesmo status', async () => {
  const jira = fakeJira();
  const b = backlogDir({ spec: true });
  for (const status of ['in_progress', 'blocked', 'in_progress', 'done', 'done']) {
    const backlog = JSON.parse(fs.readFileSync(path.join(b.dir, 'backlog.json'), 'utf8'));
    backlog.tasks[0].status = status;
    fs.writeFileSync(path.join(b.dir, 'backlog.json'), JSON.stringify(backlog));
    await sync.syncTask(b.dir, 'TT-001');
  }
  assert.equal(jira.issues.get(b.key()).fields.status.name, 'Done');
  b.cleanup();
});
