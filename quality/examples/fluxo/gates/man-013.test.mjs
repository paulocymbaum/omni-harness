// Gate MAN-013-MATERIALS — materiais com acesso restrito (rules + Functions + aba no app).
// ANTES da implementação este teste DEVE falhar (contratos ainda não existem).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-manifestacoes-caronas MAN-013 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const RULES = 'storage.rules';
const FN = 'functions/src/features/event_materials.ts';
const TAB = 'lib/features/events/presentation/widgets/event_materials_tab.dart';
const rules = fs.readFileSync(RULES, 'utf8');
const fn = fs.readFileSync(FN, 'utf8');
const tab = fs.readFileSync(TAB, 'utf8');

test('storage.rules restringe event_materials a participantes autorizados', () => {
  const i = rules.indexOf('event_materials');
  assert.notEqual(i, -1, 'bloco event_materials deve existir em storage.rules');
  const block = rules.slice(i, i + 600);
  assert.match(block, /allow\s+read/i, 'leitura declarada no bloco (restrita a autorizados)');
});

test('Functions cria, lista e remove materiais com validação de tipo e tamanho', () => {
  assert.match(fn, /createEventMaterial/, 'createEventMaterial (só admins)');
  assert.match(fn, /listEventMaterials/, 'listEventMaterials (going/confirmados)');
  assert.match(fn, /removeEventMaterial/, 'removeEventMaterial (quem subiu ou admin)');
  assert.match(fn, /mimeType/, 'valida tipo do arquivo');
  assert.match(fn, /sizeBytes/, 'valida tamanho do arquivo');
});

test('aba Materiais existe no detalhe do evento', () => {
  assert.match(tab, /class\s+EventMaterialsTab/, 'widget EventMaterialsTab deve existir');
});
