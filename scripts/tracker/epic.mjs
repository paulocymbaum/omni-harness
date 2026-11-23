// Épico da feature: um por backlog, com a descrição para pessoas (visão geral, BRD, fluxo do
// usuário, como testar, tarefas e referência técnica) e todos os cards da feature como filhos
// dele desde a criação. A chave do épico fica em jira-keys/_epic.txt.
// Regras de nome, status e descrição: docs/jira/regras-de-epicos-e-cards.md.
import { readJiraKey, writeJiraKey } from '../../quality/delivery/lib.mjs';
import { featureDocs } from '../../quality/delivery/feature-docs.mjs';
import { safeEpicDescription } from './epic-description.mjs';
import { syncAttachments } from './attachments.mjs';
import { epicSummary, PENDING_LABELS } from './naming.mjs';
import { epicStatusFor, moveToStatus } from './status.mjs';
import { rankToTop } from './rank.mjs';

export const EPIC_ID = '_epic';
export { epicDescription } from './epic-description.mjs';

/** Labels de pendência dos documentos: { add, remove } conforme BRD e fluxo estejam prontos. */
export function pendingLabelsFor(docs) {
  const pairs = [['brd', docs.brd], ['fluxo', docs.fluxo]];
  return {
    add: pairs.filter(([, d]) => d.state !== 'ready').map(([k]) => PENDING_LABELS[k]),
    remove: pairs.filter(([, d]) => d.state === 'ready').map(([k]) => PENDING_LABELS[k]),
  };
}

async function findEpic(jira, projectKey, labels) {
  const feature = labels.find((l) => l.startsWith('feature-'));
  if (!feature) return null;
  const [hit] = await jira.searchIssues(`project = ${projectKey} AND issuetype = Epic AND labels = "${feature}" ORDER BY created ASC`);
  return hit?.key ?? null;
}

const stillExists = async (jira, key) => { try { await jira.getIssue(key, 'summary'); return true; } catch { return false; } };

async function createEpic(jira, projectKey, { backlog, labels, doc }) {
  const proj = await jira.getProject(projectKey);
  const type = (proj.issueTypes ?? []).find((t) => t.hierarchyLevel === 1 || t.name === 'Epic');
  if (!type) throw new Error('o projeto Jira não tem o tipo de issue Epic');
  const issue = await jira.createIssue({
    project: { key: projectKey }, issuetype: { id: type.id },
    summary: epicSummary(backlog), description: doc, ...(labels.length ? { labels } : {}),
  });
  return issue.key;
}

/** Soma as labels que faltam e tira as de pendência que já foram resolvidas. */
async function syncLabels(jira, key, wanted, remove) {
  const have = new Set((await jira.getIssue(key, 'labels'))?.fields?.labels ?? []);
  const missing = wanted.filter((l) => !have.has(l));
  const stale = remove.filter((l) => have.has(l));
  if (missing.length) await jira.updateLabels(key, missing);
  if (stale.length) await jira.removeLabels(key, stale);
}

/** Cria ou atualiza o épico (título, descrição, labels, anexos, status) e devolve a chave. */
export async function syncEpic(jira, ctx) {
  const { projectKey, dir, backlog, labels, toAdf } = ctx;
  const docs = featureDocs(dir);
  const pending = pendingLabelsFor(docs);
  const wanted = [...labels, ...pending.add];
  const doc = toAdf(safeEpicDescription(backlog, dir, docs));
  const remembered = readJiraKey(dir, { id: EPIC_ID });
  let key = remembered && (await stillExists(jira, remembered)) ? remembered : await findEpic(jira, projectKey, labels);
  const created = !key;
  if (key) {
    await jira.updateFields(key, { summary: epicSummary(backlog), description: doc });
    await syncLabels(jira, key, wanted, pending.remove);
  } else {
    key = await createEpic(jira, projectKey, { backlog, labels: wanted, doc });
  }
  if (key !== remembered) writeJiraKey(dir, EPIC_ID, key);
  await syncAttachments(jira, key, docs.images);
  const moved = await moveToStatus(jira, key, epicStatusFor(backlog));
  // Épico novo ou que mudou de coluna também sobe ao topo: ele é o cabeçalho da feature no board.
  if (created || moved) await rankToTop(jira, projectKey, key);
  return key;
}

/** Garante o épico como pai do card (cards criados antes do épico entram aqui). */
export async function ensureParent(jira, key, epicKey) {
  const issue = await jira.getIssue(key, 'parent');
  if (issue?.fields?.parent?.key !== epicKey) await jira.setParent(key, epicKey);
}
