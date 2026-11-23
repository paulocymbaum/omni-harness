// Gate MAN-007-PRESENCE-FLOW — confirmação no app e compartilhamento pós-confirmação.
// ANTES da implementação este teste DEVE falhar (arquivos novos/campos ainda não existem).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-manifestacoes-caronas MAN-007 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PRESENCE = 'lib/features/events/domain/model/event_presence_model.dart';
const BUTTON = 'lib/features/events/presentation/widgets/geo_presence_button.dart';
const DETAILS = 'lib/features/events/presentation/event_details_page.dart';
const presence = fs.readFileSync(PRESENCE, 'utf8');
const button = fs.readFileSync(BUTTON, 'utf8');
const details = fs.readFileSync(DETAILS, 'utf8');

test('EventPresence tipa presenceStatus com estados geo_confirmed e qr_confirmed', () => {
  assert.match(presence, /enum\s+EventPresenceStatus/, 'enum EventPresenceStatus deve existir');
  assert.match(presence, /geo_confirmed/, 'estado geo_confirmed do contrato');
  assert.match(presence, /qr_confirmed/, 'estado qr_confirmed do contrato');
  assert.match(presence, /class\s+EventPresence/, 'classe EventPresence com presenceStatus');
});

test('GeoPresenceButton chama o callable server-side e trata negativa genérica', () => {
  assert.match(button, /class\s+GeoPresenceButton/, 'widget GeoPresenceButton deve existir');
  assert.match(button, /verifyEventPresence/, 'validação é server-side (MAN-006)');
  assert.match(button, /geo_confirmed|geoConfirmed/, 'resultado geo confirmado registrado');
});

test('detalhe do evento só oferece InviteSharePanel após presença confirmada', () => {
  assert.match(details, /presenceStatus|EventPresence/, 'detalhe lê o estado de presença');
  assert.match(details, /InviteSharePanel/, 'CTA de compartilhamento usa o painel MAN-005');
  assert.match(details, /GeoPresenceButton/, 'botão de confirmação presente nas manifestações');
});
