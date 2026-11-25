#!/usr/bin/env node
// Motor único dos gates de qualidade (hooks do Claude Code, skill avaliar-qualidade e CI).
// Uso: node quality/run.mjs --help
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, TIERS, LEVELS } from './lib/util.mjs';
import { isGitRepo, worktreeHash } from './lib/git.mjs';
import { resolveScope } from './lib/scope.mjs';
import { classifyRisk, renderRisk } from './lib/risk.mjs';
import { runTier } from './lib/tiers.mjs';
import { recordEvidence } from './lib/state.mjs';
import { renderReport, counts, result } from './lib/report.mjs';
import { runRelatorio, renderRelatorio } from './lib/relatorio.mjs';
import { applyMigrationOverride, MIGRATION_DEFAULT_REASON } from './lib/migration.mjs';
import { t, levelLabel, tierLabel } from './lib/messages.mjs';
import { enforceLimits } from './lib/limits.mjs';
import { autofixApplies, autofixFile } from './lib/autofix.mjs';

function parseArgs(argv) {
  const a = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--risk') a.risk = true;
    else if (k === '--tier') a.tier = next();
    else if (k === '--relatorio') a.relatorio = true;
    else if (k === '--camadas') a.camadas = next()?.split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--base') a.base = next();
    else if (k === '--files') a.files = next()?.split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--session') a.session = next();
    else if (k === '--fix') a.fix = true;
    else if (k === '--json') a.json = true;
    else if (k === '--migration-override') {
      a.migration = true;
      const motivo = argv[i + 1];
      if (motivo && !motivo.startsWith('--')) { a.migrationReason = motivo; i++; }
    }
    else if (k === '--help' || k === '-h') a.help = true;
    else a.unknown = k;
  }
  return a;
}

const HELP = [
  '',
  '  --risk                 classifica o risco (quebra do backend × escala de custo) e indica o nível exigido',
  '  --tier <nível>         rapido | rotina | completo — roda os gates do nível e registra evidência',
  '  --relatorio            avaliação COMPLETA de todas as camadas (demorada; só quando pedida explicitamente)',
  '  --camadas a,b          (com --relatorio) restringe às camadas: flutter,backend,functions,ocr,admin-web,site,rules,infra,quality',
  '  --base <ref|remote>    compara com uma base (ex.: origin/main; "remote" = upstream/origin/main) em vez do HEAD',
  '  --files a,b            restringe a arquivos; --session <id> restringe aos arquivos tocados na sessão',
  '  --migration-override [motivo]  (só com --tier) modo migração: ignora gates que dão falso positivo em merge/migração',
  '                                 completa (tamanho/complexidade de "novo", formato, supressões, fronteiras, fallback-api,',
  '                                 lint, cobertura do diff). Tipos, testes, exports e ferramentas permanecem ativos;',
  '                                 o ratchet global também aceita a flag: node quality/baseline.mjs --check --migration-override',
  '  --fix                  autocorrige (EOL, newline, dart format, lint seguro) e valida sintaxe/lint dos arquivos de gate e teste alterados',
  '  --json                 saída em JSON',
].join('\n');

function relatorioCmd(args) {
  const rep = runRelatorio({ camadas: args.camadas });
  const md = renderRelatorio(rep);
  const dir = path.join(repoRoot(), 'quality', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `relatorio-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, `${md}\n`);
  if (args.json) console.log(JSON.stringify(rep, null, 2));
  else console.log(`${md}\n\n${t('report.saved', { path: path.relative(repoRoot(), file) })}`);
  return rep.sections.some((s) => s.results.some((r) => r.status === 'fail')) ? 1 : 0;
}

function riskCmd(args, { entries, scope }, risk) {
  if (args.json) console.log(JSON.stringify({ scope, files: entries.map((e) => e.path), risk }, null, 2));
  else console.log(`${renderRisk(risk)}\n  • Arquivos avaliados: ${entries.length} (${risk.layers.join(', ') || '—'})`);
  return 0;
}

async function tierCmd(args, { entries, scope }, risk) {
  const migration = args.migration
    ? { active: true, reason: args.migrationReason || MIGRATION_DEFAULT_REASON }
    : { active: false };
  const hashBefore = worktreeHash();
  const { results, ignoredGates } = applyMigrationOverride(await runTier(args.tier, entries), migration);
  // Árvore limpa no rotina/completo: sem arquivos não há medição — ALERTA explícito em vez de aprovação vazia.
  if (!entries.length && args.tier !== 'rapido') results.push(result('escopo', 'warn', 'scope.empty', { scope }));
  const c = counts(results);
  const status = c.fail > 0 ? 'fail' : 'pass';
  const header = headerDoTier(args.tier, risk, migration, ignoredGates);
  const evidenciaLinha = linhaDeEvidencia(args, scope, hashBefore, results, entries);
  if (args.json) {
    console.log(JSON.stringify({ tier: args.tier, scope, risk, status, counts: c, results, migration: migration.active ? { reason: migration.reason, ignoredGates } : undefined }, null, 2));
  } else {
    console.log(renderReport(args.tier, results, header) + (evidenciaLinha ? `\n${evidenciaLinha}` : ''));
  }
  return status === 'fail' ? 1 : 0;
}

function headerDoTier(tier, risk, migration, ignoredGates) {
  const header = [renderRisk(risk), ''];
  if (tier === 'completo' && LEVELS.indexOf(risk.level) < LEVELS.indexOf('alto')) {
    header.push(t('summary.overkill', { level: levelLabel(risk.level), tier: tierLabel(risk.requiredTier) }), '');
  }
  if (migration.active) header.push(t('migration.banner', { reason: migration.reason, gates: ignoredGates.join(', ') }), '');
  return header;
}

/** Evidência por hash quando o worktree não mudou durante a rodada; sujo = tool.dirtied (WARN). */
function linhaDeEvidencia(args, scope, hashBefore, results, entries) {
  const tier = args.tier;
  if (hashBefore !== worktreeHash()) {
    results.push(result('ferramentas', 'warn', 'tool.dirtied', { files: 'git status' }));
    return '';
  }
  if (!entries.length) return '';
  const c = counts(results);
  recordEvidence(hashBefore, { tier, scope, status: c.fail > 0 ? 'fail' : 'pass', counts: c, migration: args.migration ? (args.migrationReason || MIGRATION_DEFAULT_REASON) : undefined });
  return t('evidence.recorded', { tier: tierLabel(tier), scope, hash: hashBefore.slice(0, 12) });
}

function fixCmd(scope) {
  let bad = 0;
  for (const e of scope.entries.filter((x) => x.status !== 'D' && autofixApplies(x.path))) {
    const r = autofixFile(e.path);
    for (const f of r.fixed) console.log(`✔ ${e.path}: ${f}`);
    for (const err of r.errors) { bad++; console.log(`✗ ${e.path}: ${err}`); }
  }
  console.log(bad ? `${bad} arquivo(s) com erro de sintaxe/lint.` : 'Autocorreção: sem pendências.');
  return bad ? 1 : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.unknown || (!args.risk && !args.tier && !args.relatorio && !args.fix)) {
    console.log(`${t('error.usage')}\n${HELP}`);
    return args.unknown ? 2 : 0;
  }
  if (!isGitRepo()) { console.error(t('error.notGit')); return 2; }
  // Níveis pesados (rotina, completo, relatório) rodam sob teto de memória e CPU: mais lento, mesmos gates.
  if (args.relatorio || args.tier === 'rotina' || args.tier === 'completo') enforceLimits();
  if (args.relatorio) return relatorioCmd(args);
  if (args.tier && !TIERS.includes(args.tier)) { console.error(t('error.usage')); return 2; }
  if (args.migration && (!args.tier || args.relatorio)) { console.error(`${t('error.usage')}\n${HELP}`); return 2; }
  const scope = resolveScope(args);
  if (args.fix) return fixCmd(scope);
  const risk = classifyRisk(scope.entries);
  return args.tier ? await tierCmd(args, scope, risk) : riskCmd(args, scope, risk);
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  process.exit(2);
});
