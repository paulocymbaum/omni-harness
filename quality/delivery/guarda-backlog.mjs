#!/usr/bin/env node
// PreToolUse (Edit, Write, MultiEdit): NEGA edição direta do `status` das tarefas em
// docs/entregas/*/backlog.json. O status só muda por `backlog.mjs mark`, que roda os gates, grava
// started_at/done_at, congela os gates e espelha no Jira. Adicionar tarefas (status pending), gates e
// demais campos continua livre. Falha aberta: JSON ilegível ou erro do hook nunca bloqueia.
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from '../lib/is-main.mjs';

const BACKLOG = /(^|\/)docs\/entregas\/[^/]+\/backlog\.json$/;

/** Mudanças de status entre duas versões do backlog: [{ id, de, para }] (tarefa nova só vale como pending). */
export function statusChanges(oldText, newText) {
  const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const before = parse(oldText);
  const after = parse(newText);
  if (!after || !Array.isArray(after.tasks)) return [];
  const old = new Map((before?.tasks ?? []).map((t) => [t.id, t.status]));
  return after.tasks.flatMap((t) => {
    const was = old.get(t.id);
    if (was === undefined) return t.status === 'pending' ? [] : [{ id: t.id, de: '(nova)', para: t.status }];
    return was === t.status ? [] : [{ id: t.id, de: was, para: t.status }];
  });
}

/** Texto do arquivo depois da edição pedida (Write, Edit ou MultiEdit), ou null se não der para saber. */
export function textAfter(toolName, input, current) {
  if (toolName === 'Write') return input.content ?? null;
  const edits = toolName === 'MultiEdit' ? input.edits ?? [] : [input];
  let text = current;
  for (const e of edits) {
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string' || !text.includes(e.old_string)) return null;
    text = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, e.new_string);
  }
  return text;
}

export function evaluate(payload, root = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  const input = payload.tool_input ?? {};
  const file = input.file_path ?? '';
  if (!['Edit', 'Write', 'MultiEdit'].includes(payload.tool_name) || !BACKLOG.test(file.split(path.sep).join('/'))) return null;
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  let current = '';
  try { current = fs.readFileSync(abs, 'utf8'); } catch { /* arquivo novo */ }
  const after = textAfter(payload.tool_name, input, current);
  if (after === null) return null;
  const changes = statusChanges(current, after);
  if (!changes.length) return null;
  const lista = changes.map((c) => `${c.id}: ${c.de} → ${c.para}`).join('; ');
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: `Status de tarefa não se edita no backlog.json (${lista}). Use: node quality/delivery/backlog.mjs mark <dir> <ID> --status <status> [--motivo "..."]. O mark roda os gates, grava as datas, congela os gates e espelha no Jira.`,
    },
  };
}

if (isMain(import.meta.url)) {
  let out = null;
  try { out = evaluate(JSON.parse(fs.readFileSync(0, 'utf8') || '{}')); } catch { /* falha aberta */ }
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
