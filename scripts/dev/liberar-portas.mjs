#!/usr/bin/env node
// Encerra os processos que escutam uma ou mais portas TCP locais.
// Uso: node scripts/dev/liberar-portas.mjs <porta|inicio-fim>... [--dry-run] [--force] [--wait <ms>]
//   --dry-run  só lista o que seria encerrado
//   --force    SIGKILL direto (padrão: SIGTERM, espera e escala para SIGKILL)
// Segurança: só portas 1024-65535, só processos em LISTEN, nunca este processo nem seus ancestrais;
// docker-proxy é pulado (use `docker stop <contêiner>`).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const MIN_PORT = 1024;
const MAX_PORT = 65535;
const MAX_PORTS = 50;

export function parsePorts(tokens) {
  const ports = new Set();
  for (const token of tokens) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(token);
    if (!m) throw new Error(`porta inválida: "${token}" (use 8089 ou 8000-8010)`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from > to) throw new Error(`faixa invertida: "${token}"`);
    if (from < MIN_PORT || to > MAX_PORT) throw new Error(`porta fora de ${MIN_PORT}-${MAX_PORT}: "${token}"`);
    for (let p = from; p <= to; p++) ports.add(p);
    if (ports.size > MAX_PORTS) throw new Error(`mais de ${MAX_PORTS} portas de uma vez`);
  }
  if (!ports.size) throw new Error('informe ao menos uma porta');
  return [...ports].sort((a, b) => a - b);
}

/** Linhas `p<pid>` e `c<comando>` do lsof -F. Retorna [{ pid, command }]. */
export function parseLsof(output) {
  const found = [];
  let current = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) { current = { pid: Number(line.slice(1)), command: '' }; found.push(current); }
    else if (line.startsWith('c') && current) current.command = line.slice(1);
  }
  return found;
}

function listeners(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8' });
  if (r.error) throw new Error(`lsof indisponível: ${r.error.message}`);
  return parseLsof(r.stdout ?? '');
}

function ancestors() {
  const pids = new Set();
  let pid = process.pid;
  while (pid > 1 && !pids.has(pid)) {
    pids.add(pid);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { break; }
  }
  return pids;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--') && a !== '--wait'));
  const waitIdx = argv.indexOf('--wait');
  const waitMs = waitIdx >= 0 ? Number(argv[waitIdx + 1]) : 3000;
  const tokens = argv.filter((a, i) => !a.startsWith('--') && !(waitIdx >= 0 && i === waitIdx + 1));
  const dry = flags.has('--dry-run');
  const force = flags.has('--force');
  const ports = parsePorts(tokens);
  const protegidos = ancestors();
  let exitCode = 0;

  for (const port of ports) {
    const procs = listeners(port);
    if (!procs.length) { console.log(`${port}: livre`); continue; }
    for (const { pid, command } of procs) {
      if (protegidos.has(pid)) { console.log(`${port}: pulado ${command} (${pid}), é este processo ou ancestral`); continue; }
      if (command === 'docker-proxy') { console.log(`${port}: pulado docker-proxy (${pid}); use docker stop <contêiner>`); exitCode = 2; continue; }
      if (dry) { console.log(`${port}: encerraria ${command} (${pid})`); continue; }
      try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); }
      catch (e) { console.log(`${port}: falhou em ${command} (${pid}): ${e.code}`); exitCode = 1; continue; }
      if (!force) {
        for (let waited = 0; waited < waitMs && alive(pid); waited += 100) await sleep(100);
        if (alive(pid)) { process.kill(pid, 'SIGKILL'); await sleep(200); }
      }
      console.log(`${port}: ${alive(pid) ? 'AINDA VIVO' : 'encerrado'} ${command} (${pid})`);
      if (alive(pid)) exitCode = 1;
    }
  }
  return exitCode;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
}
