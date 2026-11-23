#!/usr/bin/env node
// PostToolUse (Bash): para o fluxo do agente em caso de conflito git. Com arquivos não
// mesclados, devolve decision block com o runbook de resolução em pt-BR (arquivos, passos
// por tipo de operação, como publicar depois e como abortar). Operação em andamento sem
// conflito (ex.: rebase multi-commit) gera apenas contexto adicional, sem bloquear.
import { readStdinJson, repoRoot } from '../lib/util.mjs';
import { t } from '../lib/messages.mjs';
import { isGitRepo, currentBranch, conflictState, RUNBOOK, fileList } from '../lib/gitstate.mjs';

try {
  const input = readStdinJson();
  const cmd = input.tool_input?.command ?? '';
  if (/\bgit\b/.test(cmd) && isGitRepo(repoRoot())) {
    const state = conflictState(repoRoot());
    if (state.files.length > 0) {
      const run = RUNBOOK[state.kind] ?? RUNBOOK.merge;
      const branch = currentBranch(repoRoot());
      const reason = t('gitflow.conflict.block', {
        cmd,
        kind: run.label,
        files: fileList(state.files),
        finish: run.finish,
        abort: run.abort,
        pushStep: run.pushStep.replace('{branch}', branch && branch !== 'HEAD' ? branch : '<branch>'),
      });
      process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    } else if (state.kind) {
      const run = RUNBOOK[state.kind] ?? RUNBOOK.merge;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: t('gitflow.conflict.progress', { kind: run.label, finish: run.finish }) },
      }));
    }
  }
} catch (err) {
  // Um hook de fluxo nunca deve impedir o comando do agente; registra e sai limpo.
  process.stderr.write(`quality/post-bash-gitflow: ${err.stack ?? err}\n`);
}
process.exit(0);
