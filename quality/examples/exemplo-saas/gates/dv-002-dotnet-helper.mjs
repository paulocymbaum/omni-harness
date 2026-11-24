// Helper dos gates DV-002: roda `dotnet test` filtrado por classe/método e lê o TRX.
// Exige que cada método nomeado seja descoberto e passe, e recusa qualquer teste pulado.
// Integração sem ambiente (FLUXO_TEST_POSTGRES / FIRESTORE_EMULATOR_HOST) FALHA, não pula (padrão PF-001).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROJECT = 'backend/tests/Exemplo SaaS.Api.Tests/Exemplo SaaS.Api.Tests.csproj';
const NS = 'Exemplo SaaS.Api.Tests';

export function requireEnv(name, why) {
  assert.ok(
    typeof process.env[name] === 'string' && process.env[name].trim() !== '',
    `${name} não configurado (${why}); o gate falha em vez de pular`,
  );
}

/**
 * classes: { NomeDaClasse: { methods: [...], wholeClass: true|false } }
 * wholeClass=true filtra a classe inteira (todo teste dela precisa passar);
 * false filtra só os métodos nomeados (classe existente com testes antigos).
 */
export function runDotnetClasses(classes) {
  const filter = Object.entries(classes)
    .flatMap(([cls, { methods, wholeClass }]) => (wholeClass
      ? [`FullyQualifiedName~${NS}.${cls}.`]
      : methods.map((m) => `FullyQualifiedName~${NS}.${cls}.${m}`)))
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
    assert.equal(r.error, undefined, `dotnet test não executou (${r.error?.message}):\n${tail(output)}`);

    const trx = path.join(resultsDir, 'gate.trx');
    assert.ok(fs.existsSync(trx), `nenhum TRX gerado; nenhum teste foi descoberto ou o build falhou:\n${tail(output)}`);
    const results = parseTrx(fs.readFileSync(trx, 'utf8'));

    const skipped = results.filter((t) => t.outcome !== 'Passed' && t.outcome !== 'Failed');
    assert.deepEqual(skipped.map((t) => `${t.name} (${t.outcome})`), [], 'testes pulados/não executados não contam como evidência');

    const missing = [];
    for (const [cls, { methods }] of Object.entries(classes)) {
      for (const m of methods) {
        const prefix = `${NS}.${cls}.${m}`;
        if (!results.some((t) => t.name === prefix || t.name.startsWith(`${prefix}(`))) missing.push(prefix);
      }
    }
    assert.deepEqual(missing, [], `testes requeridos não descobertos:\n${tail(output)}`);

    const failed = results.filter((t) => t.outcome === 'Failed').map((t) => t.name);
    assert.deepEqual(failed, [], `testes falharam:\n${tail(output)}`);
    assert.equal(r.status, 0, `dotnet test saiu com ${r.status}:\n${tail(output)}`);
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
}

function parseTrx(xml) {
  const out = [];
  for (const [tag] of xml.matchAll(/<UnitTestResult\b[^>]*>/g)) {
    const name = tag.match(/\btestName="([^"]*)"/)?.[1];
    const outcome = tag.match(/\boutcome="([^"]*)"/)?.[1];
    if (name) out.push({ name: unescape(name), outcome: outcome ?? 'Unknown' });
  }
  return out;
}

function unescape(s) {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function tail(output, lines = 80) {
  return output.split('\n').slice(-lines).join('\n');
}

/** Roda um comando qualquer e exige exit 0. */
export function runOk(cmd, args, { cwd = ROOT, env = process.env, timeout = 90_000, label } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  assert.equal(r.error, undefined, `${label ?? cmd} não executou (${r.error?.message})`);
  assert.equal(r.status, 0, `${label ?? cmd} falhou:\n${tail(output)}`);
  return output;
}
