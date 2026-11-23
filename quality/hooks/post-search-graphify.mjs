#!/usr/bin/env node
// PostToolUse (Bash) do Claude Code: abre a janela de busca bruta SÓ quando uma consulta ao
// graphify terminou com sucesso e trouxe resultado (o PreToolUse nunca registra: antes de rodar
// não dá para saber). Estado em quality/.state/graphify-guard.json, por sessão. Falha aberta.
import path from 'node:path';
import { readStdinJson, stateDir } from '../lib/util.mjs';
import { observeResult } from '../lib/search-guard.mjs';

/** Saída textual do Bash em tool_response (objeto com stdout ou texto direto). */
export function outputOf(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse;
  if (!toolResponse || typeof toolResponse !== 'object') return undefined;
  return toolResponse.stdout ?? toolResponse.output ?? toolResponse.content;
}

try {
  const input = readStdinJson();
  const response = input.tool_response;
  observeResult({
    host: 'claude',
    toolName: input.tool_name,
    params: input.tool_input ?? {},
    output: outputOf(response),
    success: response && typeof response === 'object' && response.interrupted ? false : undefined,
    sessionKey: input.session_id ?? 'sem-sessao',
    stateFile: path.join(stateDir(), 'graphify-guard.json'),
  });
} catch { /* falha aberta */ }
process.exit(0);
