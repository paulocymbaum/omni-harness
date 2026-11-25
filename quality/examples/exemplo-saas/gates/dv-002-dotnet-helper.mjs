// Helper dos gates DV-002: roda `dotnet test` filtrado por classe/método e lê o TRX.
// Exige que cada método nomeado seja descoberto e passe, e recusa qualquer teste pulado.
// Integração sem ambiente (FLUXO_TEST_POSTGRES / FIRESTORE_EMULATOR_HOST) FALHA, não pula (padrão PF-001).
// ROOT/requireEnv/parseTrx/tail vivem em dotnet-gate-common.mjs; aqui fica só o runner próprio.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NS_PADRAO, ROOT, parseTrx, requireEnv, tailOf } from './dotnet-gate-common.mjs';

export { ROOT, requireEnv };

const PROJECT = 'backend/tests/Exemplo SaaS.Api.Tests/Exemplo SaaS.Api.Tests.csproj';

/**
 * classes: { NomeDaClasse: { methods: [...], wholeClass: true|false } }
 * wholeClass=true filtra a classe inteira (todo teste dela precisa passar);
 * false filtra só os métodos nomeados (classe existente com testes antigos).
 */
export function runDotnetClasses(classes) {
  const filter = Object.entries(classes)
    .flatMap(([cls, { methods, wholeClass }]) => (wholeClass
      ? [`FullyQualifiedName~${NS_PADRAO}.${cls}.`]
      : methods.map((m) => `FullyQualifiedName~${NS_PADRAO}.${cls}.${m}`)))
    .join('|');
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv002-trx-'));
  try {
    const r = spawnSync('dotnet', [
      'test', PROJECT,
      '--filter', filter,
      '--logger', 'trx;LogFileName=gate.trx',
      '--results-directory', resultsDir,
      '--nologo',
    ], { cwd: ROOT, encoding: 'utf8', timeout: 115_000, maxBuffer: 16 * 1024 * 1024 });
    const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    assert.equal(r.error, undefined, `dotnet test não executou (${r.error?.message}):\n${tailOf(output, 80)}`);

    const trx = path.join(resultsDir, 'gate.trx');
    assert.ok(fs.existsSync(trx), `nenhum TRX gerado; nenhum teste foi descoberto ou o build falhou:\n${tailOf(output, 80)}`);
    const results = parseTrx(fs.readFileSync(trx, 'utf8'));

    const skipped = results.filter((t) => t.outcome !== 'Passed' && t.outcome !== 'Failed');
    assert.deepEqual(skipped.map((t) => `${t.name} (${t.outcome})`), [], 'testes pulados/não executados não contam como evidência');

    const missing = [];
    for (const [cls, { methods }] of Object.entries(classes)) {
      for (const m of methods) {
        const prefix = `${NS_PADRAO}.${cls}.${m}`;
        if (!results.some((t) => t.name === prefix || t.name.startsWith(`${prefix}(`))) missing.push(prefix);
      }
    }
    assert.deepEqual(missing, [], `testes requeridos não descobertos:\n${tailOf(output, 80)}`);

    const failed = results.filter((t) => t.outcome === 'Failed').map((t) => t.name);
    assert.deepEqual(failed, [], `testes falharam:\n${tailOf(output, 80)}`);
    assert.equal(r.status, 0, `dotnet test saiu com ${r.status}:\n${tailOf(output, 80)}`);
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
}

/** Roda um comando qualquer e exige exit 0. */
export function runOk(cmd, args, { cwd = ROOT, env = process.env, timeout = 90_000, label } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  assert.equal(r.error, undefined, `${label ?? cmd} não executou (${r.error?.message})`);
  assert.equal(r.status, 0, `${label ?? cmd} falhou:\n${tailOf(output, 80)}`);
  return output;
}

