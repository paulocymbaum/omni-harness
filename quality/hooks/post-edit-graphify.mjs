#!/usr/bin/env node
// PostToolUse (Edit|Write|MultiEdit|NotebookEdit) do Claude Code: depois de editar CÓDIGO, atualiza
// o grafo do graphify em segundo plano (`graphify-build --update`, incremental, offline, sob o teto
// de memória e CPU). Sem isso o grafo envelhece e o agente conclui que um símbolo novo "não existe".
// Debounce de 10 min (lock), só com grafo já gerado e a CLI instalada. FLUXO_GRAPH_AUTOUPDATE=0
// desliga. Falha aberta: nunca bloqueia a edição.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readStdinJson, repoRoot } from '../lib/util.mjs';
import { PROFILE } from '../lib/profile.mjs';
import { envOff } from '../lib/env.mjs';
import { isMain } from '../lib/is-main.mjs';
import { graphifyAvailable } from '../lib/search-guard.mjs';
import { healGraphLink } from '../lib/graph-storage.mjs';

export const DEBOUNCE_MS = 10 * 60 * 1000;
const CODE_EXTENSIONS = /\.(dart|cs|ts|tsx|js|mjs|cjs|py|swift|kt|java)$/;
// Globs de exclusão do grafo vêm do perfil do projeto (R1).
const NOT_IN_GRAPH = new RegExp(PROFILE.graphify.exclude || '^$');

const lockAge = (file, now) => { try { return now - statSync(file).mtimeMs; } catch { return Infinity; } };

/** Rel a ser excluído do grafo (docs/assets/… do perfil). Exportado para o gate. */
export function notInGraph(rel) {
  return NOT_IN_GRAPH.test(rel);
}

/** Decide se esta edição deve disparar a atualização do grafo (puro quanto ao disparo). */
export function planUpdate({ root, rel, env = process.env, now = Date.now() }) {
  if (envOff('GRAPH_AUTOUPDATE', env) || env.GRAPHIFY_HOOK_STRICT === '0') return { action: 'off' };
  if (!rel || rel.startsWith('..') || !CODE_EXTENSIONS.test(rel) || notInGraph(rel)) return { action: 'ignore' };
  healGraphLink(root, env);
  if (!existsSync(path.join(root, 'graphify-out', 'graph.json')) || !graphifyAvailable(env)) return { action: 'no-graph' };
  const lock = path.join(root, '.claude', '.state', 'graphify-update.lock');
  if (lockAge(lock, now) < DEBOUNCE_MS) return { action: 'debounced' };
  return { action: 'update', lock };
}

function main() {
  const input = readStdinJson();
  const file = input.tool_input?.file_path;
  if (!file) return;
  const root = repoRoot();
  const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  const plan = planUpdate({ root, rel });
  if (plan.action !== 'update') return;
  mkdirSync(path.dirname(plan.lock), { recursive: true });
  writeFileSync(plan.lock, String(Date.now()));
  const log = openSync(path.join(root, '.claude', '.state', 'graphify-update.log'), 'a');
  spawn(process.execPath, [path.join(root, 'quality', 'agents', 'graphify-build.mjs'), '--update'], { cwd: root, detached: true, stdio: ['ignore', log, log] }).unref();
}

if (isMain(import.meta.url)) {
  try { main(); } catch { /* falha aberta */ }
  process.exit(0);
}
