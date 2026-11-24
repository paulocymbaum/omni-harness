// Gate MAN-006-PRESENCE-SERVER — verificação server-side de presença geo sem coordenadas brutas.
// ANTES da implementação este teste DEVE falhar (presence_verification.ts ainda não existe).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-manifestacoes-caronas MAN-006 --baseline
// Revisão de privacidade (LGPD/anti-spoofing) é gate manual: MAN-006-PRIVACY-REVIEW.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const FN = 'functions/src/features/presence_verification.ts';
const RULES = 'firestore.rules';
const src = fs.readFileSync(FN, 'utf8');
const rules = fs.readFileSync(RULES, 'utf8');

test('callable verifyEventPresence valida distância, acurácia e janela no servidor', () => {
  assert.match(src, /verifyEventPresence/, 'callable verifyEventPresence deve existir');
  assert.match(src, /haversineMeters/, 'distância calculada com haversineMeters');
  assert.match(src, /presenceRadiusMeters/, 'valida contra o raio configurado no evento');
  assert.match(src, /presenceWindow/, 'valida a janela de horário do evento');
  assert.match(src, /accuracyMeters/, 'checa acurácia mínima do fix GPS');
});

test('persistência guarda só resultado — nunca coordenada bruta', () => {
  assert.match(src, /coarseCellHash/, 'persiste apenas hash de célula grosseira, não coordenada');
  assert.match(src, /method[\s\S]{0,40}geofence|geofence[\s\S]{0,40}method/, 'método geofence registrado');
  assert.match(src, /presence_denied_generic|deniedGeneric/, 'negativa devolve motivo genérico');
});

test('firestore.rules: cliente não escreve em presence_verifications', () => {
  const i = rules.indexOf('presence_verifications');
  assert.notEqual(i, -1, 'bloco presence_verifications deve existir em firestore.rules');
  const block = rules.slice(i, i + 500);
  assert.match(block, /allow\s+create:\s*if\s*false/, 'canônico só escreve no servidor (create if false)');
});
