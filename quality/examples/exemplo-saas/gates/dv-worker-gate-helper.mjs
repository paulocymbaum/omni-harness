// Helper dos gates DV-003 (worker de ingestão em services/debate-worker).
// Roda o Vitest do pacote filtrado por marcadores de título e lê o relatório JSON.
// Cada marcador precisa casar com pelo menos um teste, e todo teste que casa precisa PASSAR:
// marcador ausente, teste pulado/todo ou falho reprova. Sem node_modules o gate falha, não pula.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const WORKER = path.join(ROOT, 'services/debate-worker');

export function requireWorkerDeps() {
  assert.ok(fs.existsSync(path.join(WORKER, 'package.json')), 'services/debate-worker/package.json ausente: o pacote do worker não existe');
  assert.ok(
    fs.existsSync(path.join(WORKER, 'node_modules/.bin/vitest')),
    'vitest ausente em services/debate-worker/node_modules (rode npm --prefix services/debate-worker ci); o gate falha em vez de pular',
  );
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Título do teste começa com o marcador e o marcador não continua (JOINER-GAP não casa JOINER-GAP-X). */
function matchesMarker(title, marker) {
  return new RegExp(`^${escapeRe(marker)}(?![\\w-])`).test(title);
}

/**
 * markers: ['DV-003 JOINER-GAP', ...]. Os títulos (último nível, `it`/`test`) começam pelo marcador.
 */
export function runVitestMarkers(markers, { timeout = 100_000 } = {}) {
  requireWorkerDeps();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv003-vitest-'));
  const outFile = path.join(outDir, 'report.json');
  try {
    const pattern = markers.map(escapeRe).join('|');
    const r = spawnSync(path.join(WORKER, 'node_modules/.bin/vitest'), [
      'run', '-t', pattern, '--reporter=json', `--outputFile=${outFile}`,
    ], { cwd: WORKER, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, CI: '1' } });
    const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    assert.equal(r.error, undefined, `vitest não executou (${r.error?.message}):\n${tail(output)}`);
    assert.ok(fs.existsSync(outFile), `vitest não gerou relatório JSON (build/coleta falhou?):\n${tail(output)}`);

    const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const all = (report.testResults ?? []).flatMap((f) => (f.assertionResults ?? []).map((a) => ({
      file: path.relative(WORKER, f.name ?? ''),
      title: a.title ?? '',
      status: a.status,
      failure: (a.failureMessages ?? []).join('\n'),
    })));

    const brokenFiles = (report.testResults ?? []).filter((f) => f.status === 'failed' && (f.assertionResults ?? []).length === 0);
    assert.deepEqual(brokenFiles.map((f) => `${f.name}: ${f.message ?? ''}`), [], 'arquivo de teste não carregou');

    const missing = [];
    const notPassed = [];
    for (const marker of markers) {
      const hits = all.filter((t) => matchesMarker(t.title, marker));
      if (hits.length === 0) { missing.push(marker); continue; }
      for (const t of hits) {
        if (t.status !== 'passed') notPassed.push(`${t.file} › ${t.title} (${t.status})${t.failure ? `\n${t.failure.slice(0, 1500)}` : ''}`);
      }
    }
    assert.deepEqual(missing, [], `testes Vitest com estes marcadores não foram descobertos:\n${tail(output, 40)}`);
    assert.deepEqual(notPassed, [], 'testes marcados falharam ou foram pulados (skip/todo não contam como evidência)');
    assert.equal(r.status, 0, `vitest saiu com ${r.status}:\n${tail(output)}`);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

/** Roda um comando de forma assíncrona (o event loop continua livre para servidores falsos locais). */
export function runAsync(cmd, args, { cwd = ROOT, env = process.env, timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeout);
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr, error }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

/** Roda um comando e exige exit 0. */
export function runOk(cmd, args, { cwd = ROOT, env = process.env, timeout = 90_000, label } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  assert.equal(r.error, undefined, `${label ?? cmd} não executou (${r.error?.message})`);
  assert.equal(r.status, 0, `${label ?? cmd} falhou:\n${tail(output)}`);
  return output;
}

export function tail(output, lines = 60) {
  return String(output).split('\n').slice(-lines).join('\n');
}
