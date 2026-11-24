// Helper dos gates DV-005. Os testes são do autor de gates e só existem no pacote durante a execução:
// nenhum teste ou marcador escrito pelo implementador serve como prova.
// - Vitest: copia support.ts + o template para services/debate-worker/.delivery-gates/ (fora de src/ e test/).
// - .NET: copia a classe xUnit para backend/tests/Exemplo SaaS.Api.Tests/ só durante o `dotnet test` e remove depois.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, WORKER, requireWorkerDeps, tail } from './dv-worker-gate-helper.mjs';
import { assertGateReport } from './dv-004-gate-helper.mjs';
import { requireEnv, runDotnetClasses } from './dv-002-dotnet-helper.mjs';

const VITEST_TEMPLATES = path.join(ROOT, 'quality/test/delivery/dv-005-vitest');
const DOTNET_TEMPLATES = path.join(ROOT, 'quality/test/delivery/dv-005-dotnet');
const TEST_PROJECT = path.join(ROOT, 'backend/tests/Exemplo SaaS.Api.Tests');

export function runCheckSpec(template, titles) {
  requireWorkerDeps();
  const scratch = path.join(WORKER, '.delivery-gates');
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'dv005-'));
  const reports = fs.mkdtempSync(path.join(os.tmpdir(), 'dv005-report-'));
  const target = path.join(dir, template.replace('.vitest.ts', '.test.ts'));
  const reportFile = path.join(reports, 'report.json');
  try {
    fs.copyFileSync(path.join(VITEST_TEMPLATES, 'support.ts'), path.join(dir, 'support.ts'));
    fs.copyFileSync(path.join(VITEST_TEMPLATES, template), target);
    const config = path.join(dir, 'vitest.config.mjs');
    fs.writeFileSync(config, `export default ${JSON.stringify({ test: {
      environment: 'node', include: [path.relative(WORKER, target)],
      testTimeout: 10_000, hookTimeout: 10_000, maxWorkers: 1,
    } })};\n`);
    const r = spawnSync(path.join(WORKER, 'node_modules/.bin/vitest'), [
      'run', '--config', config, '--reporter=json', `--outputFile=${reportFile}`,
    ], { cwd: WORKER, encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: '1', NODE_ENV: 'test' } });
    const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    assert.equal(r.error, undefined, `Vitest não executou: ${r.error?.message}\n${tail(output)}`);
    assert.ok(fs.existsSync(reportFile), `Vitest não produziu relatório:\n${tail(output)}`);
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    const failures = (report.testResults ?? []).flatMap((f) => [f.message ?? '',
      ...(f.assertionResults ?? []).flatMap((a) => a.failureMessages ?? []),
    ]).filter(Boolean).join('\n');
    try { assertGateReport(report, target, titles, r.status); }
    catch (error) { throw new Error(`${error.message}\n${tail(failures || output)}`, { cause: error }); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(reports, { recursive: true, force: true });
    try { fs.rmdirSync(scratch); } catch (error) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
    }
  }
}

/** Copia a classe xUnit do gate para o projeto de testes, roda os métodos nomeados e remove a cópia. */
export function runDotnetTemplate(file, cls, methods) {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL 17 descartável com pgvector');
  const target = path.join(TEST_PROJECT, file);
  assert.ok(!fs.existsSync(target), `${path.relative(ROOT, target)} já existe: o gate não sobrescreve testes do implementador`);
  fs.copyFileSync(path.join(DOTNET_TEMPLATES, file), target);
  try {
    runDotnetClasses({ [cls]: { methods, wholeClass: true } });
  } finally {
    fs.rmSync(target, { force: true });
  }
}
