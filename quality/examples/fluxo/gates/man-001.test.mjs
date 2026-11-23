// Gate MAN-001-EVENT-TYPE-ENUM — enum canônico EventType com manifestation.
// ANTES da implementação este teste DEVE falhar (event_type.dart ainda não existe).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-manifestacoes-caronas MAN-001 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ENUM_FILE = 'lib/features/events/domain/model/event_type.dart';
const EVENT_MODEL = 'lib/features/events/domain/model/event_model.dart';
const src = fs.readFileSync(ENUM_FILE, 'utf8');
const model = fs.readFileSync(EVENT_MODEL, 'utf8');

test('EventType é enum canônico na camada domain e inclui manifestation', () => {
  assert.match(src, /enum\s+EventType\s*\{/, 'enum EventType deve existir em event_type.dart');
  assert.match(src, /\bmanifestation\b/, 'valor manifestation é obrigatório no enum');
});

test('EventTypeX expõe wireName e fromWire tolerante a nulo/desconhecido', () => {
  assert.match(src, /String\s+get\s+wireName/, 'wireName serializa o valor do contrato');
  assert.match(src, /fromWire\s*\(\s*String\?\s*raw\s*\)/, 'fromWire aceita String? nulo');
  assert.match(src, /EventType\.other/, 'valor desconhecido cai em EventType.other');
});

test('event_model.dart tipa o campo type via EventType preservando a chave eventType', () => {
  assert.match(model, /EventType/, 'campo type deve usar o enum EventType');
  assert.match(model, /eventType/, 'serialização preserva a chave eventType do contrato atual');
});
