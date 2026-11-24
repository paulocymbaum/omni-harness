// Gates DV-011 — direito de resposta: projeção pública só de pedidos aceitos, tela admin da fila, bloco fixo na
// página do debate (contato@ofluxo.app, canal voluntário que não substitui a Justiça Eleitoral), seção "Direitos de
// resposta" e link "Resposta do candidato" no card; prazo (reply_deadline_at, 25/10/2026) configurado no admin.
// ANTES da implementação cada gate DEVE falhar:
//   node quality/delivery/eval.mjs docs/entregas/2026-10-21-debate-ao-vivo DV-011 --baseline
//
// Escopo: tabela debate_reply_requests, DebateReplyEndpoints, permissões, MFA, aceite exige texto e recusa exige
// motivo no servidor já são do DV-002 (DebateEditorialApiTests) e NÃO são refeitos aqui.
// Tudo offline: Postgres descartável em FLUXO_TEST_POSTGRES, emulador Firestore em FIRESTORE_EMULATOR_HOST,
// fetch falso no Vitest. Casos nomeados são escritos pelo implementador com o título/método exato listado aqui.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, requireEnv, runDotnetClasses } from './dv-002-dotnet-helper.mjs';
import { runSiteNamedCases } from './dv-008-gate-helper.mjs';
import { runNamedCases } from './dv-006-vitest-helper.mjs';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const D = 'src/platform/domain';
const P = 'src/platform/presentation/pages';
const A = 'src/modules/debates';

// ── DV-011-NOTICE-EVERY-PAGE ─────────────────────────────────────────────────

test('DV-011 notice-every-page: bloco de direito de resposta com mailto, fallback e aviso da Justiça Eleitoral em toda página', () => {
  runSiteNamedCases({
    [`${P}/debate-reply-notice.test.tsx`]: [
      'e-mail é link mailto vindo de reply_contact',
      'sem reply_contact usa mailto:contato@ofluxo.app',
      'mostra a frase Canal voluntário da plataforma; não substitui o direito de resposta pela Justiça Eleitoral',
    ],
    [`${P}/debate-timeline-page.test.tsx`]: [
      'bloco de direito de resposta presente ao vivo, arquivado, carregando, erro e vazio',
    ],
    [`${P}/debate-methodology-page.test.tsx`]: [
      'página de metodologia mostra o bloco de direito de resposta',
    ],
  });
});

// ── DV-011-ACCEPT-ONLY-PUBLISH ───────────────────────────────────────────────

test('DV-011 accept-only-publish: só pedido aceito por debates.publish aparece na timeline e no relatório públicos', () => {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL descartável do módulo Debates');
  requireEnv('FIRESTORE_EMULATOR_HOST', 'emulador Firestore para o CPF verificado do leitor');
  runDotnetClasses({
    DebateReplyProjectionTests: {
      wholeClass: true,
      methods: [
        'Timeline_replies_contain_only_accepted',
        'Report_replies_contain_only_accepted',
        'Received_in_review_and_rejected_never_appear',
        'Public_json_has_no_sender_email_attachments_or_decision_reason',
        'Reply_ids_only_on_card_never_on_balloon',
        'Reply_contact_comes_from_debate_reply_contact_email',
      ],
    },
    DebateReplyRequestJourneyTests: {
      wholeClass: true,
      methods: [
        'Accept_by_publish_appears_in_timeline_and_report_on_next_generation',
        'Accept_enqueues_report_changed_and_does_not_change_verdict',
        'Fact_check_from_other_debate_returns_422_fact_check_mismatch',
        'Accepted_and_rejected_are_final',
      ],
    },
  });
});

// ── DV-011-REJECT-REASON ─────────────────────────────────────────────────────

test('DV-011 reject-reason: fila de direito de resposta no admin com rota protegida e decisão bloqueada sem motivo/texto', () => {
  const router = read('admin-web/src/app/router/AppRouter.tsx');
  const line = router.split('\n').find((l) => /["'`]debates\/:id\/direito-de-resposta["'`]/.test(l));
  assert.ok(line, 'AppRouter sem a rota debates/:id/direito-de-resposta');
  for (const perm of ['debates.review', 'debates.publish', 'legal.read']) {
    assert.ok(line.includes(`"${perm}"`) || line.includes(`'${perm}'`), `rota direito-de-resposta sem ${perm} no anyOf`);
  }
  assert.match(line, /ReplyRequestsPage/);
  runNamedCases({
    [`${A}/presentation/ReplyRequestsPage.test.tsx`]: [
      'legal vê a lista sem botões de decisão',
      'debates.review sem debates.publish não vê Aceitar nem Recusar',
      'Recusar fica desabilitado sem motivo',
      'Aceitar fica desabilitado sem texto publicado',
      'pedido com respond_by vencido aparece em atraso',
      'mostra o lembrete de canal voluntário que não substitui a Justiça Eleitoral',
    ],
  });
});

// ── DV-011-CARD-LINK ─────────────────────────────────────────────────────────

test('DV-011 card-link: replies[] e reply_ids[] no schema, seção Direitos de resposta e link só em card com resposta aceita', () => {
  runSiteNamedCases({
    [`${D}/debate-timeline.test.ts`]: [
      'replies e reply_ids do card são aceitos no schema da timeline',
    ],
    [`${D}/debate-report.test.ts`]: [
      'relatório com replies aceitas é aceito',
    ],
    [`${P}/debate-fact-check-card.test.tsx`]: [
      'card com reply_ids mostra o link Resposta do candidato apontando para a resposta',
      'card sem reply_ids não mostra Resposta do candidato',
      'balão nunca mostra Resposta do candidato',
    ],
    [`${P}/debate-replies-section.test.tsx`]: [
      'lista as respostas aceitas com texto publicado e data',
      'sem replies não renderiza a seção na timeline ao vivo',
    ],
    [`${P}/debate-report-view.test.tsx`]: [
      'seção Direitos de resposta mostra as respostas aceitas',
    ],
  });
});

// ── DV-011-CONTACT-DEADLINE ──────────────────────────────────────────────────

/** Arquivos de produção (sem testes, fixtures nem pastas temporárias de gate). */
function productionFiles(relDir, exts) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!/^(node_modules|testing|__.*__|bin|obj)$/.test(e.name)) walk(p);
      } else if (exts.some((x) => e.name.endsWith(x)) && !/\.(test|spec)\.|Tests?\.cs$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(ROOT, relDir));
  return out;
}

test('DV-011 contact-deadline: e-mail e prazo do direito de resposta editáveis no admin, sem data literal no código', () => {
  runNamedCases({
    [`${A}/domain/debateForm.test.ts`]: [
      'reply_deadline_at é enviado no cadastro e na edição do debate',
    ],
    [`${A}/presentation/DebateReportPage.test.tsx`]: [
      'Direitos de resposta mostra contagem por estado, atrasos e link para a fila',
    ],
  });
  const offenders = [
    ...productionFiles('admin-web/src/modules/debates', ['.ts', '.tsx']),
    ...productionFiles('ofluxo_site/src/platform', ['.ts', '.tsx']),
    ...productionFiles('backend/src/Exemplo SaaS.Api/Modules/Debates', ['.cs']),
  ].filter((f) => /2026-10-25T23:59|25\/10\/2026/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(offenders, [], 'prazo do direito de resposta vem de reply_deadline_at, não de literal no código');
});
