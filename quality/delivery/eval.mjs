#!/usr/bin/env node
// Runner de gates de uma tarefa do backlog. Sem shell — executa os comandos diretamente.
// Uso:  node quality/delivery/eval.mjs <dir> <task-id> [--baseline]
// Como módulo: import { evalTask } from './eval.mjs'
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readBacklog, gatesForTask, taskById, run } from './lib.mjs';
import { repoRoot } from '../lib/util.mjs';

// ── biblioteca ────────────────────────────────────────────────────────────────

export const DEFAULT_GATE_TIMEOUT_MS = 120_000;
export const MAX_GATE_TIMEOUT_MS = 900_000;

/** Timeout do gate: `timeout_ms` do próprio gate (suítes pesadas), entre 1 s e 15 min; senão 120 s. */
export function gateTimeoutMs(gate) {
  const asked = Number(gate.timeout_ms);
  if (!Number.isFinite(asked) || asked <= 0) return DEFAULT_GATE_TIMEOUT_MS;
  return Math.min(Math.max(asked, 1000), MAX_GATE_TIMEOUT_MS);
}

/**
 * Executa todos os gates de command da tarefa e devolve o resultado.
 * Gates manuais (type:'manual') são pulados (returned as skipped, não contam para passed).
 */
export async function evalTask(dir, taskId, { cwd } = {}) {
  const backlog = readBacklog(dir);
  const task = taskById(backlog, taskId);
  if (!task) {
    return { taskId, passed: false, results: [], error: `tarefa não encontrada: ${taskId}` };
  }

  const commandGates = gatesForTask(backlog, taskId).filter((g) => g.type === 'command');
  const root = cwd ?? repoRoot();
  const results = commandGates.map((gate) => {
    const [cmd, ...args] = gate.command;
    const r = run(cmd, args, { cwd: root, timeoutMs: gateTimeoutMs(gate) });
    return {
      id: gate.id,
      passed: r.code === 0 && !r.timedOut && !r.missing,
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
      missing: r.missing,
    };
  });

  return { taskId, passed: results.every((r) => r.passed), results };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const [,, dir, taskId, ...flags] = process.argv;
  const baseline = flags.includes('--baseline');

  if (!dir || !taskId) {
    console.error('Uso: eval.mjs <dir> <task-id> [--baseline]');
    process.exit(1);
  }

  const result = await evalTask(path.resolve(dir), taskId);
  const passed = result.results.filter((r) => r.passed).length;
  const failed = result.results.filter((r) => !r.passed).length;

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  if (baseline) {
    console.log(`Baseline ${taskId}: ${passed} passaram, ${failed} falharam`);
    for (const r of result.results) {
      console.log(`  ${r.passed ? '✓' : '✗'} ${r.id}`);
      if (!r.passed && r.stderr) console.log(`    ${r.stderr.split('\n')[0]}`);
    }
    process.exit(0); // prova de falha: qualquer resultado é válido aqui
  }

  if (!result.passed) {
    for (const r of result.results.filter((r) => !r.passed)) {
      console.error(`FALHOU ${r.id} (código ${r.code}):`);
      if (r.stderr) console.error(r.stderr.trimEnd());
      if (r.stdout) console.error(r.stdout.trimEnd());
    }
    process.exit(1);
  }
  console.log(`${taskId}: ${result.results.length} gate(s) aprovado(s).`);
}
