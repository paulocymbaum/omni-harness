#!/usr/bin/env node
// PostToolUse hook: quando uma entrega está ativa (entrega-ativa.json),
// avisa se uma edição sair do escopo definido para a tarefa.
// Desligar: apagar quality/.state/entrega-ativa.json
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const toolName = input.tool_name ?? '';
  const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  if (!EDIT_TOOLS.has(toolName)) return null;

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const stateFile = path.join(
    process.env.QUALITY_STATE_DIR || path.join(root, 'quality', '.state'),
    'entrega-ativa.json',
  );
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; }
  if (!state?.taskId || !Array.isArray(state.scope)) return null;

  const file = input.tool_input?.file_path ?? input.tool_input?.path ?? '';
  if (!file) return null;

  const rel = path.relative(root, path.isAbsolute(file) ? file : path.join(root, file))
    .split(path.sep).join('/');
  if (rel.startsWith('..')) return null; // fora do repo

  const inScope = state.scope.some((s) => rel === s || rel.startsWith(s + '/'));
  if (inScope) return null;

  const additionalContext = [
    `⚠ guarda-entrega: edição fora do escopo da entrega ativa (${state.taskId}).`,
    `  Arquivo: ${rel}`,
    `  Escopo: ${state.scope.join(', ') || '(vazio)'}`,
    `  Se a edição for necessária, atualize o campo "scope" em quality/.state/entrega-ativa.json`,
    `  ou apague o arquivo para desativar o guarda.`,
  ].join('\n');

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext,
    },
  };
}

let out = null;
try { out = main(); } catch (err) { process.stderr.write(`guarda-entrega: ${err.stack ?? err}\n`); }
if (out) process.stdout.write(JSON.stringify(out));
process.exit(0);
