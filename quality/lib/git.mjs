import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { run, repoRoot, stateDir, toPosix } from './util.mjs';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function git(args, root, opts = {}) {
  return run('git', args, { cwd: root, timeoutMs: 30_000, ...opts });
}

export function isGitRepo(root = repoRoot()) {
  return git(['rev-parse', '--is-inside-work-tree'], root).stdout.trim() === 'true';
}

export function headSha(root = repoRoot()) {
  const r = git(['rev-parse', '--verify', '-q', 'HEAD'], root);
  return r.code === 0 ? r.stdout.trim() : null;
}

export function resolveRef(ref, root = repoRoot()) {
  const r = git(['rev-parse', '--verify', '-q', `${ref}^{commit}`], root);
  return r.code === 0 ? r.stdout.trim() : null;
}

export function mergeBase(ref, root = repoRoot()) {
  const r = git(['merge-base', 'HEAD', ref], root);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Base de comparação para push/deploy: upstream, senão origin/main, senão HEAD. */
export function remoteBase(root = repoRoot()) {
  for (const ref of ['@{upstream}', 'origin/main', 'main']) {
    if (!resolveRef(ref, root)) continue;
    const mb = mergeBase(ref, root);
    if (mb) return mb;
  }
  return headSha(root);
}

export function untrackedFiles(root = repoRoot()) {
  const r = git(['ls-files', '--others', '--exclude-standard', '-z'], root);
  return r.stdout.split('\0').filter(Boolean);
}

/** Arquivos alterados entre `base` e a árvore de trabalho (inclui não rastreados). */
export function changedFiles(root = repoRoot(), base = 'HEAD') {
  const out = [];
  const baseSha = base === 'HEAD' ? headSha(root) : resolveRef(base, root);
  if (baseSha) {
    const r = git(['diff', '--name-status', '-M', '-z', baseSha], root);
    const parts = r.stdout.split('\0').filter((p) => p !== '');
    for (let i = 0; i < parts.length; ) {
      const status = parts[i++];
      if (status.startsWith('R') || status.startsWith('C')) {
        const oldPath = parts[i++];
        const p = parts[i++];
        out.push({ path: p, oldPath, status: 'R' });
      } else {
        out.push({ path: parts[i++], status: status[0] });
      }
    }
  } else {
    for (const p of git(['ls-files', '-z'], root).stdout.split('\0').filter(Boolean)) out.push({ path: p, status: 'A' });
  }
  const seen = new Set(out.map((e) => e.path));
  for (const p of untrackedFiles(root)) if (!seen.has(p)) out.push({ path: p, status: 'A', untracked: true });
  // Dependências nunca são código do projeto, mesmo quando o .gitignore não as cobre (ex.: node_modules como symlink).
  return out.filter((e) => !/(^|\/)node_modules(\/|$)/.test(e.path));
}

function asText(buf) {
  if (buf == null) return null;
  if (buf.length > MAX_TEXT_BYTES) return null;
  const s = typeof buf === 'string' ? buf : buf.toString('utf8');
  return s.includes('\0') ? null : s;
}

export function fileAtRev(rev, file, root = repoRoot()) {
  if (!rev) return null;
  const r = git(['show', `${rev}:${file}`], root);
  return r.code === 0 ? asText(r.stdout) : null;
}

export function readWorking(file, root = repoRoot()) {
  try {
    const abs = path.join(root, file);
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_TEXT_BYTES) return null;
    return asText(fs.readFileSync(abs));
  } catch {
    return null;
  }
}

/** Linhas adicionadas (com número na versão nova) e removidas entre dois textos, via git diff --no-index. */
export function diffTexts(oldText, newText) {
  const added = [];
  const removed = [];
  if (oldText == null) {
    (newText ?? '').split('\n').forEach((text, i) => added.push({ line: i + 1, text }));
    if (added.length && added[added.length - 1].text === '') added.pop();
    return { added, removed };
  }
  if (newText == null) {
    oldText.split('\n').forEach((text) => removed.push(text));
    return { added, removed };
  }
  if (oldText === newText) return { added, removed };
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'qdiff-'));
  try {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    fs.writeFileSync(a, oldText);
    fs.writeFileSync(b, newText);
    const r = run('git', ['diff', '--no-index', '--no-color', '-U0', a, b], { cwd: tmp, timeoutMs: 30_000 });
    let newLine = 0;
    for (const line of r.stdout.split('\n')) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (h) { newLine = Number(h[1]); continue; }
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) added.push({ line: newLine++, text: line.slice(1) });
      else if (line.startsWith('-')) removed.push(line.slice(1));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { added, removed };
}

/**
 * Monta as entradas avaliadas: texto antigo (na base), texto novo (disco) e linhas do diff.
 * `only` restringe a um conjunto de caminhos (ex.: arquivos tocados na sessão).
 */
export function collectEntries({ root = repoRoot(), base = 'HEAD', only } = {}) {
  const baseSha = base === 'HEAD' ? headSha(root) : resolveRef(base, root);
  let files = changedFiles(root, baseSha ?? 'HEAD');
  if (only) {
    const set = new Set(only);
    files = files.filter((f) => set.has(f.path));
  }
  return files.map((f) => {
    const oldText = f.status === 'A' ? null : fileAtRev(baseSha, f.oldPath ?? f.path, root);
    const newText = f.status === 'D' ? null : readWorking(f.path, root);
    const { added, removed } = diffTexts(oldText, newText);
    return { ...f, oldText, newText, added, removed };
  });
}

/** Hash determinístico do estado atual: HEAD + diff da árvore + conteúdo dos não rastreados. */
export function worktreeHash(root = repoRoot()) {
  const h = createHash('sha256');
  h.update(headSha(root) ?? 'no-head');
  h.update('\0');
  h.update(git(['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff'], root).stdout);
  const state = `${toPosix(path.relative(root, stateDir()))}/`;
  for (const p of untrackedFiles(root).sort()) {
    if (p.startsWith('quality/.state/') || p.startsWith(state) || /(^|\/)node_modules(\/|$)/.test(p)) continue;
    h.update(`\0${p}\0`);
    try { h.update(fs.readFileSync(path.join(root, p))); } catch { /* removido no meio */ }
  }
  return h.digest('hex').slice(0, 32);
}
