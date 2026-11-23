import { run } from '../util.mjs';
import { result } from '../report.mjs';
import path from 'node:path';
import { cgroupOomKills, childEnv, isHeapOom, isLimited, isOutOfMemory, loadLimits, timeFactor } from '../limits.mjs';

/** Controle de orçamento de tempo: cada passo recebe o tempo restante como timeout. */
export class Budget {
  constructor(ms) { this.deadline = Date.now() + ms; }
  left() { return Math.max(0, this.deadline - Date.now()); }
  timeout(capMs) { return Math.max(1_000, Math.min(capMs, this.left())); }
  exhausted() { return this.left() < 2_000; }
}

export function tail(text, n = 20) {
  return text.split('\n').filter((l) => l.trim()).slice(-n).map((l) => `    ${l}`).join('\n');
}

export function step(out, budget, name, cmd, args, { cwd, capMs = 300_000, env } = {}) {
  if (budget.exhausted()) {
    out.push(result('ferramentas', 'warn', 'tool.timeout', { step: name, seconds: 0 }));
    return null;
  }
  const timeoutMs = budget.timeout(capMs * timeFactor());
  const killsBefore = isLimited() ? cgroupOomKills() : null;
  const r = run(cmd, args, { cwd, timeoutMs, env: { ...childEnv(process.env, path.basename(cmd)), ...env } });
  if (r.missing) {
    out.push(result('ferramentas', 'warn', 'tool.missing', { tool: cmd, impact: `${name} não medido.` }));
    return null;
  }
  if (r.timedOut) {
    out.push(result('ferramentas', 'warn', 'tool.timeout', { step: name, seconds: Math.round(timeoutMs / 1000) }));
    return null;
  }
  if (r.bufferExceeded) {
    out.push(result('ferramentas', 'fail', 'tool.outputLimit', { step: name, mb: 64 }));
    return null;
  }
  const memoryFailure = isLimited() && r.code !== 0 ? classifyMemoryFailure(r, killsBefore) : null;
  if (memoryFailure) {
    out.push(result('ferramentas', 'fail', memoryFailure.key, { step: name, ...memoryFailure.params }));
    return null;
  }
  return r;
}

/**
 * Encerrado por falta de memória REPROVA o gate (nunca vira "não medido"). Só vira tool.oom se o
 * kernel realmente matou processos do escopo (contador oom_kill subiu); abort() ou kill manual
 * seguem como falha comum do passo. Sem acesso à cgroup, cai na heurística do código de saída.
 */
function classifyMemoryFailure(r, killsBefore) {
  const limits = loadLimits();
  if (isHeapOom(r)) return { key: 'tool.oomHeap', params: { mb: limits.nodeHeapMB } };
  const killsAfter = cgroupOomKills();
  const killed = killsBefore !== null && killsAfter !== null ? killsAfter > killsBefore : isOutOfMemory(r);
  return killed ? { key: 'tool.oom', params: { mb: limits.memoryMaxMB } } : null;
}

export const addedLineSet = (e) => new Set(e.added.map((a) => a.line));
