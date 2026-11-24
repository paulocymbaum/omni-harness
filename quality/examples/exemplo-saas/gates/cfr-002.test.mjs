// Gate CFR-002 — edição de pontos agendados da carona solidária.
// ANTES da implementação este teste DEVE falhar (rodar da raiz do repo).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-caronas-followup CFR-002 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const routeSharePath = 'functions/src/features/route_share.ts';
const editModalPath = 'ofluxo_site/src/platform/presentation/pages/ride-edit-modal.tsx';

function editRideOfferBlock() {
  const source = fs.readFileSync(routeSharePath, 'utf8');
  const start = source.indexOf('export const editRideOffer');
  const end = source.indexOf('export const deleteRideOffer');
  assert.ok(start >= 0 && end > start, 'callables editRideOffer/deleteRideOffer não encontrados');
  return source.slice(start, end);
}

test('CFR-002: editRideOffer valida points via parseSolidaryPoints', () => {
  assert.match(
    editRideOfferBlock(),
    /parseSolidaryPoints/,
    'editRideOffer não valida points com parseSolidaryPoints'
  );
});

test('CFR-002: points só para carona solidária (points_only_for_solidary)', () => {
  assert.match(
    editRideOfferBlock(),
    /points_only_for_solidary/,
    'guarda points_only_for_solidary ausente'
  );
});

test('CFR-002: points gravados transacionalmente na oferta', () => {
  assert.match(
    editRideOfferBlock(),
    /points: pointsUpdate/,
    'gravação points: pointsUpdate ausente na transação'
  );
});

test('CFR-002: modal de edição lista pontos com label e horário', () => {
  const source = fs.readFileSync(editModalPath, 'utf8');
  assert.match(source, /pointKind/, 'editor de pontos ausente: pointKind');
  assert.match(source, /scheduledAtMs/, 'editor de pontos ausente: scheduledAtMs');
  assert.match(source, /solidaryPointName/, 'editor de pontos ausente: solidaryPointName');
});