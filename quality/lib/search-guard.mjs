// Guarda de busca de código: o grafo do graphify (graphify-out/graph.json) é a primeira
// ferramenta de busca; Grep/Glob/`grep -r`/`rg`/`find -name` brutos são caros em tokens num
// monorepo de ~5,8 mil arquivos. A política é pura (sem I/O de hook): os adaptadores
// (pre-search-graphify.mjs e post-search-graphify.mjs para Claude Code, cline-pre-tool-use.mjs
// e cline-post-tool-use.mjs para Cline) normalizam a chamada, leem/gravam o estado e traduzem a
// decisão para o formato de cada agente.
//
// Modos (GRAPHIFY_HOOK_MODE, ou GRAPHIFY_HOOK_STRICT=0|1, no ambiente de início do agente):
//   soft   (padrão) dica de economia UMA vez por janela e a busca segue; nunca bloqueia nem aborta;
//   strict  no Claude Code a busca bruta é negada até haver consulta; no Cline só dica a cada busca
//           (cancelar no Cline PARA a tarefa inteira, então o guard nunca cancela lá);
//   off     desligado.
// Regras: (1) sem grafo ou sem a CLI `graphify`, nada acontece; (2) buscas fora do código (docs/,
// *.md, *.json…) não entram: o grafo não as cobre; (3) a janela de WINDOW_MS abre depois de
// uma consulta `graphify query|path|explain|affected|god-nodes` que TERMINOU COM SUCESSO e
// devolveu resultado (registrada no PostToolUse, nunca antes de rodar); (4) Read de arquivo
// específico nunca é tratado como busca. É um empurrão: comandos montados por variável ou eval
// passam, e o guard não substitui revisão.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzeShell, isNonCodeTarget, looksLikeFile, outside } from './shell-search.mjs';
import { healGraphLink } from './graph-storage.mjs';

export const WINDOW_MS = 30 * 60 * 1000;
const CODE_EXTENSIONS = /\.(dart|cs|ts|tsx|js|mjs|cjs|py|swift|kt|java)$/;
const FAILED_OUTPUT = /^(error:|no matching nodes|graph file not found|no path|traceback)/i;

/** Primeiro trecho de busca bruta no comando Bash, ou null. */
export function bashSearch(cmd, root = null) {
  return analyzeShell(cmd, root).searches[0] ?? null;
}

const OTHER = { kind: 'other' };
const search = (detail) => ({ kind: 'search', detail });

function shellCall(params, root) {
  const { searches, queries } = analyzeShell(params.command ?? '', root);
  if (searches.length) return search(searches[0]);
  return queries.length ? { kind: 'query', detail: queries[0] } : OTHER;
}

const parseMaybeJson = (value) => {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return value;
  try { return JSON.parse(value); } catch { return value; }
};

/** Comandos de shell de uma chamada do Cline: execute_command (extensão) ou run_commands (CLI/SDK). */
export function commandsOf(input) {
  const v = parseMaybeJson(input);
  const one = (entry) => {
    if (typeof entry === 'string') {
      const parsed = parseMaybeJson(entry); // lista serializada como string (extensão do Cline)
      return parsed === entry ? [entry] : commandsOf(parsed);
    }
    if (!entry || typeof entry !== 'object') return [];
    if (Array.isArray(entry.commands)) return entry.commands.flatMap(one);
    if (entry.commands !== undefined) return one(entry.commands);
    const cmd = entry.command ?? entry.cmd;
    if (typeof cmd !== 'string') return [];
    return [[cmd, ...(Array.isArray(entry.args) ? entry.args : [])].join(' ')];
  };
  return Array.isArray(v) ? v.flatMap(one) : one(v);
}

const NON_CODE_GLOB = (glob) => typeof glob === 'string' && glob !== '' && isNonCodeTarget(glob);
const fileTarget = (params, root) => looksLikeFile(params.path ?? '') || outside(params.path ?? '', root)
  || isNonCodeTarget(params.path ?? '') || NON_CODE_GLOB(params.glob) || NON_CODE_GLOB(params.file_pattern);
const isTrue = (v) => v === true || v === 'true';
const clineShell = (input, root) => shellCall({ command: commandsOf(input).join('\n') }, root);

/** Classificador por ferramenta: Claude Code (Bash/Grep/Glob) e Cline (execute_command/run_commands/search_*). */
const CLASSIFIERS = {
  claude: {
    Bash: shellCall,
    Grep: (p, root) => (fileTarget(p, root) ? OTHER : search(`Grep ${p.pattern ?? ''}`)),
    Glob: (p, root) => (/\*\*/.test(p.pattern ?? '') && !outside(p.pattern, root) && !outside(p.path ?? '', root) && !isNonCodeTarget(p.pattern) && !isNonCodeTarget(p.path ?? '') ? search(`Glob ${p.pattern}`) : OTHER),
  },
  cline: {
    execute_command: shellCall,
    run_commands: clineShell,
    search_codebase: () => search('search_codebase'),
    search_files: (p, root) => (fileTarget(p, root) ? OTHER : search(`search_files ${p.regex ?? ''}`)),
    list_files: (p, root) => (isTrue(p.recursive) && !outside(p.path ?? '', root) && !isNonCodeTarget(p.path ?? '') ? search(`list_files recursive ${p.path ?? ''}`) : OTHER),
  },
};

/** Normaliza a chamada de qualquer agente: { kind: 'query' | 'search' | 'other', detail }. */
export function classifyCall(host, toolName, params = {}, root = null) {
  return (CLASSIFIERS[host]?.[toolName] ?? (() => OTHER))(params, root);
}

/** A chamada de shell contém uma consulta ao graphify (mesmo junto de outros comandos)? */
const COMMAND_TEXT = {
  claude: { Bash: (p) => p.command ?? '' },
  cline: { execute_command: (p) => p.command ?? '', run_commands: (p) => commandsOf(p).join('\n') },
};

function isGraphQueryCall(host, toolName, params = {}) {
  const textOf = COMMAND_TEXT[host]?.[toolName];
  return textOf ? analyzeShell(textOf(params)).queries.length > 0 : false;
}

/** Saída de consulta que serve de resposta: não vazia e sem as mensagens de falha do graphify. */
function usefulGraphOutput(output) {
  if (output === undefined || output === null) return true; // o agente não informou a saída: benefício da dúvida
  const text = String(output).trim();
  return text.length > 0 && !FAILED_OUTPUT.test(text);
}

/** A CLI do graphify está disponível (GRAPHIFY_BIN ou no PATH)? */
export function graphifyAvailable(env = process.env) {
  if (env.GRAPHIFY_BIN) return fs.existsSync(env.GRAPHIFY_BIN);
  return (env.PATH ?? '').split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, 'graphify')));
}

/** 'off' | 'soft' (padrão) | 'strict'. */
export function guardMode(env = process.env) {
  if (env.GRAPHIFY_HOOK_STRICT === '0' || env.GRAPHIFY_HOOK_MODE === 'off') return 'off';
  if (env.GRAPHIFY_HOOK_STRICT === '1' || env.GRAPHIFY_HOOK_MODE === 'strict') return 'strict';
  return 'soft';
}

/** O guarda só atua com grafo gerado e a CLI do graphify disponível. */
export function graphReady(root, env = process.env) {
  if (guardMode(env) === 'off') return false;
  healGraphLink(root, env); // o link pode ter sido apagado (git clean, checkpoint do Cline) com o grafo ainda no cache
  if (!fs.existsSync(path.join(root, 'graphify-out', 'graph.json'))) return false;
  return graphifyAvailable(env);
}

/**
 * Decisão pura para uma busca bruta sem consulta ao grafo na janela:
 *  strict → deny (o adaptador do Cline converte em dica, porque cancelar lá aborta a tarefa);
 *  soft → nudge UMA vez por janela e depois allow (dica sem repetir a cada busca).
 */
export function decide({ kind, ready, lastQueryAt = 0, lastNudgeAt = 0, mode = 'soft', now = Date.now(), windowMs = WINDOW_MS }) {
  if (kind !== 'search' || !ready) return { action: 'allow' };
  if (now - lastQueryAt < windowMs) return { action: 'allow' };
  const params = { minutes: Math.round(windowMs / 60_000) };
  if (mode === 'strict') return { action: 'deny', key: 'search.graphify.deny', params };
  if (now - lastNudgeAt < windowMs) return { action: 'allow' };
  return { action: 'nudge', key: 'search.graphify.nudge', params };
}

const git = (root, args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout : '';
};
const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

/** Arquivos de código alterados (na árvore ou em commits) depois da geração do grafo. */
function staleFiles(root) {
  const graphTime = mtimeOf(path.join(root, 'graphify-out', 'graph.json'));
  if (!graphTime) return [];
  const files = new Set();
  for (const line of git(root, ['status', '--porcelain', '-uall']).split('\n')) {
    const file = line.slice(3).trim().replace(/^.* -> /, '');
    if (CODE_EXTENSIONS.test(file) && mtimeOf(path.join(root, file)) > graphTime) files.add(file);
  }
  const since = Math.floor(graphTime / 1000);
  for (const file of git(root, ['log', `--since=${since}`, '--name-only', '--pretty=format:']).split('\n')) {
    if (CODE_EXTENSIONS.test(file) && fs.existsSync(path.join(root, file))) files.add(file);
  }
  return [...files];
}

/** 'ausente' | 'velho' | 'ok' — usado no SessionStart e na mensagem de bloqueio. */
export function graphStatus(root) {
  if (!fs.existsSync(path.join(root, 'graphify-out', 'graph.json'))) return { state: 'ausente', stale: [] };
  const stale = staleFiles(root);
  return { state: stale.length ? 'velho' : 'ok', stale };
}

/** Estado por sessão/tarefa: { [chave]: epochMs da última consulta ao grafo que deu certo }. */
function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function recordQuery(file, key, now = Date.now()) {
  const state = readState(file);
  state[key] = now;
  const recent = Object.entries(state).sort((a, b) => b[1] - a[1]).slice(0, 20);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(recent)));
}

/**
 * PostToolUse: se a chamada continha uma consulta ao graphify e ela deu certo e trouxe resultado,
 * abre a janela de busca. Devolve true quando registrou.
 */
export function observeResult({ host, toolName, params, output, success, sessionKey, stateFile, now = Date.now() }) {
  if (!isGraphQueryCall(host, toolName, params)) return false;
  if (success === false || !usefulGraphOutput(output)) return false;
  recordQuery(stateFile, sessionKey, now);
  return true;
}

const nudgeKey = (sessionKey) => `${sessionKey}#dica`;

/**
 * PreToolUse: classifica e decide. A CONSULTA nunca é registrada aqui (só conta depois de rodar, no
 * PostToolUse); só a dica do modo suave grava estado, para aparecer uma vez por janela.
 */
export function evaluate({ host, toolName, params, sessionKey, root, stateFile, env = process.env, now = Date.now() }) {
  const call = classifyCall(host, toolName, params, root);
  if (call.kind !== 'search') return { action: 'allow' };
  const state = readState(stateFile);
  const decision = decide({
    kind: call.kind, ready: graphReady(root, env), mode: guardMode(env), now,
    lastQueryAt: state[sessionKey] ?? 0, lastNudgeAt: state[nudgeKey(sessionKey)] ?? 0,
  });
  if (decision.action === 'nudge') recordQuery(stateFile, nudgeKey(sessionKey), now);
  if (decision.action !== 'allow') decision.stale = staleFiles(root).length;
  return decision;
}
