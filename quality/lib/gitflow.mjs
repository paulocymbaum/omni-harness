// Política Gitflow do projeto hospedeiro na camada do agente (harness); permanentes e matriz vêm
// do perfil (R3). Funções puras: recebem nomes/flags parseadas e devolvem { decision, key, params }
// (violação) ou { ok: true }. O parser reusa os utilitários de shell.mjs e não executa nada.
// Fluxo: main ← release/x.y.z (pipeline) ← develop ⇄ feat|fix|chore ; hotfix nasce de main
// e volta para main + develop (backmerge).
import { splitCommands, stripHeredocs, words } from './shell.mjs';
import { PROFILE } from './profile.mjs';

// program() não é exportado por shell.mjs; réplica local do mesmo comportamento.
const PREFIXES = new Set(['sudo', 'rtk', 'command', 'time', 'nohup', 'env', 'exec', 'npx', 'pnpx', 'bunx']);

function program(ws) {
  let i = 0;
  while (i < ws.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i]) || PREFIXES.has(ws[i]) || (ws[i].startsWith('-') && i > 0 && PREFIXES.has(ws[i - 1])))) i++;
  return ws.slice(i);
}

/** Tipo de branch → branch pai (de onde nasce). Permanentes e matriz vêm do perfil (R3);
 *  fallback legado = gitflow com RELEASE permanente (QG-025), morto na R5. */
const GF = PROFILE.gitflow || {};
const PERMANENT_LEGACY = ['main', 'develop', 'RELEASE'];
const PARENT_OF_LEGACY = { feat: 'develop', fix: 'develop', chore: 'develop', hotfix: 'main', release: 'develop' };
const MERGE_OK_LEGACY = {
  main: ['release', 'hotfix'],
  RELEASE: ['release'],
  develop: ['feat', 'fix', 'chore', 'hotfix', 'release'],
  feat: ['develop'], fix: ['develop'], chore: ['develop'],
  hotfix: ['main'],
  release: ['fix', 'hotfix'],
};

export const PARENT_OF = GF.parentOf && Object.keys(GF.parentOf).length ? GF.parentOf : PARENT_OF_LEGACY;
export const PERMANENT = GF.permanent && GF.permanent.length ? GF.permanent : PERMANENT_LEGACY;
const MERGE_OK = GF.mergeOk && Object.keys(GF.mergeOk).length ? GF.mergeOk : MERGE_OK_LEGACY;

/** release/ exige versão semântica, com sufixo opcional (release/1.4.0, release/1.4.0-beta.1). */
const VERSION_RE = /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

/** Matriz de merge: branch atual → origens permitidas (chaves da taxonomia ou permanentes). */

/** Classifica um nome de branch: permanente, taxonomia (com versão para release) ou fora. */
export function classifyBranch(name) {
  if (PERMANENT.includes(name)) return { type: 'permanent', name };
  const kind = Object.keys(PARENT_OF).find((k) => name === k || name.startsWith(`${k}/`));
  if (!kind) return { type: 'fora', name };
  if (kind === 'release') return { type: 'release', kind, name, versionOk: VERSION_RE.test(name.slice('release/'.length)) };
  return { type: kind, kind, name };
}

const keyOf = (name) => {
  const cls = classifyBranch(name ?? '');
  return cls.type === 'permanent' ? cls.name : cls.kind ?? 'fora';
};

const OK = { ok: true };
const deny = (key, params) => ({ decision: 'deny', key, params });

/** Dica de correção por branch atual quando um merge viola a matriz. */
const MERGE_HINT = { main: 'mainWork', release: 'releaseBase', hotfix: 'hotfixBase' };

/** Criação de branch (git switch -c / checkout -b): taxonomia, branch pai e versão. */
export function createDecision(name, current, startPoint) {
  const cls = classifyBranch(name ?? '');
  if (cls.type === 'permanent' || cls.type === 'fora') return deny('gitflow.taxonomy', { branch: name });
  if (cls.kind === 'release' && !cls.versionOk) return deny('gitflow.create.releaseVersion', { branch: name });
  const parent = PARENT_OF[cls.kind];
  if (current === parent || startPoint?.replace(/^origin\//, '') === parent) return { ...OK, parent, branch: name };
  return deny('gitflow.create.wrongParent', { kind: cls.kind, parent, current: current ?? 'HEAD', branch: name });
}

/** Direção de merge entre a branch atual e a origem: { ok } ou violação com a dica correta. */
export function mergeDecision(current, source) {
  const cur = keyOf(current);
  const src = keyOf(source);
  if ((MERGE_OK[cur] ?? []).includes(src)) return OK;
  const hint = cur === 'develop' ? (src === 'main' ? 'mainToDevelop' : 'developTaxonomy') : MERGE_HINT[cur] ?? 'featureCross';
  return deny(`gitflow.merge.hint.${hint}`, { source: source ?? '?', current: current ?? 'HEAD' });
}

function pushPermanent(op, cls) {
  if (op.deleting) return deny('gitflow.delete.protected', { branch: cls.name });
  if (op.force || op.forceWithLease) return deny('gitflow.push.forceProtected', { branch: cls.name });
  if (cls.name === 'main') return deny('gitflow.push.main', {});
  // RELEASE (QG-025): a negação aponta o caminho certo — bump pelo gêmeo local, não commit direto.
  if (cls.name === 'RELEASE' && !op.currentIsMergeCommit) return deny('gitflow.push.releaseDirect', {});
  return op.currentIsMergeCommit ? OK : deny('gitflow.push.developDirect', {});
}

/** Push: destino protegido, força, delete de branch e origem do conteúdo em develop. */
export function pushDecision(op) {
  const cls = classifyBranch(op.target ?? '');
  if (cls.type === 'permanent') return pushPermanent(op, cls);
  if (cls.type === 'release' && (op.force || op.forceWithLease)) return deny('gitflow.push.forceProtected', { branch: op.target });
  if (op.force) return deny('gitflow.push.force', { branch: op.target });
  if (op.deleting && op.targetMerged === false) return { decision: 'ask', key: 'gitflow.delete.unmerged', params: { branch: op.target } };
  return OK;
}

/** Pull: branches de trabalho exigem rebase (história linear); permanentes aceitam merge pull. */
export function pullDecision(current, rebase) {
  if (['feat', 'fix', 'chore'].includes(keyOf(current)) && !rebase) return deny('gitflow.pull.rebase', { branch: current });
  return OK;
}

const isPermanent = (name) => classifyBranch(name ?? '').type === 'permanent';

/** Rebase e reset --hard nunca reescrevem main/develop (história compartilhada). */
export function rebaseDecision(current) {
  return isPermanent(current) ? deny('gitflow.rebase.protected', { branch: current }) : OK;
}

export function resetDecision(current, hard) {
  return hard && isPermanent(current) ? deny('gitflow.reset.protected', { branch: current }) : OK;
}

export function branchDeleteDecision(name) {
  return isPermanent(name) ? deny('gitflow.delete.protected', { branch: name }) : OK;
}

// ------------------------------------------------------------------ parser de comandos git

/** Opções globais (antes do subcomando) que consomem o argumento seguinte. */
const GLOBAL_VAL_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path']);
/** Opções de subcomando que consomem o argumento seguinte (-c aqui é criação/cópia, não config). */
const VAL_FLAGS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '-m', '--message', '-F', '--file', '--author', '--date', '--cleanup']);

function clean(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (VAL_FLAGS.has(args[i])) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

const positionals = (args) => clean(args).filter((w) => !w.startsWith('-'));
const hasFlag = (args, ...names) => clean(args).some((w) => names.includes(w));

/** Divide o comando em ops git (uma por segmento), sem executar nada e sem falsos positivos. */
export function parseGitOps(cmd) {
  const ops = [];
  for (const seg of splitCommands(stripHeredocs(cmd ?? ''))) {
    const ws = program(words(seg));
    if (ws[0]?.split('/').pop() === 'git') {
      const op = parseGit(ws.slice(1));
      if (op) ops.push(op);
    } else if (['bash', 'sh', 'zsh'].includes(ws[0]) && ws[1] === '-c' && ws[2]) {
      ops.push(...parseGitOps(ws[2]));
    }
  }
  return ops;
}

const MUTATING_SIMPLE = ['stash', 'revert'];
const RESOLVER_SIMPLE = ['add', 'restore', 'rm'];

/** Handlers por subcomando; funções pequenas mantêm cc e Halstead dentro dos tetos. */
const HANDLERS = {
  switch: parseSwitch,
  checkout: parseCheckout,
  merge: parseMerge,
  push: parsePush,
  branch: parseBranch,
  pull: (args) => ({ op: 'pull', mutating: true, rebase: hasFlag(args, '-r', '--rebase'), ffOnly: hasFlag(args, '--ff-only') }),
  commit: () => ({ op: 'commit', mutating: true }),
  reset: (args) => ({ op: 'reset', mutating: true, hard: hasFlag(args, '--hard') }),
  rebase: (args) => parseResolver(args, 'rebase'),
  'cherry-pick': (args) => parseResolver(args, 'cherry-pick'),
  ...Object.fromEntries(RESOLVER_SIMPLE.map((s) => [s, () => ({ op: s, mutating: true, resolver: true })])),
  ...Object.fromEntries(MUTATING_SIMPLE.map((s) => [s, () => ({ op: s, mutating: true })])),
};

function parseGit(rest) {
  let i = 0;
  while (i < rest.length && rest[i].startsWith('-')) i += GLOBAL_VAL_OPTS.has(rest[i]) ? 2 : 1;
  const [sub, ...args] = rest.slice(i);
  const handler = HANDLERS[sub];
  if (!handler || args.includes('--help') || args.includes('-h')) return null;
  return handler(args); // demais subcomandos são leitura ou fora do escopo do fluxo
}

function parseSwitch(args) {
  const branch = positionals(args)[0];
  if (!branch || hasFlag(args, '-t', '--track', '-d', '--detach')) return null;
  return { op: 'switch', mutating: true, create: hasFlag(args, '-c', '--create', '--orphan'), branch, startPoint: positionals(args)[1] ?? null };
}

function parseCheckout(args) {
  if (clean(args).includes('--')) return { op: 'checkout', mutating: true, resolver: true };
  const create = hasFlag(args, '-b', '-B', '--orphan');
  const branch = positionals(args)[0];
  if (!branch) return null;
  const track = hasFlag(args, '-t', '--track') || branch.startsWith('origin/');
  return { op: 'checkout', mutating: create, create, branch: track ? branch.replace(/^origin\//, '') : branch, startPoint: positionals(args)[1] ?? null };
}

function parseMerge(args) {
  if (hasFlag(args, '--abort', '--continue')) return { op: 'merge', mutating: true, resolver: true };
  const source = positionals(args)[0]?.replace(/^origin\//, '');
  return source ? { op: 'merge', mutating: true, source } : null;
}

const isSpec = (w) => w === 'HEAD' || w.includes(':') || w.includes('@{') || w.startsWith('refs/') || w.startsWith('+');

function parsePush(args) {
  if (hasFlag(args, '--dry-run', '-n')) return null;
  const pos = positionals(args);
  let remote = 'origin';
  let specs = pos;
  if (pos.length && !isSpec(pos[0])) {
    remote = pos[0];
    specs = pos.slice(1);
  }
  const deleting = hasFlag(args, '--delete', '-d');
  const targets = specs.length ? specs.map((s) => {
    const spec = s.replace(/^\+/, '').replace(/^refs\/heads\//, '');
    const specDelete = spec.startsWith(':');
    const [src, dst] = spec.split(':');
    const branch = deleting || specDelete ? (dst || src) : dst || (src === 'HEAD' ? '@current' : src);
    return { branch, deleting: deleting || specDelete };
  }) : [{ branch: '@current', deleting }];
  return { op: 'push', mutating: true, force: hasFlag(args, '--force', '-f'), forceWithLease: hasFlag(args, '--force-with-lease'), delete: deleting, remote, targets };
}

function parseResolver(args, op) {
  return hasFlag(args, '--abort', '--continue', '--skip')
    ? { op, mutating: true, resolver: true }
    : { op, mutating: true };
}

function parseBranch(args) {
  if (!hasFlag(args, '-d', '-D', '--delete')) return null;
  const branch = positionals(args)[0];
  return branch ? { op: 'branch-delete', mutating: true, branch, force: hasFlag(args, '-D') } : null;
}
