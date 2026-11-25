// Cliente minimalista para a API REST do Jira v3 + Agile.
// Lê credenciais de variáveis de ambiente (carregadas pelo chamador).
// Sem dependências externas — usa fetch nativo (Node 18+).
//
// Limite oficial da API v3 para description e comentário: 32.767 caracteres.
// Este cliente monta ADF com quebra de linha real (`hardBreak`) e faz chunk
// de comentários acima do limite, em vez de deixar o Jira truncar/rejeitar.

export const JIRA_MAX_FIELD_CHARS = 32767;
// Margem de segurança para a serialização ADF (metadados dos nós).
const SAFE_FIELD_CHARS = JIRA_MAX_FIELD_CHARS - 600;

/** Converte texto simples em ADF, preservando quebras de linha (hardBreak). */
export function textToDoc(text, { maxChars = SAFE_FIELD_CHARS } = {}) {
  const paragraphs = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    paragraphs.push({
      type: 'paragraph',
      content: current,
    });
    current = [];
  };

  for (const line of String(text ?? '').split('\n')) {
    const trimmedEnd = line.replace(/\s+$/, '');
    if (trimmedEnd.trim() === '') {
      flush();
      continue;
    }
    if (current.length) current.push({ type: 'hardBreak' });
    current.push({ type: 'text', text: trimmedEnd });
  }
  flush();

  return enforceMaxChars({ type: 'doc', version: 1, content: paragraphs }, maxChars);
}

/** Conta os caracteres de texto de um ADF (aproxima o limite da API). */
export function adfTextLength(doc) {
  let total = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string') total += node.text.length;
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return total;
}

/** Monta o patch aditivo de labels para PUT /rest/api/3/issue/{key}.
 *  Aditivo de propósito: nunca remove labels colocadas manualmente. */
export function labelsAddPatch(labels) {
  const list = (labels ?? []).map((l) => String(l ?? '').trim()).filter(Boolean);
  if (!list.length) return null;
  return { update: { labels: list.map((l) => ({ add: l })) } };
}

/** Patch que remove labels (o inverso de labelsAddPatch). Remover label ausente é inofensivo no Jira. */
export function labelsRemovePatch(labels) {
  const list = (labels ?? []).map((l) => String(l ?? '').trim()).filter(Boolean);
  if (!list.length) return null;
  return { update: { labels: list.map((l) => ({ remove: l })) } };
}

function enforceMaxChars(doc, maxChars) {
  if (adfTextLength(doc) <= maxChars) return doc;
  const truncated = structuredClone(doc);
  let remaining = maxChars;
  const kept = [];
  for (const block of truncated.content ?? []) {
    const size = adfTextLength(block);
    if (remaining - size < 0) break;
    remaining -= size;
    kept.push(block);
  }
  kept.push({
    type: 'paragraph',
    content: [{
      type: 'text',
      text: `⚠️ Conteúdo truncado pelo limite da API Jira (${JIRA_MAX_FIELD_CHARS} caracteres). O conteúdo integral está no repositório.`,
    }],
  });
  truncated.content = kept;
  return truncated;
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** fetch com retry e backoff para 429/502/503/504 (respeita Retry-After); JIRA_RETRY_BASE_MS ajusta a base. */
async function fetchWithRetry(url, init, { retries = 3, baseMs = Number(process.env.JIRA_RETRY_BASE_MS) || 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (!RETRYABLE.has(res.status) || attempt >= retries) return res;
    const retryAfter = Number(res.headers?.get?.('retry-after'));
    await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseMs * 2 ** attempt);
  }
}

export function createClient({ baseUrl, email, token } = {}) {
  const base = (baseUrl ?? process.env.JIRA_BASE_URL ?? '').replace(/\/$/, '');
  const auth = Buffer.from(`${email ?? process.env.JIRA_EMAIL}:${token ?? process.env.JIRA_API_TOKEN}`).toString('base64');

  async function req(method, path, body) {
    const res = await fetchWithRetry(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  /** Busca por JQL. Erro HTTP NÃO é "nenhum card": propaga para o sync abortar sem criar duplicado. */
  async function searchIssues(jql) {
    const res = await fetchWithRetry(`${base}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=5&fields=summary`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`busca no Jira falhou (HTTP ${res.status}); sync abortado para não duplicar o card`);
    return (await res.json()).issues ?? [];
  }

  return {
    searchIssues,
    getMyself: () => req('GET', '/rest/api/3/myself'),
    assignIssue: (issueKey, accountId) => req('PUT', `/rest/api/3/issue/${issueKey}/assignee`, { accountId }),
    getProject: (key) => req('GET', `/rest/api/3/project/${key}`),
    getIssueTypes: (projectKey) =>
      req('GET', `/rest/api/3/issuetype?projectId=undefined`).catch(() =>
        req('GET', `/rest/api/3/project/${projectKey}`).then((p) => p.issueTypes ?? []),
      ),
    createIssue: (fields) => req('POST', '/rest/api/3/issue', { fields }),
    getIssue: (issueKey, fields = 'description,summary,comment') =>
      req('GET', `/rest/api/3/issue/${issueKey}?fields=${encodeURIComponent(fields)}`),
    /** Edita a description do card (API v3 suporta via PUT em `fields`). */
    updateDescription: (issueKey, doc) =>
      req('PUT', `/rest/api/3/issue/${issueKey}`, { fields: { description: doc } }),
    /** Atualiza campos simples do card (summary, description…). */
    updateFields: (issueKey, fields) => req('PUT', `/rest/api/3/issue/${issueKey}`, { fields }),
    /** Anexa um arquivo ao card (multipart; o Jira exige X-Atlassian-Token: no-check). */
    addAttachment: async (issueKey, { name, data }) => {
      const form = new FormData();
      form.append('file', new Blob([data]), name);
      const res = await fetchWithRetry(`${base}/rest/api/3/issue/${issueKey}/attachments`, {
        method: 'POST', body: form,
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'X-Atlassian-Token': 'no-check' },
      });
      if (!res.ok) throw new Error(`anexo ${name} em ${issueKey} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
    deleteAttachment: (attachmentId) => req('DELETE', `/rest/api/3/attachment/${attachmentId}`),
    /** Define o pai (épico) do card. */
    setParent: (issueKey, parentKey) =>
      req('PUT', `/rest/api/3/issue/${issueKey}`, { fields: { parent: { key: parentKey } } }),
    /** Chamada crua à API (scripts de administração do projeto). */
    raw: (method, path, body) => req(method, path, body),
    /** Adiciona categorias (labels) ao card — patch aditivo, não remove existentes. */
    updateLabels: (issueKey, labels) => {
      const patch = labelsAddPatch(labels);
      return patch ? req('PUT', `/rest/api/3/issue/${issueKey}`, patch) : null;
    },
    /** Remove categorias (labels) do card, só as pedidas; as demais ficam. */
    removeLabels: (issueKey, labels) => {
      const patch = labelsRemovePatch(labels);
      return patch ? req('PUT', `/rest/api/3/issue/${issueKey}`, patch) : null;
    },
    getTransitions: (issueKey) => req('GET', `/rest/api/3/issue/${issueKey}/transitions`),
    doTransition: (issueKey, transitionId) =>
      req('POST', `/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: transitionId } }),
    /** Primeiro card do projeto no ranking (`ORDER BY Rank ASC`) — referência para subir um card ao topo. */
    firstRankedIssue: async (projectKey) => {
      const issues = await searchIssues(`project = ${projectKey} ORDER BY Rank ASC`);
      return issues[0]?.key ?? null;
    },
    /** Ranking do board: sem isto o card novo entra no FIM da coluna (chega fora da área visível). */
    rankIssue: (issueKey, beforeKey) =>
      req('PUT', '/rest/agile/1.0/issue/rank', { issues: [issueKey], rankBeforeIssue: beforeKey }),
    getBoard: (boardId) => req('GET', `/rest/agile/1.0/board/${boardId}`),
    getBoardIssues: (boardId, params = '') =>
      req('GET', `/rest/agile/1.0/board/${boardId}/issue?${params}`),
    /** Comentário com quebra de linha real; acima do limite, fatia em partes. */
    addComment: async (issueKey, text) => {
      const parts = [];
      let pending = String(text ?? '');
      while (true) {
        const doc = textToDoc(pending);
        if (adfTextLength(doc) <= SAFE_FIELD_CHARS) {
          parts.push(doc);
          break;
        }
        // corta `pending` proporcionalmente ao que coube e repete
        const docTextLength = adfTextLength(doc);
        const fitRatio = SAFE_FIELD_CHARS / Math.max(1, docTextLength);
        const cut = Math.max(1, Math.floor(pending.length * fitRatio));
        parts.push(textToDoc(pending.slice(0, cut)));
        pending = pending.slice(cut);
      }
      let last = null;
      for (const [index, body] of parts.entries()) {
        const suffix = parts.length > 1 ? ` (parte ${index + 1}/${parts.length})` : '';
        last = await req('POST', `/rest/api/3/issue/${issueKey}/comment`, {
          body: suffixParagraphs(body, suffix),
        });
      }
      return last;
    },
  };
}

function suffixParagraphs(doc, suffix) {
  if (!suffix) return doc;
  return {
    ...doc,
    content: [
      ...doc.content,
      { type: 'paragraph', content: [{ type: 'text', text: suffix.trim() }] },
    ],
  };
}

