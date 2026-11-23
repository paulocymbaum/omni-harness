#!/usr/bin/env node
// Detector de force-pass: inspeciona o backlog.json em busca de sinais de
// que uma tarefa foi marcada done sem passar pelos gates.
// Uso:  node quality/delivery/integridade.mjs <dir>
// Como módulo: import { checkIntegrity } from './integridade.mjs'
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readBacklog, taskById, gatesForTask } from './lib.mjs';

// ── biblioteca ────────────────────────────────────────────────────────────────

/**
 * Inspeciona o backlog e devolve suspeitas de force-pass.
 * Cada achado: { task, severity: 'warn'|'error', reason }
 */
export function checkIntegrity(dir) {
  const backlog = readBacklog(dir);
  const findings = [];
  for (const task of backlog.tasks ?? []) {
    if (task.status !== 'done') continue;
    checkTimestamp(task, findings);
    checkDependencies(backlog, task, findings);
  }
  return findings;
}

function checkTimestamp(task, findings) {
  if (!task.done_at) {
    findings.push({
      task: task.id,
      severity: 'warn',
      reason: `done_at ausente — tarefa marcada done sem timestamp de encerramento`,
    });
  }
}

function checkDependencies(backlog, task, findings) {
  for (const depId of task.depends_on ?? []) {
    const dep = taskById(backlog, depId);
    if (dep && dep.status !== 'done') {
      findings.push({
        task: task.id,
        severity: 'error',
        reason: `dependência ${depId} está ${dep.status} mas a tarefa está done — possível force-pass`,
      });
    }
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const [,, dir] = process.argv;
  if (!dir) { console.error('Uso: integridade.mjs <dir>'); process.exit(1); }

  let findings;
  try {
    findings = checkIntegrity(path.resolve(dir));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (!findings.length) {
    console.log('Nenhuma suspeita de force-pass encontrada.');
    process.exit(0);
  }

  const errors = findings.filter((f) => f.severity === 'error');
  for (const f of findings) {
    const label = f.severity === 'error' ? '✗' : '⚠';
    console.log(`${label} ${f.task}: ${f.reason}`);
  }
  process.exit(errors.length > 0 ? 1 : 0);
}
