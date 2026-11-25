// Gate EG-TEST-HYGIENE — testa test-hygiene.mjs (falsos positivos + dependências)
// Bootstrap primeiro: os stack roots vêm do perfil do exemplo (functions, quality, scripts…).
import '../bootstrap-example-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  collectFiles, scanFalsePositives, scanDependencies,
  getPubspecDeps, getPackageJsonDeps, getPyDeps,
  resolveRelative, PY_STDLIB, ROOT,
} from '../../delivery/test-hygiene.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'th-')));
}

function write(base, rel, content) {
  const abs = path.join(base, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function entry(base, rel) {
  return { abs: path.join(base, rel), rel };
}

function run(args) {
  const tool = path.resolve(ROOT, 'quality/delivery/test-hygiene.mjs');
  const r = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function ids(findings) {
  return findings.map((f) => f.id);
}

// ── A) Falsos positivos ───────────────────────────────────────────────────────

test('mock-sem-verificacao: vi.fn sem toHaveBeenCalled → detecta', () => {
  const dir = tmpDir();
  const src = `
import { vi } from 'vitest';
test('x', () => {
  const fn = vi.fn();
  fn(1);
  // sem asserção sobre o mock
});`;
  write(dir, 'x.test.ts', src);
  const f = scanFalsePositives(entry(dir, 'x.test.ts'));
  assert.ok(ids(f).includes('mock-sem-verificacao'), JSON.stringify(f));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mock-sem-verificacao: vi.fn com toHaveBeenCalled → não detecta', () => {
  const dir = tmpDir();
  const src = `
test('x', () => {
  const fn = vi.fn();
  fn(1);
  expect(fn).toHaveBeenCalledWith(1);
});`;
  write(dir, 'x.test.ts', src);
  assert.deepEqual(ids(scanFalsePositives(entry(dir, 'x.test.ts'))), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mock-sem-verificacao: arquivo de produção é ignorado', () => {
  const dir = tmpDir();
  write(dir, 'service.ts', "const fn = vi.fn(); fn();");
  assert.deepEqual(ids(scanFalsePositives(entry(dir, 'service.ts'))), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('catch-silenciado: catch vazio em teste JS → detecta', () => {
  const dir = tmpDir();
  write(dir, 'x.test.mjs', "test('y', () => { try { doIt(); } catch (e) {} });\n");
  const f = scanFalsePositives(entry(dir, 'x.test.mjs'));
  assert.ok(ids(f).includes('catch-silenciado'), JSON.stringify(f));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('catch-silenciado: catch com corpo real não detecta', () => {
  const dir = tmpDir();
  write(dir, 'x.test.mjs', "test('y', () => { try { doIt(); } catch (e) { assert.fail(e); } });\n");
  assert.deepEqual(ids(scanFalsePositives(entry(dir, 'x.test.mjs'))), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('catch-silenciado: catch vazio em teste Dart → detecta', () => {
  const dir = tmpDir();
  write(dir, 'a_test.dart', "void main() { try { act(); } catch (e) {} }\n");
  const f = scanFalsePositives(entry(dir, 'a_test.dart'));
  assert.ok(ids(f).includes('catch-silenciado'), JSON.stringify(f));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('expect-anything-dart: detecta pattern e não-detecta com matchers reais', () => {
  const dir = tmpDir();
  write(dir, 'a_test.dart', "test('x', () { expect(anything, anything); });\n");
  const bad = ids(scanFalsePositives(entry(dir, 'a_test.dart')));
  assert.ok(bad.includes('expect-anything-dart'), JSON.stringify(bad));

  write(dir, 'b_test.dart', "test('x', () { expect(result, equals('ok')); });\n");
  assert.deepEqual(ids(scanFalsePositives(entry(dir, 'b_test.dart'))), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('promise-stub-unchecked: mockResolvedValue sem deepEqual → detecta', () => {
  const dir = tmpDir();
  const src = `
test('x', async () => {
  const fn = vi.fn().mockResolvedValue(true);
  const result = await fn();
  expect(result).toBeTruthy();
});`;
  write(dir, 'x.test.ts', src);
  assert.ok(ids(scanFalsePositives(entry(dir, 'x.test.ts'))).includes('promise-stub-unchecked'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('promise-stub-unchecked: mockResolvedValue com toEqual → não detecta este padrão', () => {
  const dir = tmpDir();
  // vi.fn() com toHaveBeenCalledWith (satisfaz mock-sem-verificacao)
  // e mockResolvedValue com toEqual (satisfaz promise-stub-unchecked)
  const src = `
test('x', async () => {
  const fn = vi.fn().mockResolvedValue(true);
  const result = await fn(42);
  expect(fn).toHaveBeenCalledWith(42);
  expect(result).toEqual(true);
});`;
  write(dir, 'x.test.ts', src);
  assert.ok(!ids(scanFalsePositives(entry(dir, 'x.test.ts'))).includes('promise-stub-unchecked'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── B) Dependências — manifestos ──────────────────────────────────────────────

test('getPubspecDeps: lê flutter e dependências do pubspec.yaml', () => {
  const dir = tmpDir();
  write(dir, 'pubspec.yaml', `
name: test_app
dependencies:
  flutter:
    sdk: flutter
  http: ^1.0.0
  my_pkg: ^2.0.0
dev_dependencies:
  flutter_test:
    sdk: flutter
`);
  const deps = getPubspecDeps(dir);
  assert.ok(deps.has('flutter'));
  assert.ok(deps.has('http'));
  assert.ok(deps.has('my_pkg'));
  assert.ok(deps.has('flutter_test'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getPackageJsonDeps: lê dependencies + devDependencies', () => {
  const dir = tmpDir();
  write(dir, 'package.json', JSON.stringify({
    dependencies: { express: '^4.0.0' },
    devDependencies: { vitest: '^1.0.0' },
  }));
  const deps = getPackageJsonDeps(dir);
  assert.ok(deps.has('express'));
  assert.ok(deps.has('vitest'));
  assert.ok(!deps.has('nonexistent'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getPackageJsonDeps: diretório sem package.json retorna null', () => {
  const dir = tmpDir();
  assert.equal(getPackageJsonDeps(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getPyDeps: inclui stdlib e lê pyproject.toml', () => {
  const dir = tmpDir();
  write(dir, 'OCR_webscraper_crawler/python/pyproject.toml', `
[project]
name = "test"
dependencies = [
    "jsonschema>=4.0",
    "rfc3987>=1.3",
]

[dependency-groups]
dev = [
    "pytest>=8.0",
]
`);
  const deps = getPyDeps(dir);
  assert.ok(deps.has('os'));      // stdlib
  assert.ok(deps.has('json'));    // stdlib
  assert.ok(deps.has('jsonschema'));
  assert.ok(deps.has('rfc3987'));
  assert.ok(deps.has('pytest'));
  assert.ok(!deps.has('boto3'));  // não declarado
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── B) Dependências — resolução de imports relativos ─────────────────────────

test('resolveRelative: Dart encontra arquivo existente', () => {
  const dir = tmpDir();
  write(dir, 'lib/a/b.dart', '');
  const abs = path.join(dir, 'lib/a/c.dart');
  assert.ok(resolveRelative(abs, './b.dart', 'dart'));
  assert.ok(!resolveRelative(abs, './missing.dart', 'dart'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveRelative: TS tenta .ts e /index.ts', () => {
  const dir = tmpDir();
  write(dir, 'src/utils.ts', '');
  write(dir, 'src/helpers/index.ts', '');
  const abs = path.join(dir, 'src/service.ts');
  assert.ok(resolveRelative(abs, './utils', 'ts'));
  assert.ok(resolveRelative(abs, './helpers', 'ts'));
  assert.ok(!resolveRelative(abs, './nonexistent', 'ts'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveRelative: MJS com extensão explícita', () => {
  const dir = tmpDir();
  write(dir, 'lib/a.mjs', '');
  const abs = path.join(dir, 'lib/b.mjs');
  assert.ok(resolveRelative(abs, './a.mjs', 'mjs'));
  assert.ok(!resolveRelative(abs, './c.mjs', 'mjs'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── B) Dependências — scanDependencies por stack ─────────────────────────────

test('scanDependencies: Dart import relativo inexistente → detecta', () => {
  const dir = tmpDir();
  write(dir, 'pubspec.yaml', 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  const abs = write(dir, 'lib/a.dart', "import '../missing/file.dart';\n");
  const f = scanDependencies({ abs, rel: 'lib/a.dart' }, dir);
  assert.ok(ids(f).includes('import-relativo-inexistente'), JSON.stringify(f));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanDependencies: Dart import relativo existente → sem falso positivo', () => {
  const dir = tmpDir();
  write(dir, 'pubspec.yaml', 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  write(dir, 'lib/models/user.dart', '');
  const abs = write(dir, 'lib/services/auth.dart', "import '../models/user.dart';\n");
  const f = scanDependencies({ abs, rel: 'lib/services/auth.dart' }, dir);
  assert.deepEqual(ids(f).filter((i) => i === 'import-relativo-inexistente'), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanDependencies: Dart pacote não declarado → detecta', () => {
  const dir = tmpDir();
  write(dir, 'pubspec.yaml', 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  const abs = write(dir, 'lib/a.dart', "import 'package:unknown_pkg/unknown.dart';\n");
  const f = scanDependencies({ abs, rel: 'lib/a.dart' }, dir);
  assert.ok(ids(f).includes('pacote-nao-declarado'), JSON.stringify(f));
  assert.ok(f[0].msg.includes('unknown_pkg'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanDependencies: Dart pacote dart: é ignorado', () => {
  const dir = tmpDir();
  write(dir, 'pubspec.yaml', 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  const abs = write(dir, 'lib/a.dart', "import 'dart:async';\nimport 'dart:ui';\n");
  const f = scanDependencies({ abs, rel: 'lib/a.dart' }, dir);
  assert.deepEqual(ids(f), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanDependencies: TS import relativo inexistente → detecta com stack correto', () => {
  const dir = tmpDir();
  write(dir, 'functions/package.json', '{"dependencies":{}}');
  const abs = write(dir, 'functions/src/index.ts', "import { fn } from './missing';\n");
  const f = scanDependencies({ abs, rel: 'functions/src/index.ts' }, dir);
  assert.ok(ids(f).includes('import-relativo-inexistente'), JSON.stringify(f));
  assert.ok(f[0].msg.includes('TS'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanDependencies: TS pacote não declarado no package.json correto → detecta', () => {
  const dir = tmpDir();
  write(dir, 'functions/package.json', JSON.stringify({ dependencies: { lodash: '*' } }));
  const abs = write(dir, 'functions/src/index.ts', "import { x } from 'undeclared-lib';\n");
  const f = scanDependencies({ abs, rel: 'functions/src/index.ts' }, dir);
  assert.ok(ids(f).includes('pacote-nao-declarado'), JSON.stringify(f));
  assert.ok(f[0].msg.includes('undeclared-lib'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanDependencies: TS builtins node: ignorados', () => {
  const dir = tmpDir();
  write(dir, 'functions/package.json', '{"dependencies":{}}');
  const abs = write(dir, 'functions/src/util.ts', "import path from 'node:path';\nimport fs from 'node:fs';\n");
  const f = scanDependencies({ abs, rel: 'functions/src/util.ts' }, dir);
  assert.deepEqual(ids(f), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanDependencies: Python módulo não declarado → detecta', () => {
  const dir = tmpDir();
  write(dir, 'OCR_webscraper_crawler/python/pyproject.toml',
    '[project]\nname = "t"\ndependencies = [\n    "jsonschema>=4.0",\n]\n');
  const abs = write(dir, 'OCR_webscraper_crawler/python/src/main.py',
    'import jsonschema\nimport boto3\n');
  const f = scanDependencies({ abs, rel: 'OCR_webscraper_crawler/python/src/main.py' }, dir);
  const pnds = f.filter((x) => x.id === 'pacote-nao-declarado');
  assert.ok(pnds.some((x) => x.msg.includes('boto3')), JSON.stringify(pnds));
  assert.ok(!pnds.some((x) => x.msg.includes('jsonschema')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanDependencies: Python stdlib é ignorado', () => {
  const dir = tmpDir();
  write(dir, 'OCR_webscraper_crawler/python/pyproject.toml',
    '[project]\nname = "t"\ndependencies = []\n');
  const abs = write(dir, 'OCR_webscraper_crawler/python/src/util.py',
    'import os\nimport json\nimport re\nfrom pathlib import Path\n');
  const f = scanDependencies({ abs, rel: 'OCR_webscraper_crawler/python/src/util.py' }, dir);
  assert.deepEqual(ids(f), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── collectFiles ──────────────────────────────────────────────────────────────

test('collectFiles: respeita SKIP_DIRS e extensões', () => {
  const dir = tmpDir();
  write(dir, 'src/a.ts', '');
  write(dir, 'src/b.dart', '');
  write(dir, 'src/c.md', '');
  write(dir, 'node_modules/pkg/index.js', '');
  write(dir, 'build/output.ts', '');

  const files = collectFiles([dir], dir);
  const rels = files.map((f) => f.rel);
  assert.ok(rels.includes('src/a.ts'));
  assert.ok(rels.includes('src/b.dart'));
  assert.ok(!rels.some((r) => r.includes('node_modules')));
  assert.ok(!rels.some((r) => r.endsWith('.md')));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── CLI end-to-end ────────────────────────────────────────────────────────────

test('CLI: sai 0 quando não há problemas', () => {
  const dir = tmpDir();
  write(dir, 'src/index.ts', "export const x = 1;\n");
  const r = run(['--tests-only', dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(/nenhum problema/i.test(r.stdout));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI: sai 1 quando há falso positivo', () => {
  const dir = tmpDir();
  write(dir, 'src/x.test.ts', "const fn = jest.fn(); fn();\n");
  const r = run(['--tests-only', dir]);
  assert.equal(r.code, 1, r.stdout);
  assert.ok(r.stderr.includes('mock-sem-verificacao'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI: --deps-only ignora falsos positivos', () => {
  const dir = tmpDir();
  write(dir, 'src/x.test.ts', "const fn = jest.fn(); fn();\n");
  const r = run(['--deps-only', dir]);
  assert.equal(r.code, 0, r.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PY_STDLIB: contém módulos essenciais', () => {
  assert.ok(PY_STDLIB.has('os'));
  assert.ok(PY_STDLIB.has('json'));
  assert.ok(PY_STDLIB.has('sys'));
  assert.ok(PY_STDLIB.has('re'));
  assert.ok(PY_STDLIB.has('typing'));
});
