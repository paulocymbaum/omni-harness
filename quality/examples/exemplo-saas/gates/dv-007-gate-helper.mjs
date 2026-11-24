// Helper dos gates DV-007.
// - runGateSpecs7: copia specs do próprio gate (quality/test/delivery/dv-007-vitest/*.vitest.ts) para
//   admin-web/src/__dv007_gate_<pid>__/, roda Vitest e apaga. Todos os casos do template precisam passar.
// - runNamedCases (reexport do DV-006): casos escritos pelo implementador com título exato.
// - runDotnetGate: copia a classe xUnit do gate para backend/tests/Exemplo SaaS.Api.Tests/ só durante o `dotnet test`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, ADMIN, runNamedCases } from './dv-006-vitest-helper.mjs';
import { requireEnv, runDotnetClasses } from './dv-002-dotnet-helper.mjs';

export { ROOT, ADMIN, runNamedCases };
const TEMPLATES = path.join(ROOT, 'quality/test/delivery/dv-007-vitest');
const DOTNET_TEMPLATES = path.join(ROOT, 'quality/test/delivery/dv-007-dotnet');
const TEST_PROJECT = path.join(ROOT, 'backend/tests/Exemplo SaaS.Api.Tests');

const tail = (text, max = 4000) => (text.length > max ? `…${text.slice(-max)}` : text);

export function runGateSpecs7(templates) {
  const bin = path.join(ADMIN, 'node_modules/.bin/vitest');
  assert.ok(fs.existsSync(bin), 'admin-web/node_modules/.bin/vitest ausente: rode npm --prefix admin-web ci');
  const dirName = `__dv007_gate_${process.pid}__`;
  const dir = path.join(ADMIN, 'src', dirName);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv007-vitest-'));
  const outFile = path.join(outDir, 'report.json');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const expected = new Map();
    for (const template of templates) {
      const text = fs.readFileSync(path.join(TEMPLATES, template), 'utf8');
      const target = template.replace(/\.vitest\.(tsx?)$/, '.test.$1');
      fs.writeFileSync(path.join(dir, target), text);
      expected.set(`src/${dirName}/${target}`, (text.match(/^\s*it\(/gm) ?? []).length);
    }
    const r = spawnSync(bin, ['run', ...expected.keys(), '--reporter=json', `--outputFile=${outFile}`], {
      cwd: ADMIN, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', CI: '1' },
      timeout: 110_000, maxBuffer: 16 * 1024 * 1024,
    });
    const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    assert.equal(r.error, undefined, `vitest não executou (${r.error?.message}):\n${tail(output)}`);
    assert.ok(fs.existsSync(outFile), `vitest não gerou relatório JSON:\n${tail(output)}`);
    const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    for (const [rel, count] of expected) {
      const f = (report.testResults ?? []).find((x) => path.relative(ADMIN, x.name).split(path.sep).join('/') === rel);
      assert.ok(f, `vitest não executou ${rel}:\n${tail(output)}`);
      const cases = f.assertionResults ?? [];
      const passed = cases.filter((c) => c.status === 'passed').length;
      const detail = [f.message ?? '', ...cases.filter((c) => c.status !== 'passed')
        .map((c) => `  - ${c.title} [${c.status}] ${(c.failureMessages ?? []).join('\n').slice(0, 1200)}`)].join('\n');
      assert.ok(count > 0 && passed === count && cases.length === count, `${rel}: ${passed}/${count} casos passaram\n${tail(detail)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

export function runDotnetGate(file, cls) {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL descartável do módulo Debates');
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
