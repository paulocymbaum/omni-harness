// Testes do teto de recursos dos gates e do graphify: configuração, ambiente dos filhos,
// escalonamento de tempo, reprovação por falta de memória (nunca "não medido"), relançamento
// no escopo cgroup (falso e real, incluindo um OOM de verdade) e o motor sob limites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { QUALITY_DIR, tempRepo, runScript } from './helpers.mjs';
import { loadLimits, childEnv, workerFlags, timeFactor, scopeArgs, isOutOfMemory, scopeAvailable } from '../lib/limits.mjs';
import { step, Budget } from '../lib/runners/common.mjs';
import { graphifyArgs } from '../agents/graphify-build.mjs';

const LIMITED = { QUALITY_LIMITED: '1' };
const LIMITS_MJS = path.join(QUALITY_DIR, 'lib', 'limits.mjs');

test('configuração: padrões do arquivo, sobrescritas por ambiente e desligamento', () => {
  const base = loadLimits({});
  assert.equal(base.enabled, true);
  assert.deepEqual([base.memoryMaxMB, base.cpuQuotaPercent, base.workers, base.nice, base.timeFactor], [3072, 200, 2, 19, 3]);
  assert.equal(base.memoryHighMB, undefined, 'MemoryHigh estrangula sem matar e prende o gate: não pode existir');
  const tuned = loadLimits({ QUALITY_MEM_MAX_MB: '1024', QUALITY_CPU_QUOTA: '100', QUALITY_WORKERS: '1' });
  assert.deepEqual([tuned.memoryMaxMB, tuned.cpuQuotaPercent, tuned.workers], [1024, 100, 1]);
  assert.equal(loadLimits({ QUALITY_MEM_MAX_MB: 'abc' }).memoryMaxMB, 3072); // inválido volta ao padrão
  assert.equal(loadLimits({ QUALITY_MEM_MAX_MB: '-5' }).memoryMaxMB, 3072);
  assert.equal(loadLimits({ QUALITY_RESOURCES: 'off' }).enabled, false);
  assert.equal(loadLimits({ CI: 'true' }).enabled, false);
  const file = JSON.parse(fs.readFileSync(path.join(QUALITY_DIR, 'config', 'resources.json'), 'utf8'));
  for (const key of ['memoryMaxMB', 'cpuQuotaPercent', 'workers', 'nodeHeapMB', 'nice', 'timeFactor']) assert.ok(file[key] > 0, key);
});

test('ambiente dos filhos: heap do Node, threads e GC do .NET só com limites ativos', () => {
  assert.deepEqual(childEnv({}), {}); // fora do escopo não altera nada
  assert.deepEqual(childEnv({ ...LIMITED, QUALITY_RESOURCES: 'off' }), {});
  const env = childEnv({ ...LIMITED });
  assert.match(env.NODE_OPTIONS, /--max-old-space-size=1536/);
  assert.equal(env.UV_THREADPOOL_SIZE, '2');
  assert.equal(env.DOTNET_gcServer, '0');
  assert.equal(env.DOTNET_GCHeapHardLimit, `0x${(1536 * 1024 * 1024).toString(16)}`);
  // preserva NODE_OPTIONS existente e não duplica um teto de heap já definido
  assert.equal(childEnv({ ...LIMITED, NODE_OPTIONS: '--max-old-space-size=512' }).NODE_OPTIONS, '--max-old-space-size=512');
  assert.match(childEnv({ ...LIMITED, NODE_OPTIONS: '--trace-warnings' }).NODE_OPTIONS, /^--trace-warnings --max-old-space-size=1536$/);
});

test('flags por ferramenta e fator de tempo: só valem sob limites', () => {
  assert.deepEqual(workerFlags({}), { vitest: [], flutter: [], nodeTest: [], dotnetBuild: [] });
  assert.equal(timeFactor({}), 1);
  const on = workerFlags({ ...LIMITED, QUALITY_WORKERS: '3' });
  assert.deepEqual(on.vitest, ['--maxWorkers=3']);
  assert.deepEqual(on.flutter, ['--concurrency=3']);
  assert.deepEqual(on.nodeTest, ['--test-concurrency=3']);
  assert.ok(on.dotnetBuild.includes('-m:1'));
  assert.equal(timeFactor({ ...LIMITED }), 3);
  assert.equal(timeFactor({ ...LIMITED, QUALITY_RESOURCES: 'off' }), 1);
});

test('escopo do systemd: teto duro, sem swap e cota de CPU, e nunca MemoryHigh', () => {
  const args = scopeArgs(loadLimits({ QUALITY_MEM_MAX_MB: '2048', QUALITY_CPU_QUOTA: '150' })).join(' ');
  for (const part of ['--user', '--scope', 'MemoryMax=2048M', 'MemorySwapMax=0', 'CPUQuota=150%', 'OOMPolicy=continue']) assert.ok(args.includes(part), part);
  assert.ok(!args.includes('MemoryHigh'), 'MemoryHigh trava o gate sem encerrá-lo');
});

test('isOutOfMemory reconhece kill do cgroup, abort do V8 e mensagens de falta de memória', () => {
  assert.equal(isOutOfMemory({ code: 137 }), true);
  assert.equal(isOutOfMemory({ code: null, signal: 'SIGKILL' }), true);
  assert.equal(isOutOfMemory({ code: 134, stderr: '' }), true);
  assert.equal(isOutOfMemory({ code: 1, stderr: 'FATAL ERROR: Reached heap limit - JavaScript heap out of memory' }), true);
  assert.equal(isOutOfMemory({ code: 1, stderr: 'AssertionError: 1 !== 2' }), false);
  assert.equal(isOutOfMemory({ code: 0, stdout: '' }), false);
  assert.equal(isOutOfMemory(null), false);
});

// ---- o passo dos gates ------------------------------------------------------------------

function withLimitedEnv(fn) {
  const before = process.env.QUALITY_LIMITED;
  process.env.QUALITY_LIMITED = '1';
  try { return fn(); } finally { if (before === undefined) delete process.env.QUALITY_LIMITED; else process.env.QUALITY_LIMITED = before; }
}
const node = (code) => [process.execPath, ['-e', code]];

test('passo sem prova de OOM da cgroup (kill manual, abort) NÃO é rotulado como falta de memória', () => {
  withLimitedEnv(() => {
    for (const code of ["process.kill(process.pid, 'SIGKILL')", 'process.abort()']) {
      const out = [];
      const r = step(out, new Budget(60_000), 'passo', ...node(code));
      assert.ok(r && r.code !== 0, 'segue como falha comum, devolvida ao gate');
      assert.equal(out.length, 0, 'não vira tool.oom sem o contador oom_kill da cgroup');
    }
  });
});

test('estouro do heap do Node REPROVA o gate com tool.oomHeap (e nunca passa nem vira aviso)', () => {
  withLimitedEnv(() => {
    const out = [];
    const r = step(out, new Budget(120_000), 'tsc teste', process.execPath, ['--max-old-space-size=24', '-e', 'const a = []; for (;;) a.push(new Array(1e6).fill(1));']);
    assert.equal(r, null);
    assert.deepEqual([out[0].status, out[0].key], ['fail', 'tool.oomHeap']);
  });
});

test('saída acima do buffer reprova com tool.outputLimit (antes virava "timeout", ou seja, não medido)', () => {
  withLimitedEnv(() => {
    const out = [];
    const r = step(out, new Budget(120_000), 'ruidoso', ...node("process.stdout.write('x'.repeat(70 * 1024 * 1024))"));
    assert.equal(r, null);
    assert.deepEqual([out[0].status, out[0].key], ['fail', 'tool.outputLimit']);
  });
});

test('heap por ferramenta: tsc ganha mais que o padrão; QUALITY_NODE_HEAP_MB sobrescreve; nada fora dos limites', () => {
  const env = { QUALITY_LIMITED: '1' };
  assert.match(childEnv(env, 'tsc').NODE_OPTIONS, /--max-old-space-size=2048/);
  assert.match(childEnv(env, 'vitest').NODE_OPTIONS, /--max-old-space-size=1536/);
  assert.match(childEnv({ ...env, QUALITY_NODE_HEAP_MB: '900' }, 'tsc').NODE_OPTIONS, /--max-old-space-size=900/);
  assert.deepEqual(childEnv({}, 'tsc'), {});
});

test('falha comum de teste continua sendo devolvida ao gate, não confundida com OOM', () => {
  withLimitedEnv(() => {
    const out = [];
    const r = step(out, new Budget(60_000), 'x', ...node('process.exit(1)'));
    assert.equal(r.code, 1);
    assert.equal(out.length, 0);
  });
});

test('o teto de tempo escala com os limites: o mesmo passo lento passa, sem virar "não medido"', () => {
  const slow = node('setTimeout(() => {}, 1500)');
  const unlimited = [];
  assert.equal(step(unlimited, new Budget(60_000), 'lento', ...slow, { capMs: 1000 }), null); // 1 s < 1,5 s
  assert.equal(unlimited[0].key, 'tool.timeout');
  withLimitedEnv(() => {
    const out = [];
    const r = step(out, new Budget(60_000), 'lento', ...slow, { capMs: 1000 }); // 1 s × 3
    assert.equal(r.code, 0);
    assert.equal(out.length, 0);
  });
});

// ---- relançamento no escopo ---------------------------------------------------------------

function probeScript(dir, body = '') {
  const file = path.join(dir, 'probe.mjs');
  fs.writeFileSync(file, `import os from 'node:os';\nimport fs from 'node:fs';\nimport { enforceLimits } from ${JSON.stringify(LIMITS_MJS)};\nenforceLimits();\nconsole.log(JSON.stringify({ limited: process.env.QUALITY_LIMITED, nice: os.getPriority(), nodeOptions: process.env.NODE_OPTIONS ?? null }));\n${body}\n`);
  return file;
}

const probe = (file, env) => spawnSync(process.execPath, [file], { encoding: 'utf8', env, timeout: 60_000 });
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').find((l) => l.startsWith('{')));

test('enforceLimits relança dentro do escopo (systemd-run falso) com prioridade mínima e marca o filho', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-'));
  try {
    const log = path.join(dir, 'calls.log');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // Simula o systemd-run: registra os argumentos, aceita a sonda (`true`) e executa o resto (nice … node …).
    fs.writeFileSync(path.join(bin, 'systemd-run'), `#!/bin/sh\necho "$@" >> "${log}"\nwhile [ "$1" != nice ] && [ "$1" != true ]; do shift; done\n[ "$1" = true ] && exit 0\nexec "$@"\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, QUALITY_MEM_MAX_MB: '2000' };
    delete env.QUALITY_LIMITED; delete env.CI;
    const r = probe(probeScript(dir), env);
    assert.equal(r.status, 0, r.stderr);
    const info = lastJson(r.stdout);
    assert.equal(info.limited, '1');
    assert.equal(info.nice, 19);
    const calls = fs.readFileSync(log, 'utf8');
    assert.match(calls, /MemoryMax=2000M/);
    assert.match(calls, /CPUQuota=200%/);
    assert.match(calls, /nice -n 19/);
    assert.equal(calls.trim().split('\n').length, 2, 'uma sonda e um relançamento, sem laço');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sem systemd-run: avisa, segue com prioridade mínima e marca o processo (sem teto rígido)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-'));
  try {
    const env = { PATH: path.join(dir, 'vazio'), HOME: os.homedir() };
    const r = probe(probeScript(dir), env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /escopo cgroup indisponível/);
    const info = lastJson(r.stdout);
    assert.equal(info.limited, '1');
    assert.equal(info.nice, 19);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('com QUALITY_RESOURCES=off nada é limitado nem relançado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-'));
  try {
    const r = probe(probeScript(dir), { ...process.env, QUALITY_RESOURCES: 'off', QUALITY_LIMITED: '' });
    const info = lastJson(r.stdout);
    assert.equal(r.stderr, '');
    assert.notEqual(info.limited, '1');
    assert.equal(info.nice, os.getPriority());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- cgroup real (pula onde o systemd de usuário não está disponível) -----------------------

const REAL = scopeAvailable(loadLimits({}));
const cgroupMax = "const cg = fs.readFileSync('/proc/self/cgroup', 'utf8').trim().split(':').pop();\nconst read = (f) => { try { return fs.readFileSync('/sys/fs/cgroup' + cg + '/' + f, 'utf8').trim(); } catch { return null; } };\nconsole.log(JSON.stringify({ memoryMax: read('memory.max'), memoryHigh: read('memory.high'), swapMax: read('memory.swap.max'), cpuMax: read('cpu.max') }));";

test('cgroup real: o escopo aplica MemoryMax, sem MemoryHigh, sem swap e CPUQuota', { skip: !REAL && 'systemd --user indisponível' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-'));
  try {
    const env = { ...process.env, QUALITY_MEM_MAX_MB: '1000', QUALITY_CPU_QUOTA: '150' };
    delete env.QUALITY_LIMITED; delete env.CI;
    const r = probe(probeScript(dir, cgroupMax), env);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    const cg = lines.find((l) => 'memoryMax' in l);
    assert.equal(cg.memoryMax, String(1000 * 1024 * 1024));
    assert.equal(cg.memoryHigh, 'max'); // sem estrangulamento
    assert.equal(cg.swapMax, '0');
    assert.match(cg.cpuMax, /^150000 100000$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cgroup real: estourar o teto encerra o escopo NA HORA (137, em segundos) e o gate reprova por OOM', { skip: !REAL && 'systemd --user indisponível' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-'));
  try {
    const eat = "const hold = []; for (let i = 0; i < 40; i++) { hold.push(Buffer.alloc(16 * 1024 * 1024, 1)); }\nconsole.log('NAO_DEVERIA_CHEGAR');";
    const env = { ...process.env, QUALITY_MEM_MAX_MB: '128' };
    delete env.QUALITY_LIMITED; delete env.CI;
    const t0 = Date.now();
    const r = probe(probeScript(dir, eat), env);
    assert.ok(Date.now() - t0 < 15_000, `precisa morrer rápido, levou ${Date.now() - t0} ms (sinal de estrangulamento)`);
    assert.notEqual(r.status, 0, 'alocar 640 MB sob teto de 128 MB precisa ser encerrado');
    assert.doesNotMatch(r.stdout, /NAO_DEVERIA_CHEGAR/);
    assert.equal(isOutOfMemory({ code: r.status, signal: r.signal, stderr: r.stderr, stdout: '' }), true, `status=${r.status} signal=${r.signal}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- o motor e o graphify sob limites ----------------------------------------------------------

test('motor de gates (nível rotina) roda sob limites e continua aprovando e reprovando como antes', () => {
  const repo = tempRepo({ 'README.md': '# x\n' });
  try {
    repo.write('quality/exemplo.mjs', 'export const soma = (a, b) => a + b;\n');
    const ok = runScript(repo, 'run.mjs', null, ['--tier', 'rotina', '--files', 'quality/exemplo.mjs']);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /todos os gates aprovados/);
    // um gate de verdade continua reprovando: função nova acima da complexidade máxima
    const branches = Array.from({ length: 26 }, (_, i) => `  if (x === ${i}) return ${i};`).join('\n');
    repo.write('quality/complexo.mjs', `export function f(x) {\n${branches}\n  return -1;\n}\n`);
    const bad = runScript(repo, 'run.mjs', null, ['--tier', 'rotina', '--files', 'quality/complexo.mjs']);
    assert.equal(bad.code, 1, bad.stdout);
    assert.match(bad.stdout, /REPROVADO/);
  } finally { repo.cleanup(); }
});

test('graphify-build: modos e teto de workers', () => {
  assert.deepEqual(graphifyArgs(false, 2), ['extract', '.', '--code-only', '--no-viz', '--max-workers', '2']);
  assert.deepEqual(graphifyArgs(true, 2), ['update', '.']);
  assert.ok(!graphifyArgs(false, 1).includes('--mode')); // nunca o modo deep (semântico, com LLM)
});

// ---- OOM confirmado pela cgroup (real) e lizard que não mede --------------------------------

const stepProbe = (extra = '') => `
import { step, Budget } from ${JSON.stringify(path.join(QUALITY_DIR, 'lib/runners/common.mjs'))};
const out = [];
const r = step(out, new Budget(120_000), 'passo', process.execPath, ['-e', ${'`'}\${process.env.CHILD}${'`'}]);
console.log(JSON.stringify({ returned: r === null ? null : r.code, results: out.map((x) => [x.status, x.key]) }));
${extra}`;

test('cgroup real: o kernel matar o filho por memória reprova com tool.oom; abort() no mesmo escopo não', { skip: !REAL && 'systemd --user indisponível' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-'));
  try {
    const file = path.join(dir, 'probe.mjs');
    fs.writeFileSync(file, `import { enforceLimits } from ${JSON.stringify(LIMITS_MJS)};\nenforceLimits();\n${stepProbe()}`);
    const run = (child) => {
      const env = { ...process.env, QUALITY_MEM_MAX_MB: '160', CHILD: child };
      delete env.QUALITY_LIMITED; delete env.CI;
      const r = spawnSync(process.execPath, [file], { encoding: 'utf8', env, timeout: 90_000 });
      return JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop());
    };
    const eat = run("const hold = []; for (let i = 0; i < 60; i++) hold.push(Buffer.alloc(8 * 1024 * 1024, 1));");
    assert.deepEqual(eat, { returned: null, results: [['fail', 'tool.oom']] });
    const aborted = run('process.abort()');
    assert.deepEqual(aborted.results, [], 'abort() não é falta de memória');
    assert.notEqual(aborted.returned, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lizard que estoura o timeout NÃO é pulado em silêncio: o gate avisa "não medido"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liz-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'lizard'), '#!/bin/sh\n[ "$1" = "--version" ] && { echo 1.17.10; exit 0; }\nsleep 5\n', { mode: 0o755 });
    const script = path.join(dir, 'gate.mjs');
    fs.writeFileSync(script, `import { complexityGate, halsteadGate } from ${JSON.stringify(path.join(QUALITY_DIR, 'lib/gates/fast.mjs'))};
const e = { path: 'quality/lib/x.mjs', newText: 'export const a = 1;\\n', oldText: null, status: 'A', added: [], removed: [] };
console.log(JSON.stringify({ c: complexityGate(e).map((r) => [r.gate, r.status, r.key]), h: halsteadGate(e).map((r) => [r.gate, r.status, r.key]) }));`);
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, QUALITY_LIZARD_TIMEOUT_MS: '400', QUALITY_RESOURCES: 'off' };
    delete env.QUALITY_NO_LIZARD;
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout.trim());
    assert.deepEqual(got.c, [['complexidade', 'warn', 'lizard.unmeasured']]);
    assert.deepEqual(got.h, [['halstead-volume', 'warn', 'lizard.unmeasured']]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
