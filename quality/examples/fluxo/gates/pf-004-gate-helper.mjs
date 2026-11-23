import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TEST_FILE = 'integration_test/civic_pulse_test.dart';
const PERFORMANCE_METRICS = [
  'coldBrBytes',
  'coldUfBytes',
  'coldZzBytes',
  'coldBrRequests',
  'coldUfRequests',
  'coldZzRequests',
  'downloadMs',
  'parseMs',
  'firstReadyMs',
  'peakMemoryMb',
  'cacheBytes',
  'jankFrames',
  'frameCount',
  'scrollP95FrameMs',
  'gestureP95FrameMs',
  'styleReloadMs',
  'cameraUpdateP95Ms',
];

export function runNativeJourney({ platform, name, rolloutEvidence = false }) {
  const result = runFlutter(platform, name);
  assertOneTestPassed(result.output, result.status, result.error, name);

  if (rolloutEvidence) {
    const report = readJsonMarker(result.output, 'PF004_ROLLOUT_JSON');
    assert.equal(report.environment, 'staging', 'smoke deve provar staging real, não produção nem texto documental');
    assert.equal(report.mode, 'read-only', 'o gate de rollout não pode aplicar migrations nem alterar infraestrutura');
    assert.equal(report.productionWrites, 0, 'o smoke não pode escrever em produção');
    for (const check of [
      'publicSnapshotsUnauthenticated',
      'apiRequiresAuthAndAppCheck',
      'privateEventExcludedFromPublicDiscovery',
      'apiFirstProjectionVisible',
      'legacyBusinessPrivacySurvivesRollback',
    ]) {
      assert.equal(report.checks?.[check], true, `smoke de staging não comprovou ${check}`);
    }
  }
}

export function runPerformanceJourney({ platform, name }) {
  const result = runFlutter(platform, name);
  assertOneTestPassed(result.output, result.status, result.error, name);

  const report = readJsonMarker(result.output, 'PF004_PERF_JSON');
  assert.equal(report.schema, 'pf004-performance-v1', 'formato de medição não reconhecido');
  assert.equal(report.device?.platform, platform, 'plataforma da medição diverge do dispositivo executado');
  assert.equal(report.device?.class, 'intermediate', 'medição precisa identificar aparelho intermediário');
  assert.ok(nonEmpty(report.device?.model), 'modelo do aparelho não informado');
  assert.match(report.gitSha ?? '', /^[0-9a-f]{40}$/i, 'SHA medido ausente ou inválido');
  assert.ok(nonEmpty(report.budget?.owner), 'responsável pelo orçamento de performance não informado');
  assert.ok(nonEmpty(report.budget?.reference), 'referência do orçamento aprovado não informada');

  for (const metric of PERFORMANCE_METRICS) {
    const observed = report.measurements?.[metric];
    const maximum = report.budget?.maximum?.[metric];
    assert.equal(typeof observed, 'number', `medição real ${metric} ausente`);
    assert.ok(Number.isFinite(observed) && observed >= 0, `medição ${metric} inválida`);
    assert.equal(typeof maximum, 'number', `orçamento aprovado para ${metric} ausente`);
    assert.ok(Number.isFinite(maximum) && maximum >= 0, `orçamento ${metric} inválido`);
    assert.ok(observed <= maximum, `${metric} excedeu o orçamento: ${observed} > ${maximum}`);
  }
}

function runFlutter(platform, name) {
  const deviceId = process.env[platform === 'android' ? 'PF004_ANDROID_DEVICE_ID' : 'PF004_IOS_DEVICE_ID'];
  const environment = process.env.PF004_TEST_ENV;
  const baseUrl = process.env.PF004_TEST_BASE_URL;

  assert.ok(nonEmpty(deviceId), `configure PF004_${platform.toUpperCase()}_DEVICE_ID com o ID do aparelho nativo`);
  assert.ok(
    environment === 'staging' || environment === 'emulator',
    'PF004_TEST_ENV deve ser staging ou emulator; o gate nunca usa produção',
  );
  assert.ok(nonEmpty(baseUrl), 'PF004_TEST_BASE_URL deve apontar para staging isolado ou emulador');
  const target = new URL(baseUrl);
  const labels = target.hostname.toLowerCase().split('.');
  const hasStagingLabel = labels.some((label) => ['staging', 'stage', 'stg', 'test', 'testing', 'emulator'].includes(label));
  const hasProductionLabel = labels.some((label) => ['prod', 'production', 'live', 'www'].includes(label));
  assert.ok(
    (environment === 'staging' && target.protocol === 'https:' && hasStagingLabel && !hasProductionLabel) ||
      (environment === 'emulator' && ['localhost', '127.0.0.1', '10.0.2.2', '[::1]'].includes(target.hostname)),
    'alvo recusado: use HTTPS de staging isolado ou host de emulador; produção é proibida',
  );

  const result = spawnSync('flutter', [
    'test',
    TEST_FILE,
    '--no-pub',
    '--device-id',
    deviceId,
    '--name',
    `^${escapeRegExp(name)}$`,
    '--reporter',
    'expanded',
    `--dart-define=PF004_TEST_ENV=${environment}`,
    `--dart-define=PF004_TEST_BASE_URL=${baseUrl}`,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    error: result.error,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

function assertOneTestPassed(output, status, error, name) {
  assert.equal(error, undefined, `flutter test não executou (${error?.message ?? 'erro desconhecido'}):\n${output}`);
  assert.equal(status, 0, `jornada nativa falhou para "${name}":\n${output}`);
  assert.ok(output.includes(name), `jornada exata não foi descoberta/executada:\n${output}`);
  assert.match(output, /\+\s*1:\s*All tests passed!/, `esperava exatamente uma jornada aprovada:\n${output}`);
  assert.doesNotMatch(output, /~\s*\d+:/, `jornada foi pulada:\n${output}`);
  assert.doesNotMatch(output, /(?:\+\s*(?:[2-9]|\d{2,}):|Total tests:\s*(?:[2-9]|\d{2,}))/, `mais de uma jornada foi executada:\n${output}`);
}

function readJsonMarker(output, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...output.matchAll(new RegExp(`${escaped}=(\\{[^\\r\\n]+\\})`, 'g'))];
  assert.equal(matches.length, 1, `esperava exatamente uma evidência JSON estruturada ${marker}; Markdown não é evidência`);
  try {
    return JSON.parse(matches[0][1]);
  } catch (error) {
    assert.fail(`${marker} não contém JSON válido: ${error.message}`);
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
