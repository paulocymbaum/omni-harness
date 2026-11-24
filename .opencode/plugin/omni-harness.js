// Ponte OpenCode → quality/hooks do harness (mesmo protocolo de hooks do Claude Code).
// Instalada em .opencode/plugin/omni-harness.js pelo harness-init (--hosts opencode).
//   tool.execute.before (bash) → quality/hooks/pre-bash.mjs: violação de guardas faz a tool
//   FALHAR com o motivo do gate (throw → OpenCode entrega o erro ao agente).
//   tool.execute.after (edit)  → quality/hooks/post-edit.mjs: tier rápido + autofix; as linhas
//   do veredito são anexadas ao metadata da tool.
// Falha aberta: harness ausente ou hook sem resposta = a tool segue sem bloqueio.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SHELL = new Set(['bash', 'shell', 'run_commands', 'execute_command']);
const EDIT = new Set(['edit', 'write', 'multiedit', 'patch', 'write_to_file', 'replace_in_file', 'str_replace_editor', 'apply_patch']);

const linhasDoVeredito = (r) => {
  const j = r.json;
  const out = [];
  if (j?.decision === 'block' && j.reason) out.push(j.reason);
  if (j?.hookSpecificOutput?.additionalContext) out.push(j.hookSpecificOutput.additionalContext);
  if (j?.systemMessage) out.push(j.systemMessage);
  return out;
};

const parseJsonSeguro = (texto) => { try { return texto?.trim() ? JSON.parse(texto) : null; } catch { return null; } };
const spawnOpts = (root, payload) => ({
  cwd: root,
  input: JSON.stringify({ session_id: 'opencode', cwd: root, hook_event_name: payload.event ?? 'PreToolUse', ...payload }),
  encoding: 'utf8',
  timeout: 90_000,
  env: { ...process.env, CLAUDE_PROJECT_DIR: root, QUALITY_ROOT: process.env.QUALITY_ROOT ?? root },
});
const rodarPadrao = (root) => (script, payload) => {
  const r = spawnSync(process.execPath, [path.join(root, script)], spawnOpts(root, payload));
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json: parseJsonSeguro(r.stdout) };
};
const negacaoPadrao = (r) => {
  if (r.code === 2 && r.stderr.trim()) return r.stderr.trim();
  const d = r.json?.hookSpecificOutput;
  if (d?.permissionDecision === 'deny') return d.permissionDecisionReason ?? 'bloqueado pelo harness';
  return null;
};

export const OmniHarness = async (ctx) => {
  const root = ctx?.directory ?? process.cwd();
  const deps = ctx?.deps ?? {};
  const rodar = deps.rodar ?? rodarPadrao(root);
  const negacao = deps.negacao ?? negacaoPadrao;
  return {
    'tool.execute.before': async (input, output) => {
      const tool = String(input.tool ?? '').toLowerCase();
      if (!SHELL.has(tool)) return;
      const raw = output.args ?? {};
      const commands = Array.isArray(raw.commands) ? raw.commands : raw.command ? [raw.command] : [];
      for (const command of commands) {
        const r = rodar('quality/hooks/pre-bash.mjs', { tool_name: 'Bash', tool_input: { command }, event: 'PreToolUse' });
        const motivo = negacao(r);
        if (motivo) throw new Error(`BLOQUEADO pelo harness do projeto: ${motivo}`);
      }
    },
    'tool.execute.after': async (input, output) => {
      const tool = String(input.tool ?? '').toLowerCase();
      if (!EDIT.has(tool)) return;
      const file = output.args?.filePath ?? output.args?.file_path ?? output.args?.path;
      if (!file) return;
      const r = rodar('quality/hooks/post-edit.mjs', { tool_name: 'Write', tool_input: { file_path: file }, event: 'PostToolUse' });
      const lin = linhasDoVeredito(r);
      if (lin.length) output.metadata = { ...(output.metadata ?? {}), harness: lin.join('\n') };
    },
  };
};