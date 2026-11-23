// Busca do card existente de uma tarefa (QG-023/QG-025): por jira_key gravado, label da feature ou legado.
// Extraído de sync-context.mjs (tamanho); API estável reexportada por lá.

/** JQLs de busca do card existente, em ordem: label da feature (novo padrão,
 *  summary limpo) e legado (cards antigos com "[backlog.id] id — título"). */
export function existingIssueJqls(projectKey, { task, backlogId, featureSlug }) {
  const jqls = [];
  if (featureSlug) {
    jqls.push(`project = ${projectKey} AND labels = "feature-${featureSlug}" AND summary ~ "${task.id}" ORDER BY created DESC`);
  }
  jqls.push(`project = ${projectKey} AND summary ~ "${backlogId}" AND summary ~ "${task.id}" ORDER BY created DESC`);
  return jqls;
}

/** Procura o card por cada JQL (novo padrão e legado) e devolve a primeira chave. */
async function searchCardByJqls(jira, jqls, { task, backlogId }) {
  for (const jql of jqls) {
    const legacy = jql.includes(`summary ~ "${backlogId}"`);
    for (const issue of await jira.searchIssues(jql)) {
      const s = (issue.fields && issue.fields.summary) || '';
      if (s.includes(task.id) && (!legacy || s.includes(`[${backlogId}]`))) return issue.key;
    }
  }
  return null;
}

/** Card pela chave gravada na tarefa (leitura direta, sem atraso de indexação); 404 = card apagado. */
async function issueByKey(jira, key) {
  if (!key || !/^[A-Z][A-Z0-9]*-\d+$/.test(key)) return null;
  try {
    return (await jira.getIssue(key, 'summary')).key ?? key;
  } catch (err) {
    if (/→ 404:/.test(err.message)) return null;
    throw err;
  }
}

/** Card existente da tarefa: chave gravada primeiro, depois busca por label/summary. Erros propagam. */
export async function findExistingIssue(jira, projectKey, task, backlogId, featureSlug = null) {
  const byKey = await issueByKey(jira, task.jira_key);
  if (byKey) return byKey;
  const jqls = existingIssueJqls(projectKey, { task, backlogId, featureSlug });
  return searchCardByJqls(jira, jqls, { task, backlogId });
}
