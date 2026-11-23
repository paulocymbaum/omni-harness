#!/usr/bin/env node
// F5 — bench comparativo dos caminhos quentes do motor (docs/parking-lot/plano-performance.md).
// Fixtures sintéticos, sem toolchain obrigatória (lizard/dart ausentes = caminhos inertes).
// Uso: node scripts/dev/perf-compara.mjs [--arquivos 30]
import { performance } from 'node:perf_hooks';
import { tempRepo } from '../../quality/test/helpers.mjs';
import { batchFastGates, fastGates } from '../../quality/lib/gates/fast.mjs';
import { collectEntries, diffGlobal, diffTexts, fileAtRev, readWorking, headSha } from '../../quality/lib/git.mjs';
import { parseColonDiag, scanScope } from '../../quality/lib/runners/common.mjs';

const arg = (nome, def) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i !== -1 ? Number(process.argv[i + 1]) || def : def;
};
const N = arg('arquivos', 30);
const seg = (t0) => `${((performance.now() - t0) / 1000).toFixed(2)} s`;
const linha = (nome, t0, extra = '') => console.log(`${nome.padEnd(52)} ${seg(t0)} ${extra}`);
const dart = (i) => `class C${i} {\n  int m(int a) {\n    var t = 0;\n    for (var i = 0; i < a; i++) {\n      if (i % 2 == 0) {\n        t += i;\n      } else {\n        t -= i;\n      }\n    }\n    return t;\n  }\n}\n`;
const ts = (i) => `export function f${i}(x: number): number {\n  return x + ${i};\n}\n`;

console.log(`perf-compara — ${N} arquivos por cenário\n`);
const darTabela = false;

// 1) tier rápido: batch vs por-entry (mesmos arquivos, mesmo processo)
const entriesDart = Array.from({ length: N }, (_, i) => ({ path: `lib/f${i}.dart`, status: 'M', newText: dart(i), oldText: null, added: [] }));
let t0 = performance.now();
for (const e of entriesDart) fastGates(e);
const porEntry = seg(t0);
t0 = performance.now();
const loteRes = batchFastGates(entriesDart);
const lote = seg(t0);
console.log(`${'tier rápido: por-entry vs batchFastGates (dart)'.padEnd(52)} ${porEntry} → ${lote} (${(N && loteRes.length) ? `${loteRes.length} resultados` : ''})`);

// 2) collectEntries: diff por arquivo (antigo) vs diff global (EG1) em repo temporário
const repo = tempRepo(Object.fromEntries(Array.from({ length: N }, (_, i) => [`svc/f${i}.ts`, ts(i)])));
try {
  for (let i = 0; i < N; i++) repo.write(`svc/f${i}.ts`, `${ts(i)}export const extra${i} = 1;\n`);
  const base = headSha(repo.dir);
  const paths = Array.from({ length: N }, (_, i) => `svc/f${i}.ts`);
  t0 = performance.now();
  for (const p of paths) diffTexts(fileAtRev(base, p, repo.dir), readWorking(p, repo.dir));
  const antigo = seg(t0);
  t0 = performance.now();
  const mapa = diffGlobal(repo.dir, base);
  for (const p of paths) if ((mapa.get(p) ?? { added: [] }).added.length === 0) throw new Error('hunk ausente');
  const global = seg(t0);
  console.log(`${'collectEntries: diff por arquivo vs diff global (ts)'.padEnd(52)} ${antigo} → ${global} (ganho ${(Number(antigo.replace(' s', '')) / Number(global.replace(' s', ''))).toFixed(1)}x)`);
  t0 = performance.now();
  const entries = collectEntries({ root: repo.dir, base: 'HEAD' });
  linha('collectEntries end-to-end', t0, `— ${entries.length} entries`);
} finally {
  repo.cleanup();
}

// 3) parsers por stack (puros)
const diag10k = Array.from({ length: 10000 }, (_, i) => `src/f${i % 500}.go:${(i % 400) + 1}:5: warning: msg ${i}`).join('\n');
t0 = performance.now();
parseColonDiag(diag10k);
linha('parseColonDiag 10k linhas', t0);
const grandes = Array.from({ length: 50000 }, (_, i) => ({ path: `svc/f${i}.go`, status: 'M' }));
t0 = performance.now();
scanScope(grandes, 'svc', /\.go$/);
linha('scanScope 50k entries', t0);
