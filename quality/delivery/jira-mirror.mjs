// Espelho backlog → Jira usado por `mark` e `homologar`. O backlog já está gravado quando isto roda;
// se o card NÃO acompanhar, o comando sai com exit 1 e diz como reparar (antes era um aviso
// ignorável). Sem credenciais o espelho não roda, mas o motivo é dito em vez de silenciado.
// O import do sync-context é tardio: ele carrega o .env no nível do módulo.
import path from 'node:path';
import { readBacklog } from './lib.mjs';
import { PROFILE } from '../lib/profile.mjs';
import { envOff } from '../lib/env.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const relative = (dir) => path.relative(process.cwd(), dir) || dir;

/** Só backlogs do próprio repositório espelham no Jira: um backlog temporário (teste) nunca vira card.
 *  O provedor vem do perfil (R3): tracker.provider !== 'jira' desliga o espelho por completo. */
export function mirrorsToJira(dir, env = process.env, profile = PROFILE) {
  const provider = profile.tracker && profile.tracker.provider ? profile.tracker.provider : 'jira';
  if (provider !== 'jira') return false;
  if (envOff('JIRA_SYNC', env)) return false;
  const rel = path.relative(REPO_ROOT, path.resolve(dir));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function withJira(dir, what, retry, action) {
  if (!mirrorsToJira(dir)) return;
  try {
    const sync = await import('../../scripts/tracker/sync-context.mjs');
    if (!process.env.JIRA_API_TOKEN) {
      console.warn(`  Jira NÃO atualizado: sem JIRA_API_TOKEN. Depois: ${retry}`);
      return;
    }
    await action(sync);
  } catch (err) {
    console.error(`  Jira NÃO atualizado (${what} já está gravado no backlog): ${err.message}`);
    console.error(`  Repare com: ${retry}`);
    process.exitCode = 1;
  }
}

/** Espelha uma tarefa (e atualiza o épico do qual o card é filho). */
export async function mirrorTask(dir, taskId) {
  await withJira(dir, taskId, `node scripts/tracker/sync-context.mjs ${relative(dir)} ${taskId}`, async ({ syncTask }) => {
    const result = await syncTask(dir, taskId, null);
    console.log(`  Jira: ${result.key} → ${result.status}`);
  });
}

/** Espelha a feature inteira: épico com a definição, e todos os cards como filhos, no status certo. */
export async function mirrorAll(dir) {
  await withJira(dir, 'o estado da feature', `node scripts/tracker/sync-context.mjs ${relative(dir)} --all`, async ({ syncMany }) => {
    const ids = (readBacklog(dir).tasks ?? []).map((t) => t.id);
    const failures = await syncMany(dir, ids, null, {}, { log() {}, error: (m) => console.error(`  ${m}`) });
    if (failures.length) throw new Error(`${failures.length} de ${ids.length} card(s) não acompanharam (${failures.map((f) => f.id).join(', ')})`);
    console.log(`  Jira: épico e ${ids.length} card(s) sincronizados`);
  });
}
