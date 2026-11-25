import fs from 'node:fs';
import { createHash } from 'node:crypto';
// Biblioteca comum do sistema de entrega em ciclo (backlog.mjs + eval.mjs).
import path from 'node:path';
import { readJson, writeJson, run } from '../lib/util.mjs';

export { run, readJson, writeJson };

export const STATUSES = ['pending', 'in_progress', 'done', 'blocked', 'cancelled'];
export const GATE_TYPES = ['command', 'manual'];

// ── paths ────────────────────────────────────────────────────────────────────

export function backlogPath(dir) {
  return path.resolve(dir, 'backlog.json');
}

// ── I/O ──────────────────────────────────────────────────────────────────────

export function readBacklog(dir) {
  const p = backlogPath(dir);
  const data = readJson(p, null);
  if (!data) throw new Error(`backlog.json não encontrado em: ${p}`);
  return data;
}

export function writeBacklog(dir, data) {
  writeJson(backlogPath(dir), data);
}

// ── chave do card no Jira ─────────────────────────────────────────────────────
// Um arquivo por tarefa (jira-keys/<ID>.txt), NÃO um campo em backlog.json: o backlog é reescrito
// pelo `backlog.mjs mark` e por agentes em paralelo, e dois escritores no mesmo JSON perdem dados.
const JIRA_KEY = /^[A-Z][A-Z0-9]*-\d+$/;
export const jiraKeyPath = (dir, id) => path.join(dir, 'jira-keys', `${id}.txt`);

/** Chave do card da tarefa: arquivo lateral, ou o campo `jira_key` legado do backlog; null se não houver. */
export function readJiraKey(dir, task) {
  try {
    const key = fs.readFileSync(jiraKeyPath(dir, task.id), 'utf8').trim();
    if (JIRA_KEY.test(key)) return key;
  } catch { /* sem arquivo lateral */ }
  return task.jira_key && JIRA_KEY.test(task.jira_key) ? task.jira_key : null;
}

export function writeJiraKey(dir, id, key) {
  if (!JIRA_KEY.test(key)) throw new Error(`chave de card inválida: ${key}`);
  const file = jiraKeyPath(dir, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${key}\n`);
  fs.renameSync(tmp, file);
}

// ── queries ───────────────────────────────────────────────────────────────────

export function taskById(backlog, id) {
  return (backlog.tasks ?? []).find((t) => t.id === id) ?? null;
}

export function gatesForTask(backlog, id) {
  return (backlog.gates ?? []).filter((g) => g.task === id);
}

/** Impressão digital dos gates da tarefa: congelada no `in_progress`, conferida no `done`. */
export function gatesFingerprint(backlog, id) {
  return createHash('sha256').update(JSON.stringify(gatesForTask(backlog, id))).digest('hex').slice(0, 16);
}

export function dependenciesMet(backlog, taskId) {
  const task = taskById(backlog, taskId);
  if (!task) return false;
  return (task.depends_on ?? []).every((depId) => taskById(backlog, depId)?.status === 'done');
}

/**
 * Situação da entrega, para o loop do agente ter condição de parada e relatório:
 *  concluida (tudo done/cancelled) | em_andamento (há in_progress) | executavel (há próxima) |
 *  travada (restam só bloqueadas e pendentes presas a elas: precisa de decisão ou ação humana).
 * `presas`: pendentes que nunca ficarão executáveis enquanto a dependência não for done.
 */
export function situacao(backlog) {
  const tasks = backlog.tasks ?? [];
  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  const bloqueadas = tasks.filter((t) => t.status === 'blocked').map((t) => ({ id: t.id, title: t.title, motivo: t.motivo ?? '' }));
  const presas = tasks
    .filter((t) => t.status === 'pending' && !dependenciesMet(backlog, t.id))
    .map((t) => ({ id: t.id, title: t.title, esperaPor: (t.depends_on ?? []).filter((d) => taskById(backlog, d)?.status !== 'done') }));
  const next = nextPending(backlog);
  const emAndamento = tasks.find((t) => t.status === 'in_progress') ?? null;
  let estado = 'travada';
  if (!open.length) estado = 'concluida';
  else if (emAndamento) estado = 'em_andamento';
  else if (next) estado = 'executavel';
  return { estado, next: next ?? null, emAndamento, bloqueadas, presas };
}

export function nextPending(backlog) {
  return (backlog.tasks ?? []).find(
    (t) => t.status === 'pending' && dependenciesMet(backlog, t.id),
  ) ?? null;
}

// ── jira: categorias e slug da feature nos cards ─────────────────────────────

/** Sanitiza um valor para label do Jira (Jira aceita letras, números, '.', '-', '_'). */
export function sanitizeJiraLabel(value) {
  const label = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-_]+|[.\-_]+$/g, '')
    .slice(0, 255);
  return label || null;
}

/** Slug da feature derivado do diretório da entrega (remove o prefixo de data). */
export function featureSlugFromDir(dir) {
  const value = String(dir ?? '').trim();
  if (!value) return null;
  const base = path.basename(path.resolve(value));
  if (!base) return null;
  return sanitizeJiraLabel(base.replace(/^\d{4}-\d{2}-\d{2}-/, ''));
}

/** Slug da feature: explícito no backlog (featureSlug) > derivado do diretório. */
export function resolveFeatureSlug(backlog, dir) {
  return sanitizeJiraLabel(backlog?.featureSlug) ?? featureSlugFromDir(dir);
}

/** Tag de versão do card: versão explícita (--versao/backlog.version) > data de criação. */
function versionTagFor(backlog, version = null) {
  return sanitizeJiraLabel(version)
    ?? sanitizeJiraLabel(backlog?.version)
    ?? sanitizeJiraLabel(backlog?.created);
}

/**
 * Categorias (labels) do card no Jira: sempre `feature-<slug>` da feature,
 * `versao-<tag>` de versão e as categorias extras do backlog/flags. Dedup.
 */
export function cardLabels(backlog = null, dir = null, { featureSlug = null, categories = [], version = null } = {}) {
  const slug = sanitizeJiraLabel(featureSlug) ?? resolveFeatureSlug(backlog, dir);
  const versionTag = versionTagFor(backlog, version);
  const labels = [
    ...(slug ? [`feature-${slug}`] : []),
    ...(versionTag ? [`versao-${versionTag}`] : []),
  ];
  for (const category of [...(backlog?.categories ?? []), ...categories]) {
    const label = sanitizeJiraLabel(category);
    if (label) labels.push(label);
  }
  return [...new Set(labels)];
}

// ── validation ────────────────────────────────────────────────────────────────

const HOMOLOGACAO_ESTADOS = ['pendente', 'em_homologacao', 'aprovada', 'reprovada'];

/** Forma do bloco `homologacao` (o preparo real do ambiente é verificado só ao homologar). */
function validateHomologacao(h, errors) {
  if (h === undefined) return;
  if (!h || typeof h !== 'object' || Array.isArray(h)) { errors.push('homologacao deve ser objeto'); return; }
  for (const campo of ['compose', 'up', 'url', 'down']) {
    if (h[campo] !== undefined && typeof h[campo] !== 'string') errors.push(`homologacao.${campo} deve ser string`);
  }
  if (h.roteiro !== undefined && !(Array.isArray(h.roteiro) && h.roteiro.every((s) => typeof s === 'string'))) errors.push('homologacao.roteiro deve ser lista de strings');
  if (h.estado !== undefined && !HOMOLOGACAO_ESTADOS.includes(h.estado)) errors.push(`homologacao.estado inválido "${h.estado}" (${HOMOLOGACAO_ESTADOS.join('|')})`);
}

export function validateBacklog(data) {
  const errors = [];
  if (!data.id) errors.push('id obrigatório (string)');
  if (!data.title) errors.push('title obrigatório (string)');
  if (!Array.isArray(data.tasks)) { errors.push('tasks deve ser array'); return errors; }
  if (!Array.isArray(data.gates)) { errors.push('gates deve ser array'); return errors; }
  const taskIds = validateTasks(data.tasks, errors);
  validateGates(data.gates, taskIds, errors);
  validateHomologacao(data.homologacao, errors);
  return errors;
}

function validateTasks(tasks, errors) {
  const taskIds = new Set();
  for (const t of tasks) {
    if (!t.id) { errors.push(`task sem id: ${JSON.stringify(t)}`); continue; }
    if (taskIds.has(t.id)) errors.push(`id duplicado: ${t.id}`);
    taskIds.add(t.id);
    if (!STATUSES.includes(t.status)) errors.push(`${t.id}: status inválido "${t.status}"`);
  }
  // depends_on: second pass so forward refs are accepted
  for (const t of tasks) {
    for (const dep of t.depends_on ?? []) {
      if (!taskIds.has(dep)) errors.push(`${t.id}: depends_on "${dep}" não existe`);
    }
  }
  return taskIds;
}

function validateGates(gates, taskIds, errors) {
  const gateIds = new Set();
  for (const g of gates) {
    if (!g.id) { errors.push(`gate sem id: ${JSON.stringify(g)}`); continue; }
    if (gateIds.has(g.id)) errors.push(`gate id duplicado: ${g.id}`);
    gateIds.add(g.id);
    if (!GATE_TYPES.includes(g.type)) errors.push(`${g.id}: tipo inválido "${g.type}"`);
    if (!g.task || !taskIds.has(g.task)) errors.push(`${g.id}: task "${g.task}" não existe`);
    if (g.type === 'command' && (!Array.isArray(g.command) || !g.command.length))
      errors.push(`${g.id}: command deve ser array não vazio`);
  }
}
