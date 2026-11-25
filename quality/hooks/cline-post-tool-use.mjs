#!/usr/bin/env node
// PostToolUse do Cline (.clinerules/hooks/PostToolUse chama este arquivo). Informativo: o Cline
// ignora cancelamento aqui, então só registra estado:
//  - abre a janela de busca bruta quando uma consulta ao graphify deu certo e trouxe resultado
//    (política em quality/lib/search-guard.mjs, a mesma do Claude Code);
//  - quando uma spec de docs/entregas/<slug>/specs/<ID>.md é gravada (editor, write_to_file,
//    replace_in_file, apply_patch), atualiza o card do Jira em segundo plano com as mesmas travas
//    do Claude (quality/lib/spec-sync.mjs: Status: ready, sem PII, lock de 2 min). Avisos
//    (PII ou falta de credencial) voltam em `contextModification`.
// Payload verificado no SDK do Cline: { postToolUse: { toolName, parameters (mapa de strings),
// result, success, executionTimeMs }, tool_result: { name } }. Falha aberta; responde `{}`.
import path from 'node:path';
import { readStdinJson, repoRoot, stateDir } from '../lib/util.mjs';
import { SCRIPTS, claudeCalls, comCap, kindOf, readPost, runClaudeHook } from '../lib/cline-bridge.mjs';
import { observeResult } from '../lib/search-guard.mjs';
import { noticeOf, planSync, startSync, writtenPaths } from '../lib/spec-sync.mjs';

/** Extrai { toolName, params, output, success } do JSON do Cline. */
function readPostCall(input) {
  const post = input.postToolUse ?? {};
  const result = input.tool_result ?? {};
  return {
    toolName: post.toolName ?? result.name ?? input.toolName,
    params: post.parameters ?? input.tool_call?.input ?? {},
    output: post.result ?? result.output ?? result.content,
    success: typeof post.success === 'boolean' ? post.success : undefined,
  };
}

/** Raiz do workspace: QUALITY_ROOT, workspaceRoots[0] (texto) ou a raiz deste repositório. */
function workspaceRoot(input) {
  const first = input.workspaceRoots?.[0];
  return process.env.QUALITY_ROOT || (typeof first === 'string' ? first : null) || repoRoot();
}

/** Sincroniza specs gravadas por esta chamada; devolve só os avisos que o agente precisa ver. */
function syncWrittenSpecs(call, root) {
  if (call.success === false) return [];
  const notices = [];
  for (const file of writtenPaths(call.params)) {
    const plan = planSync({ root, rel: path.relative(root, path.resolve(root, file)).split(path.sep).join('/') });
    const notice = noticeOf(plan);
    if (notice) notices.push(notice);
    else if (plan.action === 'sync') startSync(plan, root);
  }
  return notices;
}

/** Hooks de PostToolUse do Claude (mesmos scripts): gates rápidos + autocorreção, regras de domínio, escopo, git. */
const POST_STAGES = {
  edit: [SCRIPTS.postEdit, SCRIPTS.regrasDominio, SCRIPTS.guardaEntrega, SCRIPTS.postEditGraphify],
  shell: [SCRIPTS.gitflowPost],
};

/**
 * Roda os hooks do Claude e devolve só o texto que o agente precisa ver. O Cline ignora cancelamento no
 * PostToolUse, então o que no Claude é exit 2 / decision:block chega aqui como contexto, com o mesmo texto.
 */
function bridgeWritten(call, root, sessionKey) {
  if (call.success === false) return [];
  const kind = kindOf(call.toolName);
  const stages = POST_STAGES[kind];
  if (!stages) return [];
  const lines = [];
  for (const c of claudeCalls(call.toolName, call.params, root)) {
    if (kind === 'shell' && !/\bgit\b/.test(c.tool_input.command)) continue;
    for (const script of stages) {
      lines.push(...readPost(runClaudeHook(script, { hook_event_name: 'PostToolUse', ...c }, { root, sessionId: `cline-${sessionKey}` })));
    }
  }
  return lines;
}

let out = {};
try {
  const input = readStdinJson();
  const call = readPostCall(input);
  observeResult({
    host: 'cline',
    ...call,
    sessionKey: input.taskId ?? input.sessionId ?? 'sem-tarefa',
    stateFile: path.join(stateDir(), 'graphify-guard.json'),
  });
  const root = workspaceRoot(input);
  const notices = [...bridgeWritten(call, root, input.taskId ?? input.sessionId ?? 'sem-tarefa'), ...syncWrittenSpecs(call, root)];
  if (notices.length) out = { contextModification: comCap(notices.join('\n')) };
} catch { /* falha aberta */ }
process.stdout.write(JSON.stringify(out));
process.exit(0);
