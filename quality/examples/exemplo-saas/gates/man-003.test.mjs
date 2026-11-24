// Gate MAN-003-MAP-FILTER — filtro de Manifestações e marcador próprio no mapa.
// ANTES da implementação este teste DEVE falhar (arquivos novos ainda não existem).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-manifestacoes-caronas MAN-003 --baseline
// Nota: o limite de tamanho de map_page.dart é gate de qualidade (quality/run.mjs), não deste arquivo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CHIP = 'lib/features/map/presentation/widgets/manifestation_filter_chip.dart';
const CUBIT = 'lib/features/map/presentation/bloc/manifestation_filter_cubit.dart';
const MARKER = 'lib/features/map/presentation/widgets/manifestation_marker_factory.dart';
const chip = fs.readFileSync(CHIP, 'utf8');
const cubit = fs.readFileSync(CUBIT, 'utf8');
const marker = fs.readFileSync(MARKER, 'utf8');

test('ManifestationFilterChip alterna o filtro dedicado', () => {
  assert.match(chip, /class\s+ManifestationFilterChip/, 'widget do chip deve existir em widgets/');
  assert.match(chip, /EventType\.manifestation/, 'chip referencia o tipo manifestation');
});

test('ManifestationFilterCubit mantém estado manifestationOnly com toggle', () => {
  assert.match(cubit, /class\s+ManifestationFilterCubit/, 'cubit do filtro deve existir em bloc/');
  assert.match(cubit, /manifestationOnly/, 'estado manifestationOnly é o contrato');
  assert.match(cubit, /toggle|enable|disable/, 'cubit expõe transições do filtro');
});

test('Marker próprio segue o padrão do mapa e distingue manifestation', () => {
  assert.match(marker, /ManifestationMarkerFactory/, 'factory de marker deve existir');
  assert.match(marker, /EventType\.manifestation/, 'marker condiciona ao tipo manifestation');
});
