// Gate MAN-010-RIDE-SOCIAL — DM com o motorista e Minhas Caronas (Ofereço/Participo).
// ANTES da implementação este teste DEVE falhar (arquivos novos ainda não existem).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-manifestacoes-caronas MAN-010 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const NAV = 'lib/features/route_share/domain/ride_chat_navigator.dart';
const SECTION = 'lib/features/route_share/presentation/widgets/my_solidary_rides_section.dart';
const nav = fs.readFileSync(NAV, 'utf8');
const section = fs.readFileSync(SECTION, 'utf8');

test('openRideCreatorChat navega para a DM existente com contexto da carona', () => {
  assert.match(nav, /openRideCreatorChat/, 'helper openRideCreatorChat deve existir');
  assert.match(nav, /driverUid/, 'destino é o criador da carona');
  assert.match(nav, /rideId/, 'contexto da carona é transportado para a conversa');
  assert.match(nav, /messages|chat/i, 'reusa a feature de mensagens existente');
});

test('Minhas Caronas com abas Ofereço e Participo', () => {
  assert.match(section, /class\s+MySolidaryRidesSection/, 'widget MySolidaryRidesSection deve existir');
  assert.match(section, /Ofereço/, 'aba Ofereço (ofertas onde sou motorista)');
  assert.match(section, /Participo/, 'aba Participo (pedidos aceitos)');
  assert.match(section, /departureAt|horário/i, 'horário da carona visível na lista');
});
