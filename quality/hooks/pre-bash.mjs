#!/usr/bin/env node
// PreToolUse (Bash): exige evidência do nível de teste pedido pela matriz de risco antes de commit, push e deploy.
// Sem ação relevante no comando → sai em milissegundos sem carregar o resto do motor.
import { readStdinJson } from '../lib/util.mjs';
import { classifyCommand } from '../lib/shell.mjs';
import { isMain } from '../lib/is-main.mjs';

const ORDER = { commit: 0, push: 1, deploy: 2 };

/** Decisão (ou null) para o payload do PreToolUse; exportada para o despachante pre-bash-dispatch.mjs. */
export async function evaluate(input) {
  const actions = classifyCommand(input.tool_input?.command ?? '');
  if (actions.length === 0) return null;
  const action = actions.sort((a, b) => ORDER[b.type] - ORDER[a.type])[0];
  const costFlags = [...new Set(actions.flatMap((a) => a.costFlags))];

  const { isGitRepo, worktreeHash } = await import('../lib/git.mjs');
  if (!isGitRepo()) return null;
  const { resolveScope } = await import('../lib/scope.mjs');
  const { classifyRisk, riskReasonsShort } = await import('../lib/risk.mjs');
  const { findEvidence } = await import('../lib/state.mjs');
  const { t, levelLabel, tierLabel } = await import('../lib/messages.mjs');

  const useBase = action.type !== 'commit';
  const { entries, scope } = resolveScope(useBase ? { base: 'remote' } : {});
  const risk = classifyRisk(entries);
  const actionLabel = t(`action.${action.type}`);
  const decision = (permissionDecision, reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason } });

  if (risk.level !== 'baixo') {
    const hash = worktreeHash();
    const required = risk.requiredTier;
    const ev = findEvidence(hash, { minTier: required, scope });
    // {required} vai no comando sugerido (identificador aceito pelo run.mjs); {requiredName} vai no texto.
    const params = { action: actionLabel, level: levelLabel(risk.level), required, requiredName: tierLabel(required), hash: hash.slice(0, 12), baseArg: useBase ? ' --base remote' : '' };
    if (!ev.pass) {
      const failedLast = ev.lastFail != null;
      return decision('deny', t(failedLast ? 'hook.bash.denyFailed' : 'hook.bash.deny', params));
    }
    const mustAsk = (action.type === 'deploy' && ['alto', 'critico'].includes(risk.level)) || (action.type === 'commit' && risk.level === 'critico');
    if (mustAsk) return decision('ask', t('hook.bash.ask', { ...params, reasons: riskReasonsShort(risk) }));
  }
  if (action.type === 'deploy' && costFlags.length) return decision('ask', t('hook.bash.askCost', { action: actionLabel, flags: costFlags.join(', ') }));
  return null;
}

if (isMain(import.meta.url)) {
  evaluate(readStdinJson())
    .then((out) => { if (out) process.stdout.write(JSON.stringify(out)); process.exit(0); })
    .catch((err) => { process.stderr.write(`quality/pre-bash: ${err.stack ?? err}\n`); process.exit(0); });
}
