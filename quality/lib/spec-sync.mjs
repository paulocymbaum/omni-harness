// Spec gravada → card do Jira atualizado. Lógica compartilhada pelo hook do Claude Code
// (.claude/hooks/sync-spec-jira.mjs), pelo hook do Cline (quality/hooks/cline-post-tool-use.mjs) e
// pelo envio em si (scripts/tracker/sync-context.mjs). Nada sai para o Jira sem passar por
// `inspectSpec`: só spec com `Status: ready`, não vazia e SEM dados pessoais ou segredos.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findPersonalData, describeFindings } from './pii-guard.mjs';
import { PROFILE } from './profile.mjs';
import { envOff } from './env.mjs';

const LOCK_MS = 120_000;
const SPEC_RE = /^docs\/entregas\/([^/]+)\/specs\/([A-Z][A-Z0-9]*-\d+)\.md$/;
const PATCH_FILE = /^\*\*\* (?:Add|Update) File: (.+)$/gm;
const PATH_KEYS = ['path', 'filePath', 'file_path'];

/** { slug, id } quando o caminho (relativo à raiz, com /) é o de uma spec; senão null. */
export function specTarget(rel) {
  const m = SPEC_RE.exec(rel ?? '');
  return m ? { slug: m[1], id: m[2] } : null;
}

/** Credenciais do Jira no ambiente ou em .env.local / .env da raiz (só confere a presença, não lê o valor). */
export function hasJiraCredentials(root, env = process.env) {
  if (env.JIRA_API_TOKEN) return true;
  return ['.env.local', '.env'].some((f) => {
    try { return /^JIRA_API_TOKEN=\S+/m.test(fs.readFileSync(path.join(root, f), 'utf8')); } catch { return false; }
  });
}

/**
 * Situação do arquivo de spec para o Jira:
 *  missing (não existe ou vazio) · draft (sem `Status: ready`) · blocked (dados pessoais ou segredo,
 *  com os achados mascarados) · ready.
 */
export function inspectSpec(specPath) {
  let text;
  try { text = fs.readFileSync(specPath, 'utf8'); } catch { return { state: 'missing', findings: [] }; }
  if (!text.trim()) return { state: 'missing', findings: [] };
  if (!/^Status:\s*ready\s*$/im.test(text)) return { state: 'draft', findings: [] };
  const findings = findPersonalData(text);
  return findings.length ? { state: 'blocked', findings } : { state: 'ready', findings: [], text };
}

/** Caminhos de arquivo gravados por uma ferramenta do Cline (editor, write_to_file, apply_patch…). */
export function writtenPaths(parameters) {
  const params = parameters && typeof parameters === 'object' ? parameters : { input: parameters };
  const paths = PATH_KEYS.map((k) => params[k]).filter((v) => typeof v === 'string' && v);
  const patch = [params.input, params.patch].find((v) => typeof v === 'string' && v.includes('*** '));
  if (patch) for (const m of patch.matchAll(PATCH_FILE)) paths.push(m[1].trim());
  return paths;
}

const lockFresh = (file, now) => { try { return now - fs.statSync(file).mtimeMs < LOCK_MS; } catch { return false; } };

/** Decide o que fazer com uma spec gravada. Puro quanto ao disparo (não envia nada). */
export function planSync({ root, rel, env = process.env, now = Date.now() }) {
  const provider = PROFILE.tracker && PROFILE.tracker.provider ? PROFILE.tracker.provider : 'jira';
  if (provider !== 'jira') return { action: 'ignore' }; // R3: tracker plugável
  const target = specTarget(rel);
  if (!target || envOff('JIRA_AUTOSYNC', env)) return { action: 'ignore' };
  const dir = path.join(root, 'docs', 'entregas', target.slug);
  if (!fs.existsSync(path.join(dir, 'backlog.json'))) return { action: 'ignore' };
  const backlog = JSON.parse(fs.readFileSync(path.join(dir, 'backlog.json'), 'utf8'));
  if (!(backlog.tasks ?? []).some((t) => t.id === target.id)) return { action: 'ignore' };
  const cmd = `node scripts/tracker/sync-context.mjs docs/entregas/${target.slug} ${target.id}`;
  const spec = inspectSpec(path.join(dir, 'specs', `${target.id}.md`));
  if (spec.state === 'blocked') {
    return { action: 'blocked', cmd, message: `Spec ${target.id} NÃO foi enviada ao Jira: contém dados pessoais ou segredo (${describeFindings(spec.findings)}). Remova ou troque por placeholder (000.000.000-00, usuario@example.com, <uid>) e grave de novo.` };
  }
  if (spec.state !== 'ready') return { action: 'not-ready', cmd, state: spec.state };
  if (!hasJiraCredentials(root, env)) {
    return { action: 'no-credentials', cmd, message: `Spec ${target.id} gravada, mas faltam as credenciais JIRA_* (.env): o card segue com "Spec ainda não escrita". Informe ao usuário e rode depois: ${cmd}` };
  }
  const lock = path.join(root, '.claude', '.state', `jira-sync-${target.slug}-${target.id}.lock`);
  if (lockFresh(lock, now)) return { action: 'debounced', cmd };
  return { action: 'sync', cmd, dir, id: target.id, lock, message: `Jira: card ${target.id} sendo atualizado com a spec em segundo plano (log: .claude/.state/jira-sync.log).` };
}

/** Dispara o sync em segundo plano (ou só descreve, com FLUXO_JIRA_DRY_RUN=1). Devolve a mensagem. */
export function startSync(plan, root, env = process.env) {
  fs.mkdirSync(path.dirname(plan.lock), { recursive: true });
  fs.writeFileSync(plan.lock, String(Date.now()));
  if (env.FLUXO_JIRA_DRY_RUN === '1') return `[dry-run] ${plan.cmd}`;
  const log = fs.openSync(path.join(root, '.claude', '.state', 'jira-sync.log'), 'a');
  spawn(process.execPath, [path.join(root, 'scripts', 'jira', 'sync-context.mjs'), plan.dir, plan.id], { cwd: root, detached: true, stdio: ['ignore', log, log] }).unref();
  return plan.message;
}

/** Mensagem para o agente quando o plano pede aviso (bloqueio por PII ou falta de credencial). */
export const noticeOf = (plan) => (plan.action === 'blocked' || plan.action === 'no-credentials' ? plan.message : null);
