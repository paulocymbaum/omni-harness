#!/usr/bin/env node
// PreToolUse do Cline (.clinerules/hooks/PreToolUse chama este arquivo). Mesma política do
// Claude Code (quality/lib/search-guard.mjs) nos dois formatos de payload do Cline:
//   - extensão VS Code: { preToolUse: { toolName, parameters } }, valores às vezes em JSON string;
//     ferramentas execute_command, search_files, list_files.
//   - CLI/SDK: { tool_call: { name, input } } (+ preToolUse); ferramentas run_commands,
//     search_codebase, read_files, editor.
// NUNCA cancela: no Cline `cancel: true` PARA A TAREFA INTEIRA (SDK: `result.stop = true` em
// beforeToolResultFromControl), não só a chamada. Por isso a guarda de busca usa só `context`
// (dica anexada à conversa, a busca segue) e funciona em qualquer modo; "strict" aqui significa
// repetir a dica a cada busca, não bloquear. No CLI/SDK, `overrideInput` reescreve comandos ruidosos para `rtk <cmd>` (a extensão não
// aceita reescrita; lá vale a regra .clinerules). Falha aberta: erro ou formato desconhecido libera.
import path from 'node:path';
import { readStdinJson, repoRoot, stateDir } from '../lib/util.mjs';
import { evaluate } from '../lib/search-guard.mjs';
import { mapCommands, rtkRewrite } from '../lib/rtk-rewrite.mjs';
import { clampSleeps } from '../lib/teto-fuzzy.mjs';
import { registrarComando } from '../lib/anti-loop.mjs';
import { denyMessage } from '../lib/search-message.mjs';
import { classifyCommand } from '../lib/shell.mjs';
import { SCRIPTS, claudeCalls, kindOf, readPre, runClaudeHook, softDeny } from '../lib/cline-bridge.mjs';

const firstDefined = (...values) => values.find((v) => v !== undefined && v !== null);

/** Extrai { toolName, params, sdk } do JSON do Cline, tolerando as variações de versão. */
export function readCall(input) {
  const pre = input.preToolUse ?? input.pre_tool_use ?? {};
  const call = input.tool_call ?? {};
  return {
    toolName: firstDefined(call.name, pre.toolName, pre.tool_name, input.toolName, input.tool),
    params: firstDefined(call.input, pre.parameters, pre.params, input.parameters, {}),
    sdk: Boolean(input.tool_call),
  };
}

/** Dica para o agente: `context` (SDK/CLI) e `contextModification` (extensão VS Code), mesmo texto. */
const hintOf = (message) => ({ context: message, contextModification: message });

const AVISO_ANTI_LOOP =
  'Mesmo comando repetido 4×: o harness aborta a tarefa em 5 chamadas idênticas. ' +
  'Troque de estratégia entre checagens — faça trabalho útil, leia o log com Read (sem shell) ' +
  'ou varie a espera.';

function textosDe(decision, preparado, bridged) {
  return [
    decision.action === 'allow' ? null : denyMessage(decision),
    ...(preparado.avisar ? [AVISO_ANTI_LOOP] : []),
    ...(bridged.hints ?? []),
  ].filter(Boolean);
}

/**
 * Para run_commands no CLI/SDK: registra o comando no anti-loop (variação determinística
 * na 3ª repetição idêntica, antes do detector de 5 do harness), rebaixa sleeps pelo teto
 * fuzzy e reescreve para rtk. Devolve o input preparado e se o agente deve ser avisado.
 */
function prepararRunCommands(params, taskId) {
  const stateFile = path.join(stateDir(), 'anti-loop.json');
  let avisar = false;
  const { changed, input } = mapCommands(params, (cmd) => {
    const { comandoFinal, avisar: aviso } = registrarComando({
      stateFile,
      sessionId: taskId,
      comando: cmd,
    });
    avisar = avisar || aviso;
    const comClamp = clampSleeps(comandoFinal);
    return rtkRewrite(comClamp) ?? (comClamp !== comandoFinal ? comClamp : null);
  });
  return { params: input, changed, avisar };
}

/** Hooks de PreToolUse do Claude que se aplicam a esta chamada (mesmos scripts, mesma ordem do Claude). */
function claudeStages(kind, c) {
  if (kind === 'edit') return [SCRIPTS.guardaBacklog];
  if (kind !== 'shell') return [];
  const cmd = c.tool_input.command;
  const stages = [];
  if (classifyCommand(cmd).length) stages.push(SCRIPTS.commitGate);
  if (/\bgit\b/.test(cmd)) stages.push(SCRIPTS.gitflowPre);
  return stages;
}

/** Negações (deny/ask) e dicas dos hooks do Claude. A primeira negação vence, como no despachante do Claude. */
function bridgePre(call, root, sessionId) {
  const kind = kindOf(call.toolName);
  const hints = [];
  for (const c of claudeCalls(call.toolName, call.params, root)) {
    for (const script of claudeStages(kind, c)) {
      const r = readPre(runClaudeHook(script, { hook_event_name: 'PreToolUse', ...c }, { root, sessionId }));
      if (r.deny) return { deny: softDeny(call, r.deny) };
      if (r.ask) return { deny: softDeny(call, `${r.ask}\nPergunte ao usuário e, com a aprovação dele, repita.`, 'CONFIRMAÇÃO NECESSÁRIA') };
      if (r.context) hints.push(r.context);
    }
  }
  return { hints };
}

function main() {
  const input = readStdinJson();
  const { toolName, params, sdk } = readCall(input);
  const root = process.env.QUALITY_ROOT || input.workspaceRoots?.[0] || repoRoot();
  const taskId = input.taskId ?? input.sessionId ?? 'sem-tarefa';
  const decision = evaluate({
    host: 'cline',
    toolName,
    params,
    sessionKey: taskId,
    root,
    stateFile: path.join(stateDir(), 'graphify-guard.json'),
  });
  const bridged = bridgePre({ toolName, params, sdk }, root, `cline-${taskId}`);
  if (bridged.deny) return bridged.deny;
  const preparado =
    toolName === 'run_commands'
      ? prepararRunCommands(params, taskId)
      : { params, changed: false, avisar: false };
  const textos = textosDe(decision, preparado, bridged);
  const hint = textos.length ? hintOf(textos.join('\n')) : {};
  return {
    cancel: false,
    ...hint,
    ...(preparado.changed ? { overrideInput: preparado.params } : {}),
  };
}

let out = { cancel: false };
try { out = main(); } catch { /* falha aberta */ }
process.stdout.write(JSON.stringify(out));
process.exit(0);
