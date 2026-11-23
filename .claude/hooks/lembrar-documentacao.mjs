#!/usr/bin/env node
// Stop: se a árvore de trabalho tem arquivo novo de domínio, módulo da API, migration/SQL ou feature das Functions
// e nenhum .md foi tocado, bloqueia o encerramento uma vez por conjunto de arquivos (AGENTS.md §2.6).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { missingDocs } from './lib/regras.mjs';

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  if (input.stop_hook_active) return null;
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

  let porcelain;
  try {
    porcelain = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8' });
  } catch {
    return null;
  }
  const missing = missingDocs(porcelain.split('\n'));
  if (missing.length === 0) return null;

  // Um lembrete por conjunto de arquivos: depois de respondido, só volta se surgir arquivo novo.
  const key = createHash('sha256').update(missing.map((m) => m.path).sort().join('\n')).digest('hex').slice(0, 16);
  const stateFile = path.join(root, '.claude', '.state', 'lembrar-documentacao.json');
  let seen = [];
  try { seen = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* primeiro uso */ }
  if (seen.includes(key)) return null;
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify([...seen, key].slice(-50)));

  const lines = missing.slice(0, 15).map((m) => `- ${m.path} (${m.label})`);
  if (missing.length > 15) lines.push(`- … e mais ${missing.length - 15}`);
  return {
    decision: 'block',
    reason: [
      'Documentação pendente: há arquivos novos de domínio/contrato/schema e nenhum .md foi alterado.',
      ...lines,
      '',
      'Atualize o doc do domínio em docs/ (e docs/tasks/<CHAVE>/entrega.md se houver card), seguindo a skill documentar-entrega,',
      'ou explique ao usuário por que a mudança não precisa de documentação. Este lembrete não se repete para os mesmos arquivos.',
    ].join('\n'),
  };
}

let out = null;
try { out = main(); } catch (err) { process.stderr.write(`.claude/hooks/lembrar-documentacao: ${err.stack ?? err}\n`); }
if (out) process.stdout.write(JSON.stringify(out));
process.exit(0);
