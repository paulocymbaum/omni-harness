// Carrega as credenciais do Jira: ambiente do processo > .env.local > .env.
// Nunca sobrescreve o que já está definido; .env.local entra primeiro, .env só completa o que falta.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const ENV_FILES = ['.env.local', '.env'];

export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const isJira = (k) => k.startsWith('JIRA_');

/**
 * Preenche `env` com as variáveis ausentes, na ordem .env.local, .env.
 * As credenciais JIRA_* são um conjunto: o primeiro arquivo que tem JIRA_API_TOKEN fornece todas
 * as JIRA_* e os seguintes não entram, para não casar o token de uma pessoa com o e-mail de outra.
 */
export function loadEnv(root, env = process.env) {
  let jiraFrom = null;
  const tokenPreset = Boolean(env.JIRA_API_TOKEN);
  for (const file of ENV_FILES) {
    const p = path.join(root, file);
    if (!existsSync(p)) continue;
    const vars = parseEnv(readFileSync(p, 'utf8'));
    if (!jiraFrom && vars.JIRA_API_TOKEN) jiraFrom = file;
    for (const [k, v] of Object.entries(vars)) {
      if (!v || env[k]) continue;
      if (isJira(k) && jiraFrom !== file && (jiraFrom || !vars.JIRA_API_TOKEN)) continue;
      env[k] = v;
    }
  }
  // quem é o dono do token: só o .env.local é pessoal (ver scripts/tracker/status.mjs, claimCard)
  const source = tokenPreset ? 'ambiente' : jiraFrom;
  if (source && !env.FLUXO_JIRA_CRED_SOURCE) env.FLUXO_JIRA_CRED_SOURCE = source;
  return env;
}
