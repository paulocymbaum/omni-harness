// Helper dos gates BIL-*. Os templates xUnit são do autor de gates e só existem no projeto de testes durante a execução:
// nenhum teste ou marcador do implementador serve como prova do contrato (padrão DV-005).
// Os templates usam HTTP, SQL e reflexão para Billing, então compilam antes da implementação e falham em execução.
// Peças comuns (runDotnetGate, parseTrx, walk, leitura) vivem em dotnet-gate-common.mjs; este
// módulo fixa a família BIL (templates bil-dotnet, GateBilSupport, PostgreSQL sempre exigido).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeDotnetGate, existsRel, readFileRel, walkRel } from './dotnet-gate-common.mjs';
import { ROOT, requireEnv, runOk } from './dv-002-dotnet-helper.mjs';

export { ROOT, requireEnv, runOk };

export const DELIVERY = 'docs/entregas/2026-10-31-billing-asaas-mercadopago';
export const BILLING_DIR = 'backend/src/Exemplo SaaS.Api/Modules/Billing';
const TEMPLATES = path.join(ROOT, 'quality/test/delivery/bil-dotnet');
const EXCLUDE_TARGETS = path.join(TEMPLATES, 'exclude-unrelated-broken-test.targets');
const SUPPORT = 'GateBilSupport.cs';

export const read = (rel) => readFileRel(ROOT, rel);

export const exists = (rel) => existsRel(ROOT, rel);

/** Lista arquivos sob `rel` (caminhos POSIX relativos à raiz). Diretório ausente devolve []. */
export const walk = (rel, keep = () => true) => walkRel(ROOT, rel, keep, { exclude: ['bin', 'obj', 'node_modules'] });

const tail = (text, lines = 60) => text.split('\n').slice(-lines).join('\n');

/** runDotnetGate da família BIL: PostgreSQL sempre exigido; implementerPrefix/excludeBroken por gate. */
export const runDotnetGate = makeDotnetGate({
  root: ROOT, templatesDir: TEMPLATES, excludeTargets: EXCLUDE_TARGETS,
  supportFile: SUPPORT, trxPrefix: 'bil', postgres: true,
});

/** Roda um arquivo Vitest do admin-web e exige ao menos `minimum` testes verdes. */
export function runAdminVitest(rel, minimum) {
  assert.ok(exists(`admin-web/${rel}`), `teste ausente: admin-web/${rel}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bil-vitest-'));
  const report = path.join(dir, 'report.json');
  try {
    const r = spawnSync(path.join(ROOT, 'admin-web/node_modules/.bin/vitest'), [
      'run', rel, '--reporter=json', `--outputFile=${report}`,
    ], { cwd: path.join(ROOT, 'admin-web'), encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: '1', NODE_ENV: 'test' } });
    assert.equal(r.error, undefined, `Vitest não executou: ${r.error?.message}`);
    assert.ok(fs.existsSync(report), `Vitest não produziu relatório:\n${tail(`${r.stdout}\n${r.stderr}`)}`);
    const json = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(json.numFailedTests, 0, 'há teste Vitest falhando');
    assert.equal(json.numPendingTests ?? 0, 0, 'teste Vitest pulado não conta como evidência');
    assert.ok(json.numPassedTests >= minimum, `esperava ao menos ${minimum} testes verdes, houve ${json.numPassedTests}`);
    assert.equal(r.status, 0, `Vitest saiu com ${r.status}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copia templates Vitest do autor de gates para dentro do app, roda só eles e remove. Prova contra o contrato, não contra o
 * teste do implementador. templates: { 'arquivo em bil-web/': 'destino relativo ao app' }. Exige ao menos `minimum` verdes.
 */
export function runVitestTemplates(app, templates, minimum, { only = null, templatesDir = 'bil-web' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bil-web-'));
  const report = path.join(dir, 'report.json');
  const copies = Object.entries(templates).map(([file, dest]) => [path.join(ROOT, 'quality/test/delivery', templatesDir, file), path.join(ROOT, app, dest), dest]);
  try {
    for (const [from, to, dest] of copies) {
      assert.ok(fs.existsSync(path.dirname(to)), `diretório ausente para o template: ${path.dirname(dest)}`);
      fs.copyFileSync(from, to);
    }
    const r = spawnSync(path.join(ROOT, app, 'node_modules/.bin/vitest'), [
      'run', ...copies.map(([, , dest]) => dest), ...(only ? ['-t', only] : []), '--reporter=json', `--outputFile=${report}`,
    ], { cwd: path.join(ROOT, app), encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: '1', NODE_ENV: 'test' } });
    assert.equal(r.error, undefined, `Vitest não executou: ${r.error?.message}`);
    assert.ok(fs.existsSync(report), `Vitest não produziu relatório:\n${tail(`${r.stdout}\n${r.stderr}`)}`);
    const json = JSON.parse(fs.readFileSync(report, 'utf8'));
    const failures = json.testResults.flatMap((file) => [
      ...(file.status === 'failed' && !file.assertionResults.length ? [`${path.basename(file.name)}: ${String(file.message).split('\n')[0].slice(0, 200)}`] : []),
      ...file.assertionResults.filter((t) => t.status === 'failed').map((t) => `${t.title}: ${String(t.failureMessages?.[0]).split('\n')[0].slice(0, 200)}`),
    ]);
    assert.deepEqual(failures, [], 'testes Vitest do gate falharam');
    if (!only) assert.equal(json.numPendingTests ?? 0, 0, 'teste Vitest pulado não conta como evidência');
    assert.ok(json.numPassedTests >= minimum, `esperava ao menos ${minimum} testes verdes, houve ${json.numPassedTests}`);
    assert.equal(r.status, 0, `Vitest saiu com ${r.status}`);
  } finally {
    for (const [, to] of copies) fs.rmSync(to, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
