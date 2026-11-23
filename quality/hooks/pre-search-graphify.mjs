#!/usr/bin/env node
// PreToolUse (Grep|Glob|Bash) do Claude Code: incentiva consultar o grafo do graphify antes da busca
// bruta (política em quality/lib/search-guard.mjs). Modo suave (padrão): dica via additionalContext,
// uma vez por janela, e a busca segue. GRAPHIFY_HOOK_MODE=strict nega a busca até haver consulta.
// Falha aberta: erro, grafo ausente ou CLI ausente libera. Desligar: GRAPHIFY_HOOK_MODE=off.
// Em produção quem roda é o despachante (pre-bash-dispatch.mjs); este arquivo é a CLI independente.
import path from 'node:path';
import { readStdinJson, repoRoot, stateDir } from '../lib/util.mjs';
import { evaluate } from '../lib/search-guard.mjs';
import { denyMessage } from '../lib/search-message.mjs';

try {
  const input = readStdinJson();
  const decision = evaluate({
    host: 'claude',
    toolName: input.tool_name,
    params: input.tool_input ?? {},
    sessionKey: input.session_id ?? 'sem-sessao',
    root: repoRoot(),
    stateFile: path.join(stateDir(), 'graphify-guard.json'),
  });
  if (decision.action === 'deny') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyMessage(decision) },
    }));
  } else if (decision.action === 'nudge') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: denyMessage(decision) } }));
  }
} catch { /* falha aberta */ }
process.exit(0);
