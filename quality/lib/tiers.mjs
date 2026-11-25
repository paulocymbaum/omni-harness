import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TIERS, repoRoot } from './util.mjs';
import { layerOf, isGenerated } from './layers.mjs';
import { batchFastGates } from './gates/fast.mjs';
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
import { goRoutine } from './runners/go.mjs';
import { rustRoutine } from './runners/rust.mjs';
import { javaRoutine } from './runners/java.mjs';
import { cppRoutine } from './runners/cpp.mjs';

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
  out.push(...batchFastGates(live));
  return out;
}

// ================================================================ orquestração
// Camadas TypeScript web/worker que passam pela rotina de lint, tipos e testes do pacote.
const WEB_LAYERS = ['admin-web', 'site', 'debate-worker', 'creator-render', 'creator-worker'];

const TIER_BUDGET_MS = { rapido: 60_000, rotina: 270_000, completo: 1_800_000 };

// Grupos de camada (P1): cada grupo roda em um subprocesso quando há ≥2 ativos — o custo
// total deixa de ser a soma dos runners e passa a ser o do grupo mais lento.
const GRUPOS = [
  { id: 'flutter', ativo: (byLayer) => byLayer.has('flutter'), rodar: (ctx) => rodarFlutter(ctx) },
  { id: 'functions', ativo: (byLayer) => byLayer.has('functions') || byLayer.has('rules'), rodar: (ctx) => functionsRoutine(ctx.entries, ctx.out, ctx.budget, ctx.full) },
  { id: 'ocr', ativo: (byLayer) => byLayer.has('ocr'), rodar: (ctx) => ocrRoutine(ctx.entries, ctx.out, ctx.budget, ctx.full) },
  { id: 'web', ativo: (byLayer) => WEB_LAYERS.some((id) => byLayer.has(id)), rodar: (ctx) => webRoutine(ctx.entries, ctx.out, ctx.budget, ctx.full) },
  { id: 'backend', ativo: (byLayer) => byLayer.has('backend') || byLayer.has('rules'), rodar: (ctx) => backendRoutine(ctx.entries, ctx.out, ctx.budget, ctx.full) },
  { id: 'infra', ativo: (byLayer) => byLayer.has('infra'), rodar: (ctx) => infraRoutine(ctx.entries, ctx.out) },
  { id: 'go', ativo: (byLayer) => byLayer.has('go'), rodar: (ctx) => goRoutine(ctx.entries, ctx.out, ctx.budget, ctx.full) },
  { id: 'rust', ativo: (byLayer) => byLayer.has('rust'), rodar: (ctx) => rustRoutine(ctx.entries, ctx.out, ctx.budget, ctx.full) },
  { id: 'cpp', ativo: (byLayer) => byLayer.has('cpp'), rodar: (ctx) => cppRoutine(ctx.entries, ctx.out, ctx.budget, ctx.full) },
  { id: 'java', ativo: (byLayer) => byLayer.has('java'), rodar: (ctx) => javaRoutine(ctx.entries, ctx.out, ctx.budget, ctx.full) },
];

/** Runners por camada; `grupos` já vem filtrado pelo chamador (worker da paralelização P1). */
function rodarCamadas(ctx, grupos) {
  for (const g of grupos) if (g.ativo(ctx.byLayer)) g.rodar(ctx);
}

/** Camada Flutter: analyze sempre; suíte completa na entrega, relacionados na iteração. */
function rodarFlutter(ctx) {
  if (!ctx.byLayer.has('flutter')) return;
  flutterAnalyze(ctx.entries, ctx.out, ctx.budget);
  const testes = ctx.tier === 'completo' ? flutterFull : flutterRelatedTests;
  testes(ctx.entries, ctx.out, ctx.budget);
}

/** Roda SÓ os grupos pedidos — worker da paralelização (camada-filha.mjs). budgetMs já vem com timeFactor do pai. */
export function rodarGrupo(tier, entries, camadas, soGrupos, budgetMs) {
  const out = [];
  const ctx = { tier, entries, byLayer: new Set(camadas), out, budget: new Budget(budgetMs), full: tier === 'completo' };
  rodarCamadas(ctx, GRUPOS.filter((g) => soGrupos.includes(g.id)));
  return out;
}

/** Só no nível completo: supply chain (osv) e orçamento agregado de jobs agendados (no pai). */
function rodarCompleto(entries, out) {
  supplyChain(entries, out);
  costBudgetGate(repoRoot(), out, { runsPerDay });
}

export async function runTier(tier, entries, { budgetMs } = {}) {
  if (!TIERS.includes(tier)) throw new Error(`nível inválido: ${tier}`);
  const budget = new Budget(budgetMs ?? TIER_BUDGET_MS[tier] * timeFactor());
  const out = rapidoGates(entries);
  if (tier === 'rapido') return out;
  out.push(...actionsPinsGate(entries));
  const byLayer = new Set(entries.map((e) => layerOf(e.path).id));
  const gruposAtivos = GRUPOS.filter((g) => g.ativo(byLayer));
  const ctx = { tier, entries, byLayer, out, budget, full: tier === 'completo' };
  if (gruposAtivos.length < 2) rodarCamadas(ctx, gruposAtivos);
  else out.push(...await rodarEmFilhos(tier, entries, byLayer, gruposAtivos.map((g) => g.id), budget));
  if (ctx.full) rodarCompleto(entries, out);
  return out;
}

/** Um subprocesso por grupo de camada; falha/timeout do filho = camada não medida (WARN, falha aberta). */
function rodarEmFilhos(tier, entries, byLayer, gruposAtivos, budget) {
  const fatia = Math.max(60_000, Math.floor(budget.left() / gruposAtivos.length));
  const pedidos = gruposAtivos.map((grupos) => spawnFilho(
    { tier, entries, camadas: [...byLayer], grupos, budgetMs: fatia },
    fatia + 30_000,
  ));
  return Promise.all(pedidos).then((respostas) => respostas.flatMap((r, i) => {
    if (r.ok) return r.results;
    return [result('ferramentas', 'warn', 'camada.unmeasured', { grupos: gruposAtivos[i], detail: r.erro })];
  }));
}

const FILHO_CAMADA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'camada-filha.mjs');

/** Spawn assíncrono do worker (stdin JSON → stdout JSON); resolve sempre, nunca lança. */
function spawnFilho(pedido, timeoutMs) {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [FILHO_CAMADA], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let estourou = false;
    const timer = setTimeout(() => { estourou = true; filho.kill('SIGKILL'); }, timeoutMs);
    filho.stdout.on('data', (c) => { stdout += c; });
    filho.stderr.on('data', (c) => { stderr += c; });
    filho.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, erro: 'spawn do worker falhou' });
    });
    filho.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout);
        if (!Array.isArray(parsed.results)) throw new Error('payload sem results');
        resolve({ ok: true, results: parsed.results });
      } catch {
        const motivo = estourou ? `timeout ${Math.round(timeoutMs / 1000)}s` : (stderr || stdout || `exit ${code}`).slice(-400);
        resolve({ ok: false, erro: motivo });
      }
    });
    filho.stdin.end(JSON.stringify(pedido));
  });
}
