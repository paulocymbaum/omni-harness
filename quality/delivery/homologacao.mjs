// Homologação da feature: quando TODAS as tarefas estão desenvolvidas (done) e o ambiente Docker
// local está pronto para testar, todos os cards da feature (e o épico) vão para "Homologation".
// Aprovada → Done; reprovada → volta a Done/In Progress e o agente abre tarefas de correção.
// O estado vive em backlog.homologacao (pendente | em_homologacao | aprovada | reprovada).
// Sem atalho de "pular o docker": o preparo é verificado de verdade (compose válido, scripts existem).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readBacklog, writeBacklog, situacao } from './lib.mjs';
import { PROFILE, expandHome } from '../lib/profile.mjs';
import { mirrorAll } from './jira-mirror.mjs';
import { featureDocs, docsProblemas } from './feature-docs.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT_TOKEN = /\.(sh|mjs|js)$/;

/**
 * Ambiente para validar o compose: mescla o .env da raiz (o compose da homologação exige
 * FLUXO_TEST_*, que vive lá por design — nunca em card/repositório) sobre o env do processo.
 */
function envParaCompose() {
  const env = { ...process.env };
  try {
    const dotenv = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of dotenv.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // Sem .env na raiz: segue com o ambiente do processo.
  }
  // Dirs de cache por variável de ambiente vêm do perfil do projeto (R1); o validador usa
  // a mesma convenção do up.sh quando o diretório existe.
  for (const d of PROFILE.homologacao.envDirs || []) {
    if (d && d.env && !(d.env in env)) {
      const dirCache = expandHome(d.path);
      if (dirCache && fs.existsSync(dirCache)) env[d.env] = dirCache;
    }
  }
  return env;
}

const rel = (dir) => path.relative(process.cwd(), dir) || dir;
const firstLine = (text) => String(text ?? '').trim().split('\n')[0];

/** Pendências do preparo do ambiente Docker; `run` é injetável só para teste do docker ausente. */
function ambienteProblemas(h, run) {
  const problemas = [];
  const { compose, up, roteiro, url } = h;
  if (typeof compose !== 'string' || !compose) problemas.push('homologacao.compose ausente (caminho do docker-compose do ambiente local)');
  if (typeof up !== 'string' || !up) problemas.push('homologacao.up ausente (comando que sobe o ambiente local)');
  if (typeof url !== 'string' || !url) problemas.push('homologacao.url ausente (onde testar)');
  if (!Array.isArray(roteiro) || !roteiro.length) problemas.push('homologacao.roteiro vazio (passos para quem vai testar)');
  if (problemas.length) return problemas;
  const file = path.resolve(ROOT, compose);
  if (!fs.existsSync(file)) return [`compose não encontrado: ${compose}`];
  for (const token of up.split(/\s+/).filter((t) => SCRIPT_TOKEN.test(t))) {
    if (!fs.existsSync(path.resolve(ROOT, token))) problemas.push(`script de homologacao.up não encontrado: ${token}`);
  }
  const r = run('docker', ['compose', '-f', file, 'config', '-q'], { encoding: 'utf8', timeout: 60_000, env: envParaCompose() });
  if (r.error) problemas.push(`docker indisponível nesta máquina (${r.error.code ?? r.error.message}): não dá para garantir que o ambiente sobe`);
  else if (r.status !== 0) problemas.push(`docker compose config reprovou ${compose}: ${firstLine(r.stderr)}`);
  return problemas;
}

/** { ok, problemas }: BRD e fluxo do usuário prontos, tudo done/cancelled, bloco `homologacao` completo e ambiente Docker válido. No modo parcial (--parcial), tarefas pendentes/blocked não bloqueiam — homologa-se o escopo entregue — desde que haja ao menos uma done. */
export function prontidao(backlog, { run = spawnSync, dir = null, parcial = false } = {}) {
  const problemas = dir ? docsProblemas(featureDocs(dir)) : [];
  const sit = situacao(backlog);
  if (sit.estado !== 'concluida') {
    const abertas = (backlog.tasks ?? []).filter((t) => t.status !== 'done' && t.status !== 'cancelled').map((t) => `${t.id} (${t.status})`);
    if (!parcial) problemas.push(`restam tarefas fora de done: ${abertas.join(', ')}`);
    else if (!(backlog.tasks ?? []).some((t) => t.status === 'done')) problemas.push('homologação parcial exige ao menos uma tarefa done');
  }
  if (!backlog.homologacao) problemas.push('backlog.json sem o bloco "homologacao" (compose, up, url, roteiro)');
  else problemas.push(...ambienteProblemas(backlog.homologacao, run));
  return { ok: problemas.length === 0, problemas };
}

/** Roteiro de teste entregue a quem vai homologar (gravado em <entrega>/homologacao.md). */
export function renderRoteiro(backlog, dir) {
  const h = backlog.homologacao;
  const tarefas = (backlog.tasks ?? []).filter((t) => t.status === 'done');
  const abertas = (backlog.tasks ?? []).filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  return [
    `# Homologação${h.parcial ? ' (escopo parcial)' : ''} — ${backlog.title}`, '',
    `Iniciada em ${h.iniciada_em}. ${tarefas.length} tarefa(s) desenvolvida(s), todas com os gates aprovados.`, '',
    '## Subir o ambiente local (Docker)', '', '```bash', h.up, '```', '',
    `Compose: \`${h.compose}\``, `Onde testar: ${h.url}`, '',
    '## Roteiro de teste', '', ...h.roteiro.map((s, i) => `${i + 1}. ${s}`), '',
    ...(h.down ? ['## Derrubar', '', '```bash', h.down, '```', ''] : []),
    '## Tarefas em homologação', '', ...tarefas.map((t) => `- ${t.id} — ${t.title}`), '',
    ...(h.parcial && abertas.length
      ? ['## Fora do escopo desta homologação', '', ...abertas.map((t) => `- ${t.id} (${t.status}) — ${t.title}`), '']
      : []),
    '## Decisão', '', '```bash',
    `node quality/delivery/backlog.mjs homologar ${rel(dir)} --aprovar`,
    `node quality/delivery/backlog.mjs homologar ${rel(dir)} --reprovar --motivo "o que falhou"`,
    '```', '',
  ].join('\n');
}

const stamp = () => new Date().toISOString();

async function iniciar(dir, backlog, { parcial = false } = {}) {
  const { ok, problemas } = prontidao(backlog, { dir, parcial });
  if (!ok) {
    console.error('Homologação NÃO iniciada. Cards seguem como estão. Corrija:');
    problemas.forEach((p) => console.error(`  - ${p}`));
    process.exitCode = 1;
    return;
  }
  const abertas = (backlog.tasks ?? []).filter((t) => t.status !== 'done' && t.status !== 'cancelled').map((t) => t.id);
  const h = { ...backlog.homologacao };
  delete h.motivo_reprovacao;
  delete h.reprovada_em;
  backlog.homologacao = {
    ...h, estado: 'em_homologacao', iniciada_em: stamp(),
    ...(parcial ? { parcial: true, abertas } : {}),
  };
  writeBacklog(dir, backlog);
  fs.writeFileSync(path.join(dir, 'homologacao.md'), renderRoteiro(backlog, dir));
  console.log(`Feature em HOMOLOGAÇÃO${parcial ? ' (escopo parcial)' : ''}: roteiro em ${rel(dir)}/homologacao.md`);
  console.log(`  Subir: ${backlog.homologacao.up}\n  Testar em: ${backlog.homologacao.url}`);
  await mirrorAll(dir);
}

async function decidir(dir, backlog, args) {
  const aprovar = args.includes('--aprovar');
  const i = args.indexOf('--motivo');
  const motivo = i !== -1 ? args[i + 1] : null;
  if (backlog.homologacao?.estado !== 'em_homologacao') { console.error('A feature não está em homologação (rode `homologar <dir>` primeiro).'); process.exitCode = 1; return; }
  if (!aprovar && !motivo) { console.error('--motivo é obrigatório em --reprovar'); process.exitCode = 1; return; }
  backlog.homologacao = aprovar
    ? { ...backlog.homologacao, estado: 'aprovada', aprovada_em: stamp() }
    : { ...backlog.homologacao, estado: 'reprovada', reprovada_em: stamp(), motivo_reprovacao: motivo };
  writeBacklog(dir, backlog);
  console.log(aprovar
    ? 'Homologação APROVADA: cards e épico em Production. Done só após o deploy (`homologar <dir> --deploy`).'
    : `Homologação REPROVADA (${motivo}). Cards voltam a In Progress para correção; rode \`homologar\` de novo ao concluí-las.`);
  await mirrorAll(dir);
}

/** `--deploy`: confirma o deploy em produção e leva cards e épico de Production para Done. */
async function implantar(dir, backlog) {
  if (backlog.homologacao?.estado !== 'aprovada') {
    console.error('O deploy exige homologação APROVADA (estado atual: ' + (backlog.homologacao?.estado ?? 'indefinido') + ').');
    process.exitCode = 1;
    return;
  }
  backlog.homologacao = { ...backlog.homologacao, estado: 'implantada', implantada_em: stamp() };
  writeBacklog(dir, backlog);
  console.log('IMPLANTADA: cards e épico em Done. Entrega concluída.');
  await mirrorAll(dir);
}

/** CLI: `homologar <dir> [--parcial] [--aprovar | --reprovar --motivo <texto> | --deploy]`. Sem flag, inicia (ou reenvia) o estado ao Jira. */
export async function homologar(dir, args = []) {
  const backlog = readBacklog(dir);
  const parcial = args.includes('--parcial');
  if (args.includes('--aprovar') || args.includes('--reprovar')) return decidir(dir, backlog, args);
  if (args.includes('--deploy')) return implantar(dir, backlog);
  if (backlog.homologacao?.estado === 'aprovada' || backlog.homologacao?.estado === 'implantada') {
    console.log(backlog.homologacao.estado === 'aprovada'
      ? 'Homologação aprovada; cards em Production. Done só após o deploy (`homologar <dir> --deploy`). Reenviando o estado ao Jira.'
      : 'Feature implantada; cards e épico em Done. Reenviando o estado ao Jira.');
    return mirrorAll(dir);
  }
  if (backlog.homologacao?.estado === 'em_homologacao') {
    console.log('Já está em homologação; reenviando o estado ao Jira.');
    return mirrorAll(dir);
  }
  return iniciar(dir, backlog, { parcial });
}

/** Gancho do `mark done`: se foi a última tarefa, a feature vai para homologação sozinha. */
export async function depoisDoDone(dir) {
  const backlog = readBacklog(dir);
  if (situacao(backlog).estado !== 'concluida') return;
  const estado = backlog.homologacao?.estado;
  if (!backlog.homologacao) {
    console.log('Todas as tarefas concluídas, mas o backlog não tem `homologacao` (ambiente Docker local). Defina compose, up, url e roteiro e rode `backlog.mjs homologar <dir>`.');
    return;
  }
  if (estado === 'em_homologacao' || estado === 'aprovada') return;
  console.log('Todas as tarefas concluídas: iniciando a homologação…');
  await iniciar(dir, backlog);
}
