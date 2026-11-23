import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diffTexts } from '../lib/git.mjs';

export const QUALITY_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Entrada sintética (sem git) para testar gates e risco. */
export function entry(p, oldText, newText, status) {
  return { path: p, status: status ?? (oldText == null ? 'A' : newText == null ? 'D' : 'M'), oldText, newText, ...diffTexts(oldText, newText) };
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** Repositório git temporário com arquivos iniciais commitados. */
export function tempRepo(files = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qrepo-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'teste@example.com');
  git(dir, 'config', 'user.name', 'Teste');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'quality/.state/\n');
  for (const [p, content] of Object.entries(files)) write(dir, p, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'inicial');
  return {
    dir,
    write: (p, content) => write(dir, p, content),
    commit: (msg = 'wip') => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function write(dir, p, content) {
  fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
  fs.writeFileSync(path.join(dir, p), content);
}

/** Executa um script (hook ou CLI) contra o repo temporário, com stdin JSON. */
export function runScript(repo, script, input, extraArgs = [], env = {}) {
  const r = spawnSync(process.execPath, [path.join(QUALITY_DIR, script), ...extraArgs], {
    cwd: repo.dir,
    input: input == null ? '' : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, QUALITY_ROOT: repo.dir, QUALITY_STATE_DIR: path.join(repo.dir, 'quality/.state'), ...env },
    timeout: 120_000,
  });
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { /* saída textual */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

export const lines = (n, fn = (i) => `const v${i} = ${i};`) => Array.from({ length: n }, (_, i) => fn(i)).join('\n') + '\n';
