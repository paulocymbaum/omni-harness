#!/usr/bin/env node
// Cria cards no Jira para as tarefas pendentes do backlog harness-entrega-em-ciclo
// e demonstra a transição de status. Lê credenciais do .env do projeto.
//
// Uso:  node scripts/tracker/seed-harness-cards.mjs [--dry-run]
import path from 'node:path';
import { loadEnv } from './load-env.mjs';
import { canonicalStatus } from './workflow.mjs';
import { createClient } from './jira-client.mjs';
import { cardLabels } from '../../quality/delivery/lib.mjs';

// ── carregar .env ─────────────────────────────────────────────────────────────
const ROOT = path.resolve(import.meta.dirname, '..', '..');
loadEnv(ROOT);

const DRY_RUN = process.argv.includes('--dry-run');
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY ?? 'OFLUXO';
const jira = createClient();

// ── tarefas a criar ───────────────────────────────────────────────────────────
const TASKS = [
  {
    summary: 'RB-015 — Documentação final e entrega piloto',
    description: 'Executar a entrega piloto de ponta a ponta usando o harness de entrega em ciclo. Registrar evidências manuais EG-PILOTO e EG-REG.',
    targetStatus: 'To Do',
  },
  {
    summary: 'RB-014 — Skill product-owner e espelho no Jira',
    description: 'Implementar scripts/tracker/sync-context.mjs e quality/config/jira.json. Bloqueado externamente até credenciais disponíveis — já disponíveis.',
    targetStatus: 'In Progress',
  },
  {
    summary: 'Integração Jira validada — credenciais OK',
    description: 'Card de verificação: credenciais JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN testadas com sucesso. Board 34 (OFLUXO) acessível.',
    targetStatus: 'Done',
  },
];

/** Cria um card com a categoria da feature e devolve chave + status alvo. */
async function createCard(jira, issueType, task) {
  process.stdout.write(`==> Criando "${task.summary.slice(0, 60)}…"  `);
  const labels = cardLabels(null, null, { featureSlug: 'harness-entrega-em-ciclo', categories: ['harness'] });
  const issue = await jira.createIssue({
    project: { key: PROJECT_KEY },
    issuetype: { id: issueType.id },
    summary: task.summary,
    description: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: task.description }] }],
    },
    ...(labels.length ? { labels } : {}),
  });
  console.log(`→ ${issue.key}`);
  return { key: issue.key, targetStatus: task.targetStatus };
}

/** Resolve o issue type Story → Task → primeiro disponível. */
function pickIssueType(types) {
  return types.find((t) => t.name === 'Story')
    ?? types.find((t) => t.name === 'Task')
    ?? types[0];
}

/** Transiciona cada card criado para o status alvo, avisando transição ausente. */
async function applyTargetStatuses(jira, created) {
  for (const { key, targetStatus } of created) {
    const { transitions } = await jira.getTransitions(key);
    const t = transitions.find((x) => x.name === targetStatus || canonicalStatus(x.to?.name) === targetStatus);
    if (!t) {
      const names = transitions.map((x) => `"${x.name}"`).join(', ');
      console.log(`⚠  ${key}: transição "${targetStatus}" não encontrada. Disponíveis: ${names}`);
      continue;
    }
    await jira.doTransition(key, t.id);
    console.log(`   ${key}: movido para "${t.to?.name ?? targetStatus}"`);
  }
}

async function run() {
  console.log('==> Verificando credenciais...');
  const me = await jira.getMyself();
  console.log(`    Autenticado como: ${me.displayName} (${me.emailAddress})`);

  const proj = await jira.getProject(PROJECT_KEY);
  console.log(`    Projeto: ${proj.key} — ${proj.name}`);

  const issueType = pickIssueType(proj.issueTypes ?? []);
  if (!issueType) throw new Error('Nenhum issue type encontrado no projeto');
  console.log(`    Issue type: ${issueType.name} (id ${issueType.id})\n`);

  const created = [];

  for (const task of TASKS) {
    if (DRY_RUN) {
      console.log(`[dry-run] criaria: "${task.summary}"`);
      continue;
    }
    created.push(await createCard(jira, issueType, task));
  }

  if (DRY_RUN) return;

  await applyTargetStatuses(jira, created);

  console.log('\n✓ Cards criados:');
  for (const { key } of created) {
    console.log(`  https://${new URL(process.env.JIRA_BASE_URL).host}/browse/${key}`);
  }
}

run().catch((err) => { console.error(err.message); process.exit(1); });
