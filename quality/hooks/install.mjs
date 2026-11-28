#!/usr/bin/env node
// Instala os hooks core de git (.git/hooks/pre-commit e pre-push):
// - pre-commit → gates de qualidade (quality/hooks/git-pre-commit.mjs)
// - pre-push   → guarda de identidade de main (quality/hooks/git-identity-guard.mjs pre-push)
// Semeia a allowlist de identidade (omniharness.allowed-emails) com o user.email atual.
// Idempotente: reexecutável; não sobrescreve hook de terceiros.
// Uso: npm run hooks:install   (ou: node quality/hooks/install.mjs [--root <caminho>])
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rootArg = process.argv[process.argv.indexOf('--root') + 1];
const root = rootArg && process.argv.includes('--root') ? path.resolve(rootArg) : defaultRoot;
const hooksDir = path.join(root, '.git', 'hooks');

const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();

const HOOKS = {
  'pre-commit': {
    marker: 'fluxo-quality-gates',
    shim: 'exec node "$(git rev-parse --show-toplevel)/quality/hooks/git-pre-commit.mjs" "$@"',
    done: 'gates rápidos rodarão a cada commit.',
  },
  'pre-push': {
    marker: 'fluxo-main-identity-guard',
    shim: 'exec node "$(git rev-parse --show-toplevel)/quality/hooks/git-identity-guard.mjs" pre-push "$@"',
    done: 'push para main exigirá identidade da allowlist.',
  },
};

/** Grava o shim do hook se ausente ou já do harness; recusa hook de terceiros. */
function installHook(name, spec) {
  const target = path.join(hooksDir, name);
  if (fs.existsSync(target)) {
    const current = fs.readFileSync(target, 'utf8');
    if (!current.includes(spec.marker)) {
      console.error(`✗ .git/hooks/${name} já existe e não é do harness — não vou sobrescrever.`);
      console.error('  Mescle manualmente a chamada abaixo no seu hook:');
      console.error(`  ${spec.shim}`);
      return false;
    }
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(target, ['#!/bin/sh', `# ${spec.marker} — instalado por: npm run hooks:install`, spec.shim, ''].join('\n'));
  fs.chmodSync(target, 0o755);
  console.log(`✓ ${name} instalado — ${spec.done}`);
  return true;
}

/** Semeia a allowlist de identidade de main com o user.email atual (só se ainda não houver). */
function seedAllowlist() {
  const existing = git(['config', '--get-all', 'omniharness.allowed-emails']);
  if (existing) {
    console.log(`✓ allowlist de main já configurada: ${existing.split('\n').join(', ')}`);
    return true;
  }
  const email = git(['config', '--get', 'user.email']);
  if (!email) {
    console.error('✗ user.email vazio: configure git config user.email antes de instalar (allowlist de main ficaria vazia).');
    return false;
  }
  git(['config', '--local', '--add', 'omniharness.allowed-emails', email]);
  console.log(`✓ allowlist de main semeada com o dono do clone: ${email}`);
  return true;
}

const ok = Object.entries(HOOKS).every(([name, spec]) => installHook(name, spec)) && seedAllowlist();
console.log('  Bypass consciente do hook local: git commit --no-verify (barreira definitiva: branch protection no GitHub).');
process.exit(ok ? 0 : 1);

