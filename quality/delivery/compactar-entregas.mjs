#!/usr/bin/env node
// Compacta uma entrega concluída: gera um resumo SUMMARY.md no diretório da entrega
// com links para os specs, relatório de gates e artefatos. Arquiva evidências opcionais.
// Uso: node quality/delivery/compactar-entregas.mjs <dir> [--archive-evidence]
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { readBacklog, gatesForTask, STATUSES } from './lib.mjs';

export async function compactarEntrega(dir, { archiveEvidence = false } = {}) {
  const backlog = readBacklog(dir);
  const tasks = backlog.tasks ?? [];
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;

  const lines = buildSummary(backlog, tasks, counts, dir);
  const summaryPath = path.join(dir, 'SUMMARY.md');
  fs.writeFileSync(summaryPath, lines.join('\n') + '\n');

  if (archiveEvidence) archiveEvidenceFiles(dir);

  return { summaryPath, counts };
}

function buildSummary(backlog, tasks, counts, dir) {
  const now = new Date().toISOString().slice(0, 10);
  const lines = [
    `# Entrega — ${backlog.title}`,
    '',
    `**Gerado em:** ${now}  `,
    `**Status:** ${STATUSES.map((s) => `${counts[s]} ${s}`).join(' · ')}`,
    '',
    '## Tarefas',
    '',
    '| ID | Título | Status | Done em |',
    '|---|---|---|---|',
  ];

  for (const t of tasks) {
    const specLink = hasSpec(dir, t.id)
      ? `[${t.id}](specs/${t.id}.md)`
      : t.id;
    const doneAt = t.done_at ? t.done_at.slice(0, 10) : '—';
    lines.push(`| ${specLink} | ${t.title} | \`${t.status}\` | ${doneAt} |`);
  }

  lines.push('', '## Gates');
  lines.push('', '| Gate | Tarefa | Tipo |', '|---|---|---|');
  for (const g of backlog.gates ?? []) {
    lines.push(`| ${g.id} | ${g.task} | ${g.type} |`);
  }

  const blocked = tasks.filter((t) => t.status === 'blocked');
  if (blocked.length) {
    lines.push('', '## Bloqueios externos', '');
    for (const t of blocked) {
      lines.push(`- **${t.id}**: ${t.motivo ?? '(sem motivo registrado)'}`);
    }
  }

  return lines;
}

function hasSpec(dir, id) {
  return fs.existsSync(path.join(dir, 'specs', `${id}.md`));
}

function archiveEvidenceFiles(dir) {
  const evidenceDir = path.join(dir, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  // move any *.log and *.txt from dir root to evidence/
  for (const f of fs.readdirSync(dir)) {
    if (/\.(log|txt)$/.test(f)) {
      fs.renameSync(path.join(dir, f), path.join(evidenceDir, f));
    }
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const [,, dir, ...flags] = process.argv;
  if (!dir) { console.error('Uso: compactar-entregas.mjs <dir> [--archive-evidence]'); process.exit(1); }
  try {
    const result = await compactarEntrega(path.resolve(dir), {
      archiveEvidence: flags.includes('--archive-evidence'),
    });
    console.log(`Resumo gerado: ${result.summaryPath}`);
    console.log(STATUSES.map((s) => `${result.counts[s]} ${s}`).join(' · '));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
