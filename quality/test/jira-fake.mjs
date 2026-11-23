// Jira falso em memória (sem rede) para os testes de sync: issues com tipo, status, pai e labels,
// busca configurável ('ok' | 'lag' sem achar | status HTTP de erro) e workflow configurável.
import assert from 'node:assert/strict';
import { workflowGraph } from '../../scripts/tracker/workflow.mjs';

const EPIC_TYPE = '10000';
const STORY_TYPE = '10001';

/** Workflow DIRECIONADO do OFLUXO (v4): o mesmo de produção, em scripts/tracker/workflow.mjs. */
export const DIRECTED_WORKFLOW = workflowGraph();

export function fakeJira({ search = 'ok', workflow = ['To Do', 'In Progress', 'Done', 'Blocked', 'Homologation'], graph = null, localize = {} } = {}) {
  const loc = (n) => localize[n] ?? n; // idioma da conta: o Jira traduz os status de sistema
  const reachable = (from) => (graph ? [...new Set([...(graph[from] ?? []), ...(graph['*'] ?? [])])].filter((n) => n !== from) : workflow.filter((n) => n !== from));
  const issues = new Map();
  const calls = [];
  let seq = 0;
  let attSeq = 0;
  let epicSeq = 900; // épicos numerados à parte: não deslocam as chaves dos cards
  const json = (body, status = 200) => (status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status }));
  const isEpic = (i) => i.fields.issuetype.id === EPIC_TYPE;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://jira.test', 'nenhuma chamada pode sair para um Jira real');
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const p = u.pathname;
    calls.push(`${method} ${p}`);
    if (p.endsWith('/search/jql')) {
      if (typeof search === 'number') return json({ errorMessages: ['falha simulada'] }, search);
      if (search === 'lag') return json({ issues: [] });
      const jql = u.searchParams.get('jql');
      const wantsEpic = jql.includes('issuetype = Epic');
      const hit = (i) => (wantsEpic ? isEpic(i) && i.fields.labels.some((l) => jql.includes(`"${l}"`)) : !isEpic(i) && jql.includes(i.fields.summary.split(' ')[0]));
      return json({ issues: [...issues.values()].filter(hit).map((i) => ({ key: i.key, fields: { summary: i.fields.summary } })) });
    }
    if (method === 'POST' && p.endsWith('/attachments')) {
      const issue = issues.get(p.match(/\/issue\/([\w-]+)\//)[1]);
      const file = init.body.get('file');
      issue.fields.attachment = [...(issue.fields.attachment ?? []), { id: `a${++attSeq}`, filename: file.name, size: file.size }];
      return json([]);
    }
    if (method === 'DELETE' && p.includes('/attachment/')) {
      const id = p.split('/').pop();
      for (const i of issues.values()) i.fields.attachment = (i.fields.attachment ?? []).filter((a) => a.id !== id);
      return json(null, 204);
    }
    if (p.match(/\/project\/\w+$/)) return json({ issueTypes: [{ id: STORY_TYPE, name: 'Story', subtask: false, hierarchyLevel: 0 }, { id: EPIC_TYPE, name: 'Epic', subtask: false, hierarchyLevel: 1 }] });
    if (method === 'POST' && p.endsWith('/issue')) {
      const key = `OFLUXO-${body.fields.issuetype.id === EPIC_TYPE ? ++epicSeq : ++seq}`;
      issues.set(key, { key, fields: { ...body.fields, issuetype: body.fields.issuetype, labels: body.fields.labels ?? [], status: { name: 'To Do' } } });
      return json({ key });
    }
    if (p.endsWith('/myself')) return json({ accountId: 'acc-dev' });
    const asg = p.match(/\/issue\/([\w-]+)\/assignee$/);
    if (asg) { issues.get(asg[1]).fields.assignee = { accountId: body.accountId }; return json(null, 204); }
    const m = p.match(/\/issue\/([\w-]+)(\/transitions)?$/);
    if (m && m[2]) {
      const issue = issues.get(m[1]);
      if (method === 'GET') return json({ transitions: reachable(issue?.fields.status.name).map((n) => ({ id: `t-${n}`, name: n, to: { name: loc(n) } })) });
      issue.fields.status = { name: body.transition.id.slice(2) };
      return json(null, 204);
    }
    if (m) {
      const issue = issues.get(m[1]);
      if (!issue) return json({ errorMessages: ['Issue does not exist'] }, 404);
      if (method === 'GET') return json({ key: issue.key, fields: { ...issue.fields, status: { name: loc(issue.fields.status.name) } } });
      if (body.fields?.description) issue.fields.description = body.fields.description;
      if (body.fields?.summary) issue.fields.summary = body.fields.summary;
      if (body.fields?.parent) issue.fields.parent = body.fields.parent;
      for (const op of body.update?.labels ?? []) {
        if (op.add) issue.fields.labels = [...new Set([...issue.fields.labels, op.add])];
        if (op.remove) issue.fields.labels = issue.fields.labels.filter((l) => l !== op.remove);
      }
      return json(null, 204);
    }
    return json({}, 404);
  };
  const cards = () => [...issues.values()].filter((i) => !isEpic(i));
  return {
    issues, calls, cards, card: () => cards()[0],
    epics: () => [...issues.values()].filter(isEpic),
    creates: () => cards().length,
  };
}
