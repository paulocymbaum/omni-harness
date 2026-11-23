#!/usr/bin/env node
// Executor da suíte FUNCIONAL do Jira: offline, com Jira falso, sem rede. Cobre nomenclatura, status,
// descrição do épico, BRD e fluxo, anexos, homologação, espelho do `mark` e resiliência a falhas.
// Uso: node scripts/tracker/test-funcional.mjs        (a integração real é test-integracao.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..', '..');
const test = (...parts) => path.join(root, 'quality', 'test', ...parts);
const files = [
  ...fs.readdirSync(test()).filter((f) => /^jira-.*\.test\.mjs$/.test(f)).map((f) => test(f)),
  test('delivery', 'mark.test.mjs'), test('delivery', 'homologacao.test.mjs'),
];
// credenciais falsas numa porta fechada: um vazamento para a rede vira erro, nunca card de verdade
const env = { ...process.env, JIRA_BASE_URL: 'http://127.0.0.1:1', JIRA_EMAIL: 'teste@example.com', JIRA_API_TOKEN: 'falso', JIRA_PROJECT_KEY: 'TST' };
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
console.log(r.status === 0 ? `\nSuíte funcional do Jira: ${files.length} arquivos, offline, aprovada.` : '\nSuíte funcional do Jira REPROVADA.');
process.exit(r.status ?? 1);
