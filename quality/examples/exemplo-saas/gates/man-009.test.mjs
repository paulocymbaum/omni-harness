// Gate MAN-009-RANKING — ranking de caronas por proximidade calculado no cliente.
// ANTES da implementação este teste DEVE falhar (arquivos novos ainda não existem).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-manifestacoes-caronas MAN-009 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const RANKING = 'lib/features/route_share/domain/solidary_ride_ranking.dart';
const LIST = 'lib/features/route_share/presentation/widgets/event_solidary_rides_list.dart';
const ranking = fs.readFileSync(RANKING, 'utf8');
const list = fs.readFileSync(LIST, 'utf8');

test('rankSolidaryRides ordena pela distância mínima a qualquer ponto marcado', () => {
  assert.match(ranking, /rankSolidaryRides/, 'função rankSolidaryRides deve existir');
  assert.match(ranking, /distanceMetersToRide/, 'distância mínima ao ponto marcado (A/B/stop)');
  assert.match(ranking, /pointKind/, 'considera os pontos tipados A, B e paradas');
  assert.match(ranking, /haversine/i, 'distância geodésica (haversine)');
});

test('desempate por horário de partida e vagas disponíveis', () => {
  assert.match(ranking, /departureAt/, 'desempate 1: horário de partida');
  assert.match(ranking, /seatAvailable/, 'desempate 2: vagas livres');
});

test('lista do evento usa o ranking e destaca caronas oficiais', () => {
  assert.match(list, /class\s+EventSolidaryRidesList/, 'widget EventSolidaryRidesList deve existir');
  assert.match(list, /rankSolidaryRides/, 'lista consome o ranking por proximidade');
  assert.match(list, /isOfficial/, 'selo da carona oficial visível');
});
