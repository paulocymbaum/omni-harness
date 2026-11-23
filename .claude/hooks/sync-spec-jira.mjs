#!/usr/bin/env node
// PostToolUse (Edit|Write|MultiEdit): ao gravar docs/entregas/<slug>/specs/<ID>.md, atualiza o card
// Jira da tarefa em segundo plano. Sem isso, o card criado antes da spec (regra "tarefa nova →
// card na hora") ficava para sempre com "Spec ainda não escrita" até alguém mudar o status.
// A lógica (e o filtro de PII e de `Status: ready`) vive em quality/lib/spec-sync.mjs, comum ao
// Cline. Não bloqueante: sem credenciais JIRA_* só avisa; um sync por tarefa a cada 2 min (lock);
// FLUXO_JIRA_AUTOSYNC=0 desliga. Nunca imprime credenciais nem o valor de dado pessoal.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isMain } from '../../quality/lib/is-main.mjs';
import { noticeOf, planSync, startSync } from '../../quality/lib/spec-sync.mjs';

export { specTarget, hasJiraCredentials, planSync } from '../../quality/lib/spec-sync.mjs';

const context = (text) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const file = input.tool_input?.file_path;
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  if (!file) return;
  const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  const plan = planSync({ root, rel });
  const notice = noticeOf(plan);
  if (notice) return context(notice);
  if (plan.action === 'sync') context(startSync(plan, root));
}

if (isMain(import.meta.url)) {
  try { main(); } catch { /* não bloqueante */ }
  process.exit(0);
}
