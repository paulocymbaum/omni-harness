#!/usr/bin/env node
// Garante no Jira (projeto JIRA_PROJECT_KEY) os status Blocked, Homologation e Cancelled no workflow.
// Uso: node scripts/tracker/ensure-statuses.mjs
// Escreve no workflow do projeto (precisa de "Administrar projetos"); é idempotente.
import path from 'node:path';
import { loadEnv } from './load-env.mjs';
import { createClient } from './jira-client.mjs';
import { ensureStatuses } from './workflow-statuses.mjs';

loadEnv(path.resolve(import.meta.dirname, '..', '..'));

try {
  const { criados, anexados } = await ensureStatuses(createClient(), process.env.JIRA_PROJECT_KEY);
  console.log(criados.length || anexados.length
    ? `Criados: ${criados.join(', ') || '—'} · anexados ao workflow: ${anexados.join(', ') || '—'}`
    : 'Nada a fazer: os status já estão no workflow.');
} catch (err) {
  console.error(`ensure-statuses: ${err.message}`);
  process.exit(1);
}
