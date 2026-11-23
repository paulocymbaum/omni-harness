// Teto de recursos dos gates e do build do graphify: poupar CPU e memória mesmo que demore
// mais, sem mudar o que é verificado. Três camadas que se reforçam:
//  1. escopo cgroup do systemd (--user --scope): MemoryMax é o teto duro (estourou, o processo é
//     encerrado na hora e o gate REPROVA com tool.oom) e CPUQuota limita os núcleos, para toda a
//     árvore. NÃO usar MemoryHigh: sem swap ele estrangula em vez de matar e o gate fica rastejando
//     por minutos sem terminar (medido: >40 s preso contra 0,14 s para morrer só com MemoryMax);
//  2. prioridade mínima (nice, ionice idle) e limites por ferramenta (workers, heap do Node,
//     GC do .NET), via variáveis de ambiente e flags;
//  3. os tetos de tempo dos gates escalam por `timeFactor`, para que um gate lento não estoure
//     o prazo e vire "não medido" (isso seria um bypass disfarçado).
// Sem systemd-run/cgroup (macOS, contêiner, sem sessão de usuário): segue só com 2 e 3 e avisa.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONFIG = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'config', 'resources.json');
const DEFAULTS = { memoryMaxMB: 3072, cpuQuotaPercent: 200, workers: 2, nodeHeapMB: 1536, nice: 19, timeFactor: 3, toolHeapMB: { tsc: 2048 } };

const positive = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : fallback);

/** Configuração efetiva (arquivo + variáveis de ambiente). `enabled: false` em CI ou com QUALITY_RESOURCES=off. */
export function loadLimits(env = process.env) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { /* usa os padrões */ }
  const merged = { ...DEFAULTS, ...file };
  const memoryMaxMB = positive(env.QUALITY_MEM_MAX_MB, positive(merged.memoryMaxMB, DEFAULTS.memoryMaxMB));
  return {
    enabled: env.QUALITY_RESOURCES !== 'off' && env.CI !== 'true',
    memoryMaxMB,
    cpuQuotaPercent: positive(env.QUALITY_CPU_QUOTA, positive(merged.cpuQuotaPercent, DEFAULTS.cpuQuotaPercent)),
    workers: positive(env.QUALITY_WORKERS, positive(merged.workers, DEFAULTS.workers)),
    nodeHeapMB: positive(merged.nodeHeapMB, DEFAULTS.nodeHeapMB),
    nice: Math.min(19, Math.max(0, positive(merged.nice, DEFAULTS.nice))),
    timeFactor: positive(merged.timeFactor, DEFAULTS.timeFactor),
    toolHeapMB: { ...DEFAULTS.toolHeapMB, ...(merged.toolHeapMB ?? {}) },
  };
}

/** Os limites já estão valendo neste processo (ele roda dentro do escopo ou já se limitou)? */
export const isLimited = (env = process.env) => env.QUALITY_LIMITED === '1';

/** Fator de escala dos tetos de tempo: 1 sem limites, `timeFactor` com limites. */
export function timeFactor(env = process.env) {
  const limits = loadLimits(env);
  return limits.enabled && isLimited(env) ? limits.timeFactor : 1;
}

/** Flags de paralelismo por ferramenta; vazias quando os limites estão desligados. */
export function workerFlags(env = process.env) {
  const limits = loadLimits(env);
  if (!limits.enabled || !isLimited(env)) return { vitest: [], flutter: [], nodeTest: [], dotnetBuild: [] };
  const n = String(limits.workers);
  return {
    vitest: [`--maxWorkers=${n}`],
    flutter: [`--concurrency=${n}`],
    nodeTest: [`--test-concurrency=${n}`],
    dotnetBuild: ['-m:1', '-p:UseSharedCompilation=false'],
  };
}

/** Variáveis de ambiente para os processos filhos (heap do Node, threads, GC do .NET); `tool` escolhe o heap da ferramenta. */
export function childEnv(env = process.env, tool = null) {
  const limits = loadLimits(env);
  if (!limits.enabled || !isLimited(env)) return {};
  const nodeOptions = env.NODE_OPTIONS ?? '';
  const heapMB = positive(env.QUALITY_NODE_HEAP_MB, limits.toolHeapMB[tool] ?? limits.nodeHeapMB);
  const heap = /--max-old-space-size=/.test(nodeOptions) ? nodeOptions : `${nodeOptions} --max-old-space-size=${heapMB}`.trim();
  return {
    NODE_OPTIONS: heap,
    UV_THREADPOOL_SIZE: String(limits.workers),
    DOTNET_gcServer: '0',
    DOTNET_GCHeapHardLimit: `0x${Math.floor((limits.memoryMaxMB * 1024 * 1024) / 2).toString(16)}`,
    MSBUILDDISABLENODEREUSE: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  };
}

/** Argumentos do systemd-run que criam o escopo com teto de memória e CPU. */
export function scopeArgs(limits) {
  return [
    '--user', '--scope', '--quiet',
    '-p', `MemoryMax=${limits.memoryMaxMB}M`,
    '-p', 'MemorySwapMax=0',
    // Padrão (stop): ao matar UM processo por memória o systemd derruba o escopo INTEIRO, inclusive o
    // próprio run.mjs, e nenhum gate é reportado. `continue` mata só o culpado e o gate reprova (tool.oom).
    '-p', 'OOMPolicy=continue',
    '-p', `CPUQuota=${limits.cpuQuotaPercent}%`,
  ];
}

let probed;
/** O systemd-run consegue criar um escopo de usuário com limites aqui? (testa uma vez por processo) */
export function scopeAvailable(limits, env = process.env) {
  if (probed !== undefined) return probed;
  const r = spawnSync('systemd-run', [...scopeArgs(limits), 'true'], { env, stdio: 'ignore', timeout: 10_000 });
  return (probed = r.status === 0);
}

/** Prioridade mínima de CPU e de disco para este processo (os filhos herdam). Melhor esforço. */
export function lowerPriority(limits = loadLimits()) {
  if (!limits.enabled) return;
  try { os.setPriority(0, limits.nice); } catch { /* sem permissão ou plataforma sem suporte */ }
  try { spawnSync('ionice', ['-c', '3', '-p', String(process.pid)], { stdio: 'ignore', timeout: 3000 }); } catch { /* ionice ausente */ }
}

/**
 * Chamar no início de um CLI pesado. Com limites ligados e fora do escopo, relança o próprio
 * CLI dentro do escopo cgroup e sai com o código dele; sem cgroup, aplica prioridade e variáveis
 * e segue. Devolve true quando o processo deve continuar a execução normal.
 */
export function enforceLimits({ argv = process.argv.slice(1), env = process.env, stderr = process.stderr } = {}) {
  const limits = loadLimits(env);
  if (!limits.enabled || isLimited(env)) { if (isLimited(env)) lowerPriority(limits); return true; }
  const childEnvVars = { ...env, QUALITY_LIMITED: '1' };
  if (scopeAvailable(limits, env)) {
    const r = spawnSync('systemd-run', [...scopeArgs(limits), 'nice', '-n', String(limits.nice), process.execPath, ...argv], { stdio: 'inherit', env: childEnvVars });
    process.exit(r.status ?? (r.signal === 'SIGKILL' ? 137 : 1));
  }
  stderr.write('Aviso: escopo cgroup indisponível (systemd-run --user); seguindo sem teto rígido de memória, só com prioridade mínima, workers e heap limitados.\n');
  process.env.QUALITY_LIMITED = '1';
  lowerPriority(limits);
  return true;
}

/** Quantas vezes o kernel encerrou processos DESTE escopo por falta de memória (memory.events); null se ilegível. */
export function cgroupOomKills() {
  try {
    const cg = fs.readFileSync('/proc/self/cgroup', 'utf8').trim().split(':').pop();
    const events = fs.readFileSync(`/sys/fs/cgroup${cg}/memory.events`, 'utf8');
    return Number(/^oom_kill (\d+)$/m.exec(events)?.[1] ?? 0);
  } catch { return null; }
}

/** O Node encerrou por estourar o próprio heap (--max-old-space-size), sem relação com a cgroup. */
export const isHeapOom = (r) => /JavaScript heap out of memory/i.test(`${r?.stderr ?? ''}${r?.stdout ?? ''}`.slice(-4000));

/** O filho foi morto por falta de memória (cgroup, kernel ou heap do V8)? Heurística: prefira cgroupOomKills. */
export function isOutOfMemory(r) {
  if (!r) return false;
  if (r.code === 137 || r.code === 134 || r.signal === 'SIGKILL') return true;
  return /JavaScript heap out of memory|Cannot allocate memory|std::bad_alloc|OutOfMemory/i.test(`${r.stderr ?? ''}${r.stdout ?? ''}`.slice(-4000));
}
