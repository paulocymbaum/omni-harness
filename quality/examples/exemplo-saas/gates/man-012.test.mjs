// Gate MAN-012-ITINERARY — stops da manifestação, camada no mapa e notificação de mudança.
// ANTES da implementação este teste DEVE falhar (arquivos/contratos ainda não existem).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-manifestacoes-caronas MAN-012 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const STOP = 'lib/features/events/domain/model/event_itinerary_model.dart';
const LAYER = 'lib/features/map/presentation/widgets/itinerary_layer.dart';
const EVENTS_FN = 'functions/src/features/events.ts';
const stop = fs.readFileSync(STOP, 'utf8');
const layer = fs.readFileSync(LAYER, 'utf8');
const eventsFn = fs.readFileSync(EVENTS_FN, 'utf8');

test('EventStop com id, label, geo, scheduledAt, radiusMeters e order', () => {
  assert.match(stop, /class\s+EventStop/, 'classe EventStop deve existir');
  for (const field of ['id', 'label', 'geo', 'scheduledAt', 'radiusMeters', 'order']) {
    assert.match(stop, new RegExp(`\\b${field}\\b`), `campo ${field} é obrigatório no EventStop`);
  }
});

test('ItineraryLayer desenha os stops ordenados e some sem itinerário', () => {
  assert.match(layer, /class\s+ItineraryLayer/, 'widget ItineraryLayer deve existir');
  assert.match(layer, /EventStop/, 'camada consome EventStop');
  assert.match(layer, /order/, 'ordenação dos pontos pelo campo order');
});

test('mudança de cronograma notifica confirmados via itinerary_changed', () => {
  assert.match(eventsFn, /itinerary_changed/, 'events.ts dispara notificação itinerary_changed');
});
