#!/usr/bin/env node
// Arquiva entregas concluídas para evitar crescimento de contexto.
// Uma entrega está "concluída" quando todas as tarefas são done/cancelled/blocked-externo.
//
// O que faz:
//   1. Move docs/entregas/<slug>/ → docs/entregas/archive/<slug>/
//   2. Remove quality/.state/entrega-ativa.json se apontar para a entrega arquivada
//   3. Atualiza README_AGENT_WORKFLOW.md com ponteiro para o arquivo
//   4. Preserva sempre: backlog.json, SUMMARY.md, specs/
//   5. Remove opcionalmente: evidências e logs temporários
//
// Uso:  node quality/delivery/overflow-roadmap.mjs <slug> [--dry-run] [--remove-evidence]
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { readBacklog } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const [,, slug, ...flags] = process.argv;
const DRY = flags.includes('--dry-run');
const REMOVE_EVIDENCE = flags.includes('--remove-evidence');

if (!slug) {
  console.error('Uso: overflow-roadmap.mjs <slug> [--dry-run] [--remove-evidence]');
  process.exit(1);
}

const srcDir = path.join(ROOT, 'docs', 'entregas', slug);
const archiveDir = path.join(ROOT, 'docs', 'entregas', 'archive', slug);

if (!fs.existsSync(srcDir)) {
  console.error(`Entrega não encontrada: ${srcDir}`);
  process.exit(1);
}

// verifica se está concluída
const backlog = readBacklog(srcDir);
const open = (backlog.tasks ?? []).filter((t) => !['done', 'cancelled'].includes(t.status) &&
  !(t.status === 'blocked' && t.motivo));
if (open.length && !flags.includes('--force')) {
  console.error(`${open.length} tarefa(s) ainda abertas. Use --force para arquivar mesmo assim.`);
  open.forEach((t) => console.error(`  ${t.id}: ${t.status}`));
  process.exit(1);
}

console.log(`${DRY ? '[dry-run] ' : ''}Arquivando ${slug} → archive/${slug}`);

if (!DRY) {
  fs.mkdirSync(path.join(ROOT, 'docs', 'entregas', 'archive'), { recursive: true });
  fs.renameSync(srcDir, archiveDir);

  // limpar evidências se solicitado
  if (REMOVE_EVIDENCE) {
    const evidenceDir = path.join(archiveDir, 'evidence');
    if (fs.existsSync(evidenceDir)) {
      fs.rmSync(evidenceDir, { recursive: true, force: true });
      console.log('  evidências removidas');
    }
  }

  // limpar entrega-ativa se apontar para este slug
  const stateFile = path.join(ROOT, 'quality', '.state', 'entrega-ativa.json');
  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (state.dir?.includes(slug)) {
        fs.unlinkSync(stateFile);
        console.log('  entrega-ativa.json removido');
      }
    } catch { /* ignorar */ }
  }
}

const counts = {};
for (const t of backlog.tasks ?? []) counts[t.status] = (counts[t.status] ?? 0) + 1;
console.log(`  ${backlog.tasks?.length ?? 0} tarefas — ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')}`);
console.log(`  Arquivado em: docs/entregas/archive/${slug}/`);
