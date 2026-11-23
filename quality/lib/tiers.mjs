import { TIERS, repoRoot } from './util.mjs';
import { layerOf, isGenerated } from './layers.mjs';
import { fastGates } from './gates/fast.mjs';
import { actionsPinsGate } from './gates/workflows.mjs';
import { lizardCommand, which } from './tools.mjs';
import { result } from './report.mjs';
import { Budget } from './runners/common.mjs';
import { timeFactor } from './limits.mjs';
import { runsPerDay } from './risk.mjs';
import { costBudgetGate } from './cost-job.mjs';
import { flutterAnalyze, flutterRelatedTests, flutterFull } from './runners/flutter.mjs';
import { functionsRoutine, ocrRoutine, webRoutine } from './runners/typescript.mjs';
import { backendRoutine, infraRoutine, supplyChain } from './runners/backend.mjs';

export { diffCoverage } from './runners/flutter.mjs';
export { ocrRouterScan } from './runners/typescript.mjs';

// ================================================================ nível rápido
export function rapidoGates(entries) {
  const out = [];
  const live = entries.filter((e) => e.status !== 'D' && !isGenerated(e.path));
  if (live.some((e) => /\.(dart|tsx?|m?js|cs|py)$/.test(e.path)) && !lizardCommand()) {
    out.push(result('ferramentas', 'warn', 'tool.missing', { tool: 'lizard', impact: 'Complexidade por função não medida (instale com: uv tool install lizard).' }));
  }
  if (live.some((e) => e.path.endsWith('.dart')) && !which('dart')) {
    out.push(result('ferramentas', 'warn', 'tool.missing', { tool: 'dart', impact: 'Formatação Dart não verificada.' }));
  }
  for (const e of live) out.push(...fastGates(e));
  return out;
}

// ================================================================ orquestração
// Camadas TypeScript web/worker que passam pela rotina de lint, tipos e testes do pacote.
const WEB_LAYERS = ['admin-web', 'site', 'debate-worker', 'creator-render', 'creator-worker'];

export const TIER_BUDGET_MS = { rapido: 60_000, rotina: 270_000, completo: 1_800_000 };

/** Runners por camada + gates de nível completo (supply chain e orçamento de jobs). */
function rodarCamadas(tier, entries, byLayer, out, budget) {
  const full = tier === 'completo';
  rodarFlutter(tier, entries, byLayer, out, budget);
  if (byLayer.has('functions') || byLayer.has('rules')) functionsRoutine(entries, out, budget, full);
  if (byLayer.has('ocr')) ocrRoutine(entries, out, budget, full);
  if (WEB_LAYERS.some((id) => byLayer.has(id))) webRoutine(entries, out, budget, full);
  if (byLayer.has('backend') || byLayer.has('rules')) backendRoutine(entries, out, budget, full);
  if (byLayer.has('infra')) infraRoutine(entries, out);
  if (full) rodarCompleto(entries, out);
}

/** Camada Flutter: analyze sempre; suíte completa na entrega, relacionados na iteração. */
function rodarFlutter(tier, entries, byLayer, out, budget) {
  if (!byLayer.has('flutter')) return;
  flutterAnalyze(entries, out, budget);
  const testes = tier === 'completo' ? flutterFull : flutterRelatedTests;
  testes(entries, out, budget);
}

/** Só no nível completo: supply chain (osv) e orçamento agregado de jobs agendados. */
function rodarCompleto(entries, out) {
  supplyChain(entries, out);
  costBudgetGate(repoRoot(), out, { runsPerDay });
}

export function runTier(tier, entries, { budgetMs } = {}) {
  if (!TIERS.includes(tier)) throw new Error(`nível inválido: ${tier}`);
  const budget = new Budget(budgetMs ?? TIER_BUDGET_MS[tier] * timeFactor());
  const out = rapidoGates(entries);
  if (tier === 'rapido') return out;
  out.push(...actionsPinsGate(entries));
  rodarCamadas(tier, entries, new Set(entries.map((e) => layerOf(e.path).id)), out, budget);
  return out;
}
