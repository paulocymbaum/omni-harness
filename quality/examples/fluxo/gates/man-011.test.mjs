// Gate MAN-011-REMINDERS — lembrete de horário e confirmação de presença pelo motorista.
// ANTES da implementação este teste DEVE falhar (trigger novo e callable ainda não existem).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-manifestacoes-caronas MAN-011 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TRIGGER = 'functions/src/triggers/rideDepartureReminders.scheduled.ts';
const ROUTE_SHARE = 'functions/src/features/route_share.ts';
const trigger = fs.readFileSync(TRIGGER, 'utf8');
const routeShare = fs.readFileSync(ROUTE_SHARE, 'utf8');

test('job agendado envia ride_departure_reminder antes da partida', () => {
  assert.match(trigger, /ride_departure_reminder/, 'tipo de notificação ride_departure_reminder');
  assert.match(trigger, /departureAt/, 'varredura pela partida futura');
  assert.match(trigger, /scheduled/i, 'padrão de trigger agendado (.scheduled.ts)');
});

test('callable confirmRideParticipant é exclusivo do motorista e registra confirmed/no_show', () => {
  assert.match(routeShare, /confirmRideParticipant/, 'callable confirmRideParticipant deve existir');
  assert.match(routeShare, /participantConfirmations/, 'grava participantConfirmations');
  assert.match(routeShare, /no_show/, 'status de ausência registrado');
  assert.match(routeShare, /driverUid/, 'autorização: só o motorista confirma');
});
