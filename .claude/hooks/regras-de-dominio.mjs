#!/usr/bin/env node
// PostToolUse (Edit|Write|MultiEdit): regras de domínio do AGENTS.md no texto que acabou de ser escrito.
// Bloqueio → exit 2 com o motivo no stderr (o Claude recebe e corrige). Avisos → additionalContext.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { addedText, checkContent } from './lib/regras.mjs';

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const file = input.tool_input?.file_path;
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  if (!file) return 0;
  const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  if (rel.startsWith('..')) return 0;

  const { bloqueios, avisos } = checkContent(rel, addedText(input.tool_input));
  if (bloqueios.length) {
    process.stderr.write(['REPROVADO — regras de domínio (AGENTS.md):', ...bloqueios, ...avisos].join('\n') + '\n');
    return 2;
  }
  if (avisos.length) {
    const additionalContext = ['ALERTA — regras de domínio (AGENTS.md):', ...avisos].join('\n');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }));
  }
  return 0;
}

let code = 0;
try { code = main(); } catch (err) { process.stderr.write(`.claude/hooks/regras-de-dominio: ${err.stack ?? err}\n`); code = 1; }
process.exit(code);
