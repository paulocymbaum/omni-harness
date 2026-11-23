// Helper dos gates DV-009.
// - runDotnetWithTemplate: copia a classe xUnit do gate (dv-009-dotnet/) para backend/tests/Fluxo.Api.Tests/ só durante
//   o `dotnet test`, roda junto com as classes nomeadas do implementador (um build só) e remove a cópia.
// - runFakeGcloud: roda um script de deploy com um `gcloud` falso no PATH que só grava os argumentos (nada vai à rede).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, requireEnv, runDotnetClasses } from './dv-002-dotnet-helper.mjs';

export { ROOT };
const DOTNET_TEMPLATES = path.join(ROOT, 'quality/test/delivery/dv-009-dotnet');
const TEST_PROJECT = path.join(ROOT, 'backend/tests/Fluxo.Api.Tests');

export function runDotnetWithTemplate(file, cls, named = {}, { firestore = false } = {}) {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL descartável do módulo Debates');
  if (firestore) requireEnv('FIRESTORE_EMULATOR_HOST', 'emulador Firestore para o CPF verificado do leitor');
  const target = path.join(TEST_PROJECT, file);
  assert.ok(!fs.existsSync(target), `${path.relative(ROOT, target)} já existe: o gate não sobrescreve testes do implementador`);
  const source = fs.readFileSync(path.join(DOTNET_TEMPLATES, file), 'utf8');
  const methods = [...source.matchAll(/\[Fact[^\]]*\][^\n]*\n\s*public async Task (\w+)\(/g)].map((m) => m[1]);
  assert.ok(methods.length > 0, 'template .NET sem [Fact]');
  const classes = Object.fromEntries(Object.entries(named).map(([c, ms]) => [c, { methods: ms, wholeClass: true }]));
  classes[cls] = { methods, wholeClass: true };
  fs.writeFileSync(target, source);
  try {
    runDotnetClasses(classes);
  } finally {
    fs.rmSync(target, { force: true });
  }
}

export function runFakeGcloud(script, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv009-gcloud-'));
  const log = path.join(dir, 'calls.log');
  try {
    fs.writeFileSync(path.join(dir, 'gcloud'), `#!/usr/bin/env bash\nprintf '%s\\0' "$@" >> "${log}"\nprintf '\\n' >> "${log}"\n`);
    fs.chmodSync(path.join(dir, 'gcloud'), 0o755);
    const r = spawnSync('bash', [path.join(ROOT, script), ...args], {
      cwd: ROOT, encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    const calls = fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\0').filter((x) => x !== ''))
      : [];
    return { status: r.status, stderr: r.stderr ?? '', calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
