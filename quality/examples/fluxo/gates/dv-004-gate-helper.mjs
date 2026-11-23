// Testes independentes do autor de gates. Copiados só durante a execução para o worker,
// com config própria: nenhum teste ou marcador escrito pelo implementador serve como prova.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, WORKER, requireWorkerDeps, tail } from './dv-worker-gate-helper.mjs';

const TEMPLATES = path.join(ROOT, 'quality/test/delivery/dv-004-vitest');

export function assertGateReport(report, expectedFile, titles, exitCode) {
  assert.equal(exitCode, 0, 'Vitest precisa terminar com exit 0');
  const files = report.testResults ?? [];
  assert.equal(files.length, 1, 'só o arquivo independente solicitado deve rodar');
  const file = files[0];
  assert.equal(path.resolve(file.name), path.resolve(expectedFile), 'Vitest executou outro arquivo');
  assert.equal(file.status, 'passed', file.message ?? 'arquivo de gate falhou');
  const cases = file.assertionResults ?? [];
  assert.deepEqual(cases.map((c) => c.title).sort(), [...titles].sort(), 'casos ausentes, extras ou renomeados');
  assert.deepEqual(cases.filter((c) => c.status !== 'passed').map((c) => ({
    title: c.title, status: c.status, failures: c.failureMessages,
  })), [], 'todos os casos independentes devem passar; skip/todo não são evidência');
}

export function runExtractionSpec(template, titles) {
  requireWorkerDeps();
  // Fora de src/ e test/: o runner normal DV003 não deve coletar gates temporários
  // de uma tarefa ainda não implementada quando outro agente executa os testes do pacote.
  const scratch = path.join(WORKER, '.delivery-gates');
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'dv004-'));
  const reports = fs.mkdtempSync(path.join(os.tmpdir(), 'dv004-report-'));
  const target = path.join(dir, template.replace('.vitest.ts', '.test.ts'));
  const reportFile = path.join(reports, 'report.json');
  try {
    fs.copyFileSync(path.join(TEMPLATES, 'support.ts'), path.join(dir, 'support.ts'));
    fs.copyFileSync(path.join(TEMPLATES, template), target);
    const config = path.join(dir, 'vitest.config.mjs');
    fs.writeFileSync(config, `export default ${JSON.stringify({ test: {
      environment: 'node', include: [path.relative(WORKER, target)],
      testTimeout: 5_000, hookTimeout: 5_000, maxWorkers: 1,
    } })};\n`);
    const r = spawnSync(path.join(WORKER, 'node_modules/.bin/vitest'), [
      'run', '--config', config, '--reporter=json', `--outputFile=${reportFile}`,
    ], { cwd: WORKER, encoding: 'utf8', timeout: 45_000, maxBuffer: 12 * 1024 * 1024,
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
