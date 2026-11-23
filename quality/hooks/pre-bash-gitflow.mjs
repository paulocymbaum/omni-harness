#!/usr/bin/env node
// PreToolUse (Bash): Gitflow determinístico do projeto hospedeiro para repositório compartilhado.
// Criação de branch (taxonomia + branch pai correta), matriz de merge, push/pull com
// sincronização obrigatória com origin e bloqueio de operações mutantes durante conflito.
// Decisões: deny (motivo acionável em pt-BR) ou ask (quando o remote não pôde ser verificado).
// Política pura em quality/lib/gitflow.mjs; consultas de estado em quality/lib/gitstate.mjs.
// Sem comando git relevante ou fora de repositório → sai em milissegundos.
import { readStdinJson, repoRoot } from '../lib/util.mjs';
import { isMain } from '../lib/is-main.mjs';
import { t } from '../lib/messages.mjs';
import {
  parseGitOps, classifyBranch, createDecision, mergeDecision, pushDecision,
  pullDecision, rebaseDecision, resetDecision, branchDeleteDecision,
} from '../lib/gitflow.mjs';
import {
  isGitRepo, currentBranch, conflictState, fetchOrigin, behindCount,
  remoteStatus, isMergeCommit, isMergedInto, RUNBOOK, fileList,
} from '../lib/gitstate.mjs';

const deny = (key, params) => ({ decision: 'deny', key, params });

/** Contexto compartilhado: branch atual, conflito e sincronização com origin sob demanda. */
function newCtx(root, cmd) {
  const branch = currentBranch(root);
  const conflict = conflictState(root);
  let fetched = null;
  const ctx = {
    root, cmd, branch, conflict,
    runbook: RUNBOOK[conflict.kind] ?? RUNBOOK.merge,
    cls: branch && branch !== 'HEAD' ? classifyBranch(branch) : null,
    decide(d) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: t(d.key, { cmd, branch: branch ?? 'HEAD', ...d.params }) } };
    },
    fetchError: () => fetched?.error ?? '',
    syncCmd: (name) => (classifyBranch(name).type === 'permanent' ? 'git pull --ff-only' : `git pull --rebase origin ${name}`),
  };
  ctx.ensureFetch = () => { fetched ??= fetchOrigin(root); return fetched.ok; };
  return ctx;
}

/** Conflito ativo: só passam operações de resolução (add/restore/rm/--continue/--abort). */
function conflictGate(op, ctx) {
  if (ctx.conflict.files.length === 0) return null;
  const run = ctx.runbook;
  if (op.op === 'commit') return ctx.decide(deny('gitflow.commit.conflict', { kind: run.label, files: fileList(ctx.conflict.files), finish: run.finish }));
  if (!op.resolver) return ctx.decide(deny('gitflow.conflict.pending', { kind: run.label, files: fileList(ctx.conflict.files), abort: run.abort }));
  return null;
}

/** Confirma a política pura; devolve a decisão formatada ou null quando aprovada. */
const check = (d, ctx) => (d.decision ? ctx.decide(d) : null);

function handleCreate(op, ctx) {
  if (!op.create || !ctx.cls) return null;
  const d = createDecision(op.branch, ctx.cls.name, op.startPoint);
  if (d.decision) return ctx.decide(d);
  if (!ctx.ensureFetch()) return ctx.decide({ decision: 'ask', key: 'gitflow.fetch.failed', params: { error: ctx.fetchError() } });
  const behind = behindCount(ctx.root, d.parent);
  if (behind === 0) return null;
  return ctx.decide(deny('gitflow.create.parentBehind', { parent: d.parent, count: behind, branch: op.branch, cmd: `git switch ${d.parent} && git pull --ff-only && git switch -c ${op.branch}` }));
}

function handleMerge(op, ctx) {
  if (op.resolver || !ctx.cls) return null;
  return check(mergeDecision(ctx.cls.name, op.source), ctx);
}

function handleCommit(op, ctx) {
  if (ctx.cls?.name === 'main') return ctx.decide(deny('gitflow.commit.main', {}));
  if (ctx.cls?.name === 'develop') return ctx.decide(deny('gitflow.commit.develop', {}));
  return null;
}

/** Política de cada alvo do push (destino protegido, força, delete, develop só via merge). */
function pushTargetDecision(tg, op, ctx) {
  const name = tg.branch === '@current' ? ctx.branch : tg.branch;
  if (!name) return null;
  const d = pushDecision({
    target: name, deleting: tg.deleting, force: op.force, forceWithLease: op.forceWithLease,
    currentIsMergeCommit: isMergeCommit(ctx.root), targetMerged: isMergedInto(ctx.root, name, 'develop'),
  });
  return d.decision ? ctx.decide(d) : null;
}

/** Sincronização obrigatória com origin para cada alvo do push (atrás ou divergido bloqueia). */
function pushSyncDecision(tg, ctx) {
  const name = tg.branch === '@current' ? ctx.branch : tg.branch;
  if (!name || tg.deleting || classifyBranch(name).type === 'fora') return null;
  const rs = remoteStatus(ctx.root, name);
  if (!rs.exists || rs.behind === 0) return null;
  const key = rs.ahead > 0 ? 'gitflow.push.diverged' : 'gitflow.push.behind';
  return ctx.decide(deny(key, { branch: name, count: rs.behind, ahead: rs.ahead, behind: rs.behind, cmd: ctx.syncCmd(name) }));
}

function handlePush(op, ctx) {
  for (const tg of op.targets) {
    const d = pushTargetDecision(tg, op, ctx);
    if (d) return d;
  }
  if (op.delete) return null;
  if (!ctx.ensureFetch()) return ctx.decide({ decision: 'ask', key: 'gitflow.fetch.failed', params: { error: ctx.fetchError() } });
  for (const tg of op.targets) {
    const d = pushSyncDecision(tg, ctx);
    if (d) return d;
  }
  return null;
}

const HANDLERS = {
  switch: handleCreate,
  checkout: handleCreate,
  merge: handleMerge,
  commit: handleCommit,
  push: handlePush,
  pull: (op, ctx) => check(pullDecision(ctx.cls?.name, op.rebase), ctx),
  rebase: (op, ctx) => (op.resolver || !ctx.cls ? null : check(rebaseDecision(ctx.cls.name), ctx)),
  reset: (op, ctx) => (ctx.cls ? check(resetDecision(ctx.cls.name, op.hard), ctx) : null),
  'branch-delete': (op, ctx) => check(branchDeleteDecision(op.branch), ctx),
};

/** Decisão (ou null) para o payload do PreToolUse; exportada para o despachante pre-bash-dispatch.mjs. */
export function evaluate(input) {
  const cmd = input.tool_input?.command ?? '';
  if (!/\bgit\b/.test(cmd)) return null;
  const root = repoRoot();
  if (!isGitRepo(root)) return null;
  const ops = parseGitOps(cmd);
  if (ops.length === 0) return null;
  const ctx = newCtx(root, cmd);
  for (const op of ops) {
    const decision = conflictGate(op, ctx) ?? HANDLERS[op.op]?.(op, ctx) ?? null;
    if (decision) return decision;
  }
  return null;
}

if (isMain(import.meta.url)) {
  const out = evaluate(readStdinJson());
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
