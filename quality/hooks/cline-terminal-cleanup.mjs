// Limpeza de terminais antigos do Cline (roda em TODO hook do Cline, via shims .clinerules/hooks).
// Terminais integrados do VS Code/Cursor são processos shell filhos do pty host (ou com a
// assinatura shellIntegration nos args). Dois limiares: terminal GERADO PELO CLINE (marcador
// CLINE_* no /proc/<pid>/environ) morre ocioso após idadeCline (600 s padrão; env
// CLINE_TERMINAL_MAX_AGE_SEC sobrescreve — antes o env era no-op); terminal MANUAL do usuário
// só após 1 h. Guardas: só shell interativo, SEM processo filho vivo (terminal em uso nunca
// morre), whitelist CLINE_KEEP_TERMINAL_PIDS e desligador CLINE_TERMINAL_CLEANUP=0. Falha
// aberta: sem saída, sem lança — auditoria em quality/.state/terminal-cleanup.log.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const SHELL_RE = /(^|\/)(bash|zsh|sh|fish|pwsh|powershell)( |$)/;
const LINHA_PS = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/;
const LIMITE_MANUAL = 3600;

/** Parses das linhas de `ps`: mapa por PID, índice de filhos e conjunto de pty hosts. */
function parseLinhas(linhas) {
  const porPid = new Map();
  const filhosDe = new Map();
  const ptyhosts = new Set();
  for (const linha of linhas) {
    const m = LINHA_PS.exec(linha);
    if (!m) continue;
    const pid = Number(m[1]);
    porPid.set(pid, { ppid: Number(m[2]), etimes: Number(m[3]), args: m[4], shell: SHELL_RE.test(` ${m[4]} `) });
    if (m[4].includes('--type=ptyhost')) ptyhosts.add(pid);
    if (!filhosDe.has(Number(m[2]))) filhosDe.set(Number(m[2]), []);
    filhosDe.get(Number(m[2])).push(pid);
  }
  return { porPid, filhosDe, ptyhosts };
}

/** Puro: de linhas `ps -eo pid,ppid,etimes,args`, devolve os PIDs a encerrar. Terminais do
 * Cline (marcados via environ) usam idadeCline; os manuais do usuário, 1 h. */
export function selecionarAlvos(linhas, { manter = [], marcados = new Set(), idadeCline = 600 } = {}) {
  const manterSet = new Set(manter.map(Number));
  const { porPid, filhosDe, ptyhosts } = parseLinhas(linhas);
  const temFilho = (pid) => (filhosDe.get(pid) ?? []).some((f) => porPid.has(f));
  const ehTerminalIntegrado = (proc) => proc.args.includes('shellIntegration') || proc.args.includes('shell-integration') || ptyhosts.has(proc.ppid);
  const alvos = [];
  for (const [pid, proc] of porPid) {
    if (!proc.shell || !ehTerminalIntegrado(proc)) continue;
    if (proc.etimes <= (marcados.has(pid) ? idadeCline : LIMITE_MANUAL)) continue;
    if (temFilho(pid)) continue;
    if (manterSet.has(pid)) continue;
    alvos.push(pid);
  }
  return alvos.sort((a, b) => a - b);
}

/** PIDs de shells do lote que são terminais do Cline: variável CLINE_* no environ. */
function marcadosCline(linhas) {
  const marcados = new Set();
  for (const linha of linhas) {
    const m = LINHA_PS.exec(linha);
    if (!m || !SHELL_RE.test(` ${m[4]} `)) continue;
    let env;
    try { env = fs.readFileSync(`/proc/${m[1]}/environ`, 'utf8'); } catch { continue; }
    if (env.split('\0').some((v) => v.startsWith('CLINE_'))) marcados.add(Number(m[1]));
  }
  return marcados;
}

/** SIGKILL direto: shells interativos (bash/zsh) IGNORAM SIGTERM. */
function matar(alvos) {
  const encerrados = [];
  for (const pid of alvos) {
    const k = spawnSync('kill', ['-KILL', String(pid)], { timeout: 5_000 });
    if (k.status === 0) encerrados.push(pid);
  }
  return encerrados;
}

/** Auditoria melhor-esforço: nunca lança. */
function registrar(logPath, encerrados, idadeCline) {
  if (encerrados.length === 0 || !logPath) return;
  try {
    fs.mkdirSync(logPath.slice(0, logPath.lastIndexOf('/')), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} encerrados: ${encerrados.join(', ')} (cline > ${idadeCline}s, manual > ${LIMITE_MANUAL}s)\n`);
  } catch { /* auditoria é melhor-esforço */ }
}

/** Roda a limpeza; nunca lança, nunca escreve no stdout (hook é transparente). */
export function limpar({ logPath } = {}) {
  if (process.env.CLINE_TERMINAL_CLEANUP === '0') return [];
  const idadeCline = Number(process.env.CLINE_TERMINAL_MAX_AGE_SEC) || 600;
  const manter = (process.env.CLINE_KEEP_TERMINAL_PIDS ?? '').split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
  const r = spawnSync('ps', ['-eo', 'pid,ppid,etimes,args'], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0 || !r.stdout) return [];
  const linhas = r.stdout.split('\n').slice(1);
  const alvos = selecionarAlvos(linhas, { manter, marcados: marcadosCline(linhas), idadeCline });
  const encerrados = matar(alvos);
  registrar(logPath, encerrados, idadeCline);
  return encerrados;
}

const executadoDireto = process.argv[1] && process.argv[1].endsWith('cline-terminal-cleanup.mjs');
if (executadoDireto) {
  limpar({
    logPath: `${process.env.QUALITY_STATE_DIR ?? 'quality/.state'}/terminal-cleanup.log`,
  });
}
