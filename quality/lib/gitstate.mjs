// Consultas de estado git para os hooks do Gitflow (sincronização com origin, conflitos,
// branch atual). Tolerantes por construção: git ausente ou erro devolvem valor neutro e
// nunca lançam — um hook de fluxo não pode derrubar o comando do agente.
import fs from 'node:fs';
import path from 'node:path';
import { run, repoRoot } from './util.mjs';

function g(args, root, timeoutMs = 20_000) {
  return run('git', args, { cwd: root ?? repoRoot(), timeoutMs });
}

function resolveRef(ref, root) {
  return g(['rev-parse', '--verify', '-q', `${ref}^{commit}`], root).code === 0;
}

export function isGitRepo(root = repoRoot()) {
  return g(['rev-parse', '--is-inside-work-tree'], root).stdout.trim() === 'true';
}

/** Branch atual (nome curto); 'HEAD' ou null em detached/unborn — políticas de branch são puladas. */
export function currentBranch(root = repoRoot()) {
  const r = g(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Estado de conflito: operação em andamento (merge/rebase/cherry-pick) + arquivos não mesclados. */
export function conflictState(root = repoRoot()) {
  const gitDir = g(['rev-parse', '--git-dir'], root).stdout.trim() || '.git';
  const inGitDir = (p) => fs.existsSync(path.isAbsolute(gitDir) ? path.join(gitDir, p) : path.join(root, gitDir, p));
  const kind = (inGitDir('rebase-merge') || inGitDir('rebase-apply')) ? 'rebase'
    : inGitDir('CHERRY_PICK_HEAD') ? 'cherry-pick'
    : inGitDir('MERGE_HEAD') ? 'merge' : null;
  const files = kind ? g(['diff', '--name-only', '--diff-filter=U', '-z'], root).stdout.split('\0').filter(Boolean) : [];
  return { kind, files };
}

/** Atualiza as referências de origin (só leitura para a árvore). Falha de rede não lança. */
export function fetchOrigin(root = repoRoot()) {
  const r = g(['fetch', 'origin', '--quiet', '--prune'], root, 15_000);
  const error = (r.stderr || r.stdout || '').trim().split('\n').filter(Boolean)[0] ?? '';
  return { ok: r.code === 0, error };
}

/** Commits em origin/<branch> que faltam localmente (0 se a referência remota não existe). */
export function behindCount(root = repoRoot(), branch, remote = 'origin') {
  const ref = `${remote}/${branch}`;
  if (!resolveRef(ref, root)) return 0;
  return Number.parseInt(g(['rev-list', '--count', `${branch}..${ref}`], root).stdout.trim(), 10) || 0;
}

/** Posição de <branch> vs origin/<branch> após fetch: { exists, ahead, behind }. */
export function remoteStatus(root = repoRoot(), branch, remote = 'origin') {
  const ref = `${remote}/${branch}`;
  if (!resolveRef(ref, root)) return { exists: false, ahead: 0, behind: 0 };
  const r = g(['rev-list', '--left-right', '--count', `${branch}...${ref}`], root);
  const [ahead, behind] = r.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
  return { exists: true, ahead, behind };
}

/** HEAD é merge commit (recebeu conteúdo de outra branch)? É o único push legítimo em develop. */
export function isMergeCommit(root = repoRoot(), ref = 'HEAD') {
  return g(['rev-list', '--parents', '-n', '1', ref], root).stdout.trim().split(/\s+/).length > 2;
}

/** branch está totalmente contida em `into`? null quando impossível verificar. */
export function isMergedInto(root = repoRoot(), branch, into) {
  if (!resolveRef(into, root) || !resolveRef(branch, root)) return null;
  const r = g(['rev-list', '--count', `${into}..${branch}`], root);
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isNaN(n) ? null : n === 0;
}

/** Runbook de resolução por tipo de operação (usado pelos dois hooks). */
export const RUNBOOK = {
  merge: { label: 'merge', finish: 'git commit (conclui o merge)', abort: 'git merge --abort', pushStep: 'git push origin {branch}' },
  rebase: { label: 'rebase', finish: 'git rebase --continue', abort: 'git rebase --abort', pushStep: 'git push --force-with-lease origin {branch} (a história foi rebaseada)' },
  'cherry-pick': { label: 'cherry-pick', finish: 'git cherry-pick --continue', abort: 'git cherry-pick --abort', pushStep: 'git push origin {branch}' },
};

/** Lista de arquivos para mensagens: no máximo 8 itens + contador do restante. */
export function fileList(files, max = 8) {
  const shown = files.slice(0, max).map((f) => `- ${f}`);
  return files.length > max ? [...shown, `- … +${files.length - max} arquivo(s)`].join('\n') : shown.join('\n');
}
