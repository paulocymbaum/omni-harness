// Handoff determinístico: parse, validação e fatos do harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHandoff, validateHandoff, renderFatos, nomeArquivo } from '../../delivery/handoff.mjs';

const VALIDO = `texto livre antes
## HANDOFF
- Fase: C
- Agente: implementador
- Entrega: 2026-10-02-cnpj-alfanumerico-correcoes
- Tarefa: CNPJ-002
- Resultado: done
### Arquivos
- alterado: lib/shared/utils/cnpj_utils.dart
### Gates
| Gate | Resultado | Evidência |
|---|---|---|
| CNPJ-G002-STATIC | pass | CNPJ-002: 2 gate(s) aprovado(s). |
### Não verificado
- nenhum
### Decisões para o usuário
- nenhum
### Próximo passo
- CNPJ-003
`;

test('handoff completo é válido e o texto livre antes do bloco é ignorado', () => {
  const p = parseHandoff(VALIDO);
  assert.deepEqual(validateHandoff(p), []);
  assert.equal(p.campos.Tarefa, 'CNPJ-002');
  assert.ok(!p.bloco.includes('texto livre'));
});

test('resposta sem bloco HANDOFF é rejeitada', () => {
  assert.deepEqual(validateHandoff(parseHandoff('só prosa')), ['bloco "## HANDOFF" ausente na resposta final']);
});

test('campo ausente e resultado inválido são apontados', () => {
  const ruim = VALIDO.replace('- Agente: implementador\n', '').replace('Resultado: done', 'Resultado: talvez');
  const erros = validateHandoff(parseHandoff(ruim));
  assert.ok(erros.includes('campo obrigatório ausente: Agente'));
  assert.ok(erros.some((e) => e.startsWith('Resultado "talvez" inválido')));
});

test('seção vazia é rejeitada, "nenhum" é aceito', () => {
  const ruim = VALIDO.replace('### Não verificado\n- nenhum\n', '### Não verificado\n');
  assert.deepEqual(validateHandoff(parseHandoff(ruim)), [
    'seção obrigatória vazia ou ausente: Não verificado (escreva "nenhum" se não houver)',
  ]);
});

test('gate "pass" sem evidência e resultado de gate inválido são rejeitados', () => {
  const semEvidencia = VALIDO.replace('| pass | CNPJ-002: 2 gate(s) aprovado(s). |', '| pass |  |');
  assert.deepEqual(validateHandoff(parseHandoff(semEvidencia)), ['gate CNPJ-G002-STATIC: "pass" exige evidência (saída do eval.mjs)']);
  const invalido = VALIDO.replace('| pass |', '| ok |');
  assert.deepEqual(validateHandoff(parseHandoff(invalido)), ['gate CNPJ-G002-STATIC: resultado "ok" inválido']);
});

test('nome do arquivo é derivado de fase, tarefa e agente sem caracteres inseguros', () => {
  assert.equal(nomeArquivo(parseHandoff(VALIDO)), 'C-CNPJ-002-implementador.md');
});

test('fatos vêm do backlog.json real, não do texto do agente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-fatos-'));
  const done = (id) => ({ id, title: `Tarefa ${id}`, status: 'done', depends_on: [], ...(id === 'CNPJ-002' ? { jira_key: 'OFLUXO-5' } : {}) });
  const backlog = {
    id: 'cnpj-alfanumerico', title: 'CNPJ alfanumérico', created: '2026-10-02',
    tasks: ['CNPJ-001', 'CNPJ-002', 'CNPJ-003', 'CNPJ-004', 'CNPJ-005', 'CNPJ-006', 'CNPJ-007'].map(done),
    gates: [
      { id: 'CNPJ-G002-STATIC', task: 'CNPJ-002', type: 'command', command: ['node', '--version'] },
      { id: 'CNPJ-G002-FLUTTER', task: 'CNPJ-002', type: 'command', command: ['node', '--version'] },
    ],
  };
  fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));
  const fatos = renderFatos(dir, '.', 'CNPJ-002');
  assert.match(fatos, /### Fatos do harness/);
  assert.match(fatos, /- CNPJ-002: done · OFLUXO-5 · gates: CNPJ-G002-STATIC\(command\), CNPJ-G002-FLUTTER\(command\)/);
  assert.match(fatos, /Backlog: 7 done/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── hook SubagentStop ────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function rodarHook(input, linhas) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-hook-'));
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, linhas.map((l) => JSON.stringify(l)).join('\n'));
  const r = spawnSync('node', ['.claude/hooks/handoff-subagente.mjs'], {
    input: JSON.stringify({ cwd: process.cwd(), agent_transcript_path: transcript, ...input }),
    encoding: 'utf8',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return r.stdout ? JSON.parse(r.stdout) : null;
}

const handback = (message) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message } }] } });
const VALIDO_SEM_ENTREGA = VALIDO.replace('2026-10-02-cnpj-alfanumerico-correcoes', '-');

test('hook lê o relatório de SubagentHandback e imprime handoff + fatos via systemMessage', () => {
  const out = rodarHook({ agent_type: 'implementador' }, [handback(VALIDO_SEM_ENTREGA)]);
  assert.match(out.systemMessage, /^## HANDOFF/);
  assert.match(out.systemMessage, /### Fatos do harness/);
  assert.equal(out.decision, undefined);
});

test('hook bloqueia relatório sem bloco HANDOFF e devolve o template', () => {
  const out = rodarHook({ agent_type: 'implementador' }, [handback('tudo certo')]);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /bloco "## HANDOFF" ausente/);
  assert.match(out.reason, /Template:\n## HANDOFF/);
});

test('hook não bloqueia de novo quando stop_hook_active, só avisa', () => {
  const out = rodarHook({ agent_type: 'implementador', stop_hook_active: true }, [handback('tudo certo')]);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /Handoff inválido/);
});

test('hook ignora agentes fora do ciclo', () => {
  assert.equal(rodarHook({ agent_type: 'Explore' }, [handback('qualquer coisa')]), null);
});
