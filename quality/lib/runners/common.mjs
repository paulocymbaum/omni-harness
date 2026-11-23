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

// ================================================================ parsers compartilhados (F1)
// Runners por stack (docs/parking-lot/runners-go-rust-cpp-csharp-java.md): parser puro, testável
// sem o binário — a rotina real só roda quando which() acha a toolchain no hospedeiro.

/** Escopo de um runner por stack: arquivos vivos sob o root do perfil que casam a regex. */
export function scanScope(entries, root, re) {
  const base = (root || '').replace(/\/$/, '');
  const prefixo = base ? `${base}/` : '';
  return entries.filter((e) => e.status !== 'D' && e.path.startsWith(prefixo) && re.test(e.path));
}

/**
 * Diagnóstico `file:line[:col]: [severity: ]msg` — cobre go vet, golangci (line-number),
 * rustc/clippy (error[E0308]) e clang-tidy (warning… [check]). Ignora snippets de contexto
 * do rustc (linhas com espaço inicial, `--> file:line:col`, `12 |`). Sem severity explícita
 * o diagnóstico é tratado como error (a tool só reporta problema real).
 */
export function parseColonDiag(text) {
  const out = [];
  for (const linha of text.split('\n')) {
    if (/^\s/.test(linha) || !linha.trim()) continue;
    const m = /^(.+?):(\d+):(?:(\d+):)?\s*(?:(?:fatal error|error|warning)(?:\[E\d+\])?\s*:\s*)?(.+)$/.exec(linha);
    if (!m || m[1].includes('-->')) continue;
    const severity = /warning/.test(linha) ? 'warning' : 'error';
    out.push({ file: m[1].trim(), line: Number(m[2]), col: m[3] ? Number(m[3]) : null, severity, msg: (m[4] || '').trim() });
  }
  return out;
}

/** Lista de caminhos por linha (gofmt -l, cargos de saída simples). */
export function parseLineList(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * Diagnóstico focado nas linhas adicionadas (padrão dos runners): issue em linha adicionada
 * reprova (fail); fora, é dívida legada (warn). Reusa addedLineSet do diff em memória.
 */
export function classifyLintIssues(entries, diags) {
  const porArquivo = new Map(entries.filter((e) => e.status !== 'D').map((e) => [e.path, e]));
  return diags.map((d) => {
    const e = porArquivo.get(d.file);
    const adicionada = Boolean(e) && addedLineSet(e).has(d.line);
    return result('lint', adicionada ? 'fail' : 'warn', 'lint.issue', { file: d.file, line: d.line, msg: d.msg });
  });
}
