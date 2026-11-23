#!/usr/bin/env node
// Executor da INTEGRAÇÃO REAL do Jira (quality/integration/jira.integration.test.mjs).
// Uso: node scripts/tracker/test-integracao.mjs [--limpar]
//   (sem flag)  cria um épico + 3 cards de sandbox (label harness-teste), exercita o ciclo todo e apaga tudo
//   --limpar    só apaga sobras de rodadas interrompidas (issues com a label harness-teste)
// Precisa de JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN e JIRA_PROJECT_KEY (.env). A suíte offline é
// node scripts/tracker/test-funcional.mjs.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createClient } from './jira-client.mjs';
import { loadEnv } from './load-env.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
loadEnv(root);
const missing = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY'].filter((k) => !process.env[k]);
if (missing.length) { console.error(`Faltam credenciais no ambiente/.env.local/.env: ${missing.join(', ')}`); process.exit(1); }

async function limpar() {
  const jira = createClient();
  const jql = `project = ${process.env.JIRA_PROJECT_KEY} AND labels = "harness-teste"`;
  const found = (await jira.raw('GET', `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=issuetype`)).issues ?? [];
  for (const i of found.sort((a, b) => Number(a.fields.issuetype.name === 'Epic') - Number(b.fields.issuetype.name === 'Epic'))) {
    await jira.raw('DELETE', `/rest/api/3/issue/${i.key}?deleteSubtasks=true`);
  }
  console.log(`Sobras apagadas: ${found.length}`);
}

if (process.argv.includes('--limpar')) {
  await limpar();
} else {
  console.log(`Integração REAL: cria e apaga issues de sandbox em ${process.env.JIRA_PROJECT_KEY} (label harness-teste).`);
  const r = spawnSync(process.execPath, ['--test', path.join(root, 'quality/integration/jira.integration.test.mjs')], {
    stdio: 'inherit', env: { ...process.env, JIRA_INTEGRATION_RUN: '1' },
  });
  process.exit(r.status ?? 1);
}
