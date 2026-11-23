#!/usr/bin/env node
// Stop: roda o nível automático da matriz de risco nos arquivos tocados na sessão e decide se bloqueia o encerramento.
import { readStdinJson, repoRoot, TIERS } from '../lib/util.mjs';
import { isGitRepo, collectEntries, worktreeHash } from '../lib/git.mjs';
import { classifyRisk, renderRisk } from '../lib/risk.mjs';
import { runTier } from '../lib/tiers.mjs';
import { loadSession, saveSession, findEvidence, recordEvidence } from '../lib/state.mjs';
import { counts, renderLine, summaryLine } from '../lib/report.mjs';
import { t, levelLabel, tierLabel } from '../lib/messages.mjs';
import { lembretesDeDeploy } from '../lib/deploy-pendente.mjs';

const AUTO_TIER = { baixo: 'rapido', medio: 'rapido', alto: 'rotina', critico: 'rotina' };
const MAX_BLOCKS_PER_STATE = 2;
const MAX_BLOCKS_PER_SESSION = 5;

/** Roda o nível automático, ou reaproveita uma execução aprovada para o mesmo estado. */
function evaluate(entries, tier, hash, root) {
  if (findEvidence(hash, { minTier: tier, scope: 'session' }).pass) return { results: [], reused: true };
  const results = runTier(tier, entries, { budgetMs: 240_000 });
  const c = counts(results);
  if (worktreeHash(root) === hash) recordEvidence(hash, { tier, scope: 'session', status: c.fail ? 'fail' : 'pass', counts: c });
  return { results, reused: false };
}

function blockOrRelease(ctx) {
  const { session, sessionId, hash, risk, tier, results, needFull, detail } = ctx;
  const c = counts(results);
  session.stopBlocks ??= {};
  const byState = session.stopBlocks[hash] ?? 0;
  const total = Object.values(session.stopBlocks).reduce((a, b) => a + b, 0);
  if (byState >= MAX_BLOCKS_PER_STATE || total >= MAX_BLOCKS_PER_SESSION) {
    return { systemMessage: [t('hook.stop.loop', { count: byState || total }), renderRisk(risk), ...detail.slice(0, 15), summaryLine(tier, results)].join('\n') };
  }
  session.stopBlocks[hash] = byState + 1;
  saveSession(sessionId, session);
  const head = c.fail > 0
    ? t('hook.stop.block', { failed: c.fail, tier, tierName: tierLabel(tier), level: levelLabel(risk.level) })
    : t('hook.stop.needFull');
  const extra = c.fail > 0 && needFull ? ['', t('hook.stop.needFull')] : [];
  return { decision: 'block', reason: [head, '', renderRisk(risk), '', ...detail, '', summaryLine(tier, results), ...extra].join('\n') };
}

function releaseMessage({ risk, tier, results, reused, detail }) {
  const c = counts(results);
  const lines = reused ? [t('hook.stop.reused', { tier: tierLabel(tier) })] : [];
  if (c.fail > 0) lines.push(t('hook.stop.warnLow'), ...detail.slice(0, 15));
  else if (TIERS.indexOf(risk.requiredTier) > TIERS.indexOf(tier)) {
    lines.push(t('hook.stop.passNeeds', { tier: tierLabel(tier), level: levelLabel(risk.level), required: risk.requiredTier, requiredName: tierLabel(risk.requiredTier) }));
  } else lines.push(t('hook.stop.pass', { tier: tierLabel(tier), level: levelLabel(risk.level) }));
  if (!reused) lines.push(summaryLine(tier, results));
  return { systemMessage: lines.join('\n') };
}

/** Avalia o risco da sessão, decide bloqueio/liberação e anexa os lembretes de deploy (QG-027). */
function resolverSessao({ input, root, session, entries, lembretes }) {
  const risk = classifyRisk(entries);
  const tier = AUTO_TIER[risk.level];
  const hash = worktreeHash(root);
  const { results, reused } = evaluate(entries, tier, hash, root);
  const needFull = risk.level === 'critico' && !findEvidence(hash, { minTier: 'completo', scope: 'session' }).pass;
  const detail = results.filter((r) => r.status === 'fail' || r.status === 'warn').map(renderLine);
  const ctx = { session, sessionId: input.session_id, hash, risk, tier, results, reused, needFull, detail };
  const needBlock = risk.level !== 'baixo' && (counts(results).fail > 0 || needFull);
  const resultado = needBlock ? blockOrRelease(ctx) : releaseMessage(ctx);
  if (lembretes.length) {
    resultado.systemMessage = [lembretes.join('\n\n'), resultado.systemMessage].filter(Boolean).join('\n\n');
  }
  return resultado;
}

function main() {
  const input = readStdinJson();
  const root = repoRoot();
  if (!isGitRepo(root)) {
    // Sem git NÃO silencia: informa o que fica indisponível e o caminho via CLI (R-hosts).
    const aviso = 'Repositório sem git: evidência por hash e gates de sessão do Stop ficam indisponíveis — rode os gates via CLI (node quality/run.mjs --tier rapido) e considere git init.';
    return { systemMessage: aviso, hookSpecificOutput: { hookEventName: 'Stop', additionalContext: aviso } };
  }
  // QG-027: deploy esquecido — homologação aprovada sem registro de deploy depois dela (aviso, não bloqueia).
  const lembretes = lembretesDeDeploy(root);
  const session = loadSession(input.session_id);
  const entries = session.touched?.length ? collectEntries({ root, only: session.touched }) : [];
  if (entries.length === 0) return lembretes.length ? { systemMessage: lembretes.join('\n\n') } : null;
  return resolverSessao({ input, root, session, entries, lembretes });
}

let out = null;
try { out = main(); } catch (err) { process.stderr.write(`quality/stop: ${err.stack ?? err}\n`); }
if (out) process.stdout.write(JSON.stringify(out));
process.exit(0);
