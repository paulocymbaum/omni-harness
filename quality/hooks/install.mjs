#!/usr/bin/env node
// Instala o hook pre-commit do git (.git/hooks/pre-commit) apontando para o
// fluxo de gates local (quality/hooks/git-pre-commit.mjs).
// Idempotente: reexecutável; não sobrescreve hook de terceiros.
// Uso: npm run hooks:install
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hooksDir = path.join(root, '.git', 'hooks');
const target = path.join(hooksDir, 'pre-commit');
const MARKER = 'fluxo-quality-gates';
const shim = [
  '#!/bin/sh',
  `# ${MARKER} — instalado por: npm run hooks:install`,
  'exec node "$(git rev-parse --show-toplevel)/quality/hooks/git-pre-commit.mjs" "$@"',
  '',
].join('\n');

fs.mkdirSync(hooksDir, { recursive: true });

if (fs.existsSync(target)) {
  const current = fs.readFileSync(target, 'utf8');
  if (!current.includes(MARKER)) {
    console.error('✗ .git/hooks/pre-commit já existe e não é do harness — não vou sobrescrever.');
    console.error('  Mescle manualmente a chamada abaixo no seu hook:');
    console.error(`  exec node "${path.join(root, 'quality', 'hooks', 'git-pre-commit.mjs')}"`);
    process.exit(1);
  }
}

fs.writeFileSync(target, shim);
fs.chmodSync(target, 0o755);
console.log('✓ pre-commit instalado — gates rápidos rodarão a cada commit.');
console.log('  Bypass pontual: git commit --no-verify (ou FLUXO_SKIP_QUALITY_GATES=1).');
