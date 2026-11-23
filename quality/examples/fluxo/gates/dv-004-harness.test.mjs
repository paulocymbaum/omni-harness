import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertGateReport } from './dv-004-gate-helper.mjs';

const file = '/tmp/dv004-independent.test.ts';
const report = (status = 'passed', cases = [{ title: 'comportamento', status: 'passed' }]) => ({
  testResults: [{ name: file, status, assertionResults: cases }],
});

test('DV-004 harness aceita somente casos independentes presentes e aprovados', () => {
  assert.doesNotThrow(() => assertGateReport(report(), file, ['comportamento'], 0));
});

test('DV-004 harness rejeita descoberta vazia, arquivo errado e caso ausente', () => {
  assert.throws(() => assertGateReport({ testResults: [] }, file, ['comportamento'], 0));
  assert.throws(() => assertGateReport(report(), '/tmp/outro.test.ts', ['comportamento'], 0));
  assert.throws(() => assertGateReport(report('passed', []), file, ['comportamento'], 0));
});

test('DV-004 harness rejeita skip, todo, falha, caso extra e processo com erro', () => {
  for (const status of ['pending', 'todo', 'skipped', 'failed']) {
    assert.throws(() => assertGateReport(report('passed', [{ title: 'comportamento', status }]), file, ['comportamento'], 0));
  }
  assert.throws(() => assertGateReport(report('failed'), file, ['comportamento'], 0));
  assert.throws(() => assertGateReport(report(), file, ['outro'], 0));
  assert.throws(() => assertGateReport(report(), file, ['comportamento'], 1));
});
