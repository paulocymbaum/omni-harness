// Status que o harness usa e o workflow do projeto Jira (team-managed) precisa ter. Idempotente:
// só cria o que falta e só anexa ao workflow o que ainda não está nele. A atualização do workflow
// exige declarar TODOS os status dele e as transições (as de scripts/tracker/workflow.mjs que chegam ao novo status).
import { TRANSITIONS } from './workflow.mjs';

export const REQUIRED_STATUSES = [
  { name: 'Blocked', statusCategory: 'IN_PROGRESS', description: 'Tarefa bloqueada por dependência externa; o motivo fica no card.' },
  { name: 'Homologation', statusCategory: 'IN_PROGRESS', description: 'Feature desenvolvida e pronta para testar no ambiente Docker local; aguarda aprovação.' },
  { name: 'Production', statusCategory: 'IN_PROGRESS', description: 'Homologação aprovada; implantada no ambiente de produção, aguarda confirmação do deploy.' },
  { name: 'Cancelled', statusCategory: 'DONE', description: 'Tarefa cancelada; não será entregue.' },
];

const nextTransitionId = (transitions) => String(Math.max(0, ...transitions.map((t) => Number(t.id) || 0)) + 10);

/**
 * Corpo de `POST /workflows/update` que anexa `wanted` (status já existentes no projeto, com id)
 * ao workflow, com uma transição global por status. Devolve null se nada falta.
 */
export function planWorkflowUpdate(workflow, projectStatuses, wanted) {
  const inWorkflow = new Set(workflow.statuses.map((s) => s.statusReference));
  const missing = wanted.filter((w) => !inWorkflow.has(w.id));
  if (!missing.length) return null;
  const byId = new Map(projectStatuses.map((s) => [s.id, s]));
  const all = [...workflow.statuses.map((s) => byId.get(s.statusReference)).filter(Boolean), ...missing];
  const transitions = [...workflow.transitions];
  const ref = new Map(all.map((s) => [s.name, s.id]));
  for (const w of missing) {
    for (const t of TRANSITIONS.filter((x) => x.to === w.name && (x.from === '*' || ref.has(x.from)))) {
      transitions.push(t.from === '*'
        ? { id: nextTransitionId(transitions), name: t.name, type: 'GLOBAL', toStatusReference: w.id, links: [] }
        : { id: nextTransitionId(transitions), name: t.name, type: 'DIRECTED', fromStatusReference: ref.get(t.from), toStatusReference: w.id, links: [] });
    }
  }
  return {
    statuses: all.map((s) => ({ id: s.id, statusReference: s.id, name: s.name, statusCategory: s.statusCategory, description: s.description ?? '' })),
    workflows: [{
      id: workflow.id, name: workflow.name, description: workflow.description ?? '', startPointLayout: workflow.startPointLayout, version: workflow.version,
      statuses: [...workflow.statuses, ...missing.map((w) => ({ statusReference: w.id, layout: {}, properties: {}, deprecated: false }))],
      transitions,
    }],
  };
}

/** Garante os status no projeto e no workflow. Devolve { criados, anexados }. */
export async function ensureStatuses(jira, projectKey, required = REQUIRED_STATUSES) {
  const project = await jira.getProject(projectKey);
  const found = await jira.raw('GET', `/rest/api/3/statuses/search?projectId=${project.id}&maxResults=200`);
  const projectStatuses = found.values ?? [];
  const toCreate = required.filter((r) => !projectStatuses.some((s) => s.name === r.name));
  if (toCreate.length) {
    const created = await jira.raw('POST', '/rest/api/3/statuses', { scope: { type: 'PROJECT', project: { id: project.id } }, statuses: toCreate });
    projectStatuses.push(...created);
  }
  const { values } = await jira.raw('GET', '/rest/api/3/workflows/search?maxResults=50&scope=PROJECT');
  const summary = values.find((w) => w.scope?.project?.id === project.id);
  if (!summary) throw new Error(`workflow do projeto ${projectKey} não encontrado`);
  const { workflows } = await jira.raw('POST', '/rest/api/3/workflows', { workflowIds: [summary.id] });
  const wanted = required.map((r) => projectStatuses.find((s) => s.name === r.name));
  const body = planWorkflowUpdate(workflows[0], projectStatuses, wanted);
  if (body) await jira.raw('POST', '/rest/api/3/workflows/update', body);
  return { criados: toCreate.map((s) => s.name), anexados: body ? wanted.filter((w) => !workflows[0].statuses.some((s) => s.statusReference === w.id)).map((w) => w.name) : [] };
}
