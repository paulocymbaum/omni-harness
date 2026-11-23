// Status do Jira para o backlog: mapa tarefa → status, regra do Homologation/Production e do épico,
// e a transição que FALHA quando o Jira não alcança o status (antes ela era ignorada e o card parava).
import { situacao } from '../../quality/delivery/lib.mjs';
import { viaOf, canonicalStatus } from './workflow.mjs';

export const HOMOLOGATION = 'Homologation';
export const PRODUCTION = 'Production';

export const STATUS_MAP = {
  pending: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

/**
 * Status do card da tarefa. `done` = desenvolvida e com os gates aprovados. Ciclo da homologação:
 * em homologação → Homologation; aprovada → Production (aguardando deploy); reprovada → In Progress
 * (correção); implantada (deploy feito) → Done.
 */
export function jiraStatusFor(task, backlog) {
  if (task.status === 'done' && backlog?.homologacao?.estado) {
    const estado = backlog.homologacao.estado;
    if (estado === 'em_homologacao') return HOMOLOGATION;
    if (estado === 'aprovada') return PRODUCTION;
    if (estado === 'reprovada') return 'In Progress';
    if (estado === 'implantada') return 'Done';
  }
  return STATUS_MAP[task.status] ?? 'To Do';
}

const EPIC_POR_ESTADO = {
  em_homologacao: HOMOLOGATION,
  aprovada: PRODUCTION,
  implantada: 'Done',
  reprovada: 'In Progress',
};

/**
 * Status do épico da feature: acompanha a entrega inteira.
 * Concluída com homologação definida e ainda não iniciada NÃO é Done (falta homologar).
 * Done só chega com o deploy (estado implantada).
 */
export function epicStatusFor(backlog) {
  const tasks = backlog.tasks ?? [];
  if (!tasks.length) return 'To Do'; // feature ainda sem tarefas não está concluída
  if (tasks.every((t) => t.status === 'cancelled')) return 'Cancelled';
  const peloEstado = EPIC_POR_ESTADO[backlog.homologacao?.estado];
  if (peloEstado) return peloEstado;
  const sit = situacao(backlog);
  if (sit.estado === 'concluida') return backlog.homologacao ? 'In Progress' : 'Done';
  if (sit.estado === 'travada') return 'Blocked';
  const started = tasks.some((t) => t.status === 'done' || t.status === 'in_progress');
  return started ? 'In Progress' : 'To Do';
}

/**
 * Passos intermediários para chegar a um status quando o workflow é DIRECIONADO (o do OFLUXO v4:
 * Blocked e Homologation só se alcançam a partir de In Progress; a volta é a transição global
 * `Regredido`). Status globais (To Do, In Progress, Done, Cancelled) não precisam de passo extra.
 */
export const VIA = viaOf(); // derivado de scripts/tracker/workflow.mjs: { Blocked: [In Progress], Homologation: [In Progress, Blocked] }
const MAX_HOPS = 3;
const target = (t) => canonicalStatus(t.to?.name ?? t.name); // o NOME da transição é livre (Iniciado, Aprovado…); vale o status de destino

/**
 * Leva o card ao status, andando até MAX_HOPS passos pelo workflow. Devolve `true` quando houve
 * transição (o card mudou de coluna) e `false` quando já estava no destino. Se não há caminho, FALHA
 * com os status alcançáveis: sem isso o `mark` imprimia "→ Blocked" com o card parado em "To Do".
 */
export async function moveToStatus(jira, key, jiraStatus) {
  const visited = new Set();
  let origin = null;
  try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const { transitions } = await jira.getTransitions(key);
      const direct = transitions.find((t) => target(t) === jiraStatus);
      if (direct) { await jira.doTransition(key, direct.id); await claimCard(jira, key); return true; }
      const current = canonicalStatus((await jira.getIssue(key, 'status'))?.fields?.status?.name);
      if (current === jiraStatus) return false;
      origin ??= current;
      visited.add(current);
      const step = transitions.find((t) => (VIA[jiraStatus] ?? []).includes(target(t)) && !visited.has(target(t)));
      if (!step) throw noPath(key, current, jiraStatus, transitions);
      await jira.doTransition(key, step.id);
    }
    throw new Error(`o card ${key} não chegou a "${jiraStatus}" em ${MAX_HOPS} passos`);
  } catch (err) {
    await returnTo(jira, key, origin); // não deixa o card parado num passo intermediário enganoso
    throw err;
  }
}

/**
 * Quem move o card passa a ser o responsável, se o token é pessoal (.env.local). Com o token
 * compartilhado do .env o responsável não muda. FLUXO_JIRA_ASSIGN=1|0 força. Falha aqui só avisa:
 * o status já mudou e é o que importa.
 */
export function shouldClaim(env = process.env) {
  if (env.FLUXO_JIRA_ASSIGN === '0') return false;
  return env.FLUXO_JIRA_ASSIGN === '1' || env.FLUXO_JIRA_CRED_SOURCE === '.env.local';
}

const mine = new WeakMap(); // accountId por cliente
export async function claimCard(jira, key, env = process.env) {
  if (!shouldClaim(env)) return;
  try {
    if (!mine.has(jira)) mine.set(jira, (await jira.getMyself()).accountId);
    await jira.assignIssue(key, mine.get(jira));
  } catch (err) {
    console.warn(`  Aviso: ${key} mudou de status, mas o responsável não foi atualizado (${err.message.split('\n')[0]}).`);
  }
}

function noPath(key, current, wanted, transitions) {
  const reachable = transitions.map(target).join(', ') || 'nenhum';
  return new Error(`o card ${key} está em "${current ?? '?'}" e o Jira não tem caminho até "${wanted}" (alcança: ${reachable}). Crie o status/transição no workflow: node scripts/tracker/ensure-statuses.mjs`);
}

/** Melhor esforço: volta ao status de origem se o workflow permitir; erros aqui nunca escondem o erro original. */
async function returnTo(jira, key, origin) {
  if (!origin) return;
  try {
    const { transitions } = await jira.getTransitions(key);
    const back = transitions.find((t) => target(t) === origin);
    if (back) await jira.doTransition(key, back.id);
  } catch { /* o erro original é o que importa */ }
}
