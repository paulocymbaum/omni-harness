// Homologação: com todas as tarefas desenvolvidas e o ambiente Docker local pronto, a feature vai
// para "em_homologacao" (e os cards para Homologation). Sem preparo real, não vai: nada de atalho.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateBacklog } from '../../delivery/lib.mjs';

const BACKLOG_MJS = path.resolve(import.meta.dirname, '..', '..', 'delivery', 'backlog.mjs');
const FAKE_JIRA = { JIRA_BASE_URL: 'http://127.0.0.1:1', JIRA_EMAIL: 'teste@example.com', JIRA_API_TOKEN: 'falso', JIRA_PROJECT_KEY: 'TST' };

function fakeBin({ docker }) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node')); // os gates chamam `node`; o docker real fica de fora do PATH
  if (docker) {
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\n[ "${docker}" = fail ] && { echo "services.api: invalid" >&2; exit 1; }\nexit 0\n`, { mode: 0o755 });
  }
  return bin;
}

function run(args, { docker = 'ok' } = {}) {
  const bin = fakeBin({ docker: docker === 'ausente' ? null : docker });
  try {
    const r = spawnSync(process.execPath, [BACKLOG_MJS, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...FAKE_JIRA, PATH: bin } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
}

function entrega({ status = ['done', 'done'], homologacao = true, docs = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'homolog-')));
  const compose = path.join(dir, 'compose.yml');
  const up = path.join(dir, 'up.sh');
  fs.writeFileSync(compose, 'services: {}\n');
  fs.writeFileSync(up, '#!/bin/sh\n');
  if (docs) {
    fs.writeFileSync(path.join(dir, 'brd.md'), '# BRD\nStatus: ready\n\n## Regras\n- RN-01 só business cria post\n');
    fs.writeFileSync(path.join(dir, 'fluxo-usuario.md'), '# Fluxo\nStatus: ready\n\n1. Abrir a área business\n');
  }
  const backlog = {
    id: 'feat', title: 'Feature', created: '2026-11-14',
    tasks: status.map((s, i) => ({ id: `H-00${i + 1}`, title: `Tarefa ${i + 1}`, status: s, depends_on: [] })),
    gates: status.map((_, i) => ({ id: `EG-${i + 1}`, type: 'command', task: `H-00${i + 1}`, command: ['node', '--version'] })),
    ...(homologacao ? { homologacao: { estado: 'pendente', compose, up: `sh ${up}`, down: 'docker compose down -v', url: 'http://127.0.0.1:18080', roteiro: ['Abrir a área business', 'Gerar um post'] } } : {}),
  };
  fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));
  return { dir, read: () => JSON.parse(fs.readFileSync(path.join(dir, 'backlog.json'), 'utf8')), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('com tarefa fora de done NÃO homologa e diz quais', () => {
  const e = entrega({ status: ['done', 'in_progress'] });
  const r = run(['homologar', e.dir]);
  assert.equal(r.code, 1);
  assert.match(r.err, /restam tarefas fora de done: H-002 \(in_progress\)/);
  assert.equal(e.read().homologacao.estado, 'pendente');
  e.cleanup();
});

test('homologar --parcial entra com pendentes/blocked e marca o escopo', () => {
  const e = entrega({ status: ['done', 'done', 'pending', 'blocked'] });
  const r = run(['homologar', e.dir, '--parcial']);
  assert.equal(r.code, 0, r.err);
  const b = e.read();
  assert.equal(b.homologacao.estado, 'em_homologacao');
  assert.equal(b.homologacao.parcial, true);
  assert.deepEqual(b.homologacao.abertas, ['H-003', 'H-004']);
  const md = fs.readFileSync(path.join(e.dir, 'homologacao.md'), 'utf8');
  assert.match(md, /escopo parcial/);
  assert.match(md, /Fora do escopo desta homologação/);
  assert.match(md, /H-003 \(pending\) — Tarefa 3/);
  e.cleanup();
});

test('homologar --parcial sem nenhuma done NÃO homologa', () => {
  const e = entrega({ status: ['pending', 'blocked'] });
  const r = run(['homologar', e.dir, '--parcial']);
  assert.equal(r.code, 1);
  assert.match(r.err, /homologação parcial exige ao menos uma tarefa done/);
  assert.equal(e.read().homologacao.estado, 'pendente');
  e.cleanup();
});

test('sem --parcial o modo completo segue bloqueando pendentes (regressão)', () => {
  const e = entrega({ status: ['done', 'pending'] });
  const r = run(['homologar', e.dir]);
  assert.equal(r.code, 1);
  assert.match(r.err, /restam tarefas fora de done/);
  e.cleanup();
});

test('sem o bloco homologacao no backlog NÃO homologa', () => {
  const e = entrega({ homologacao: false });
  const r = run(['homologar', e.dir]);
  assert.equal(r.code, 1);
  assert.match(r.err, /sem o bloco "homologacao"/);
  e.cleanup();
});

test('tudo done + ambiente Docker válido: em_homologacao, roteiro gravado, comando para decidir', () => {
  const e = entrega();
  const r = run(['homologar', e.dir]);
  assert.equal(r.code, 0, r.err);
  const h = e.read().homologacao;
  assert.equal(h.estado, 'em_homologacao');
  assert.ok(h.iniciada_em);
  const md = fs.readFileSync(path.join(e.dir, 'homologacao.md'), 'utf8');
  for (const t of ['http://127.0.0.1:18080', '1. Abrir a área business', '2. Gerar um post', 'H-001 — Tarefa 1', 'H-002 — Tarefa 2', 'homologar', '--aprovar', '--reprovar']) assert.ok(md.includes(t), `faltou ${t}`);
  e.cleanup();
});

test('docker compose config reprovado ou docker ausente: NÃO homologa (sem bypass)', () => {
  const e = entrega();
  const falha = run(['homologar', e.dir], { docker: 'fail' });
  assert.equal(falha.code, 1);
  assert.match(falha.err, /docker compose config reprovou .*services\.api: invalid/);
  const ausente = run(['homologar', e.dir], { docker: 'ausente' });
  assert.equal(ausente.code, 1);
  assert.match(ausente.err, /docker indisponível/);
  assert.equal(e.read().homologacao.estado, 'pendente');
  e.cleanup();
});

test('compose inexistente ou script de subida inexistente reprova', () => {
  const e = entrega();
  const b = e.read(); b.homologacao.compose = path.join(e.dir, 'nao-existe.yml'); fs.writeFileSync(path.join(e.dir, 'backlog.json'), JSON.stringify(b));
  assert.match(run(['homologar', e.dir]).err, /compose não encontrado/);
  b.homologacao.compose = path.join(e.dir, 'compose.yml'); b.homologacao.up = `sh ${path.join(e.dir, 'sumiu.sh')}`; fs.writeFileSync(path.join(e.dir, 'backlog.json'), JSON.stringify(b));
  assert.match(run(['homologar', e.dir]).err, /script de homologacao\.up não encontrado/);
  e.cleanup();
});

test('mark done da ÚLTIMA tarefa manda a feature para homologação sozinho; da penúltima não', () => {
  const e = entrega({ status: ['done', 'pending', 'pending'] });
  const meio = run(['mark', e.dir, 'H-002', '--status', 'done']);
  assert.equal(meio.code, 0, meio.err);
  assert.equal(e.read().homologacao.estado, 'pendente');
  const ultima = run(['mark', e.dir, 'H-003', '--status', 'done']);
  assert.equal(ultima.code, 0, ultima.err);
  assert.match(ultima.out, /iniciando a homologação/);
  assert.equal(e.read().homologacao.estado, 'em_homologacao');
  e.cleanup();
});

test('última tarefa done mas ambiente sem preparo: done gravado, homologação NÃO inicia e o mark sai 1', () => {
  const e = entrega({ status: ['done', 'pending'] });
  const r = run(['mark', e.dir, 'H-002', '--status', 'done'], { docker: 'fail' });
  assert.equal(r.code, 1);
  assert.equal(e.read().tasks[1].status, 'done');
  assert.match(r.err, /Homologação NÃO iniciada/);
  e.cleanup();
});

test('última tarefa done sem bloco homologacao: avisa como definir, sem falhar', () => {
  const e = entrega({ status: ['done', 'pending'], homologacao: false });
  const r = run(['mark', e.dir, 'H-002', '--status', 'done']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /não tem `homologacao`/);
  e.cleanup();
});

test('aprovar e reprovar: exigem estar em homologação; reprovar exige motivo; reprovada pode homologar de novo', () => {
  const e = entrega();
  assert.equal(run(['homologar', e.dir, '--aprovar']).code, 1, 'não está em homologação');
  assert.equal(run(['homologar', e.dir]).code, 0);
  assert.equal(run(['homologar', e.dir, '--reprovar']).code, 1, 'sem --motivo');
  const rep = run(['homologar', e.dir, '--reprovar', '--motivo', 'post não gera']);
  assert.equal(rep.code, 0, rep.err);
  assert.equal(e.read().homologacao.estado, 'reprovada');
  assert.equal(e.read().homologacao.motivo_reprovacao, 'post não gera');
  assert.equal(run(['homologar', e.dir]).code, 0, 'depois da correção, homologa de novo');
  assert.equal(e.read().homologacao.estado, 'em_homologacao');
  assert.equal('motivo_reprovacao' in e.read().homologacao, false);
  assert.equal(run(['homologar', e.dir, '--aprovar']).code, 0);
  assert.equal(e.read().homologacao.estado, 'aprovada');
  assert.equal(run(['homologar', e.dir, '--deploy']).code, 0, 'deploy exige aprovação prévia');
  assert.equal(e.read().homologacao.estado, 'implantada');
  assert.ok('implantada_em' in e.read().homologacao);
  e.cleanup();
});

test('init --compose já cria o bloco homologacao; validate recusa bloco malformado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-'));
  const r = run(['init', path.join(dir, 'entrega'), '--compose', 'a/compose.yml', '--url', 'http://127.0.0.1:1', '--roteiro', 'passo um']);
  assert.equal(r.code, 0, r.err);
  const b = JSON.parse(fs.readFileSync(path.join(dir, 'entrega', 'backlog.json'), 'utf8'));
  assert.deepEqual(b.homologacao.roteiro, ['passo um']);
  assert.equal(b.homologacao.estado, 'pendente');
  assert.match(b.homologacao.up, /docker compose -f a\/compose\.yml up -d --build/);
  assert.ok(validateBacklog({ ...b }).length === 0);
  assert.ok(validateBacklog({ ...b, homologacao: { estado: 'qualquer', roteiro: 'x' } }).some((e) => /estado inválido/.test(e)));
  assert.ok(validateBacklog({ ...b, homologacao: { roteiro: 'x' } }).some((e) => /roteiro/.test(e)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sem BRD ou fluxo do usuário prontos NÃO homologa, e diz qual está ausente, em rascunho ou com dado pessoal', () => {
  const e = entrega({ docs: false });
  const ausentes = run(['homologar', e.dir]);
  assert.equal(ausentes.code, 1);
  assert.match(ausentes.err, /BRD ausente: brd\.md/);
  assert.match(ausentes.err, /fluxo do usuário ausente: fluxo-usuario\.md/);
  fs.writeFileSync(path.join(e.dir, 'brd.md'), '# BRD\nStatus: draft\n\nrascunho\n');
  fs.writeFileSync(path.join(e.dir, 'fluxo-usuario.md'), '# Fluxo\nStatus: ready\n\nfalar com maria.silva@empresa.com.br\n');
  const mistos = run(['homologar', e.dir]);
  assert.match(mistos.err, /BRD em rascunho \(falta `Status: ready`\): brd\.md/);
  assert.match(mistos.err, /fluxo do usuário com dados pessoais \(e-mail \(ma\*\*\*br, linha 4\)\): fluxo-usuario\.md/);
  assert.doesNotMatch(mistos.err, /maria\.silva/, 'o valor bruto nunca aparece');
  assert.equal(e.read().homologacao.estado, 'pendente');
  e.cleanup();
});

test('init cria rascunhos de BRD e fluxo do usuário (Status: draft) e nunca sobrescreve os existentes', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'init-docs-'));
  const dir = path.join(base, 'entrega');
  assert.equal(run(['init', dir]).code, 0);
  const brd = fs.readFileSync(path.join(dir, 'brd.md'), 'utf8');
  assert.match(brd, /^# BRD — entrega\nStatus: draft/);
  for (const secao of ['Objetivo e valor', 'Regras de negócio', 'Cenários de aceite (BDD)', 'Dado']) assert.ok(brd.includes(secao), secao);
  assert.match(fs.readFileSync(path.join(dir, 'fluxo-usuario.md'), 'utf8'), /```mermaid/);
  fs.writeFileSync(path.join(dir, 'brd.md'), '# meu BRD\nStatus: ready\n');
  assert.equal(run(['init', dir, '--force']).code, 0);
  assert.match(fs.readFileSync(path.join(dir, 'brd.md'), 'utf8'), /meu BRD/);
  fs.rmSync(base, { recursive: true, force: true });
});
