// Precedência das credenciais do Jira: ambiente > .env.local > .env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from '../../scripts/tracker/load-env.mjs';
import { hasJiraCredentials } from '../lib/spec-sync.mjs';

const root = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenv-'));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
  return dir;
};

test('.env.local com token fornece todas as JIRA_*; o .env não entra no conjunto', () => {
  const dir = root({ '.env.local': "JIRA_EMAIL=local@x.test\nJIRA_API_TOKEN='tok-local'\n", '.env': 'JIRA_EMAIL=env@x.test\nJIRA_API_TOKEN=tok-env\nJIRA_PROJECT_KEY=OFLUXO\n' });
  const env = loadEnv(dir, {});
  assert.equal(env.JIRA_EMAIL, 'local@x.test');
  assert.equal(env.JIRA_API_TOKEN, 'tok-local');
  assert.equal(env.JIRA_PROJECT_KEY, undefined, 'não mistura credenciais de arquivos diferentes');
});

test('variáveis que não são JIRA_* ainda se completam entre os arquivos', () => {
  const dir = root({ '.env.local': 'JIRA_API_TOKEN=a\n', '.env': 'OUTRA=1\nJIRA_EMAIL=x@y.test\n' });
  const env = loadEnv(dir, {});
  assert.equal(env.OUTRA, '1');
  assert.equal(env.JIRA_EMAIL, undefined);
});

test('.env.local sem token cai no conjunto completo do .env', () => {
  const env = loadEnv(root({ '.env.local': 'JIRA_PROJECT_KEY=LOCAL\n', '.env': 'JIRA_API_TOKEN=t\nJIRA_PROJECT_KEY=OFLUXO\n' }), {});
  assert.equal(env.JIRA_API_TOKEN, 't');
  assert.equal(env.JIRA_PROJECT_KEY, 'OFLUXO', 'JIRA_* parcial do .env.local é ignorado');
});

test('o ambiente do processo nunca é sobrescrito', () => {
  const dir = root({ '.env.local': 'JIRA_API_TOKEN=local\n' });
  assert.equal(loadEnv(dir, { JIRA_API_TOKEN: 'shell' }).JIRA_API_TOKEN, 'shell');
});

test('sem .env.local cai no .env; sem nenhum, não quebra', () => {
  assert.equal(loadEnv(root({ '.env': 'JIRA_API_TOKEN=a\n' }), {}).JIRA_API_TOKEN, 'a');
  assert.deepEqual(loadEnv(root({}), {}), {});
});

test('hasJiraCredentials enxerga o token no .env.local', () => {
  assert.equal(hasJiraCredentials(root({ '.env.local': 'JIRA_API_TOKEN=x\n' }), {}), true);
  assert.equal(hasJiraCredentials(root({}), {}), false);
});

test('registra de onde veio o token (só o .env.local é pessoal)', () => {
  assert.equal(loadEnv(root({ '.env.local': 'JIRA_API_TOKEN=a\n', '.env': 'JIRA_API_TOKEN=b\n' }), {}).FLUXO_JIRA_CRED_SOURCE, '.env.local');
  assert.equal(loadEnv(root({ '.env': 'JIRA_API_TOKEN=b\n' }), {}).FLUXO_JIRA_CRED_SOURCE, '.env');
  assert.equal(loadEnv(root({ '.env.local': 'JIRA_API_TOKEN=a\n' }), { JIRA_API_TOKEN: 'shell' }).FLUXO_JIRA_CRED_SOURCE, 'ambiente');
});
