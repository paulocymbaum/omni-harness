#!/usr/bin/env node
// PostToolUse (Edit|Write|MultiEdit|NotebookEdit): nível rápido no arquivo editado + atualização do risco da sessão.
// REPROVADO → exit 2 com o relatório no stderr (o Claude recebe e corrige). APROVADO → uma linha de contexto.
import { readStdinJson, relToRoot, repoRoot, LEVELS } from '../lib/util.mjs';
import { isGitRepo, collectEntries } from '../lib/git.mjs';
import { isGenerated } from '../lib/layers.mjs';
import { rapidoGates } from '../lib/tiers.mjs';
import { classifyRisk, riskReasonsShort } from '../lib/risk.mjs';
import { addTouched, loadSession, saveSession } from '../lib/state.mjs';
import { counts, renderLine } from '../lib/report.mjs';
import { autofixReport } from '../lib/autofix.mjs';
import { t, levelLabel, tierLabel } from '../lib/messages.mjs';

function main() {
  const input = readStdinJson();
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  const root = repoRoot();
  const rel = relToRoot(file, root);
  if (!rel || rel.startsWith('quality/.state/') || !isGitRepo(root)) return 0;
  const sessionId = input.session_id;
  addTouched(sessionId, rel);
  const session = loadSession(sessionId);

  // Autocorreção leve (só gate/teste): correções mecânicas + erro de sintaxe/lint devolvido ao agente.
  const notes = [];
  const fx = autofixReport(rel, session, root);
  saveSession(sessionId, session);
  notes.push(...fx.messages);
  if (fx.block) {
    process.stderr.write([...fx.errors, ...notes].join('\n') + '\n');
    return 2;
  }

  let results = [];
  if (!isGenerated(rel)) {
    results = rapidoGates(collectEntries({ root, only: [rel] }));
    // Aviso de ferramenta ausente só uma vez por sessão.
    if (session.toolsWarned) results = results.filter((r) => r.gate !== 'ferramentas');
    else if (results.some((r) => r.gate === 'ferramentas')) session.toolsWarned = true;
  }

  const risk = classifyRisk(collectEntries({ root, only: session.touched }));
  const raised = LEVELS.indexOf(risk.level) > LEVELS.indexOf(session.lastLevel ?? 'baixo');
  session.lastLevel = risk.level;
  saveSession(sessionId, session);
  const riskLine = raised ? t('risk.raised', { level: levelLabel(risk.level), reasons: riskReasonsShort(risk), tier: tierLabel(risk.requiredTier) }) : null;

  const c = counts(results);
  const detail = results.filter((r) => r.status === 'fail' || r.status === 'warn').map(renderLine);
  if (c.fail > 0) {
    process.stderr.write([...notes, t('hook.post.fail', { file: rel, failed: c.fail }), ...detail, ...(riskLine ? [riskLine] : [])].join('\n') + '\n');
    return 2;
  }
  if (results.length === 0 && !riskLine && notes.length === 0) return 0;
  const lines = [...notes];
  if (results.length) lines.push(`${t('status.pass')} — ${t('hook.post.pass', { file: rel, passed: c.pass, warned: c.warn })}`, ...detail);
  if (riskLine) lines.push(riskLine);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lines.join('\n') } }));
  return 0;
}

let code = 0;
try { code = main(); } catch (err) { process.stderr.write(`quality/post-edit: ${err.stack ?? err}\n`); code = 0; }
process.exit(code);
