import { repoRoot } from './util.mjs';
import { collectEntries, remoteBase, resolveRef, headSha } from './git.mjs';
import { loadSession } from './state.mjs';

/** Resolve o escopo avaliado: arquivos da sessão, lista explícita, diff contra uma base, ou a árvore toda (worktree). */
export function resolveScope({ base, files, session } = {}) {
  const root = repoRoot();
  let baseSha = 'HEAD';
  let scope = 'worktree';
  if (base) {
    baseSha = base === 'remote' ? remoteBase(root) : resolveRef(base, root);
    if (!baseSha) throw new Error(`base inválida: ${base}`);
    scope = baseSha === headSha(root) ? 'worktree' : `base:${baseSha}`;
    if (scope === 'worktree') baseSha = 'HEAD';
  }
  let only;
  if (files?.length) { only = files; scope = 'session'; }
  if (session) { only = loadSession(session).touched; scope = 'session'; }
  const entries = collectEntries({ root, base: baseSha, only });
  return { entries, scope, baseSha };
}
