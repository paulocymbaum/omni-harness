#!/usr/bin/env node
// SubagentStop: exige o bloco "## HANDOFF" na resposta final dos agentes do ciclo de entrega,
// grava em docs/entregas/<slug>/handoffs/ e imprime no CLI com os fatos do harness (systemMessage).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nomeArquivo, parseHandoff, renderFatos, renderHandoff, validateHandoff } from '../../quality/delivery/handoff.mjs';

const AGENTES = [
  'planejador', 'investigador-de-spec', 'eval-gate-author', 'implementador',
  'eval-gate-fixer', 'avaliador-de-entrega', 'documentador', 'revisor-de-dominio',
];

const TEMPLATE = [
  '## HANDOFF',
  '- Fase: P|A|B|C|D|E|F|R',
  '- Agente: <nome do agente>',
  '- Entrega: <slug em docs/entregas/ ou ->',
  '- Tarefa: <ID ou todas>',
  '- Resultado: done|failed|blocked|needs-decision',
  '### Arquivos', '### Gates (tabela | Gate | Resultado pass|fail|manual-pendente|nao-executado | Evidência |)',
  '### Não verificado', '### Decisões para o usuário', '### Próximo passo',
].join('\n');

// O relatório final do subagente chega pela ferramenta SubagentHandback({message}); texto solto é o plano B.
function blocosDe(m) {
  const c = m.message?.content ?? m.content;
  return Array.isArray(c) ? c : [{ type: 'text', text: c }];
}

function lerMensagens(arquivo) {
  if (!arquivo || !existsSync(arquivo)) return [];
  const msgs = [];
  for (const l of readFileSync(arquivo, 'utf8').split('\n').filter(Boolean)) {
    try { msgs.push(JSON.parse(l)); } catch { /* linha inválida */ }
  }
  return msgs;
}

function textoFinal(input) {
  if (typeof input.last_assistant_message === 'string') return input.last_assistant_message;
  const msgs = lerMensagens(input.agent_transcript_path || input.transcript_path);
  const blocos = msgs.filter((m) => m.type === 'assistant').flatMap(blocosDe).reverse();
  const handback = blocos.find((b) => b.type === 'tool_use' && b.name === 'SubagentHandback' && typeof b.input?.message === 'string');
  return handback?.input.message ?? blocos.find((b) => b.type === 'text' && b.text)?.text ?? '';
}

function gravar(root, parsed, conteudo) {
  const slug = parsed.campos.Entrega;
  const dir = path.join(root, 'docs', 'entregas', slug);
  if (!/^[\w.-]+$/.test(slug) || !existsSync(dir)) return null;
  const alvo = path.join(dir, 'handoffs');
  mkdirSync(alvo, { recursive: true });
  writeFileSync(path.join(alvo, nomeArquivo(parsed)), conteudo);
  return path.join('docs', 'entregas', slug, 'handoffs', nomeArquivo(parsed));
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const dbg = path.join(root, '.claude', '.state', 'handoff-debug.jsonl');
  if (process.env.HANDOFF_DEBUG || existsSync(path.join(root, '.claude', '.state', 'handoff-debug.flag'))) {
    mkdirSync(path.dirname(dbg), { recursive: true });
    appendFileSync(dbg, `${JSON.stringify({ keys: Object.keys(input), agent_type: input.agent_type, event: input.hook_event_name })}\n`);
  }
  const agente = input.agent_type;
  if (agente && !AGENTES.includes(agente)) return null;

  const parsed = parseHandoff(textoFinal(input));
  const erros = validateHandoff(parsed);
  if (erros.length) {
    if (input.stop_hook_active) return { systemMessage: `Handoff inválido (${agente ?? 'subagente'}):\n${erros.map((e) => `- ${e}`).join('\n')}` };
    return { decision: 'block', reason: `Handoff inválido. Corrija e reenvie a resposta final com o bloco abaixo:\n${erros.map((e) => `- ${e}`).join('\n')}\n\nTemplate:\n${TEMPLATE}` };
  }
  const texto = renderHandoff(parsed, renderFatos(root, path.join('docs', 'entregas', parsed.campos.Entrega), parsed.campos.Tarefa));
  const arquivo = gravar(root, parsed, texto);
  return { systemMessage: `${texto}${arquivo ? `\nSalvo em: ${arquivo}` : ''}` };
}

let out = null;
try { out = main(); } catch (err) { process.stderr.write(`.claude/hooks/handoff-subagente: ${err.stack ?? err}\n`); }
if (out) process.stdout.write(JSON.stringify(out));
process.exit(0);
