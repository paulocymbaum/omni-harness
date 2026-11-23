// Workflow canônico do projeto OFLUXO (v4). Fonte única: o sync (caminho entre status), o
// ensure-statuses (transições de um projeto novo), o Jira falso dos testes e a doc usam isto.
// Nomes das transições são os do Jira; `from: '*'` é transição global (qualquer status → `to`).
export const TRANSITIONS = [
  { name: 'Iniciado', from: 'To Do', to: 'In Progress' },
  { name: 'Bloqueado', from: 'In Progress', to: 'Blocked' },
  { name: 'Aprovado', from: 'In Progress', to: 'Homologation' },
  { name: 'Desbloqueado', from: 'Blocked', to: 'Homologation' },
  { name: 'Em Produção', from: 'Homologation', to: 'Production' },
  { name: 'Implantado', from: 'Production', to: 'Done' },
  { name: 'To Do', from: '*', to: 'To Do' },
  { name: 'Regredido', from: '*', to: 'In Progress' },
  { name: 'Done', from: '*', to: 'Done' },
  { name: 'Cancelled', from: '*', to: 'Cancelled' },
];

export const STATUSES = ['To Do', 'In Progress', 'Blocked', 'Homologation', 'Production', 'Done', 'Cancelled'];

/** Grafo { origem: [destinos] } com a chave '*' para as globais. */
export function workflowGraph(transitions = TRANSITIONS) {
  const graph = Object.fromEntries(STATUSES.map((s) => [s, []]));
  graph['*'] = [];
  for (const t of transitions) graph[t.from].push(t.to);
  return graph;
}

/** Status que só se alcançam por passos intermediários: { destino: [status de onde sai uma transição direta] }. */
export function viaOf(transitions = TRANSITIONS) {
  const via = {};
  for (const s of STATUSES) {
    if (transitions.some((t) => t.to === s && t.from === '*')) continue;
    via[s] = [...new Set(transitions.filter((t) => t.to === s && t.from !== '*').map((t) => t.from))];
  }
  return via;
}

/**
 * O Jira traduz os status de sistema conforme o idioma da CONTA (pt_PT: "A fazer", "Em Progresso",
 * "Concluído"); os criados pelo harness (Blocked, Homologation, Cancelled) ficam como foram criados.
 * Compare sempre por `canonicalStatus`, nunca pelo texto cru.
 */
const ALIASES = {
  'a fazer': 'To Do', 'por fazer': 'To Do', 'pendiente': 'To Do', 'tareas por hacer': 'To Do',
  'em progresso': 'In Progress', 'em andamento': 'In Progress', 'en curso': 'In Progress', 'en progreso': 'In Progress',
  'concluído': 'Done', 'concluido': 'Done', 'finalizado': 'Done', 'listo': 'Done', 'hecho': 'Done',
};
export const canonicalStatus = (name) => (name == null ? name : ALIASES[String(name).trim().toLowerCase()] ?? name);
