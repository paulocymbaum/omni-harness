#!/usr/bin/env node
// Handoff determinístico entre fases do ciclo de entrega.
// Biblioteca: parseHandoff, validateHandoff, renderFatos, renderHandoff.
// CLI: node quality/delivery/handoff.mjs validate <arquivo.md>
//      node quality/delivery/handoff.mjs fatos <dir-da-entrega> [ID]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBacklog, readJiraKey, taskById, gatesForTask } from './lib.mjs';

export const FASES = ['P', 'A', 'B', 'C', 'D', 'E', 'F', 'R'];
const RESULTADOS = ['done', 'failed', 'blocked', 'needs-decision'];
const RESULTADOS_GATE = ['pass', 'fail', 'manual-pendente', 'nao-executado'];
const CAMPOS = ['Fase', 'Agente', 'Entrega', 'Tarefa', 'Resultado'];
const SECOES = ['Arquivos', 'Gates', 'Não verificado', 'Decisões para o usuário', 'Próximo passo'];

const CAMPO_RE = /^- ([^:]+): (.+)$/;

/** Extrai o bloco `## HANDOFF` de um texto. Retorna null se não houver. */
function extrairBloco(text) {
  const i = text.search(/^## HANDOFF\s*$/m);
  return i < 0 ? null : text.slice(i).trimEnd();
}

function dividirSecoes(linhas) {
  const campos = {};
  const secoes = {};
  let atual = null;
  for (const line of linhas) {
    const h = line.match(/^### (.+?)\s*$/);
    if (h) atual = h[1];
    if (h) secoes[atual] = [];
    else if (atual) secoes[atual].push(line);
    else Object.assign(campos, camposDe(line));
  }
  return { campos, secoes };
}

function camposDe(line) {
  const m = line.match(CAMPO_RE);
  return m ? { [m[1].trim()]: m[2].trim() } : {};
}

export function parseHandoff(text) {
  const bloco = extrairBloco(text ?? '');
  if (!bloco) return null;
  return { bloco, ...dividirSecoes(bloco.split('\n').slice(1)) };
}

function gatesInvalidos(linhas) {
  const rows = linhas.filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l)).slice(1);
  return rows.flatMap((r) => {
    const cols = r.split('|').slice(1, -1).map((c) => c.trim());
    if (cols.length < 3) return [`linha de gate malformada: ${r}`];
    const erros = [];
    if (!RESULTADOS_GATE.includes(cols[1])) erros.push(`gate ${cols[0]}: resultado "${cols[1]}" inválido`);
    if (cols[1] === 'pass' && !cols[2]) erros.push(`gate ${cols[0]}: "pass" exige evidência (saída do eval.mjs)`);
    return erros;
  });
}

function camposInvalidos({ campos }) {
  const erros = CAMPOS.filter((c) => !campos[c]).map((c) => `campo obrigatório ausente: ${c}`);
  if (campos.Fase && !FASES.includes(campos.Fase)) erros.push(`Fase "${campos.Fase}" inválida (${FASES.join('|')})`);
  if (campos.Resultado && !RESULTADOS.includes(campos.Resultado)) erros.push(`Resultado "${campos.Resultado}" inválido (${RESULTADOS.join('|')})`);
  return erros;
}

function secoesVazias({ secoes }) {
  return SECOES.filter((s) => !(secoes[s] ?? []).join('').trim())
    .map((s) => `seção obrigatória vazia ou ausente: ${s} (escreva "nenhum" se não houver)`);
}

export function validateHandoff(parsed) {
  if (!parsed) return ['bloco "## HANDOFF" ausente na resposta final'];
  return [...camposInvalidos(parsed), ...secoesVazias(parsed), ...gatesInvalidos(parsed.secoes.Gates ?? [])];
}

function gitArquivos(root) {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8' });
    return out.split('\n').filter(Boolean).map((l) => `- ${l.slice(0, 2).trim() || '?'} ${l.slice(3)}`);
  } catch {
    return ['- (git indisponível)'];
  }
}

function renderBacklog(backlog, taskId, dir = null) {
  const todas = !taskId || taskId === 'todas';
  const tarefas = todas ? backlog.tasks : [taskById(backlog, taskId)].filter(Boolean);
  const cont = {};
  for (const t of backlog.tasks) cont[t.status] = (cont[t.status] ?? 0) + 1;
  const resumo = Object.entries(cont).map(([k, v]) => `${v} ${k}`).join(' · ');
  const linhas = tarefas.map((t) => {
    const gates = gatesForTask(backlog, t.id).map((g) => `${g.id}(${g.type})`).join(', ') || 'sem gates';
    const key = dir ? readJiraKey(dir, t) : t.jira_key;
    return `- ${t.id}: ${t.status}${key ? ` · ${key}` : ''} · gates: ${gates}`;
  });
  return [`- Backlog: ${resumo}`, ...linhas];
}

/** Fatos lidos do harness (backlog.json e git), não do texto do agente. */
export function renderFatos(root, dir, taskId = null) {
  const out = ['### Fatos do harness'];
  try {
    out.push(...renderBacklog(readBacklog(path.resolve(root, dir)), taskId, path.resolve(root, dir)));
  } catch (err) {
    out.push(`- backlog indisponível: ${err.message}`);
  }
  const arqs = gitArquivos(root);
  out.push(`- Working tree (git): ${arqs.length} arquivo(s)`, ...arqs.slice(0, 15));
  if (arqs.length > 15) out.push(`- … e mais ${arqs.length - 15}`);
  return out.join('\n');
}

export function renderHandoff(parsed, fatos) {
  return `${parsed.bloco}\n\n${fatos}\n`;
}

export function nomeArquivo(parsed) {
  const { Fase, Tarefa, Agente } = parsed.campos;
  const seguro = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, '-');
  return `${seguro(Fase)}-${seguro(Tarefa)}-${seguro(Agente)}.md`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , cmd, arg, extra] = process.argv;
  if (cmd === 'validate' && arg) {
    const erros = validateHandoff(parseHandoff(fs.readFileSync(arg, 'utf8')));
    if (erros.length) { console.error(erros.map((e) => `- ${e}`).join('\n')); process.exit(1); }
    console.log('handoff válido');
  } else if (cmd === 'fatos' && arg) {
    console.log(renderFatos(process.cwd(), arg, extra));
  } else {
    console.error('Uso: handoff.mjs validate <arquivo.md> | fatos <dir> [ID]');
    process.exit(1);
  }
}
