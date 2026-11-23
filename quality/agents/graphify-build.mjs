#!/usr/bin/env node
// Gera ou atualiza o grafo do graphify (graphify-out/) sob o teto de recursos dos gates
// (quality/config/resources.json): escopo cgroup com limite de memória e CPU, prioridade mínima
// e poucos workers. Mais lento que o `graphify extract` solto (que abre núcleos-1 processos),
// porém não trava a máquina. Só código (--code-only), sem LLM e sem chave de API.
//   node quality/agents/graphify-build.mjs            primeira geração / regeneração completa
//   node quality/agents/graphify-build.mjs --update   atualização incremental depois de editar código
import { spawnSync } from 'node:child_process';
import { childEnv, enforceLimits, loadLimits } from '../lib/limits.mjs';
import { repoRoot } from '../lib/util.mjs';
import { isMain } from '../lib/is-main.mjs';
import { ensureGraphLink } from '../lib/graph-storage.mjs';

export { ensureGraphLink, graphStorageDir } from '../lib/graph-storage.mjs';

/** Argumentos da CLI do graphify para o modo pedido. */
export function graphifyArgs(update, workers) {
  return update ? ['update', '.'] : ['extract', '.', '--code-only', '--no-viz', '--max-workers', String(workers)];
}

if (isMain(import.meta.url)) {
  enforceLimits();
  const limits = loadLimits();
  const storage = ensureGraphLink(repoRoot());
  if (storage.mode === 'link') process.stderr.write(`Grafo armazenado fora da árvore: ${storage.target}\n`);
  const probe = spawnSync('graphify', ['--help'], { stdio: 'ignore' });
  if (probe.error) {
    process.stderr.write('graphify não encontrado no PATH. Instale com: uv tool install graphifyy\n');
    process.exit(2);
  }
  const r = spawnSync('graphify', graphifyArgs(process.argv.includes('--update'), limits.workers), {
    cwd: repoRoot(),
    stdio: 'inherit',
    env: { ...process.env, ...childEnv(), GRAPHIFY_BACKEND: 'none' },
  });
  process.exit(r.status ?? 1);
}
