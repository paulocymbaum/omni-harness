#!/usr/bin/env node
// Gates de qualidade no pre-commit do git (substitui o CI "Gates de Qualidade",
// quality.yml — desativado no GitHub em 2026-10-31).
//
// Instalação: npm run hooks:install
// Bypass:     git commit --no-verify   (ou FLUXO_SKIP_QUALITY_GATES=1)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { envOff } from '../lib/env.mjs';
import { fileURLToPath } from 'node:url';
import { enforcePreCommit } from './git-identity-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Ponto de entrada: guarda de identidade → autocorreção leve → gates rápidos. */
function main() {
  // Guarda de identidade antes de tudo: main só recebe commit da allowlist do clone
  // (não é gate de qualidade, por isso roda mesmo com HARNESS_SKIP_QUALITY_GATES=1).
  enforcePreCommit(root);

  if (envOff('SKIP_QUALITY_GATES')) {
    console.log('[pre-commit] gates pulados (HARNESS_SKIP_QUALITY_GATES=1; alias FLUXO_SKIP_QUALITY_GATES).');
    return;
  }

  // Autocorreção leve primeiro (EOL, lint seguro); os arquivos corrigidos precisam ser re-adicionados pelo autor.
  const fix = spawnSync(process.execPath, [path.join(root, 'quality', 'run.mjs'), '--fix'], { stdio: 'inherit', cwd: root });
  if (fix.status !== 0) {
    console.error('✗ Sintaxe/lint de gate ou teste com erro — commit bloqueado (corrija ou use --no-verify).');
    process.exit(fix.status ?? 1);
  }

  const run = spawnSync(process.execPath, [path.join(root, 'quality', 'run.mjs'), '--tier', 'rapido'], {
    stdio: 'inherit',
    cwd: root,
  });

  if (run.error) {
    console.error(`[pre-commit] falha ao executar o motor de qualidade: ${run.error.message}`);
    process.exit(1);
  }

  if (run.status !== 0) {
    console.error('');
    console.error('✗ Gates de qualidade reprovados — commit bloqueado.');
    console.error('  Corrija os pontos acima ou use o bypass: git commit --no-verify');
    process.exit(run.status ?? 1);
  }

  console.log('[pre-commit] gates rápidos: OK');
}

main();
