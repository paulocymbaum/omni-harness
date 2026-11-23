// Helper dos gates DV-008.
// - runSiteSpecs: copia specs do próprio gate (dv-008-vitest/*.vitest.ts) para ofluxo_site/src/__dv008_gate_<pid>__/,
//   roda Vitest e apaga. Todos os casos do template precisam passar.
// - runSiteNamedCases: casos escritos pelo implementador em ofluxo_site com o título exato (ausente/pulado = falha).
// - runDotnetGate8: copia a classe xUnit do gate para backend/tests/Fluxo.Api.Tests/ só durante o `dotnet test`.
// - runSmoke: Playwright de e2e/routes-smoke.spec.ts filtrado por rota, só chromium, sobre um build novo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireEnv, runDotnetClasses } from './dv-002-dotnet-helper.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SITE = path.join(ROOT, 'ofluxo_site');
const TEMPLATES = path.join(ROOT, 'quality/test/delivery/dv-008-vitest');
const DOTNET_TEMPLATES = path.join(ROOT, 'quality/test/delivery/dv-008-dotnet');
const TEST_PROJECT = path.join(ROOT, 'backend/tests/Fluxo.Api.Tests');
const ENV = { ...process.env, NODE_ENV: 'test', CI: '1' };

const tail = (text, max = 4000) => (text.length > max ? `…${text.slice(-max)}` : text);

function runVitest(relFiles) {
  const bin = path.join(SITE, 'node_modules/.bin/vitest');
  assert.ok(fs.existsSync(bin), 'ofluxo_site/node_modules/.bin/vitest ausente: rode npm --prefix ofluxo_site ci');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv008-vitest-'));
  const outFile = path.join(outDir, 'report.json');
  try {
    const r = spawnSync(bin, ['run', ...relFiles, '--reporter=json', `--outputFile=${outFile}`], {
      cwd: SITE, encoding: 'utf8', env: ENV, timeout: 110_000, maxBuffer: 16 * 1024 * 1024,
    });
    const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    assert.equal(r.error, undefined, `vitest não executou (${r.error?.message}):\n${tail(output)}`);
    assert.ok(fs.existsSync(outFile), `vitest não gerou relatório JSON:\n${tail(output)}`);
    const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const files = (report.testResults ?? []).map((f) => ({
      file: path.relative(SITE, f.name).split(path.sep).join('/'),
      status: f.status,
      message: f.message ?? '',
      cases: (f.assertionResults ?? []).map((a) => ({
        title: a.title, status: a.status, failure: (a.failureMessages ?? []).join('\n').slice(0, 1200),
      })),
    }));
    return { files, output };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

const describe = (f) => [`${f.file} [${f.status}] ${f.message.slice(0, 1200)}`,
  ...f.cases.filter((c) => c.status !== 'passed').map((c) => `  - ${c.title} [${c.status}] ${c.failure}`)].join('\n');

export function runSiteSpecs(templates) {
  const dirName = `__dv008_gate_${process.pid}__`;
  const dir = path.join(SITE, 'src', dirName);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const expected = new Map();
    for (const template of templates) {
      const text = fs.readFileSync(path.join(TEMPLATES, template), 'utf8');
      const target = template.replace(/\.vitest\.(tsx?)$/, '.test.$1');
      fs.writeFileSync(path.join(dir, target), text);
      expected.set(`src/${dirName}/${target}`, (text.match(/^\s*it\(/gm) ?? []).length);
    }
    const { files, output } = runVitest([...expected.keys()]);
    for (const [rel, count] of expected) {
      const f = files.find((x) => x.file === rel);
      assert.ok(f, `vitest não executou ${rel}:\n${tail(output)}`);
      const passed = f.cases.filter((c) => c.status === 'passed').length;
      assert.ok(count > 0 && passed === count && f.cases.length === count, `${rel}: ${passed}/${count} casos passaram\n${tail(describe(f))}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** casesByFile: { 'src/platform/...test.tsx': ['título exato', ...] } relativo a ofluxo_site. */
export function runSiteNamedCases(casesByFile) {
  const rels = Object.keys(casesByFile);
  assert.deepEqual(rels.filter((rel) => !fs.existsSync(path.join(SITE, rel))), [],
    'arquivos de teste do ofluxo_site exigidos pelo gate não existem');
  const { files, output } = runVitest(rels);
  const problems = [];
  for (const [rel, titles] of Object.entries(casesByFile)) {
    const f = files.find((x) => x.file === rel);
    if (!f) { problems.push(`${rel}: não executado`); continue; }
    if (f.status !== 'passed') problems.push(describe(f));
    for (const title of titles) {
      const c = f.cases.find((x) => x.title === title);
      if (!c) problems.push(`${rel}: caso ausente "${title}"`);
      else if (c.status !== 'passed') problems.push(`${rel}: "${title}" [${c.status}]`);
    }
  }
  assert.deepEqual(problems, [], `casos Vitest exigidos não passaram:\n${tail(output)}`);
}

export function runDotnetGate8(file, cls, { firestore = false } = {}) {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL descartável do módulo Debates');
  if (firestore) requireEnv('FIRESTORE_EMULATOR_HOST', 'emulador Firestore para o CPF verificado do leitor');
  const target = path.join(TEST_PROJECT, file);
  assert.ok(!fs.existsSync(target), `${path.relative(ROOT, target)} já existe: o gate não sobrescreve testes do implementador`);
  const source = fs.readFileSync(path.join(DOTNET_TEMPLATES, file), 'utf8');
  const methods = [...source.matchAll(/\[Fact[^\]]*\][^\n]*\n\s*public async Task (\w+)\(/g)].map((m) => m[1]);
  assert.ok(methods.length > 0, 'template .NET sem [Fact]');
  fs.writeFileSync(target, source);
  try {
    runDotnetClasses({ [cls]: { methods, wholeClass: true } });
  } finally {
    fs.rmSync(target, { force: true });
  }
}

/** Build de produção novo e Playwright só nos testes cujo título contém `grep`, projeto chromium-desktop. */
export function runSmoke(grep, minPassed) {
  const vite = path.join(SITE, 'node_modules/.bin/vite');
  const pw = path.join(SITE, 'node_modules/.bin/playwright');
  assert.ok(fs.existsSync(vite) && fs.existsSync(pw), 'vite/playwright ausentes em ofluxo_site/node_modules');
  const build = spawnSync(vite, ['build'], { cwd: SITE, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' },
    timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(build.status, 0, `vite build falhou:\n${tail(`${build.stdout}\n${build.stderr}`)}`);
  const r = spawnSync(pw, ['test', 'e2e/routes-smoke.spec.ts', '--project=chromium-desktop', '--grep', grep,
    '--reporter=json'], { cwd: SITE, encoding: 'utf8', env: ENV, timeout: 55_000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.error, undefined, `playwright não executou (${r.error?.message})`);
  let report;
  try { report = JSON.parse(r.stdout); } catch { assert.fail(`playwright sem relatório JSON:\n${tail(`${r.stdout}\n${r.stderr}`)}`); }
  const stats = report.stats ?? {};
  assert.ok((stats.expected ?? 0) >= minPassed && (stats.unexpected ?? 0) === 0 && (stats.skipped ?? 0) === 0,
    `smoke: ${JSON.stringify(stats)}\n${tail(r.stderr ?? '')}`);
}
