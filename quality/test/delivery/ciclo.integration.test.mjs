// Ciclo de entrega ponta a ponta pela CLI real (EG-CICLO/EG-PILOTO, versão automatizada):
// init (com rascunhos) → BRD e fluxo prontos → tarefas e gates → in_progress → blocked (next sai 3) →
// desbloqueio → done → última tarefa manda a feature para homologação (Docker validado) → aprovar.
// Backlog temporário fora do repositório: nenhum card é criado no Jira.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BACKLOG_MJS = path.resolve(import.meta.dirname, '..', '..', 'delivery', 'backlog.mjs');

function cli(bin, args) {
  const r = spawnSync(process.execPath, [BACKLOG_MJS, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: bin, JIRA_BASE_URL: 'http://127.0.0.1:1', JIRA_EMAIL: 'teste@example.com', JIRA_API_TOKEN: 'falso', JIRA_PROJECT_KEY: 'TST' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('ciclo completo: do init à homologação aprovada, com bloqueio no meio', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ciclo-')));
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const dir = path.join(base, 'entrega');
  const compose = path.join(base, 'compose.yml');
  const up = path.join(base, 'up.sh');
  fs.writeFileSync(compose, 'services: {}\n');
  fs.writeFileSync(up, '#!/bin/sh\n');
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'backlog.json'), 'utf8'));
  const edit = (fn) => { const b = read(); fn(b); fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(b)); };
  try {
    // 1. init cria o backlog com o bloco de homologação e os rascunhos de BRD e fluxo
    const init = cli(bin, ['init', dir, '--feature', 'piloto', '--compose', compose, '--up', `sh ${up}`, '--url', 'http://127.0.0.1:18080', '--roteiro', 'Abrir a tela', '--roteiro', 'Gerar o post']);
    assert.equal(init.code, 0, init.err);
    assert.match(init.out, /Rascunhos para preencher/);
    assert.equal(read().homologacao.estado, 'pendente');

    // 2. tarefas e gates (a Fase A/B do ciclo)
    edit((b) => {
      b.tasks = [{ id: 'P-001', title: 'Base', status: 'pending', depends_on: [] }, { id: 'P-002', title: 'Tela', status: 'pending', depends_on: ['P-001'] }, { id: 'P-003', title: 'Deploy', status: 'pending', depends_on: ['P-002'] }];
      b.gates = b.tasks.map((t) => ({ id: `EG-${t.id}`, type: 'command', task: t.id, command: ['node', '--version'] }));
    });
    assert.equal(cli(bin, ['validate', dir]).code, 0);
    assert.match(cli(bin, ['next', dir]).out, /Próxima: P-001/);

    // 3. P-001: in_progress congela os gates, done passa; ainda não é a última
    assert.equal(cli(bin, ['mark', dir, 'P-001', '--status', 'in_progress']).code, 0);
    assert.ok(read().tasks[0].gates_sha);
    assert.equal(cli(bin, ['mark', dir, 'P-001', '--status', 'done']).code, 0);

    // 4. P-002 bloqueia: motivo obrigatório; só restam P-002 (blocked) e P-003 (presa): next sai 3
    assert.equal(cli(bin, ['mark', dir, 'P-002', '--status', 'blocked']).code, 1, 'sem --motivo não bloqueia');
    assert.equal(cli(bin, ['mark', dir, 'P-002', '--status', 'blocked', '--motivo', 'aguarda decisão do usuário']).code, 0);
    const travada = cli(bin, ['next', dir]);
    assert.equal(travada.code, 3);
    assert.match(travada.out, /P-002[\s\S]*motivo: aguarda decisão do usuário[\s\S]*P-003 espera P-002[\s\S]*TRAVADA/);
    assert.equal(fs.existsSync(path.join(dir, 'homologacao.md')), false, 'travada não homologa');

    // 5. desbloqueio: motivo some; conclui P-002 e P-003; a última dispara a homologação (BRD/fluxo ainda draft)
    assert.equal(cli(bin, ['mark', dir, 'P-002', '--status', 'in_progress']).code, 0);
    assert.equal('motivo' in read().tasks[1], false);
    assert.equal(cli(bin, ['mark', dir, 'P-002', '--status', 'done']).code, 0);
    assert.equal(cli(bin, ['mark', dir, 'P-003', '--status', 'in_progress']).code, 0);
    const semDocs = cli(bin, ['mark', dir, 'P-003', '--status', 'done']);
    assert.equal(semDocs.code, 1, 'BRD e fluxo em rascunho: homologação não inicia');
    assert.match(semDocs.err, /BRD em rascunho[\s\S]*fluxo do usuário em rascunho/);
    assert.equal(read().tasks[2].status, 'done', 'o done já está gravado');
    assert.equal(read().homologacao.estado, 'pendente');

    // 6. BRD e fluxo prontos: homologar inicia, gera o roteiro e muda o estado
    fs.writeFileSync(path.join(dir, 'brd.md'), '# BRD\nStatus: ready\n\n## Regras\n- RN-01 regra\n');
    fs.writeFileSync(path.join(dir, 'fluxo-usuario.md'), '# Fluxo\nStatus: ready\n\n1. passo\n');
    const hom = cli(bin, ['homologar', dir]);
    assert.equal(hom.code, 0, hom.err);
    assert.equal(read().homologacao.estado, 'em_homologacao');
    assert.match(fs.readFileSync(path.join(dir, 'homologacao.md'), 'utf8'), /1\. Abrir a tela[\s\S]*P-003 — Deploy/);

    // 7. aprovada: ciclo fechado (cards em Production); deploy leva a Done; next reporta entrega concluída
    assert.equal(cli(bin, ['homologar', dir, '--aprovar']).code, 0);
    assert.equal(read().homologacao.estado, 'aprovada');
    assert.match(cli(bin, ['next', dir]).out, /Entrega concluída|deploy/i);
    assert.equal(cli(bin, ['homologar', dir, '--deploy']).code, 0);
    assert.equal(read().homologacao.estado, 'implantada');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
