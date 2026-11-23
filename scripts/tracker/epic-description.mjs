// Descrição do épico escrita para PESSOAS: o que é, em que ponto está, o que precisa de decisão,
// o BRD, o fluxo do usuário, como testar e as tarefas por situação. A definição técnica completa
// do backlog.json fica por último ("Referência técnica") e é a primeira a ser cortada se o card
// passar do limite do Jira. Só markdown que o conversor ADF entende (títulos, listas, checkbox, código).
import path from 'node:path';
import { gatesForTask, situacao } from '../../quality/delivery/lib.mjs';
import { findPersonalData, describeFindings } from '../../quality/lib/pii-guard.mjs';
import { clip } from './naming.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const KNOWN_FIELDS = new Set(['id', 'title', 'created', 'featureSlug', 'version', 'categories', 'tasks', 'gates', 'homologacao', 'objetivo']);
const BAR_WIDTH = 10;

const SITUACAO = {
  concluida: 'Concluída', em_andamento: 'Em andamento', executavel: 'Pronta para a próxima tarefa',
  travada: 'Travada: aguarda decisão ou ação de alguém',
};
const HOMOLOGACAO = { em_homologacao: 'Em homologação', aprovada: 'Homologação aprovada', reprovada: 'Reprovada na homologação' };

function relDir(dir) {
  const rel = dir ? path.relative(ROOT, dir) : '';
  return !rel || rel.startsWith('..') ? '' : rel;
}

/** Barra de progresso em texto: ▰▰▰▱▱▱▱▱▱▱ 3/10 (30%). Canceladas não entram na conta. */
export function progressLine(tasks) {
  const counted = tasks.filter((t) => t.status !== 'cancelled');
  const done = counted.filter((t) => t.status === 'done').length;
  const filled = counted.length ? Math.round((done / counted.length) * BAR_WIDTH) : 0;
  const pct = counted.length ? Math.round((done / counted.length) * 100) : 0;
  return `${'▰'.repeat(filled)}${'▱'.repeat(BAR_WIDTH - filled)} ${done}/${counted.length} (${pct}%)`;
}

/** Rebaixa os títulos de um documento embutido (e tira a linha Status:), sem tocar em blocos de código. */
export function embed(markdown, by = 2) {
  let inFence = false;
  return String(markdown ?? '').split('\n').filter((l) => !/^Status:\s*(ready|draft)\s*$/i.test(l)).map((line) => {
    if (line.startsWith('```')) { inFence = !inFence; return line; }
    const m = !inFence && line.match(/^(#{1,4})\s+(.*)$/);
    return m ? `${'#'.repeat(Math.min(4, m[1].length + by))} ${m[2]}` : line;
  }).join('\n').trim();
}

function overview(backlog, tasks) {
  const sit = situacao(backlog);
  const h = backlog.homologacao;
  return [
    '## Visão geral', '',
    ...(backlog.objetivo ? [backlog.objetivo, ''] : []),
    `Situação: ${HOMOLOGACAO[h?.estado] ?? SITUACAO[sit.estado]}`,
    `Progresso: ${progressLine(tasks)}`,
    ...(backlog.featureSlug ? [`Feature: ${backlog.featureSlug}`] : []),
    ...(backlog.version ? [`Versão: ${backlog.version}`] : []),
    ...((backlog.categories ?? []).length ? [`Categorias: ${backlog.categories.join(', ')}`] : []),
    `Criado em: ${backlog.created ?? '—'}`,
    ...(relDir(backlog.__dir) ? [`Documentos no repositório: ${relDir(backlog.__dir)}/`] : []),
    '',
  ];
}

function attention(backlog) {
  const blocked = (backlog.tasks ?? []).filter((t) => t.status === 'blocked');
  const rep = backlog.homologacao?.estado === 'reprovada' ? backlog.homologacao.motivo_reprovacao : null;
  if (!blocked.length && !rep) return [];
  return [
    '## Atenção: precisa de ação',
    ...blocked.map((t) => `- ${t.id} — ${t.title}: ${t.motivo || 'bloqueada, sem motivo registrado'}`),
    ...(rep ? [`- Homologação reprovada: ${rep}`] : []),
    '',
  ];
}

function document(title, doc, extra = []) {
  if (doc.state === 'ready') return [`## ${title}`, '', embed(doc.text), ...extra, ''];
  if (doc.state === 'blocked') return [`## ${title}`, '', `> Não enviado: dados pessoais detectados (${describeFindings(doc.findings)}). Corrija ${doc.file}.`, ''];
  return [`## ${title}`, '', `> ${doc.state === 'draft' ? 'Em rascunho' : 'Ainda não escrito'}: \`${doc.file}\` (precisa de \`Status: ready\`).`, ''];
}

function homologationSection(h) {
  if (!h) return ['## Como testar (homologação)', '', '> Ambiente local não definido: falta o bloco `homologacao` no backlog.json.', ''];
  return [
    '## Como testar (homologação)', '',
    `Estado: ${HOMOLOGACAO[h.estado] ?? 'ainda não iniciada'}`,
    ...(h.up ? ['Subir o ambiente:', '```', h.up, '```'] : []),
    ...(h.url ? [`Onde testar: ${h.url}`] : []),
    ...((h.roteiro ?? []).length ? ['Roteiro:', ...h.roteiro.map((s, i) => `${i + 1}. ${s}`)] : []),
    ...(h.down ? ['Derrubar:', '```', h.down, '```'] : []),
    '',
  ];
}

const GROUPS = [
  ['Em andamento', (t) => t.status === 'in_progress'],
  ['Bloqueadas', (t) => t.status === 'blocked'],
  ['A fazer', (t) => t.status === 'pending'],
  ['Concluídas', (t) => t.status === 'done'],
  ['Canceladas', (t) => t.status === 'cancelled'],
];

function taskLine(t) {
  const deps = (t.depends_on ?? []).length ? ` (depende de: ${t.depends_on.join(', ')})` : '';
  return `- [${t.status === 'done' ? 'x' : ' '}] ${t.id} — ${t.title}${deps}`;
}

function tasksSection(tasks) {
  return ['## Tarefas', '', ...GROUPS.flatMap(([name, match]) => {
    const group = tasks.filter(match);
    return group.length ? [`### ${name} (${group.length})`, ...group.map(taskLine), ''] : [];
  })];
}

function technical(backlog, tasks) {
  const extra = Object.fromEntries(Object.entries(backlog).filter(([k]) => !KNOWN_FIELDS.has(k) && k !== '__dir'));
  const rel = relDir(backlog.__dir);
  return [
    '## Referência técnica (definição do backlog.json)', '',
    ...tasks.flatMap((t) => {
      const gates = gatesForTask(backlog, t.id).map((g) => `  - ${g.id} (${g.type ?? 'gate'}): ${clip([].concat(g.command ?? g.path ?? '').join(' '), 200)}`);
      return [`### ${t.id}`, `- Status: ${t.status}`, `- Spec: ${rel ? `${rel}/` : ''}specs/${t.id}.md`, ...(gates.length ? ['- Gates:', ...gates] : ['- Gates: nenhum']), ...(t.motivo ? [`- Motivo de bloqueio: ${t.motivo}`] : []), ''];
    }),
    ...(Object.keys(extra).length ? ['### Outros campos', '```json', JSON.stringify(extra, null, 2), '```', ''] : []),
  ];
}

/** Markdown do épico, para pessoas. `docs` vem de featureDocs(dir). */
export function epicDescription(backlog, dir = null, docs) {
  const withDir = { ...backlog, __dir: dir };
  const tasks = backlog.tasks ?? [];
  return [
    ...overview(withDir, tasks), ...attention(backlog),
    ...document('BRD — requisitos e regras de negócio', docs.brd),
    ...document('Fluxo do usuário', docs.fluxo, docs.images.length ? [`Diagrama(s) anexado(s) ao épico: ${docs.images.map((f) => path.basename(f)).join(', ')}`] : []),
    ...homologationSection(backlog.homologacao), ...tasksSection(tasks), ...technical(withDir, tasks),
  ].join('\n');
}

/** A definição só vai ao Jira sem dado pessoal; com achado, vai o aviso mascarado no lugar de tudo. */
export function safeEpicDescription(backlog, dir, docs) {
  const text = epicDescription(backlog, dir, docs);
  const found = findPersonalData(text);
  if (!found.length) return text;
  return [`Backlog: ${backlog.id}`, '', `> Definição NÃO enviada: dados pessoais detectados (${describeFindings(found)}).`, '> Corrija o backlog.json (ou o BRD/fluxo) e sincronize de novo.'].join('\n');
}
