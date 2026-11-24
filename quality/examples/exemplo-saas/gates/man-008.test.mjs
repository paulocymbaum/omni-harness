// Gate MAN-008-SOLIDARY-BACKEND — Carona Solidária em route_share.ts (pontos A/B/paradas).
// ANTES da implementação este teste DEVE falhar (contratos ainda não existem no arquivo).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-manifestacoes-caronas MAN-008 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ROUTE_SHARE = 'functions/src/features/route_share.ts';
const src = fs.readFileSync(ROUTE_SHARE, 'utf8');

test('oferta solidária carrega linkedEventId, isOfficial e departureAt', () => {
  assert.match(src, /linkedEventId/, 'vínculo obrigatório com o evento');
  assert.match(src, /isOfficial/, 'selo de carona oficial (só admins gravam true)');
  assert.match(src, /departureAt/, 'horário de partida obrigatório');
});

test('pontos tipados A, B e stop com validação de A e B obrigatórios', () => {
  assert.match(src, /pointKind/, 'campo pointKind nos pontos da carona');
  // Aceita aspas simples ou duplas: o gate testa o contrato, não o estilo.
  for (const kind of ["A", "B", "stop"]) {
    assert.match(src, new RegExp(`['"]${kind}['"]`), `pointKind deve aceitar ${kind}`);
  }
  assert.match(src, /invalid_solidary_points/, 'recusa solidária sem A e B com erro dedicado');
});

test('regras existentes de vagas e aceitação manual preservadas', () => {
  assert.match(src, /acceptanceMode/, 'aceitação manual continua no contrato');
  assert.match(src, /seatTotal/, 'vagas totais continuam no contrato');
  assert.match(src, /seatAvailable/, 'vagas disponíveis continuam no contrato');
});
