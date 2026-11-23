// Gates DV-007 — admin-web: fila e tela de validação, revisões, duas pessoas, não validar, checagem manual,
// expiração no fim, correção e despublicação; e o snapshot ampliado da mesa (pendência herdada da DV-006).
// ANTES da implementação cada gate DEVE falhar:
//   node quality/delivery/eval.mjs docs/entregas/2026-10-21-debate-ao-vivo DV-007 --baseline
//
// Escopo: a máquina de estados e as rotas editoriais já existem na API (DV-002) e têm testes próprios
// (DebateEditorialApiTests.cs). Estes gates cobrem só o que a DV-007 acrescenta: telas e cliente em
// admin-web/src/modules/debates/ e o snapshot do SSE da mesa. Tudo offline (fetch falso no Vitest;
// Postgres descartável em FLUXO_TEST_POSTGRES no gate .NET).
// Specs do próprio gate: dv-007-vitest/ e dv-007-dotnet/ (copiados só durante a execução).
// Casos nomeados (runNamedCases) são escritos pelo implementador com o título exato listado aqui.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, runGateSpecs7, runNamedCases, runDotnetGate } from './dv-007-gate-helper.mjs';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const M = 'admin-web/src/modules/debates';
const T = 'src/modules/debates';

function assertFiles(rels) {
  assert.deepEqual(rels.map((r) => `${M}/${r}`).filter((rel) => !exists(rel)), [], 'arquivos do DV-007 ausentes');
}

/** Trecho da rota `path` no AppRouter, com constantes do mesmo arquivo citadas no trecho expandidas. */
function routeSegment(src, routePath) {
  const re = new RegExp(`path:\\s*["'\`]/?${routePath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}["'\`]`);
  const m = re.exec(src);
  assert.ok(m, `AppRouter sem a rota ${routePath}`);
  const rest = src.slice(m.index + m[0].length);
  const next = rest.search(/\bpath:\s*["'`]/);
  const segment = next >= 0 ? rest.slice(0, next) : rest;
  let expanded = segment;
  for (const id of new Set(segment.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [])) {
    const decl = new RegExp(`(?:const|let)\\s+${id}\\b[^=]*=([^;]*);`).exec(src);
    if (decl) expanded += `\n${decl[1]}`;
  }
  return expanded;
}

const REVIEW = `${T}/presentation/FactCheckReviewPage.test.tsx`;

// ── DV-007-PERMISSIONS ───────────────────────────────────────────────────────

test('DV-007 permissions: /checagem, /checagem/:id, /correcoes e /relatorio com o gate certo; ações sensíveis só com debates.publish', () => {
  assertFiles(['presentation/FactCheckQueuePage.tsx', 'presentation/FactCheckReviewPage.tsx',
    'presentation/DebateCorrectionsPage.tsx', 'presentation/DebateReportPage.tsx']);
  const router = read('admin-web/src/app/router/AppRouter.tsx');
  for (const page of ['FactCheckQueuePage', 'FactCheckReviewPage', 'DebateCorrectionsPage', 'DebateReportPage']) {
    assert.match(router, new RegExp(`\\b${page}\\b`), `AppRouter deve usar ${page}`);
  }
  const queue = routeSegment(router, 'checagem');
  assert.match(queue, /debates\.review/, '/checagem exige debates.review');
  assert.doesNotMatch(queue, /debates\.manage|debates\.operate/, '/checagem não abre com manage/operate');
  const review = routeSegment(router, 'checagem/:id');
  assert.match(review, /anyOf/); assert.match(review, /debates\.review/); assert.match(review, /debates\.publish/);
  const corrections = routeSegment(router, 'debates/:id/correcoes');
  assert.match(corrections, /anyOf/); assert.match(corrections, /debates\.publish/); assert.match(corrections, /legal\.read/);
  const report = routeSegment(router, 'debates/:id/relatorio');
  assert.match(report, /debates\.manage/, '/relatorio exige debates.manage');
  assert.match(read('admin-web/src/app/layout/AdminLayout.tsx'), /["'`]\/checagem["'`]/, 'item Checagem no menu');

  runNamedCases({
    [REVIEW]: [
      'só debates.review: Validar, Corrigir e Despublicar não aparecem',
      'debates.publish: Validar, Corrigir e Despublicar aparecem conforme o estado',
    ],
  });
});

// ── DV-007-CLIENT ────────────────────────────────────────────────────────────

test('DV-007 client: factChecksApi com rotas do contrato, Idempotency-Key em escrita e code preservado', () => {
  assertFiles(['infrastructure/factChecksApi.ts', 'domain/factCheck.ts']);
  runGateSpecs7(['client.vitest.ts']);
  runNamedCases({
    [`${T}/infrastructure/factChecksApi.test.ts`]: [
      'REAUTH_REQUIRED em validate resolve o segundo fator e repete com a mesma Idempotency-Key',
    ],
  });
});

// ── DV-007-RULES ─────────────────────────────────────────────────────────────

test('DV-007 rules: validationRules e changeReasons espelham as regras do servidor', () => {
  assertFiles(['domain/validationRules.ts', 'domain/changeReasons.ts']);
  runGateSpecs7(['rules.vitest.ts']);
  runNamedCases({
    [`${T}/domain/validationRules.test.ts`]: [
      'validationEligibility lista not_lock_holder, sources_not_checked, two_person_required, debate_ended, invalid_state e missing_permission',
      'validationEligibility libera quem tem lock, publish, fontes conferidas e não é autor',
      'timeLeft usa scheduledEndAt e vira encerrado quando há endedAt',
    ],
  });
});

// ── DV-007-QUEUE ─────────────────────────────────────────────────────────────

test('DV-007 queue: abas Validando e Aguardando checagem manual, selo Teste, lock na linha, polling de 5 s e Assumir', () => {
  assertFiles(['presentation/FactCheckQueuePage.tsx']);
  runNamedCases({
    [`${T}/presentation/FactCheckQueuePage.test.tsx`]: [
      'aba Validando mostra idade do balão e tempo até o fim, em ordem de prioridade e idade',
      'aba Aguardando checagem manual pede queue=manual_pending',
      'debate de teste aparece com o selo Teste',
      'linha mostra quem assumiu e até quando',
      'refaz a consulta a cada 5 s e pausa com a aba oculta',
      'Assumir chama claim e abre /checagem/:id',
    ],
  });
});

// ── DV-007-STALE-REVISION ────────────────────────────────────────────────────

test('DV-007 stale-revision: 409 stale_revision mantém o rascunho, mostra a versão nova e não valida com formulário sujo', () => {
  assertFiles(['presentation/FactCheckReviewPage.tsx', 'presentation/review/RevisionForm.tsx']);
  runNamedCases({
    [REVIEW]: [
      'Validar envia o revisionId exibido e as URLs conferidas',
      'Validar fica bloqueado com o formulário sujo até salvar a revisão',
      '409 stale_revision mantém o rascunho e mostra Há uma versão mais nova com a diferença de selo',
    ],
  });
});

// ── DV-007-CHANGE-REASON ─────────────────────────────────────────────────────

test('DV-007 change-reason: mudar o selo da IA exige motivo na revisão e na checagem manual; 280 caracteres', () => {
  assertFiles(['presentation/review/RevisionForm.tsx', 'domain/changeReasons.ts']);
  runNamedCases({
    [`${T}/presentation/review/RevisionForm.test.tsx`]: [
      'selo diferente do da IA mostra motivo obrigatório e bloqueia o envio sem ele',
      'selo igual ao da IA não pede motivo',
      'explicação acima de 280 caracteres bloqueia o envio',
      'checagem manual a partir da IA com selo diferente exige motivo',
    ],
  });
});

// ── DV-007-TWO-PERSON ────────────────────────────────────────────────────────

test('DV-007 two-person: autor de Falso/Exagerado vê o bloqueio; Confirmar o selo cria revisão própria; lista vem do contrato', () => {
  assertFiles(['presentation/review/ReviewActions.tsx']);
  runNamedCases({
    [REVIEW]: [
      'autor da revisão Falso vê Precisa de uma segunda pessoa e Validar desabilitado',
      'Confirmar o selo cria revisão de mesmo conteúdo com autoria do checador',
      'outra pessoa valida a revisão confirmada',
      'selo fora de twoPersonVerdicts não pede segunda pessoa',
    ],
  });
});

// ── DV-007-SOURCES-CHECKED ───────────────────────────────────────────────────

test('DV-007 sources-checked: Validar desabilitado com fonte sem "abri e confere"; links com noopener', () => {
  assertFiles(['presentation/review/RevisionForm.tsx']);
  runNamedCases({
    [`${T}/presentation/review/RevisionForm.test.tsx`]: [
      'link da fonte abre em nova aba com rel noopener noreferrer',
    ],
    [REVIEW]: [
      'Validar desabilitado enquanto alguma fonte não tem abri e confere',
      '422 sources_not_checked mostra a mensagem própria',
    ],
  });
});

// ── DV-007-LOCK ──────────────────────────────────────────────────────────────

test('DV-007 lock: 409 lock_held mostra dono e prazo e desabilita o formulário; renova a cada 4 min com interação; release ao sair', () => {
  assertFiles(['presentation/review/LockBanner.tsx']);
  runNamedCases({
    [REVIEW]: [
      '409 lock_held mostra Em edição por nome até hh:mm e desabilita o formulário',
      'dono do lock vê a contagem regressiva de 10 min',
      'renova o lock a cada 4 min só com interação nos últimos 5 min',
      'sair da tela chama release',
    ],
  });
});

// ── DV-007-AI-PANEL-LOCKED ───────────────────────────────────────────────────

test('DV-007 ai-panel-locked: painel do veredito no ar mostra publicRevisionId e não muda ao editar o formulário', () => {
  assertFiles(['presentation/review/AiVerdictPanel.tsx', 'presentation/review/SaidPanel.tsx']);
  runNamedCases({
    [REVIEW]: [
      'painel do veredito no ar mostra a revisão de publicRevisionId com o aviso de IA',
      'editar selo, explicação e fontes no formulário não altera o painel do veredito no ar',
      'sem revisão pública o painel mostra Nada no ar',
      'painel do que foi dito destaca o trecho na fala completa com falante, partido e minuto',
    ],
  });
});

// ── DV-007-AUDIO-CLIP ────────────────────────────────────────────────────────

test('DV-007 audio-clip: URL pedida só ao tocar, só em memória, renovada perto de expirar ou em erro', () => {
  assertFiles(['presentation/AudioClipPlayer.tsx']);
  runNamedCases({
    [`${T}/presentation/AudioClipPlayer.test.tsx`]: [
      'não pede audio-clip antes de tocar e usa preload none',
      'pede outra URL quando faltam menos de 30 s para expirar',
      'pede outra URL quando o audio dá erro',
      'não grava a URL em storage nem em log',
    ],
  });
});

// ── DV-007-NOT-VALIDATE-END ──────────────────────────────────────────────────

test('DV-007 not-validate-end: Não validar exige descartar ou abrir manual; depois do fim só resta Checagem manual', () => {
  assertFiles(['presentation/review/ReviewActions.tsx', 'presentation/review/DebateClock.tsx']);
  runNamedCases({
    [REVIEW]: [
      'Não validar exige escolher descartar ou checagem manual e envia followUp',
      'Não validar com checagem manual abre a checagem nova',
      'depois de endedAt Validar e Não validar somem e resta Checagem manual',
      'relógio mostra o fim previsto e Debate encerrado depois do fim',
      'Pedir novo veredito exige instrução de 10 a 500 caracteres',
    ],
  });
});

// ── DV-007-CORRECT-UNPUBLISH ─────────────────────────────────────────────────

test('DV-007 correct-unpublish: Corrigir e Despublicar com motivo público, confirmação dupla e MFA; histórico de correções', () => {
  assertFiles(['presentation/DebateCorrectionsPage.tsx', 'presentation/review/RevisionHistory.tsx']);
  runNamedCases({
    [REVIEW]: [
      'Corrigir exige motivo público e envia baseRevisionId e URLs conferidas',
      'Despublicar exige motivo público e confirmação dupla',
      'REAUTH_REQUIRED em Despublicar repete com a mesma Idempotency-Key',
      'histórico lista todas as revisões e ações em ordem',
    ],
    [`${T}/presentation/DebateCorrectionsPage.test.tsx`]: [
      'lista correções e despublicações com selo anterior, novo, motivo público, autor e data',
    ],
  });
});

// ── DV-007-REPORT ────────────────────────────────────────────────────────────

test('DV-007 report: custos nulos e direitos de resposta vazios não quebram; candidatos na mesma ordem', () => {
  assertFiles(['presentation/DebateReportPage.tsx']);
  runNamedCases({
    [`${T}/presentation/DebateReportPage.test.tsx`]: [
      'costs null mostra estado vazio sem erro',
      'Direitos de resposta mostra estado vazio',
      'candidatos aparecem todos na mesma ordem de displayOrder',
    ],
  });
});

// ── DV-007-E2E-FLOW ──────────────────────────────────────────────────────────

test('DV-007 e2e-flow: da fila ao card visto pelo admin (assumir, revisar, outra pessoa valida, fila atualiza)', () => {
  assertFiles(['presentation/FactCheckQueuePage.tsx', 'presentation/FactCheckReviewPage.tsx']);
  runNamedCases({
    [`${T}/presentation/validationFlow.test.tsx`]: [
      'checador assume, muda o selo com motivo e salva; outra pessoa confere as fontes e valida; a fila tira o item',
    ],
  });
});

// ── DV-007-DESK-SNAPSHOT ─────────────────────────────────────────────────────

test('DV-007 desk-snapshot: snapshot da mesa traz falas recentes, fila de afirmações e checagens abertas', () => {
  runDotnetGate('DebateDv007GateTests.cs', 'DebateDv007GateTests');
});
