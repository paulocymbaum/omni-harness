// Testes da guarda de identidade de main (git-identity-guard.mjs) e do instalador
// (install.mjs): commit/push em main só com identidade na allowlist do clone.
// Cenários com git real em repo temporário; a guarda só decide e sai com código.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { QUALITY_DIR } from './helpers.mjs';

const DONO = 'dono@fluxo';
const ESTRANHO = 'estranho@fluxo';

const g = (dir, ...args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (${dir}): ${r.stderr.trim()}`);
  return r.stdout.trim();
};

/** Repo temporário em main com dono configurado, allowlist semeada e um commit inicial. */
function identityRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ident-')));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', DONO);
  g(dir, 'config', 'user.name', 'Dono');
  g(dir, 'config', 'omniharness.allowed-emails', DONO);
  fs.writeFileSync(path.join(dir, 'README.md'), '# ident\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'inicial');
  return {
    dir,
    config: (...args) => g(dir, 'config', ...args),
    switch: (branch) => g(dir, 'switch', '-c', branch),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const run = (repo, mode, stdin = '', env = {}) => {
  const r = spawnSync(process.execPath, [path.join(QUALITY_DIR, 'hooks', 'git-identity-guard.mjs'), mode], {
    cwd: repo.dir,
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, QUALITY_ROOT: repo.dir, ...env },
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

const pushLine = (ref) => `refs/heads/${ref} 1111111111111111111111111111111111111111 refs/heads/${ref} 2222222222222222222222222222222222222222\n`;

test('dono da allowlist commita e faz push em main: liberado', () => {
  const repo = identityRepo();
  try {
    assert.equal(run(repo, 'pre-commit').code, 0);
    assert.equal(run(repo, 'pre-push', pushLine('main')).code, 0);
  } finally { repo.cleanup(); }
});

test('conta estranha: commit e push em main bloqueados com allowlist na mensagem', () => {
  const repo = identityRepo();
  try {
    repo.config('user.email', ESTRANHO);
    const r = run(repo, 'pre-commit');
    assert.equal(r.code, 1, `esperado deny, saiu 0: ${r.stdout}`);
    assert.match(r.stderr, /allowlist/);
    assert.match(r.stderr, new RegExp(ESTRANHO));
    assert.match(r.stderr, new RegExp(DONO));
    const p = run(repo, 'pre-push', pushLine('main'));
    assert.equal(p.code, 1, `esperado deny no push, saiu 0: ${p.stdout}`);
    assert.match(p.stderr, /Push para main bloqueado/);
  } finally { repo.cleanup(); }
});

test('env GIT_AUTHOR_EMAIL/GIT_COMMITTER_EMAIL estranho bloqueia mesmo com config do dono', () => {
  const repo = identityRepo();
  try {
    const env = { GIT_AUTHOR_EMAIL: ESTRANHO, GIT_COMMITTER_EMAIL: ESTRANHO };
    assert.equal(run(repo, 'pre-commit', '', env).code, 1);
    assert.equal(run(repo, 'pre-push', pushLine('main'), env).code, 1);
  } finally { repo.cleanup(); }
});

test('branch de trabalho e ref não-main não passam pela guarda', () => {
  const repo = identityRepo();
  try {
    repo.config('user.email', ESTRANHO);
    repo.switch('feat/outra');
    assert.equal(run(repo, 'pre-commit').code, 0);
    assert.equal(run(repo, 'pre-push', pushLine('feat/outra')).code, 0);
  } finally { repo.cleanup(); }
});

test('allowlist multi-valor aceita a segunda identidade', () => {
  const repo = identityRepo();
  try {
    repo.config('--add', 'omniharness.allowed-emails', 'robot@fluxo');
    repo.config('user.email', 'robot@fluxo');
    assert.equal(run(repo, 'pre-commit').code, 0);
  } finally { repo.cleanup(); }
});

test('sem allowlist e sem user.email: negado (identidade vazia não é verificável)', () => {
  const repo = identityRepo();
  try {
    repo.config('--unset', 'omniharness.allowed-emails');
    repo.config('--unset', 'user.email');
    // isola config global/system da máquina: sem fallback, identidade fica vazia mesmo assim negada
    const r = run(repo, 'pre-commit', '', { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
    assert.equal(r.code, 1, `esperado deny, saiu 0: ${r.stdout}`);
    assert.match(r.stderr, /user\.name\/user\.email/);
  } finally { repo.cleanup(); }
});

test('install.mjs: shims dos dois hooks, allowlist semeada, idempotente, recusa hook de terceiros', () => {
  const repo = identityRepo();
  const hook = (name) => path.join(repo.dir, '.git', 'hooks', name);
  const install = () => {
    const r = spawnSync(process.execPath, [path.join(QUALITY_DIR, 'hooks', 'install.mjs'), '--root', repo.dir], {
      encoding: 'utf8', timeout: 30_000,
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  try {
    const first = install();
    assert.equal(first.code, 0, `install falhou: ${first.stderr}`);
    assert.match(fs.readFileSync(hook('pre-commit'), 'utf8'), /fluxo-quality-gates/);
    assert.match(fs.readFileSync(hook('pre-push'), 'utf8'), /git-identity-guard\.mjs" pre-push/);
    assert.equal(repo.config('--get', 'omniharness.allowed-emails'), DONO);
    assert.equal(install().code, 0, 'reexecução idempotente deve passar');
    fs.writeFileSync(hook('pre-commit'), '#!/bin/sh\n# lefthook de terceiros\n');
    const refused = install();
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /não é do harness/);
    assert.match(fs.readFileSync(hook('pre-commit'), 'utf8'), /lefthook/);
  } finally { repo.cleanup(); }
});
