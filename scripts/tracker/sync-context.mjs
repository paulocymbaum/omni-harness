#!/usr/bin/env node
// Espelha o estado de uma tarefa do backlog no Jira:
//   - cria o card com summary + description integral da tarefa (spec completa)
//   - atualiza a description via PUT (API v3) em re-sincronizações
//   - transiciona o card para o status Jira mapeado
//
// Uso:  node scripts/tracker/sync-context.mjs <dir> <taskId> [--status <jiraStatus>]
// Ex:   node scripts/tracker/sync-context.mjs \
//           docs/entregas/2026-10-01-harness-entrega-em-ciclo RB-001 --status Done
//
// Credenciais: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY (do .env).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from './load-env.mjs';
import { createClient, adfTextLength, JIRA_MAX_FIELD_CHARS } from './jira-client.mjs';
import { inspectSpec } from '../../quality/lib/spec-sync.mjs';
import { describeFindings } from '../../quality/lib/pii-guard.mjs';
import { jiraStatusFor, moveToStatus } from './status.mjs';
import { rankToTop } from './rank.mjs';
import { syncEpic, ensureParent } from './epic.mjs';
import { cardSummary } from './naming.mjs';
import { findExistingIssue, existingIssueJqls } from './find-card.mjs';
export { findExistingIssue, existingIssueJqls };

import {
  readBacklog, readJiraKey, writeJiraKey, taskById, gatesForTask,
  cardLabels, resolveFeatureSlug,
} from '../../quality/delivery/lib.mjs';

// Deve vir ANTES do bloco CLI: o top-level await do `syncTask` suspende a
// avaliação do módulo, e `const` declarado depois ainda estaria em TDZ.
const SAFE_ADF_CHARS = JIRA_MAX_FIELD_CHARS - 600;

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Label que marca o card criado antes de a spec existir; sai sozinha no sync que encontra a spec. */
export const SPEC_PENDING_LABEL = 'spec-pendente';
const FINISHED_STATUSES = new Set(['done', 'cancelled']);

// ── carregar .env ─────────────────────────────────────────────────────────────
loadEnv(ROOT);

// ── CLI ───────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (isMain) {
  const [,, dir, taskId, ...flags] = process.argv;
  const { statusOverride, featureSlug, categories, versao } = parseSyncFlags(flags);

  if (dir && taskId === '--audit') {
    const missing = auditSpecs(path.resolve(dir));
    for (const m of missing) console.log(`${m.id} (${m.status}) spec ${m.state}: ${m.specPath}`);
    console.log(missing.length ? `${missing.length} tarefa(s) com spec ausente, em rascunho ou com dados pessoais; os cards delas ficam com a label ${SPEC_PENDING_LABEL}.` : 'Todas as tarefas têm spec pronta.');
    process.exit(missing.length ? 1 : 0);
  }
  if (!dir || !taskId) {
    console.error('Uso: sync-context.mjs <dir> <taskId|--all|--epic|--audit> [--status <jiraStatus>] [--feature <slug>] [--versao <tag>] [--categoria <label>]…');
    process.exit(1);
  }

  try {
    const absDir = path.resolve(dir);
    if (taskId === '--epic') {
      console.log(`Épico: ${await syncEpicOf(absDir, { featureSlug, categories, version: versao })}`);
    } else {
      const ids = taskId === '--all' ? (readBacklog(absDir).tasks ?? []).map((t) => t.id) : [taskId];
      const failures = await syncMany(absDir, ids, statusOverride, { featureSlug, categories, version: versao });
      if (failures.length && ids.length === 1) throw new Error(failures[0].message);
      if (failures.length) {
        console.error(`sync-context: ${failures.length} de ${ids.length} tarefa(s) falharam (${failures.map((f) => f.id).join(', ')}); as demais foram sincronizadas. Rode de novo para as que falharam.`);
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`sync-context: ${err.message}`);
    process.exit(1);
  }
}

// ── biblioteca ────────────────────────────────────────────────────────────────

/**
 * Sincroniza várias tarefas. Uma falha (ex.: 429 que esgotou os retries) NÃO aborta o lote:
 * as demais seguem e as que falharam voltam em `[{ id, message }]`.
 */
export async function syncMany(dir, ids, statusOverride = null, options = {}, log = console) {
  const failures = [];
  const batch = { ...options, client: options.client ?? createClient() };
  batch.epicKey = ids.length > 1 ? await syncEpicOf(dir, batch) : undefined; // lote: o épico uma vez, antes dos cards
  for (const id of ids) {
    try {
      const result = await syncTask(dir, id, statusOverride, batch);
      log.log(`${id} → ${result.key} (${result.status})`);
      log.log(`  ${process.env.JIRA_BASE_URL}/browse/${result.key}`);
    } catch (err) {
      failures.push({ id, message: err.message });
      log.error(`${id} falhou: ${err.message}`);
    }
  }
  return failures;
}

/** Cria ou atualiza só o épico da feature (definição completa do backlog) e devolve a chave. */
export async function syncEpicOf(dir, options = {}) {
  const projectKey = process.env.JIRA_PROJECT_KEY;
  if (!projectKey) throw new Error('JIRA_PROJECT_KEY não definido');
  const backlog = readBacklog(dir);
  const jira = options.client ?? createClient();
  return syncEpic(jira, { projectKey, dir, backlog, labels: cardLabels(backlog, dir, options), toAdf: markdownToAdf });
}

export async function syncTask(dir, taskId, statusOverride = null, options = {}) {
  const jira = options.client ?? createClient();
  const projectKey = process.env.JIRA_PROJECT_KEY;
  if (!projectKey) throw new Error('JIRA_PROJECT_KEY não definido');

  const backlog = readBacklog(dir);
  const task = taskById(backlog, taskId);
  if (!task) throw new Error(`tarefa não encontrada: ${taskId}`);

  const jiraStatus = statusOverride ?? jiraStatusFor(task, backlog);
  const summary = cardSummary(task);
  const description = buildDescription(task, backlog, dir);
  const featureSlug = resolveFeatureSlug(backlog, dir);
  // Tarefa encerrada sem spec é histórico, não pendência: sem a label (e ela sai se já estava no card).
  const specMissing = specInfo(dir, task).state !== 'ready' && !FINISHED_STATUSES.has(task.status);
  const labels = [...cardLabels(backlog, dir, options), ...(specMissing ? [SPEC_PENDING_LABEL] : [])];

  // todo card da feature é filho do épico, desde a criação
  const epicKey = options.epicKey ?? await syncEpic(jira, { projectKey, dir, backlog, labels: cardLabels(backlog, dir, options), toAdf: markdownToAdf });
  const known = { ...task, jira_key: readJiraKey(dir, task) };
  const { key, created } = await upsertIssue(jira, projectKey, { task: known, backlog, card: { summary, description, labels, featureSlug, specMissing, epicKey } });
  if (known.jira_key !== key) writeJiraKey(dir, taskId, key);
  await ensureParent(jira, key, epicKey);

  const moved = await moveToStatus(jira, key, jiraStatus);
  // Card novo ou que mudou de coluna sobe ao topo: sem isto o Jira o anexa no FIM da coluna (Done com
  // dezenas de cards = o card recém-criado nunca aparece na tela do board).
  if (created || moved) await rankToTop(jira, projectKey, key);
  return { key, status: jiraStatus };
}

/** QG-023: o summary do card acompanha o re-sync; PUT de `fields.summary` só quando diverge do título atual. */
async function resumoEmDia(jira, key, summary) {
  const issue = await jira.getIssue(key, 'summary');
  const atual = (issue.fields && issue.fields.summary) || '';
  if (atual === summary) return;
  await jira.updateFields(key, { summary });
}

/** Cria o card (com labels) ou re-sincroniza o existente (description + summary + labels). */
async function upsertIssue(jira, projectKey, { task, backlog, card }) {
  // procura card existente: jira_key da tarefa → label da feature + id → legado
  const existing = await findExistingIssue(jira, projectKey, task, backlog.id, card.featureSlug);
  if (existing) {
    // API v3 edita description via PUT (fields.description) — o card passa a
    // refletir a spec INTEGRAL em cada re-sincronização, sem comentários
    // truncados fazendo o papel de description.
    await jira.updateDescription(existing, markdownToAdf(card.description, task));
    // spec presente: tira a marca de pendência que o card recebeu quando nasceu sem spec
    await ensureLabels(jira, existing, card.labels, { remove: card.specMissing ? [] : [SPEC_PENDING_LABEL] });
    // tarefa retitulada: o summary "<ID> — <título>" acompanha (só quando diverge)
    await resumoEmDia(jira, existing, card.summary);
    return { key: existing, created: false };
  }
  const proj = await jira.getProject(projectKey);
  const issueType = pickIssueType(proj.issueTypes ?? []);
  const issue = await jira.createIssue({
    project: { key: projectKey },
    issuetype: { id: issueType.id },
    summary: card.summary,
    description: markdownToAdf(card.description, task),
    ...(card.labels.length ? { labels: card.labels } : {}),
    ...(card.epicKey ? { parent: { key: card.epicKey } } : {}),
  });
  return { key: issue.key, created: true };
}

/** Parseia as flags do CLI. `--status` e `--feature` únicas; `--categoria` repetível. */
export function parseSyncFlags(flags = []) {
  const single = (name) => {
    const i = flags.indexOf(name);
    return i !== -1 ? flags[i + 1] ?? null : null;
  };
  const categories = [];
  flags.forEach((flag, i) => {
    if (flag === '--categoria' && flags[i + 1]) categories.push(flags[i + 1]);
  });
  return { statusOverride: single('--status'), featureSlug: single('--feature'), categories, versao: single('--versao') };
}

/** Garante as categorias (labels) no card — patch aditivo, preserva labels manuais. */
async function ensureLabels(jira, key, labels, { remove = [] } = {}) {
  if (!labels.length && !remove.length) return;
  const issue = await jira.getIssue(key, 'labels');
  const existing = new Set(issue.fields?.labels ?? []);
  const missing = labels.filter((l) => !existing.has(l));
  if (missing.length) await jira.updateLabels(key, missing);
  const stale = remove.filter((l) => existing.has(l));
  if (stale.length) await jira.removeLabels(key, stale);
}


export { cardSummary } from './naming.mjs';

/** Linhas de Feature/Categorias para a description do card. */
function featureLines(backlog, dir) {
  const featureSlug = resolveFeatureSlug(backlog, dir);
  if (!featureSlug) return [];
  const categories = cardLabels(backlog, dir).filter((l) => l !== `feature-${featureSlug}`);
  return [
    `Feature: ${featureSlug}`,
    ...(categories.length ? [`Categorias: ${categories.join(', ')}`] : []),
  ];
}

/** Bloco de gates da tarefa, quando houver. */
function gateLines(backlog, task) {
  const gates = gatesForTask(backlog, task.id);
  if (!gates.length) return [];
  const lines = ['', `## Gates (${gates.length})`, ''];
  for (const g of gates) {
    lines.push(`- \`${g.id}\` [${g.type}]${g.type === 'command' ? ` — \`${g.command.join(' ')}\`` : ''}`);
  }
  return lines;
}

/** Bloco da spec integral (ou aviso de spec ausente) — sem corte silencioso. */
// function (içada): o bloco CLI no topo do arquivo roda antes dos `const` desta seção.
function specFile(dir, task) { return path.join(dir, 'specs', `${task.id}.md`); }
/** Situação da spec para o Jira (missing, draft, blocked por PII ou ready); só `ready` vai ao card. */
function specInfo(dir, task) { return inspectSpec(specFile(dir, task)); }

/** Tarefas cuja spec não pode ir ao card (ausente, rascunho ou com PII); os cards delas ficam com spec-pendente. */
export function auditSpecs(dir) {
  const backlog = readBacklog(dir);
  return (backlog.tasks ?? [])
    .map((t) => ({ id: t.id, status: t.status, state: specInfo(dir, t).state, specPath: `docs/entregas/${path.basename(dir)}/specs/${t.id}.md` }))
    .filter((t) => t.state !== 'ready');
}

function specLines(dir, task) {
  const specPath = specFile(dir, task);
  const specRelPath = `docs/entregas/${path.basename(dir)}/specs/${task.id}.md`;
  const info = specInfo(dir, task);
  if (info.state === 'blocked') {
    return ['', '## Spec integral', '', `> Spec retida: o arquivo \`${specRelPath}\` contém dados pessoais ou segredo (${describeFindings(info.findings)}). Nada dela foi enviado. Troque por placeholders e sincronize de novo.`];
  }
  if (info.state === 'draft') {
    return ['', '## Spec integral', '', `> Spec ainda em rascunho (sem \`Status: ready\`): \`${specRelPath}\`. O card recebe a spec integral quando ela estiver pronta.`];
  }
  if (info.state === 'ready') {
    // SEM corte: a spec vai integral no card; o limite da API (32.767) é
    // tratado no conversor ADF, com aviso e referência ao arquivo no repo.
    return ['', '## Spec integral', '', readFileSync(specPath, 'utf8'), '', `> Fonte: \`${specRelPath}\` no repositório.`];
  }
  return ['', '## Spec integral', '', `> Spec ainda não escrita: \`${specRelPath}\`.`, `> Este card recebe a spec integral sozinho assim que o arquivo for gravado (label ${SPEC_PENDING_LABEL} sai nesse momento).`];
}

function buildDescription(task, backlog, dir) {
  const lines = [
    `Tarefa: ${task.id} — ${task.title}`,
    `Backlog: ${backlog.title}`,
    `Status: ${task.status}`,
    `Dependências: ${(task.depends_on ?? []).join(', ') || 'nenhuma'}`,
    ...featureLines(backlog, dir),
  ];
  lines.push(
    ...(task.motivo ? [`Motivo de bloqueio: ${task.motivo}`] : []),
    ...(task.done_at ? [`Concluída em: ${task.done_at}`] : []),
    ...gateLines(backlog, task),
    ...specLines(dir, task),
  );
  return lines.join('\n');
}

/** Converte o markdown da description em ADF do Jira v3, preservando
 *  estrutura (títulos, listas, checkboxes, código) e respeitando o limite
 *  de 32.767 caracteres com aviso e referência à spec no repositório. */
export function markdownToAdf(markdown, task = null) {
  const doc = { type: 'doc', version: 1, content: [] };
  const lines = String(markdown ?? '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') { i++; continue; }

    if (line.startsWith('```')) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i++;
      }
      i++; // fecha o fence
      doc.content.push({
        type: 'codeBlock',
        attrs: { language: 'text' },
        content: [{ type: 'text', text: code.join('\n') }],
      });
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      doc.content.push({
        type: 'heading',
        attrs: { level: heading[1].length },
        content: [{ type: 'text', text: heading[2] }],
      });
      i++; continue;
    }

    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      doc.content.push({ type: 'rule' });
      i++; continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(
          lines[i]
            .replace(/^\s*[-*]\s+/, '')
            .replace(/^\[ \]\s*/, '☐ ')
            .replace(/^\[[xX]\]\s*/, '☑ '),
        );
        i++;
      }
      doc.content.push({
        type: 'bulletList',
        content: items.map((text) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        })),
      });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      doc.content.push({
        type: 'orderedList',
        attrs: { order: 1 },
        content: items.map((text) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        })),
      });
      continue;
    }

    // parágrafo: linhas contíguas simples viram UM parágrafo com hardBreak
    const paragraphLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('```') &&
      !/^#{1,4}\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^(---|\*\*\*|___)\s*$/.test(lines[i])
    ) {
      paragraphLines.push(lines[i]);
      i++;
    }
    const content = [];
    paragraphLines.forEach((text, index) => {
      if (index > 0) content.push({ type: 'hardBreak' });
      content.push({ type: 'text', text });
    });
    if (content.length) doc.content.push({ type: 'paragraph', content });
  }

  return truncateAdf(doc, task);
}

function truncateAdf(doc, task) {
  if (adfTextLength(doc) <= SAFE_ADF_CHARS) return doc;
  const notice =
    `⚠️ Descrição truncada no limite da API Jira (${JIRA_MAX_FIELD_CHARS} caracteres). ` +
    `Spec integral no repositório: docs/entregas/<slug>/specs/${task?.id ?? '<ID>'}.md`;
  const kept = [];
  let remaining = SAFE_ADF_CHARS - notice.length - 10;
  for (const block of doc.content) {
    const size = adfTextLength(block);
    if (remaining - size < 0) break;
    remaining -= size;
    kept.push(block);
  }
  kept.push({ type: 'paragraph', content: [{ type: 'text', text: notice }] });
  return { type: 'doc', version: 1, content: kept };
}

/** Tipo do card: nível 0 (nunca épico nem subtarefa), preferindo História/Tarefa; os nomes vêm traduzidos pela conta. */
export function pickIssueType(types) {
  const level0 = types.filter((t) => t.hierarchyLevel === 0 && !t.subtask);
  const pool = level0.length ? level0 : types.filter((t) => !t.subtask && t.hierarchyLevel !== 1);
  const prefer = (names) => pool.find((t) => names.includes(t.name));
  return prefer(['Story', 'História', 'Historia']) ?? prefer(['Task', 'Tarefa', 'Tarea']) ?? pool[0] ?? types[0];
}
