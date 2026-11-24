#!/usr/bin/env node
// Orquestrador do deploy da release (grafo em scripts/deploy/grafo.mjs).
//   --plan            plano na ordem topológica com o status REAL de cada workflow (gh)
//   --graph           diagrama Mermaid para documentação
//   --status          estado completo em JSON
//   --run <id>        executa UM passo (deps precisam estar verdes; gates param com instrução)
//   --run --proximo   executa o primeiro passo pendente com deps verdes
// Determinístico: mesma árvore + mesmo estado do gh → mesmo plano/ordem.
import { spawnSync } from 'node:child_process';
import { STEPS, FEITOS, topoOrdem, mermaid, planoTexto } from './grafo.mjs';
import { billingInfo, vereditoTexto } from './actions-quota.mjs';
import { GH_ACTIONS_ENABLED, exitCodeProbe, recusaSemActions, vereditoProbe } from './gh-actions.mjs';

const args = process.argv.slice(2);
const runId = args.includes('--run') && !args.includes('--proximo') ? args[args.indexOf('--run') + 1] : null;
const modoRun = args.includes('--run');
// --local: executa a variante local do passo (grafo.mjs local.cmd) em vez do workflow do Actions.
// Use quando os minutos do Actions esgotarem (runbook: docs/entregas/2026-11-14-fluxo-creator/deploy.md).
const modoLocal = args.includes('--local');

const gh = (ghArgs) => {
  if (!GH_ACTIONS_ENABLED) throw new Error('GH_ACTIONS=false — Actions desligado: nenhuma chamada ao gh (use --local)');
  const r = spawnSync('gh', ghArgs, { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`gh ${ghArgs.join(' ')}: ${r.stderr.trim() || r.stdout.trim() || 'falhou'}`);
  return r.stdout;
};

/** Último run do workflow (por caminho do arquivo): { status, conclusion } ou null (nunca rodou/erro de consulta). */
function statusDoWorkflow(workflowPath) {
  try {
    const out = gh(['run', 'list', '--workflow', workflowPath, '--branch', 'RELEASE', '--limit', '1', '--json', 'status,conclusion']);
    const [run] = JSON.parse(out);
    return run ?? null;
  } catch {
    return null;
  }
}

function statusPorId(steps = STEPS) {
  const status = {};
  for (const s of steps) {
    if (!s.workflowPath) continue;
    const r = statusDoWorkflow(s.workflowPath);
    status[s.id] = !r ? 'nunca-rodou' : r.conclusion === 'success' ? '✓ ok' : r.conclusion === 'failure' ? '✗ falhou' : r.status;
  }
  return status;
}

const segredoListado = (nome, env = 'prod') => {
  const out = spawnSync('gh', ['secret', 'list', '--env', env], { encoding: 'utf8' });
  return out.status === 0 && out.stdout.split('\n').some((l) => l.startsWith(nome));
};

function gatePendente(s) {
  if (!s.gate) return null;
  const faltando = s.gate.comandos
    .map((c) => /gh secret set ([A-Z0-9_]+)/.exec(c)?.[1])
    .filter((nome) => nome && !segredoListado(nome));
  return faltando.length ? `${faltando.join(', ')} ausente(s) no Environment prod` : null;
}

let probeCache = null;

/**
 * Sonda de crédito do Actions (deploy-probe.yml, ~2 s de runner): dispatch + acompanhamento curto.
 * Run SUCCESS => o Actions está pagando; falha imediata => sem minutos (billing) e o deploy local assume.
 */
function actionsHasCredit() {
  if (probeCache !== null) return probeCache;
  // Camada 1 (barata): leitura do billing — sem dispatch, sem queimar runner.
  const billing = billingInfo();
  if (billing) {
    probeCache = billing.ok;
    console.log(billing.ok
      ? `  sonda: billing com crédito (${billing.used}/${billing.included} min) ✓`
      : `  sonda: billing sem saldo (${billing.used}/${billing.included} min) — Actions bloqueado.`);
    return probeCache;
  }
  // Camada 2 (billing inconclusivo): dispatch do probe (~2 s de runner).
  try {
    gh(['workflow', 'run', 'deploy-probe.yml', '--ref', 'RELEASE']);
  } catch (error) {
    probeCache = false;
    console.log('  sonda: dispatch recusado — Actions sem crédito.');
    return probeCache;
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    spawnSync('sleep', ['4'], { encoding: 'utf8' });
    try {
      const runs = JSON.parse(gh(['run', 'list', '--workflow', 'deploy-probe.yml', '--limit', '1', '--json', 'status,conclusion']));
      const run = runs[0];
      if (run && run.status === 'completed') {
        probeCache = run.conclusion === 'success';
        console.log(probeCache ? '  sonda: Actions com crédito ✓' : '  sonda: Actions sem crédito (run falhou).');
        return probeCache;
      }
    } catch { /* poll segue até o deadline */ }
  }
  probeCache = false;
  console.log('  sonda: sem resposta em 90 s — tratando como sem crédito.');
  return probeCache;
}

function executarPasso(s) {
  if (modoLocal) return executarPassoLocal(s);
  if (!s.executar) { console.log(`  nada a executar: ${s.titulo} (acompanhe pelo gh)`); return; }
  const e = s.executar;
  if (e.tipo === 'gh-dispatch' || e.tipo === 'gh-rerun') {
    if (!actionsHasCredit()) {
      if (s.local) {
        console.log('  Actions sem crédito — caindo para o workflow local.');
        executarPassoLocal(s);
        return;
      }
      console.error('Sem crédito no Actions e sem variante local para este passo. Resolva o billing ou adicione local.cmd ao grafo.');
      process.exitCode = 1;
      return;
    }
  }
  if (e.tipo === 'gh-dispatch') {
    gh(['workflow', 'run', e.workflow, '--ref', e.ref]);
    console.log(`  dispatch feito: ${e.workflow} @ ${e.ref}`);
  } else if (e.tipo === 'gh-rerun') {
    gh(['run', 'rerun', String(e.runId)]);
    console.log(`  rerun feito: run ${e.runId}`);
  } else if (e.tipo === 'cli') {
    const [bin, ...resto] = e.cmd.split(' ');
    const r = spawnSync(bin, resto, { encoding: 'utf8', stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`comando falhou (${r.status}): ${e.cmd}`);
  }
}

/** Variante local do passo: grafo.mjs local.cmd com prereqs explícitos (sem Actions). */
function executarPassoLocal(s) {
  if (!s.local) {
    console.error(`"${s.id}" não tem variante local — rode sem --local (ou adicione local.cmd ao grafo).`);
    process.exitCode = 1;
    return;
  }
  console.log(`  prereq: ${s.local.requer}`);
  const r = spawnSync(s.local.cmd, { encoding: 'utf8', stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`Falhou localmente (${r.status}): ${s.id}. Resolva o prereq acima e rode de novo.`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${s.id} executado localmente. Registre como FEITO no grafo.mjs quando definitivo.`);
}

/** Camadas com bump pendente (plano de `quality/version/bump.mjs`). Falha ao ler o plano bloqueia (não assume ok). */
function versaoPendente() {
  const r = spawnSync('node', ['quality/version/bump.mjs', '--json'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`não consegui ler o plano de bump: ${(r.stderr || '').trim()}`);
  return JSON.parse(r.stdout).rows.map((row) => row.layer);
}

function depsVerdes(id, status) {
  const s = STEPS.find((x) => x.id === id);
  const pend = s.deps.filter((d) => status[d] !== '✓ ok' && !FEITOS.some((f) => f.id === d));
  return pend;
}

const plan = () => console.log(planoTexto(STEPS, statusPorId()).join('\n'));
const graph = () => console.log(mermaid());
const statusJson = () => console.log(JSON.stringify(statusPorId(), null, 2));

function rodar(id) {
  const status = statusPorId();
  const s = STEPS.find((x) => x.id === id);
  if (!s) { console.error(`passo desconhecido: ${id}`); process.exitCode = 1; return; }
  const recusa = recusaSemActions(s, modoLocal);
  if (recusa) { console.error(recusa); process.exitCode = 1; return; }
  const depsPend = depsVerdes(id, status);
  if (depsPend.length) { console.error(`deps não verdes: ${depsPend.join(', ')}`); process.exitCode = 1; return; }
  // Deploy nunca sai com versão pendente: o build calcula a versão pelas tags (`bump --next`), e sem o
  // bump a produção mostraria a versão antiga. Sem atalho: aplique o bump (passo `versionar`) primeiro.
  if (versaoPendenteBloqueia(id)) { process.exitCode = 1; return; }
  // No modo local explícito o operador decide: o status do Actions pode estar verde com
  // código antigo (ex.: API publicada antes do fix do carrossel).
  if (!modoLocal && status[id] === '✓ ok') { console.log(`${id}: já está ok — nada a fazer`); return; }
  if (!modoLocal && gateHumanoBloqueia(s)) { process.exitCode = 1; return; }
  console.log(`▶ ${id}: ${s.titulo}`);
  executarPasso(s);
}

/** Gate humano (secrets do Environment prod ausentes). true = bloqueou. */
function gateHumanoBloqueia(s) {
  const gate = gatePendente(s);
  if (!gate) return false;
  console.error(`GATE HUMANO em "${s.id}": ${gate}`);
  s.gate.comandos.forEach((c) => console.error(`  ${c}`));
  console.error('Depois de resolver, rode de novo: node scripts/deploy/release.mjs --run ' + s.id);
  return true;
}

function rodarProximo() {
  const status = statusPorId();
  const proximo = topoOrdem().find((s) => !s.opcional && status[s.id] !== '✓ ok');
  if (!proximo) { console.log('Todos os passos obrigatórios estão ok.'); return; }
  rodar(proximo.id);
}

if (args.includes('--probe')) {
  const info = billingInfo();
  console.log(vereditoProbe(info, vereditoTexto));
  process.exitCode = exitCodeProbe(info);
}
else if (args.includes('--plan')) plan();
else if (args.includes('--graph')) graph();
else if (args.includes('--status')) statusJson();
else if (modoRun && runId) rodar(runId);
else if (modoRun) rodarProximo();
else {
  console.log('Uso: release.mjs --probe | --plan | --graph | --status | --run <id> [--local] | --run --proximo');
  console.log('  --probe: saldo do Actions (exit 1 = sem saldo → deploy por script local).');
  console.log('  --local: executa a variante local do passo (grafo local.cmd) — para Actions sem minutos.');
  process.exitCode = 1;
}