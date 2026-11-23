// Reescrita de comandos para `rtk <cmd>` (saída compacta) fora do Claude Code. O Claude usa
// `rtk hook claude` (pre-bash-rtk.mjs); o Cline CLI/SDK aceita `overrideInput` no hook
// PreToolUse, então o adaptador do Cline reescreve o input com o veredito do `rtk hook check`.
// Sem o binário `rtk`, com RTK_DISABLED=1 ou em qualquer erro: devolve o comando original.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { splitCommands, words } from './shell.mjs';
import { stripPrefixes } from './shell-search.mjs';

const onPath = (bin, env) => (env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));

const INFO_FLAGS = new Set(['--version', '--help', '-V']);

/**
 * Comandos de informação (`--version`, `--help`) não devem ser reescritos: o rtk os troca por um
 * subcomando próprio que imprime OUTRA coisa (visto: `npx eslint --version` virou `rtk lint --version`).
 */
export function shouldRewrite(command) {
  return !splitCommands(command ?? '').some((segment) => stripPrefixes(words(segment)).some((w) => INFO_FLAGS.has(w)));
}

/** Saída do `rtk hook claude` para o payload bruto do PreToolUse, ou null (sem rtk, desligado, erro ou sem reescrita). */
export function rtkClaudeHook(raw, env = process.env) {
  if (env.RTK_DISABLED === '1' || !raw?.trim() || !onPath('rtk', env)) return null;
  try {
    if (!shouldRewrite(JSON.parse(raw).tool_input?.command)) return null;
    const r = spawnSync('rtk', ['hook', 'claude'], { input: raw, encoding: 'utf8', timeout: 5000, env });
    return r.status === 0 && r.stdout.trim() ? r.stdout : null;
  } catch {
    return null;
  }
}

/** Comando reescrito pelo rtk, ou null quando não há reescrita (ou o rtk não está disponível). */
export function rtkRewrite(command, env = process.env) {
  if (!command || env.RTK_DISABLED === '1' || !onPath('rtk', env) || !shouldRewrite(command)) return null;
  try {
    const r = spawnSync('rtk', ['hook', 'check', command], { encoding: 'utf8', timeout: 5000, env });
    const out = r.stdout.trim();
    return r.status === 0 && out && out !== command ? out : null;
  } catch {
    return null;
  }
}

/**
 * Aplica `fn(comando) → novo | null` aos comandos de string de um input de run_commands,
 * preservando o formato original (string, array, {commands}, {command}, {cmd}).
 * Entradas estruturadas ({command, args}) não são tocadas. Devolve { changed, input }.
 */
export function mapCommands(input, fn) {
  let changed = false;
  const apply = (cmd) => {
    const next = typeof cmd === 'string' ? fn(cmd) : null;
    if (next) changed = true;
    return next ?? cmd;
  };
  const walk = (v) => {
    if (typeof v === 'string') return apply(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      if (v.commands !== undefined) return { ...v, commands: walk(v.commands) };
      if (typeof v.command === 'string' && v.args === undefined) return { ...v, command: apply(v.command) };
      if (typeof v.cmd === 'string') return { ...v, cmd: apply(v.cmd) };
    }
    return v;
  };
  const result = walk(input);
  return { changed, input: result };
}
