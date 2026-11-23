// Anexar status ao workflow do Jira: só o que falta, com as transições do workflow canônico, sem tocar no resto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWorkflowUpdate, REQUIRED_STATUSES } from '../../scripts/tracker/workflow-statuses.mjs';

const workflow = () => ({
  id: 'wf-1', name: 'Software workflow', version: { versionNumber: 3, id: 'v' }, startPointLayout: {},
  statuses: ['1', '2', '3'].map((id) => ({ statusReference: id, layout: {}, properties: {}, deprecated: false })),
  transitions: [{ id: '11', name: 'To Do', type: 'GLOBAL', toStatusReference: '1', links: [] }, { id: '41', name: 'Blocked', type: 'GLOBAL', toStatusReference: '4', links: [] }, { id: '1', name: 'Create', type: 'INITIAL', toStatusReference: '1', links: [] }],
});
const statuses = [
  { id: '1', name: 'To Do', statusCategory: 'TODO' }, { id: '2', name: 'In Progress', statusCategory: 'IN_PROGRESS' },
  { id: '3', name: 'Done', statusCategory: 'DONE', description: 'feito' },
  { id: '4', name: 'Blocked', statusCategory: 'IN_PROGRESS' }, { id: '5', name: 'Homologation', statusCategory: 'IN_PROGRESS' },
];

test('anexa só o status que falta, com as transições do workflow canônico, e declara todos os status do workflow', () => {
  const body = planWorkflowUpdate(workflow(), statuses, [statuses[3], statuses[4]]);
  const wf = body.workflows[0];
  assert.deepEqual(wf.statuses.map((s) => s.statusReference), ['1', '2', '3', '4', '5']);
  assert.deepEqual(body.statuses.map((s) => s.name), ['To Do', 'In Progress', 'Done', 'Blocked', 'Homologation']);
  assert.equal(body.statuses.find((s) => s.name === 'Done').description, 'feito', 'preserva a descrição existente');
  const novas = wf.transitions.filter((t) => !workflow().transitions.some((o) => o.id === t.id));
  // Homologation: Aprovado (In Progress→) e Desbloqueado (Blocked→); Blocked: Bloqueado (In Progress→)
  const resumo = novas.map((t) => `${t.name}:${t.type}:${t.fromStatusReference ?? '*'}>${t.toStatusReference}`).sort();
  assert.deepEqual(resumo, ['Aprovado:DIRECTED:2>5', 'Desbloqueado:DIRECTED:4>5', 'Bloqueado:DIRECTED:2>4'].sort());
  assert.ok(novas.every((t) => t.links.length === 0));
  assert.equal(new Set(wf.transitions.map((t) => t.id)).size, wf.transitions.length, 'ids de transição únicos');
  assert.deepEqual(wf.version, { versionNumber: 3, id: 'v' });
});

test('tudo já no workflow: nada a atualizar (idempotente)', () => {
  const w = workflow(); w.statuses.push(...['4', '5'].map((id) => ({ statusReference: id, layout: {}, properties: {}, deprecated: false })));
  assert.equal(planWorkflowUpdate(w, statuses, [statuses[3], statuses[4]]), null);
});

test('o harness exige Blocked, Homologation e Cancelled', () => {
  assert.deepEqual(REQUIRED_STATUSES.map((s) => s.name), ['Blocked', 'Homologation', 'Production', 'Cancelled']);
});

test('workflow canônico = diagrama do Jira: caminhos diretos e por In Progress', async () => {
  const { TRANSITIONS, workflowGraph, viaOf } = await import('../../scripts/tracker/workflow.mjs');
  assert.equal(TRANSITIONS.length, 10);
  const g = workflowGraph();
  assert.deepEqual(g['To Do'], ['In Progress']);
  assert.deepEqual(g['In Progress'], ['Blocked', 'Homologation']);
  assert.deepEqual(g.Blocked, ['Homologation']);
  assert.deepEqual(g.Homologation, ['Production']);
  assert.deepEqual(g.Production, ['Done']);
  assert.deepEqual([...g['*']].sort(), ['Cancelled', 'Done', 'In Progress', 'To Do']);
  assert.deepEqual(viaOf(), { Blocked: ['In Progress'], Homologation: ['In Progress', 'Blocked'], Production: ['Homologation'] });
});

test('nomes de status traduzidos pela conta (pt_PT) valem como os canônicos', async () => {
  const { canonicalStatus } = await import('../../scripts/tracker/workflow.mjs');
  assert.deepEqual(['A fazer', 'Em Progresso', 'Concluído', 'Em andamento', 'Blocked', 'Homologation', 'Cancelled', 'To Do'].map(canonicalStatus),
    ['To Do', 'In Progress', 'Done', 'In Progress', 'Blocked', 'Homologation', 'Cancelled', 'To Do']);
});

test('tipo do card: nível 0 mesmo com nomes traduzidos; nunca Subtask nem Épico', async () => {
  const { pickIssueType } = await import('../../scripts/tracker/sync-context.mjs');
  const pt = [{ id: '1', name: 'Subtask', hierarchyLevel: -1, subtask: true }, { id: '2', name: 'Épico', hierarchyLevel: 1 }, { id: '3', name: 'História', hierarchyLevel: 0 }, { id: '4', name: 'Tarefa', hierarchyLevel: 0 }];
  assert.equal(pickIssueType(pt).id, '3');
  assert.equal(pickIssueType(pt.filter((t) => t.id !== '3')).id, '4');
  assert.equal(pickIssueType([pt[0], pt[1], { id: '9', name: 'Bug', hierarchyLevel: 0 }]).id, '9');
});
