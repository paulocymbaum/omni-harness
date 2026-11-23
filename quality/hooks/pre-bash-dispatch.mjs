#!/usr/bin/env node
// Despachante único do PreToolUse (Bash, Grep, Glob). Antes eram 4 processos node por chamada de
// Bash (rtk, pre-bash, gitflow, guarda de busca): ~240 ms de CPU contra ~28 ms de um node vazio.
// Aqui roda UM processo que lê o payload uma vez e executa as etapas em ordem, cada uma carregada
// só quando o comando a interessa:
//   1. guarda de busca (graphify primeiro; dica no modo suave, nega no strict)   Grep, Glob e Bash
//   2. evidência de testes antes de commit/push/deploy (pre-bash)   Bash
//   3. gitflow (branch pai, merge, push sincronizado)               Bash
//   4. reescrita para rtk (só se nenhuma etapa decidiu)             Bash
// A primeira decisão (deny ou ask) vence e encerra; é a mesma precedência de antes (qualquer deny
// ganhava). Cada etapa tem try/catch: um bug numa etapa nunca derruba as outras nem bloqueia o
// comando (falha aberta). Os scripts individuais continuam existindo como CLI e nos testes.
import path from 'node:path';
import fs from 'node:fs';
import { repoRoot, stateDir } from '../lib/util.mjs';

const isBash = (input) => input.tool_name === 'Bash';

async function searchGuard(input) {
  const { evaluate } = await import('../lib/search-guard.mjs');
  const decision = evaluate({
    host: 'claude',
    toolName: input.tool_name,
    params: input.tool_input ?? {},
    sessionKey: input.session_id ?? 'sem-sessao',
    root: repoRoot(),
    stateFile: path.join(stateDir(), 'graphify-guard.json'),
  });
  if (decision.action === 'allow') return null;
  const { denyMessage } = await import('../lib/search-message.mjs');
  const message = denyMessage(decision);
  if (decision.action === 'nudge') return { nudge: message }; // não decide: as outras etapas seguem
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message } };
}

async function commitGate(input) {
  if (!isBash(input)) return null;
  return (await import('./pre-bash.mjs')).evaluate(input);
}

async function gitflow(input) {
  if (!isBash(input) || !/\bgit\b/.test(input.tool_input?.command ?? '')) return null;
  return (await import('./pre-bash-gitflow.mjs')).evaluate(input);
}

/** Etapas que podem negar ou pedir confirmação; a primeira que decidir encerra. */
const DECIDERS = [searchGuard, commitGate, gitflow];

const withContext = (hookOutput, text) => ({ ...hookOutput, hookSpecificOutput: { ...hookOutput.hookSpecificOutput, additionalContext: text } });

/** Executa as etapas sobre o payload e devolve a saída (texto JSON) ou null. */
export async function dispatch(input, raw, env = process.env) {
  let nudge = null;
  for (const stage of DECIDERS) {
    try {
      const decision = await stage(input);
      if (decision?.nudge) nudge = decision.nudge;
      else if (decision) return JSON.stringify(decision);
    } catch (err) {
      process.stderr.write(`quality/pre-bash-dispatch (${stage.name}): ${err.message}\n`);
    }
  }
  let rewritten = null;
  if (isBash(input)) {
    try { rewritten = (await import('../lib/rtk-rewrite.mjs')).rtkClaudeHook(raw, env); } catch { /* sem reescrita */ }
  }
  if (!nudge) return rewritten;
  const base = rewritten ? JSON.parse(rewritten) : { hookSpecificOutput: { hookEventName: 'PreToolUse' } };
  return JSON.stringify(withContext(base, nudge));
}

const { isMain } = await import('../lib/is-main.mjs');
if (isMain(import.meta.url)) {
  let out = null;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    out = await dispatch(raw.trim() ? JSON.parse(raw) : {}, raw);
  } catch { /* falha aberta */ }
  if (out) process.stdout.write(out);
  process.exit(0);
}
