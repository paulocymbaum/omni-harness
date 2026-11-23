// QG-027 — deploy esquecido: detector determinístico (aviso, nunca bloqueio).
// Pendente quando a entrega tem homologação APROVADA (cards em Production, `homologar --deploy`
// ainda não rodou) e o registro de deploy (deploy.md da entrega) é mais antigo que a aprovação —
// ou não existe. Fontes: backlog.json (homologacao.estado/aprovada_em, done_at) e deploy.md (mtime).
// Sem `?.` — o parser do lizard dessincroniza em optional chaining.
import fs from 'node:fs';
import path from 'node:path';
import { t } from './messages.mjs';

const umDia = 24 * 60 * 60 * 1000;

function stampMaisRecente(homologacao, tasks) {
  const aprovada = Date.parse(homologacao.aprovada_em ?? '');
  if (Number.isFinite(aprovada)) return aprovada;
  const doneStamps = (tasks ?? []).filter((x) => x.done_at).map((x) => Date.parse(x.done_at)).filter(Number.isFinite);
  return doneStamps.length ? Math.max(...doneStamps) : null;
}

/** { pendente, motivo, stamp } da entrega em `dir`: homologação aprovada e deploy.md sem registro depois dela. */
export function deployPendente(dir, { agora = Date.now(), janelaDias = 14 } = {}) {
  const nome = path.basename(dir);
  let backlog;
  try {
    backlog = JSON.parse(fs.readFileSync(path.join(dir, 'backlog.json'), 'utf8'));
  } catch {
    return { pendente: false, entrega: nome, motivo: 'backlog.json ilegível' };
  }
  const homologacao = (backlog && backlog.homologacao) || {};
  if (homologacao.estado !== 'aprovada') return { pendente: false, entrega: nome, motivo: `estado ${homologacao.estado ?? 'indefinido'}` };
  const stamp = stampMaisRecente(homologacao, backlog.tasks);
  if (stamp == null) return { pendente: true, entrega: nome, stamp: null, motivo: 'aprovada sem marca de tempo' };
  if (agora - stamp > janelaDias * umDia) return { pendente: false, entrega: nome, motivo: 'aprovação fora da janela de atenção' };
  const deployMd = path.join(dir, 'deploy.md');
  let registro = 0;
  try {
    registro = fs.statSync(deployMd).mtimeMs;
  } catch {
    return { pendente: true, entrega: nome, stamp, motivo: 'sem deploy.md na entrega' };
  }
  if (registro < stamp) return { pendente: true, entrega: nome, stamp, motivo: 'deploy.md não foi tocado depois da aprovação' };
  return { pendente: false, entrega: nome, stamp, motivo: 'deploy registrado depois da aprovação' };
}

/** Entregas de docs/entregas com deploy pendente (na janela), mais novas primeiro. Para o hook de Stop. */
export function entregasComDeployPendente(raiz, { agora = Date.now(), janelaDias = 14, raizEntregas = 'docs/entregas' } = {}) {
  const base = path.join(raiz, raizEntregas);
  let nomes = [];
  try {
    nomes = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  return nomes
    .map((nome) => ({ dir: path.join(base, nome), nome }))
    .map(({ dir, nome }) => ({ ...deployPendente(dir, { agora, janelaDias }), nome }))
    .filter((r) => r.pendente)
    .sort((a, b) => (b.stamp ?? 0) - (a.stamp ?? 0));
}

/** Linhas de aviso prontas para o hook de Stop (pt-BR), uma por entrega pendente. */
export function lembretesDeDeploy(raiz, { agora = Date.now(), janelaDias = 14 } = {}) {
  return entregasComDeployPendente(raiz, { agora, janelaDias }).map((l) => t('hook.stop.deployPendente', {
    entrega: l.nome,
    stamp: l.stamp ? new Date(l.stamp).toISOString().slice(0, 16).replace('T', ' ') : 'sem marca de tempo',
  }));
}
