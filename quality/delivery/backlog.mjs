#!/usr/bin/env node
// Gerencia o backlog de entrega em ciclo.
// Uso: node quality/delivery/backlog.mjs <comando> <dir> [opções]
// Comandos: init, status, next, render, validate, mark, homologar
// `next` sai com 0 (há tarefa executável ou a entrega acabou) ou 3 (TRAVADA: só restam bloqueios).
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {
  readBacklog, writeBacklog, validateBacklog,
  nextPending, taskById, gatesForTask, dependenciesMet, STATUSES, situacao, gatesFingerprint,
  sanitizeJiraLabel,
} from './lib.mjs';
import { mirrorTask } from './jira-mirror.mjs';
import { depoisDoDone, homologar } from './homologacao.mjs';
import { scaffoldDocs } from './feature-docs.mjs';

const [,, cmd, dir, ...args] = process.argv;

if (!cmd || !dir) {
  console.error('Uso: backlog.mjs <init|status|next|render|validate|mark|homologar> <dir> [opções]');
  console.error('  init: --force --feature <slug> --versao <tag> --categoria <label> (repetível)');
  console.error('        --compose <arquivo> [--up <cmd>] [--down <cmd>] [--url <url>] [--roteiro <passo>]… (ambiente Docker local da homologação)');
  console.error('  mark: --status <status> --motivo <texto>');
  console.error('  homologar: [--aprovar | --reprovar --motivo <texto>]  (sem flag: manda a feature para homologação)');
  process.exit(1);
}

const COMMANDS = { init, status, next, render, validate, mark, homologar };
if (!COMMANDS[cmd]) {
  console.error(`Comando desconhecido: ${cmd}. Disponíveis: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(1);
}

try {
  await COMMANDS[cmd](path.resolve(dir), args);
} catch (err) {
  // QUALITY_STACK=1 imprime o stack completo (diagnóstico de crashes como este).
  console.error(process.env.QUALITY_STACK === '1' ? err.stack || err : err.message);
  process.exit(1);
}

// ── init ──────────────────────────────────────────────────────────────────────

function init(dir, args) {
  const p = path.join(dir, 'backlog.json');
  if (fs.existsSync(p) && !args.includes('--force')) {
    console.error(`backlog.json já existe em ${dir}. Use --force para sobrescrever.`);
    process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true });
  const featureSlug = sanitizeJiraLabel(argValue(args, '--feature'));
  const categories = argValues(args, '--categoria').map(sanitizeJiraLabel).filter(Boolean);
  const version = sanitizeJiraLabel(argValue(args, '--versao'));
  const compose = argValue(args, '--compose');
  writeBacklog(dir, {
    id: path.basename(dir),
    title: path.basename(dir),
    created: new Date().toISOString().slice(0, 10),
    ...(featureSlug ? { featureSlug } : {}),
    ...(version ? { version } : {}),
    ...(categories.length ? { categories } : {}),
    ...(compose ? { homologacao: homologacaoInicial(args, compose) } : {}),
    tasks: [],
    gates: [],
  });
  console.log(`backlog.json criado em ${dir}`);
  const drafts = scaffoldDocs(dir, path.basename(dir));
  if (drafts.length) console.log(`Rascunhos para preencher (BRD e fluxo do usuário vão no épico do Jira): ${drafts.join(', ')}`);
  if (featureSlug) console.log(`Feature: ${featureSlug}`);
  if (version) console.log(`Versão: ${version}`);
  if (categories.length) console.log(`Categorias: ${categories.join(', ')}`);
}

/** Ambiente Docker local da homologação, vindo das flags do init (o backlog nasce com ele). */
function homologacaoInicial(args, compose) {
  return {
    estado: 'pendente', compose,
    up: argValue(args, '--up') ?? `docker compose -f ${compose} up -d --build`,
    ...(argValue(args, '--down') ? { down: argValue(args, '--down') } : {}),
    url: argValue(args, '--url') ?? '',
    roteiro: argValues(args, '--roteiro'),
  };
}

/** Linha de metadados (feature, versão, categorias) para o status. */
function featureMetaLine(backlog) {
  const featureSlug = sanitizeJiraLabel(backlog.featureSlug);
  const version = sanitizeJiraLabel(backlog.version);
  const categories = (backlog.categories ?? []).map(sanitizeJiraLabel).filter(Boolean);
  return [
    featureSlug ? `Feature: ${featureSlug}` : null,
    version ? `Versão: ${version}` : null,
    categories.length ? `Categorias: ${categories.join(', ')}` : null,
  ].filter(Boolean).join(' · ');
}

// ── status ────────────────────────────────────────────────────────────────────

function status(dir) {
  const backlog = readBacklog(dir);
  const tasks = backlog.tasks ?? [];
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;

  console.log(`\nBacklog: ${backlog.title}`);
  const meta = featureMetaLine(backlog);
  if (meta) console.log(meta);
  console.log(`Total: ${tasks.length} tarefas — ${STATUSES.map((s) => `${counts[s]} ${s}`).join(' · ')}`);
  const sit = situacao(backlog);
  if (sit.next) console.log(`Próxima: ${sit.next.id} — ${sit.next.title}`);
  printBlockers(sit);

  console.log('\n| ID | Título | Status | Dependências |');
  console.log('|---|---|---|---|');
  for (const t of tasks) {
    const deps = (t.depends_on ?? []).join(', ') || '—';
    console.log(`| ${t.id} | ${t.title} | ${t.status} | ${deps} |`);
  }
}

/** Bloqueios com o motivo e o que ficou preso por eles; vazio se não há nada travado. */
function printBlockers(sit) {
  if (sit.bloqueadas.length) {
    console.log('\nBloqueadas (precisam de decisão ou ação de alguém):');
    for (const b of sit.bloqueadas) console.log(`  - ${b.id} — ${b.title}\n    motivo: ${b.motivo || '(sem motivo)'}`);
  }
  if (sit.estado === 'travada' && sit.presas.length) {
    console.log('\nPresas (esperam dependência que não está done):');
    for (const t of sit.presas) console.log(`  - ${t.id} espera ${t.esperaPor.join(', ')}`);
  }
  if (sit.estado === 'travada') console.log('\nSituação: TRAVADA. Nada executável: o usuário precisa resolver as bloqueadas acima. A entrega NÃO está concluída.');
}

/** Próxima tarefa do loop. Exit 3 = travada (não confundir com "nada a fazer"). */
function next(dir) {
  const sit = situacao(readBacklog(dir));
  if (sit.estado === 'concluida') { console.log('Entrega concluída: todas as tarefas done ou cancelled.'); return; }
  if (sit.estado === 'em_andamento') { console.log(`Em andamento: ${sit.emAndamento.id} — ${sit.emAndamento.title}`); return; }
  if (sit.estado === 'executavel') { console.log(`Próxima: ${sit.next.id} — ${sit.next.title}`); return; }
  printBlockers(sit);
  process.exitCode = 3;
}

// ── render ────────────────────────────────────────────────────────────────────

function render(dir) {
  const backlog = readBacklog(dir);
  const lines = [`# Backlog — ${backlog.title}`, ''];
  lines.push('| ID | Título | Status | Dependências | Gates |');
  lines.push('|---|---|---|---|---|');
  for (const t of backlog.tasks ?? []) {
    const deps = (t.depends_on ?? []).join(', ') || '—';
    const gates = gatesForTask(backlog, t.id).map((g) => g.id).join(', ') || '—';
    lines.push(`| ${t.id} | ${t.title} | \`${t.status}\` | ${deps} | ${gates} |`);
  }
  console.log(lines.join('\n'));
}

// ── validate ──────────────────────────────────────────────────────────────────

function validate(dir, args) {
  const backlog = readBacklog(dir);
  const errors = validateBacklog(backlog);
  if (args.includes('--require-specs')) checkSpecs(dir, backlog, errors);
  if (errors.length) {
    console.error('Erros de validação:');
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }
  console.log(`Backlog válido: ${(backlog.tasks ?? []).length} tarefas, ${(backlog.gates ?? []).length} gates.`);
}

function checkSpecs(dir, backlog, errors) {
  for (const t of backlog.tasks ?? []) {
    const specPath = path.join(dir, 'specs', `${t.id}.md`);
    if (!fs.existsSync(specPath)) errors.push(`${t.id}: spec não encontrada em specs/${t.id}.md`);
  }
}

// ── mark ──────────────────────────────────────────────────────────────────────

async function mark(dir, args) {
  const [taskId] = args;
  const newStatus = argValue(args, '--status');
  const motivo = argValue(args, '--motivo');
  const correcao = argValue(args, '--correcao');

  if (!taskId || !newStatus) {
    console.error('Uso: mark <dir> <id> --status <status> [--motivo <texto>] [--correcao <nota>]');
    process.exit(1);
  }

  const backlog = readBacklog(dir);
  const task = taskById(backlog, taskId);
  if (!task) { console.error(`Tarefa não encontrada: ${taskId}`); process.exit(1); }

  await applyTransition(dir, backlog, task, newStatus, { motivo, correcao });
  writeBacklog(dir, backlog);
  console.log(`${taskId}: ${task.status}`);
  await mirrorTask(dir, taskId);
  if (newStatus === 'done') await depoisDoDone(dir);
}

async function applyTransition(dir, backlog, task, newStatus, { motivo, correcao }) {
  if (newStatus === 'in_progress') checkInProgress(backlog, task);
  if (newStatus === 'blocked') checkBlocked(motivo);
  if (newStatus === 'done') await checkDone(dir, backlog, task, correcao);

  if (task.status === 'blocked' && newStatus !== 'blocked') delete task.motivo; // senão o card segue dizendo "bloqueada"
  task.status = newStatus;
  if (newStatus === 'blocked') task.motivo = motivo;
  if (newStatus === 'in_progress') {
    task.started_at = new Date().toISOString();
    task.gates_sha = gatesFingerprint(backlog, task.id); // congela os gates: mudar depois exige --correcao no done
  }
  if (newStatus === 'done') task.done_at = new Date().toISOString();
}

function checkInProgress(backlog, task) {
  if (!dependenciesMet(backlog, task.id)) {
    const unmet = (task.depends_on ?? []).filter((d) => taskById(backlog, d)?.status !== 'done');
    console.error(`Dependências não concluídas: ${unmet.join(', ')}`);
    process.exit(1);
  }
  const busy = (backlog.tasks ?? []).find((t) => t.id !== task.id && t.status === 'in_progress');
  if (busy) { console.error(`Outra tarefa já está in_progress: ${busy.id}`); process.exit(1); }
}

function checkBlocked(motivo) {
  if (!motivo) { console.error('--motivo é obrigatório para status blocked'); process.exit(1); }
}

/** Gates alterados depois do `in_progress` (afrouxar para ficar verde) só passam com `--correcao "<nota>"`, que fica registrada. */
function checkGatesFrozen(backlog, task, correcao) {
  if (!task.gates_sha) return;
  const now = gatesFingerprint(backlog, task.id);
  if (now === task.gates_sha) return;
  if (!correcao) {
    console.error(`Os gates de ${task.id} mudaram depois do in_progress (possível afrouxamento para passar).`);
    console.error('Se a mudança é uma correção legítima do gate, registre: mark ... --status done --correcao "<o que mudou e por quê>"');
    process.exit(1);
  }
  task.gates_nota = correcao;
  task.gates_sha = now;
}

async function checkDone(dir, backlog, task, correcao) {
  const { evalTask } = await import('./eval.mjs');
  const result = await evalTask(dir, task.id);
  if (!result.passed) {
    console.error(`Gates não passaram para ${task.id}:`);
    result.results.filter((r) => !r.passed).forEach((r) => {
      console.error(`  ✗ ${r.id} (código ${r.code})`);
      if (r.stderr) console.error(`    ${r.stderr.split('\n')[0]}`);
    });
    process.exit(1);
  }
  checkGatesFrozen(backlog, task, correcao);
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

function argValues(args, flag) {
  const values = [];
  args.forEach((arg, i) => {
    if (arg === flag && args[i + 1]) values.push(args[i + 1]);
  });
  return values;
}
