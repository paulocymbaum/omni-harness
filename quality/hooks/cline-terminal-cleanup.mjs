// Limpeza de terminais antigos do Cline (roda em TODO hook do Cline, via shims .clinerules/hooks).
// Terminais integrados do VS Code são processos shell filhos do `--type=ptyhost`; matar o shell
// ocioso fecha o terminal na UI. Guardas: só shells interativos com MAIS de 1 h (ou
// CLINE_TERMINAL_MAX_AGE_SEC), SEM processo filho (terminal em uso nunca morre), whitelist
// CLINE_KEEP_TERMINAL_PIDS e desligador CLINE_TERMINAL_CLEANUP=0. Falha aberta: sem saída,
// sem lança — auditoria em quality/.state/terminal-cleanup.log.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const SHELL_RE = /(^|\/)(bash|zsh|sh|fish|pwsh|powershell)( |$)/;

/** Puro: de linhas `ps -eo pid,ppid,etimes,args`, devolve os PIDs a encerrar. */
export function selecionarAlvos(linhas, { agora = Date.now(), manter = [] } = {}) {
  const manterSet = new Set(manter.map(Number));
  const porPid = new Map();
  const filhosDe = new Map();
  const ptyhosts = new Set();
  for (const linha of linhas) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(linha);
    if (!m) continue;
    const [, pid, ppid, etimes, args] = m;
    porPid.set(Number(pid), { ppid: Number(ppid), etimes: Number(etimes), args, shell: SHELL_RE.test(` ${args} `) });
    if (args.includes('--type=ptyhost')) ptyhosts.add(Number(pid));
    if (!filhosDe.has(Number(ppid))) filhosDe.set(Number(ppid), []);
    filhosDe.get(Number(ppid)).push(Number(pid));
  }
  const temFilho = (pid) => (filhosDe.get(pid) ?? []).some((f) => porPid.has(f));
  const ehTerminalIntegrado = (proc) => proc.args.includes('shellIntegration') || ptyhosts.has(proc.ppid);
  const alvos = [];
  for (const [pid, proc] of porPid) {
    if (!proc.shell || !ehTerminalIntegrado(proc)) continue;
    if (proc.etimes <= 3600) continue;
    if (temFilho(pid)) continue;
    if (manterSet.has(pid)) continue;
    alvos.push(pid);
  }
  void agora;
  return alvos.sort((a, b) => a - b);
}

/** Roda a limpeza; nunca lança, nunca escreve no stdout (hook é transparente). */
export function limpar({ root, logPath } = {}) {
  if (process.env.CLINE_TERMINAL_CLEANUP === '0') return [];
  const maxAge = Number(process.env.CLINE_TERMINAL_MAX_AGE_SEC) || 3600;
  const manter = (process.env.CLINE_KEEP_TERMINAL_PIDS ?? '').split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
  const r = spawnSync('ps', ['-eo', 'pid,ppid,etimes,args'], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0 || !r.stdout) return [];
  const linhas = r.stdout.split('\n').slice(1);
  const alvos = selecionarAlvos(linhas, { manter });
  const encerrados = [];
  for (const pid of alvos) {
    // SIGKILL direto: shells interativos (bash/zsh) IGNORAM SIGTERM.
    const k = spawnSync('kill', ['-KILL', String(pid)], { timeout: 5_000 });
    if (k.status === 0) encerrados.push(pid);
  }
  if (encerrados.length && logPath) {
    try {
      fs.mkdirSync(logPath.slice(0, logPath.lastIndexOf('/')), { recursive: true });
      fs.appendFileSync(logPath, `${new Date().toISOString()} encerrados: ${encerrados.join(', ')} (idade > ${maxAge}s)\n`);
    } catch { /* auditoria é melhor-esforço */ }
  }
  return encerrados;
}

const executadoDireto = process.argv[1] && process.argv[1].endsWith('cline-terminal-cleanup.mjs');
if (executadoDireto) {
  limpar({
    logPath: `${process.env.QUALITY_STATE_DIR ?? 'quality/.state'}/terminal-cleanup.log`,
  });
}
