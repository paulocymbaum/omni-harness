// Análise de comandos Bash para a guarda de busca (search-guard.mjs): separa as buscas brutas no
// repositório das consultas ao graphify. Reconhece o que a versão anterior errava:
//  - corpo de heredoc NÃO é comando (gravar um script que menciona `rg` não é busca);
//  - só a PRIMEIRA palavra do comando conta como `graphify` (`echo graphify query` não é consulta);
//  - `--help`/`--version` não são busca;
//  - `cd` para fora do repositório muda onde a busca acontece;
//  - `$(…)`, crases, `bash -c "…"` e `xargs grep` são desembrulhados e analisados.
// Continua sendo heurística (um empurrão, não uma barreira): comandos montados por variável ou
// `eval` passam. Funções puras, sem I/O.
import path from 'node:path';
import { splitCommands, stripHeredocs, words } from './shell.mjs';

const PREFIXES = new Set(['sudo', 'rtk', 'command', 'time', 'nohup', 'env', 'exec']);
const SEARCH_PROGRAMS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'fd', 'fdfind']);
const GREP_FAMILY = new Set(['grep', 'egrep', 'fgrep']);
const PATH_MATCH_FLAGS = new Set(['-name', '-iname', '-path', '-ipath', '-regex', '-iregex']);
const QUERY_SUBCOMMANDS = new Set(['query', 'path', 'explain', 'affected', 'god-nodes']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const XARGS_VALUE_OPTIONS = new Set(['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a']);
const INFO_FLAGS = new Set(['--help', '--version', '-V']);
const MAX_DEPTH = 4;

/** Remove variáveis inline e prefixos (sudo, rtk, env…) e o subcomando `rtk proxy|run`. */
export function stripPrefixes(ws) {
  let i = 0;
  while (i < ws.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i]) || PREFIXES.has(ws[i]))) i++;
  if (i > 0 && ws[i - 1] === 'rtk' && (ws[i] === 'proxy' || ws[i] === 'run')) i++;
  return ws.slice(i);
}

// O grafo é só de código (.graphifyignore exclui docs/, assets/ etc.): buscar texto nesses lugares
// ou nesses tipos de arquivo é o caso em que `graphify query` não tem como responder.
const NON_CODE_DIR = /^(?:\.\/)?(?:docs|assets|fluxo_branding_book|interface_mobile|\.github|\.claude)(?:\/|$)/;
const NON_CODE_FILE = /\.(?:md|mdx|txt|json|jsonc|ya?ml|toml|csv|lock|arb|html|css|svg|xml|sql|env|example)$/i;
export const isNonCodeTarget = (target) => NON_CODE_DIR.test(target) || NON_CODE_FILE.test(target);
const includeGlobs = (ws) => ws.filter((w) => w.startsWith('--include=')).map((w) => w.slice('--include='.length));
/** Todos os alvos (ou todos os --include) são de fora do código? Sem alvo e sem include: não. */
const onlyNonCode = (targets, ws) => {
  const includes = includeGlobs(ws);
  if (includes.length) return includes.every(isNonCodeTarget);
  return targets.length > 0 && targets.every(isNonCodeTarget);
};

export const looksLikeFile = (operand) => /[^/]\.[A-Za-z0-9]{1,8}$/.test(operand) && !operand.endsWith('/');

/** Alvo absoluto fora do repositório (ex.: ~/outro-projeto). */
export function outside(target, root) {
  if (!root) return false;
  if (target.startsWith('~')) return true;
  return path.isAbsolute(target) && target !== root && !target.startsWith(`${root}${path.sep}`);
}

const operands = (ws) => ws.slice(1).filter((w) => !w.startsWith('-'));
const hasRecursiveFlag = (ws) => ws.some((w) => w === '--recursive' || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(w));

/** Índice logo depois do `)` que fecha o `$(` aberto antes de `from`. */
function closeParen(text, from) {
  let depth = 1;
  let j = from;
  while (j < text.length && depth > 0) {
    if (text[j] === '(') depth++;
    else if (text[j] === ')') depth--;
    j++;
  }
  return j;
}

/** Conteúdo de `$( … )` (balanceado, fora de aspas simples) e de `` `…` `` dentro de um segmento. */
function innerSubstitutions(segment) {
  const out = [];
  let single = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === "'") single = !single;
    else if (single) continue;
    else if (c === '$' && segment[i + 1] === '(') {
      const end = closeParen(segment, i + 2);
      out.push(segment.slice(i + 2, end - 1));
      i = end - 1;
    } else if (c === '`') {
      const end = segment.indexOf('`', i + 1);
      if (end > i) { out.push(segment.slice(i + 1, end)); i = end; }
    }
  }
  return out;
}

/** O comando que o `xargs` executa (sem as opções do próprio xargs). */
function xargsInner(ws) {
  let i = 1;
  while (i < ws.length && ws[i].startsWith('-')) i += XARGS_VALUE_OPTIONS.has(ws[i]) ? 2 : 1;
  return ws.slice(i);
}

/** Todos os comandos simples do texto, em ordem de execução, já desembrulhados. */
function collect(text, out, depth = 0) {
  if (depth > MAX_DEPTH) return;
  let cursor = 0;
  for (const segment of splitCommands(text)) {
    const idx = text.indexOf(segment, cursor);
    if (idx >= 0) cursor = idx + segment.length;
    const piped = idx > 0 && /(^|[^|])\|\s*$/.test(text.slice(0, idx));
    for (const inner of innerSubstitutions(segment)) collect(inner, out, depth + 1);
    const ws = stripPrefixes(words(segment));
    if (SHELLS.has(ws[0]) && ws[1] === '-c' && ws[2]) { collect(ws[2], out, depth + 1); continue; }
    if (ws[0] === 'xargs') {
      const inner = xargsInner(ws);
      if (inner.length) out.push({ ws: stripPrefixes(inner), piped: false, xargs: true, segment });
      continue;
    }
    out.push({ ws, piped, xargs: false, segment });
  }
}

/** Depois de `cd <alvo>`, a busca acontece dentro ou fora do repositório? */
function enterDirectory(target, root, previous) {
  if (target === undefined) return true; // `cd` sozinho vai para o HOME
  if (target === '-') return previous;
  if (outside(target, root)) return true;
  return path.isAbsolute(target) ? false : previous; // relativo continua onde estava
}

const targetsOutside = (targets, ctx) => targets.length > 0 && targets.every((t) => outside(t, ctx.root));
const searchesOutsideCwd = (targets, ctx) => ctx.cwdOutside && targets.every((t) => !path.isAbsolute(t) || outside(t, ctx.root));

/** `grep`/`rg`/… é busca no repositório (e não filtro de stdin ou leitura de um arquivo só)? */
function isRepoSearch(unit, ctx) {
  const { ws, piped, xargs } = unit;
  const [prog] = ws;
  const targets = operands(ws).slice(1);
  if (targetsOutside(targets, ctx) || searchesOutsideCwd(targets, ctx) || onlyNonCode(targets, ws)) return false;
  if (xargs) return true; // lista de arquivos vem do stdin: varredura do repo
  if (prog === 'fd' || prog === 'fdfind') return !piped;
  if (GREP_FAMILY.has(prog)) return hasRecursiveFlag(ws) || targets.some((o) => o === '.' || o.endsWith('/'));
  if (piped && targets.length === 0) return false; // rg/ag/ack lendo stdin
  return !(targets.length > 0 && targets.every(looksLikeFile));
}

function isFindSearch(ws, ctx) {
  const firstFlag = ws.findIndex((w, i) => i > 0 && w.startsWith('-'));
  const starts = ws.slice(1, firstFlag < 0 ? undefined : firstFlag);
  if (targetsOutside(starts, ctx) || searchesOutsideCwd(starts, ctx) || (starts.length > 0 && starts.every(isNonCodeTarget))) return false;
  if (!ws.some((w) => PATH_MATCH_FLAGS.has(w))) return false;
  const depth = ws.indexOf('-maxdepth');
  return !(depth >= 0 && Number(ws[depth + 1]) <= 1);
}

function isSearchUnit(unit, ctx) {
  const { ws } = unit;
  if (ws.some((w) => INFO_FLAGS.has(w))) return false;
  if (ws[0] === 'git') return ws.includes('grep') && !ctx.cwdOutside;
  if (ws[0] === 'find') return isFindSearch(ws, ctx);
  return SEARCH_PROGRAMS.has(ws[0]) && isRepoSearch(unit, ctx);
}

/**
 * Analisa um comando Bash. `searches`: trechos que são busca bruta no repo; `queries`: trechos
 * que são consulta ao graphify (`graphify query|path|explain|affected|god-nodes` como comando).
 */
export function analyzeShell(cmd, root = null) {
  const units = [];
  collect(stripHeredocs(cmd ?? ''), units);
  const searches = [];
  const queries = [];
  const ctx = { root, cwdOutside: false };
  for (const unit of units) {
    if (unit.ws[0] === 'cd') { ctx.cwdOutside = enterDirectory(unit.ws[1], root, ctx.cwdOutside); continue; }
    if (unit.ws[0] === 'graphify' && QUERY_SUBCOMMANDS.has(unit.ws[1])) { queries.push(unit.segment); continue; }
    if (isSearchUnit(unit, ctx)) searches.push(unit.segment);
  }
  return { searches, queries };
}
