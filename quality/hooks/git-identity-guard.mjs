#!/usr/bin/env node
// Guarda de identidade da branch main (hook core de git, não de agente):
// commit e push tocando main só passam com identidade na allowlist deste clone.
//
// Allowlist: git config --get-all omniharness.allowed-emails
// (semeada pelo install.mjs com o user.email do dono; multi-valor).
// Modos: pre-commit (branch atual) e pre-push (refs do stdin: local_ref local_sha remote_ref remote_sha).
// Verificação honesta: hook local se contorna com --no-verify; a barreira definitiva
// é o branch protection do GitHub ("restrict who can push" → só a conta do dono).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isMain } from '../lib/is-main.mjs';

const CONFIG_KEY = 'omniharness.allowed-emails';

const gitOut = (root, args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};

/** Email que o git usará para author/committer (env > EMAIL > user.email), como o git resolve. */
function identityEmail(kind, root) {
  const fromEnv = process.env[`GIT_${kind}_EMAIL`] || process.env.EMAIL || '';
  return fromEnv.trim() || gitOut(root, ['config', '--get', 'user.email']);
}

/** Allowlist do clone; sem config, cai para o user.email atual (não trava o dono legítimo). */
function allowedEmails(root) {
  const configured = gitOut(root, ['config', '--get-all', CONFIG_KEY]).split('\n').map((s) => s.trim()).filter(Boolean);
  if (configured.length > 0) return configured;
  const fallback = gitOut(root, ['config', '--get', 'user.email']).trim();
  return fallback ? [fallback] : [];
}

/** Identidade (autor OU committer) fora da allowlist? Null quando ok ou quando não é main. */
function identityViolation(root, branch) {
  if (branch !== 'main') return null;
  const allowed = allowedEmails(root);
  const author = identityEmail('AUTHOR', root);
  const committer = identityEmail('COMMITTER', root);
  const foreign = [author, committer].filter((email) => !allowed.includes(email));
  if (foreign.length === 0) return null;
  return { author, committer, foreign, allowed };
}

/** Decisão do pre-commit: null libera; objeto detalha a negação (branch main, identidade estranha). */
function preCommitDecision(root) {
  const branch = gitOut(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return identityViolation(root, branch || 'HEAD');
}

/** Decisão do pre-push: alguma ref remota é main? Devolve violação de identidade ou null. */
function prePushDecision(root, stdinText) {
  const touchesMain = stdinText.split('\n').some((line) => {
    const parts = line.trim().split(/\s+/);
    return parts.length >= 3 && parts[2] === 'refs/heads/main';
  });
  if (!touchesMain) return null;
  return identityViolation(root, 'main');
}

function printDeny(action, v) {
  console.error(`✗ ${action} para main bloqueado: identidade fora da allowlist deste clone.`);
  console.error(`  autor:     ${v.author || '(vazia — configure user.name/user.email)'}`);
  console.error(`  committer: ${v.committer || '(vazia — configure user.name/user.email)'}`);
  console.error(`  permitido(s): ${v.allowed.join(', ')}`);
  console.error('  main recebe apenas merges do fluxo (release/hotfix); trabalhe em feat/, fix/ ou chore/.');
  console.error(`  Ajuste a allowlist: git config ${CONFIG_KEY} <email>  — o instalador semeia com o user.email atual.`);
  console.error('  Hook local se contorna com --no-verify; a barreira definitiva é o branch protection no GitHub.');
}

/** Chamado pelo git-pre-commit.mjs antes dos gates: sai 1 na negação, 0 na liberação. */
export function enforcePreCommit(root) {
  const violation = preCommitDecision(root);
  if (violation) {
    printDeny('Commit', violation);
    process.exit(1);
  }
}

function readStdinRaw() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

if (isMain(import.meta.url)) {
  const mode = process.argv[2];
  const root = process.env.QUALITY_ROOT || process.cwd();
  if (mode === 'pre-commit') {
    enforcePreCommit(root);
  } else if (mode === 'pre-push') {
    const violation = prePushDecision(root, readStdinRaw());
    if (violation) {
      printDeny('Push', violation);
      process.exit(1);
    }
  } else {
    console.error('uso: node quality/hooks/git-identity-guard.mjs pre-commit|pre-push');
    process.exit(2);
  }
  process.exit(0);
}
