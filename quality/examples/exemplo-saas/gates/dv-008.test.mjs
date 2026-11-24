// Gates DV-008 — timeline do debate: gerador por outbox, GET /debates/{slug}/timeline, telas /app/pulso/debates,
// balão "Validando…" com aviso vermelho, card validado, placar; e as pendências herdadas da DV-007.
// ANTES da implementação cada gate DEVE falhar:
//   node quality/delivery/eval.mjs docs/entregas/2026-10-21-debate-ao-vivo DV-008 --baseline
//
// Escopo: o leitor de CPF, RequireCpfVerifiedFilter, DebateTimelineSignal, a bomba e GET /debates são do DV-002 e
// têm testes próprios. Estes gates cobrem só o que a DV-008 acrescenta. Tudo offline: Postgres descartável em
// FLUXO_TEST_POSTGRES, emulador Firestore em FIRESTORE_EMULATOR_HOST, fetch falso no Vitest, build local no smoke.
// Specs do próprio gate: dv-008-vitest/ e dv-008-dotnet/ (copiados só durante a execução).
// Casos nomeados são escritos pelo implementador com o título/método exato listado aqui.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runDotnetClasses } from './dv-002-dotnet-helper.mjs';
import { ROOT, runSiteSpecs, runSiteNamedCases, runDotnetGate8, runSmoke } from './dv-008-gate-helper.mjs';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const D = 'src/platform/domain';
const I = 'src/platform/infrastructure';
const P = 'src/platform/presentation/pages';

// ── DV-008-API-PROJECTION ────────────────────────────────────────────────────

test('DV-008 projection: DebateTimelineProjector aplica a tabela de projeção, privacidade e placar', () => {
  runDotnetClasses({
    DebateTimelineProjectorTests: {
      wholeClass: true,
      methods: [
        'Claim_without_public_revision_projects_pending_without_fact_check',
        'Ai_public_pending_human_projects_balloon_with_ai_preview_and_disclaimer_only',
        'Validated_projects_card_with_check_and_validated_at_without_ai_preview',
        'Not_validated_expired_unpublished_and_discarded_are_absent',
        'Discarded_claim_is_absent',
        'Manual_check_projects_only_as_card',
        'Unvalidated_editor_revision_keeps_ai_public_revision_in_balloon',
        'Serialized_json_has_no_forbidden_fields',
        'Scoreboard_lists_all_participants_in_display_order_and_counts_only_cards',
        'Events_keep_all_claims_and_only_last_50_utterances',
      ],
    },
  });
});

// ── DV-008-API-JOURNEY ───────────────────────────────────────────────────────

test('DV-008 journey: outbox gera o snapshot e o leitor vê balão, card, ausência, 304 e 404', () => {
  runDotnetGate8('DebateDv008TimelineGateTests.cs', 'DebateDv008TimelineGateTests', { firestore: true });
});

// ── DV-008-WEB-DOMAIN ────────────────────────────────────────────────────────

test('DV-008 web-domain: schema Zod com fact_check discriminado, funções puras e paleta AA', () => {
  runSiteNamedCases({
    [`${D}/debate-timeline.test.ts`]: [
      'balloon sem disclaimer é rejeitado',
      'balloon com check é rejeitado',
      'card sem validated_at é rejeitado',
      'card com ai_preview é rejeitado',
      'checagem inválida volta a Em checagem sem derrubar a timeline',
      'ordena do mais recente para o mais antigo',
      'filtra por candidato e por tipo',
      'placar conta só card',
      'detecta atualização quando version sobe',
      'detecta a transição balloon para card',
    ],
    [`${D}/debate-verdict-palette.test.ts`]: [
      'cada selo tem contraste AA com seu texto lendo fluxo-tokens.css',
      'pending não tem cor de veredito',
    ],
  });
});

// ── DV-008-WEB-CLIENT ────────────────────────────────────────────────────────

test('DV-008 web-client: GET condicional com ETag/304 e polling de 5 s que para em archived', () => {
  runSiteSpecs(['conditional.vitest.ts']);
  runSiteNamedCases({
    [`${I}/debate-timeline.test.ts`]: [
      '304 devolve o corpo anterior',
      'polling de 5 s pausa com a aba oculta',
      'polling desligado em archived',
      '403 identity_verification_required vira estado de verificação',
      '404 vira estado de debate não encontrado',
    ],
  });
});

// ── DV-008-WEB-FACT-CHECK ────────────────────────────────────────────────────

test('DV-008 web-fact-check: Em checagem sem selo, balão com prévia só após clique e aviso vermelho, card validado', () => {
  runSiteNamedCases({
    [`${P}/debate-fact-check-card.test.tsx`]: [
      'pending não renderiza selo',
      'balão não mostra selo nem prévia antes do clique',
      'após o clique a prévia mostra o aviso vermelho com ícone e texto e aria-expanded=true',
      'balão não tem href, âncora #c- nem botão de compartilhar',
      'card mostra selo, fontes com link, Validado pela equipe e âncora #c-<id>',
      'card corrigido mostra Corrigido em e o motivo',
    ],
  });
});

// ── DV-008-WEB-PAGE ──────────────────────────────────────────────────────────

test('DV-008 web-page: timeline some com o JSON, aria-live só na validação, direito de resposta e placar fixo', () => {
  runSiteNamedCases({
    [`${P}/debate-timeline-page.test.tsx`]: [
      'checagem ausente no JSON seguinte some da tela',
      'aria-live anuncia Checagem validada só na transição balloon para card',
      'falas ficam fora do aria-live',
      'direito de resposta presente em carregando, erro, vazio, ao vivo e arquivado',
      '403 mostra a verificação de identidade',
      '404 mostra debate não encontrado',
      'nunca instancia WebSocket nem EventSource',
    ],
    [`${P}/debate-scoreboard.test.tsx`]: [
      'lista todos os candidatos em display_order',
      'ordem não muda com os números do placar',
      'balão não conta no placar',
    ],
    [`${P}/debate-list-page.test.tsx`]: [
      'agrupa em ao vivo, próximos e encerrados',
    ],
  });
});

// ── DV-008-WEB-ROUTES ────────────────────────────────────────────────────────

/** Trecho do JSX a partir do atributo path até o próximo path. */
function routeSegment(src, routePath) {
  const re = new RegExp(`path=\\{?["'\`]/?${routePath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}["'\`]`);
  const m = re.exec(src);
  assert.ok(m, `fluxo-platform.tsx sem a rota ${routePath}`);
  const rest = src.slice(m.index + m[0].length);
  const next = rest.search(/\bpath=/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('DV-008 web-routes: /app/pulso/debates e /:slug atrás de RequireIdentityVerified; open/debate/:id preserva o hash', () => {
  const platform = read('ofluxo_site/src/platform/fluxo-platform.tsx');
  for (const route of ['pulso/debates', 'pulso/debates/:slug']) {
    const segment = routeSegment(platform, route);
    assert.match(segment, /<RequireIdentityVerified\b/, `${route} precisa de RequireIdentityVerified`);
  }
  assert.match(platform, /lazy\(\s*\(\)\s*=>\s*import\([^)]*debate-list-page/, 'DebateListPage em lazy import');
  assert.match(platform, /lazy\(\s*\(\)\s*=>\s*import\([^)]*debate-timeline-page/, 'DebateTimelinePage em lazy import');
  const core = read('ofluxo_site/src/platform/presentation/pages/core-pages.tsx');
  const m = /kind\s*===\s*['"]debate['"]([\s\S]{0,400})/.exec(core);
  assert.ok(m, "OpenSharedResourcePage sem kind === 'debate'");
  assert.match(m[1], /\/app\/pulso\/debates\//, 'debate compartilhado abre /app/pulso/debates/:id');
  assert.match(m[1], /\bhash\b/, 'o link compartilhado preserva location.hash (#c-<id>)');
});

// ── DV-008-SMOKE ─────────────────────────────────────────────────────────────

test('DV-008 smoke: /app/pulso/debates e /app/pulso/debates/exemplo abrem o acesso sem erro de JavaScript', () => {
  const spec = read('ofluxo_site/e2e/routes-smoke.spec.ts');
  const list = /protectedRoutes\s*=\s*\[([\s\S]*?)\];/.exec(spec)?.[1] ?? '';
  for (const route of ['pulso/debates', 'pulso/debates/exemplo']) {
    assert.match(list, new RegExp(`['"\`]${route}['"\`]`), `protectedRoutes sem ${route}`);
  }
  runSmoke('/app/pulso/debates', 2);
});

// ── DV-008-LOCK-DISPLAY-NAME (pendência DV-007) ──────────────────────────────

test('DV-008 lock-display-name: lock.holder e authorDisplayName trazem o nome do admin; holderUid traz o uid', () => {
  runDotnetGate8('DebateDv008LockNameGateTests.cs', 'DebateDv008LockNameGateTests');
});

// ── DV-008-MANUAL-QUEUE (pendência DV-007) ───────────────────────────────────

test('DV-008 manual-queue: manual_pending traz ManualDraft e not_validated sem checagem manual nem descarte', () => {
  runDotnetGate8('DebateDv008ManualQueueGateTests.cs', 'DebateDv008ManualQueueGateTests');
});
