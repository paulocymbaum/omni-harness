// Gate MAN-002-CONFIG-AND-FORM — ManifestationConfig + formulário de manifestação.
// ANTES da implementação este teste DEVE falhar (arquivos novos ainda não existem).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-manifestacoes-caronas MAN-002 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CONFIG = 'lib/features/events/domain/model/manifestation_config_model.dart';
const EVENT_MODEL = 'lib/features/events/domain/model/event_model.dart';
const FORM = 'lib/features/events/presentation/widgets/manifestation_form_section.dart';
const src = fs.readFileSync(CONFIG, 'utf8');
const model = fs.readFileSync(EVENT_MODEL, 'utf8');
const form = fs.readFileSync(FORM, 'utf8');

test('ManifestationConfig expõe presença geo, raio e janela com (de)serialização', () => {
  assert.match(src, /class\s+ManifestationConfig/, 'classe ManifestationConfig deve existir');
  assert.match(src, /presenceGeoEnabled/, 'campo presenceGeoEnabled é obrigatório');
  assert.match(src, /presenceRadiusMeters/, 'campo presenceRadiusMeters é obrigatório');
  assert.match(src, /presenceWindow/, 'campo presenceWindow é obrigatório');
  assert.match(src, /toJson/, 'contrato exige toJson');
  assert.match(src, /fromJson/, 'contrato exige fromJson');
});

test('event_model carrega manifestationConfig opcional', () => {
  assert.match(model, /manifestationConfig/, 'evento deve carregar manifestationConfig (nulo em comuns)');
});

test('ManifestationFormSection só se aplica ao tipo manifestation', () => {
  assert.match(form, /class\s+ManifestationFormSection/, 'widget ManifestationFormSection deve existir');
  assert.match(form, /ManifestationConfig/, 'form edita ManifestationConfig');
  assert.match(form, /EventType\.manifestation/, 'form condiciona a exibição ao tipo manifestation');
});
