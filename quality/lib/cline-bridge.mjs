// Ponte Claude → Cline: traduz o payload de ferramenta do Cline para o formato do Claude Code e roda os MESMOS
// scripts de hook (quality/hooks, .claude/hooks, quality/delivery). Uma regra, uma implementação, dois hosts.
// Semântica do Cline (SDK verificado): PreToolUse pode `cancel` (PARA A TAREFA INTEIRA), `context` (dica) e
// `overrideInput`; PostToolUse só `context`/stop. Por isso a negação é "suave" sempre que possível: comando de
// shell vira `echo <motivo>; exit 1` via overrideInput (o agente lê o motivo e segue). Sem override (extensão
// VS Code, edição de arquivo), nega com cancel:true — raro e explícito.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { QUALITY_DIR, relToRoot } from './util.mjs';
import { writtenPaths } from './spec-sync.mjs';
import { mapCommands } from './rtk-rewrite.mjs';

const REPO = path.dirname(QUALITY_DIR);
export const SCRIPTS = {
  commitGate: 'quality/hooks/pre-bash.mjs',
  gitflowPre: 'quality/hooks/pre-bash-gitflow.mjs',
  guardaBacklog: 'quality/delivery/guarda-backlog.mjs',
  postEdit: 'quality/hooks/post-edit.mjs',
  postEditGraphify: 'quality/hooks/post-edit-graphify.mjs',
  regrasDominio: '.claude/hooks/regras-de-dominio.mjs',
  guardaEntrega: 'quality/delivery/guarda-entrega.mjs',
  gitflowPost: 'quality/hooks/post-bash-gitflow.mjs',
  sessionStart: 'quality/hooks/session-start.mjs',
  stop: 'quality/hooks/stop.mjs',
  lembrarDocs: '.claude/hooks/lembrar-documentacao.mjs',
};

const SHELL = new Set(['run_commands', 'execute_command']);
const EDIT = new Set(['editor', 'write_to_file', 'replace_in_file', 'apply_patch', 'str_replace_editor']);
export const kindOf = (toolName) => (SHELL.has(toolName) ? 'shell' : EDIT.has(toolName) ? 'edit' : null);

/** JSON em string vira objeto (a extensão do Cline manda parâmetros como texto). */
function asParams(params) {
  if (typeof params === 'string') { try { return JSON.parse(params); } catch { return { input: params }; } }
  return params && typeof params === 'object' ? params : {};
}

/** Comandos de shell de uma chamada (run_commands: commands[]; execute_command: command). */
export function shellCommands(params) {
  const p = asParams(params);
  const raw = p.commands ?? p.command ?? p.cmd;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((c) => (typeof c === 'string' ? c : c?.command ?? '')).filter(Boolean);
}

const SEARCH_REPLACE = /<{3,}\s*SEARCH\s*\n([\s\S]*?)\n?={3,}\s*\n([\s\S]*?)\n?>{3,}\s*REPLACE/g;

/** Edições de UM arquivo no vocabulário do Claude (Write, Edit ou MultiEdit). */
function editFor(file, p) {
  const content = p.file_text ?? p.content;
  if (p.command === 'create' || (typeof content === 'string' && p.old_str === undefined && p.diff === undefined)) {
    return { tool_name: 'Write', tool_input: { file_path: file, content: content ?? '' } };
  }
  if (typeof p.old_str === 'string') return { tool_name: 'Edit', tool_input: { file_path: file, old_string: p.old_str, new_string: p.new_str ?? '' } };
  if (typeof p.diff === 'string') {
    const edits = [...p.diff.matchAll(SEARCH_REPLACE)].map((m) => ({ old_string: m[1], new_string: m[2] }));
    if (edits.length) return { tool_name: 'MultiEdit', tool_input: { file_path: file, edits } };
  }
  if (p.command === 'insert' && typeof p.new_str === 'string') return { tool_name: 'Edit', tool_input: { file_path: file, new_string: p.new_str } };
  // apply_patch e formatos desconhecidos: só as linhas adicionadas (as regras de domínio olham o texto novo).
  const patch = [p.input, p.patch].find((v) => typeof v === 'string' && v.includes('*** '));
  const added = patch ? patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n') : undefined;
  return { tool_name: 'Edit', tool_input: { file_path: file, ...(added ? { new_string: added } : {}) } };
}

/** Payloads no formato do Claude para uma chamada do Cline: [{ tool_name, tool_input }]. */
export function claudeCalls(toolName, params, root) {
  const p = asParams(params);
  const kind = kindOf(toolName);
  if (kind === 'shell') return shellCommands(p).map((command) => ({ tool_name: 'Bash', tool_input: { command } }));
  if (kind !== 'edit') return [];
  const files = [...new Set(writtenPaths(p).map((f) => path.resolve(root, f)))];
  return files.map((abs) => editFor(abs, p));
}

/** Roda um script de hook do repositório com o payload do Claude; nunca lança. */
export function runClaudeHook(script, payload, { root, sessionId, timeoutMs = 60_000 }) {
  const r = spawnSync(process.execPath, [path.join(REPO, script)], {
    cwd: root,
    input: JSON.stringify({ session_id: sessionId, cwd: root, hook_event_name: payload.hook_event_name ?? 'PostToolUse', ...payload }),
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, QUALITY_ROOT: process.env.QUALITY_ROOT ?? root },
  });
  let json = null;
  try { json = r.stdout?.trim() ? JSON.parse(r.stdout) : null; } catch { /* saída textual */ }
  const timedOut = (r.error != null && r.error.code === 'ETIMEDOUT') || (r.signal === 'SIGTERM' && r.status === null);
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json, failed: r.error != null, timedOut };
}

/** Resultado de hook PreToolUse do Claude → { deny, ask, context } (texto). */
export function readPre(res) {
  const h = res.json?.hookSpecificOutput;
  const reason = h?.permissionDecisionReason;
  if (h?.permissionDecision === 'deny') return { deny: reason ?? 'bloqueado pelo harness' };
  if (h?.permissionDecision === 'ask') return { ask: reason ?? 'confirmação necessária' };
  if (res.code === 2) return { deny: res.stderr.trim() || 'bloqueado pelo harness' };
  return { context: h?.additionalContext };
}

/** Resultado de hook PostToolUse/Stop/SessionStart → linhas de texto para o agente. */
export function readPost(res) {
  const lines = [];
  if (res.code === 2 && res.stderr.trim()) lines.push(res.stderr.trim());
  const j = res.json;
  if (j?.decision === 'block' && j.reason) lines.push(j.reason);
  if (j?.hookSpecificOutput?.additionalContext) lines.push(j.hookSpecificOutput.additionalContext);
  if (j?.systemMessage) lines.push(j.systemMessage);
  return lines;
}

/**
 * Negação no vocabulário do Cline. Shell com `overrideInput` disponível (CLI/SDK): o comando vira um no-op que imprime o
 * motivo e falha. Caso contrário, cancel:true (para a tarefa; o motivo vai em errorMessage).
 */
export function softDeny({ toolName, params, sdk }, text, kind = 'BLOQUEADO') {
  const message = `${kind} pelo harness do projeto: ${text}`;
  if (sdk && toolName === 'run_commands') {
    const echo = `printf '%s\\n' ${shellQuote(message)} >&2; exit 1`;
    const { input } = mapCommands(asParams(params), () => echo);
    return { cancel: false, overrideInput: input, context: message, contextModification: message };
  }
  return { cancel: true, errorMessage: message };
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const relPath = (file, root) => relToRoot(path.resolve(root, file), root);

/** Teto defensivo do contexto injetado no Cline — hoje as notices não truncam; estourar o contexto do host é pior. */
export const CAP_CONTEXTO = 8_000;

/** Contexto com teto: acima do cap, corta com marcador e aponta o caminho integral (CLI). */
export function comCap(texto) {
  const t = String(texto ?? '');
  if (t.length <= CAP_CONTEXTO) return t;
  return `${t.slice(0, CAP_CONTEXTO)}\n…(truncado pelo harness no teto de ${CAP_CONTEXTO} caracteres — rode os gates via CLI para o texto integral)`;
}
