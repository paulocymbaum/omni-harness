// Gates F1–F6 (runners por stack) — docs/parking-lot/runners-go-rust-cpp-csharp-java.md.
// Parsers e montagens de comando são PUROS: testáveis sem a toolchain. As rotinas reais só
// rodam quando which() acha o binário; sem a tool, o caminho é tool.missing (falha aberta,
// nunca crash) — por isso os testes do caminho "sem tool" pulam quando o hospedeiro a tem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Budget, parseColonDiag, parseLineList, scanScope, classifyLintIssues } from '../lib/runners/common.mjs';
import { goPackages, goTestArgs, vetArgs, goRoutine } from '../lib/runners/go.mjs';
import { clippyArgs, cargoTestArgs, rustRoutine } from '../lib/runners/rust.mjs';
import { lintGoal, detectBuildTool, mavenTestArgs, javaRoutine } from '../lib/runners/java.mjs';
import { ctestArgs, cppRoutine } from '../lib/runners/cpp.mjs';
import { dotnetHasVulnerabilities } from '../lib/runners/backend.mjs';
import { which } from '../lib/tools.mjs';

const TEM_GO = Boolean(which('go'));
const TEM_CARGO = Boolean(which('cargo'));
const TEM_CMAKE = Boolean(which('cmake'));

// ---- F1: parsers compartilhados ----------------------------------------------
test('parseColonDiag: go vet (file:line:col: msg)', () => {
  assert.deepEqual(parseColonDiag('main.go:12:5: undefined: x\n'), [
    { file: 'main.go', line: 12, col: 5, severity: 'error', msg: 'undefined: x' },
  ]);
});

test('parseColonDiag: golangci line-number (file:line: msg, col null)', () => {
  assert.deepEqual(parseColonDiag('pkg/a.go:12: use of err'), [
    { file: 'pkg/a.go', line: 12, col: null, severity: 'error', msg: 'use of err' },
  ]);
});

test('parseColonDiag: rustc error[E0308] e clippy warning', () => {
  const diags = parseColonDiag('src/lib.rs:2:5: error[E0308]: mismatched types\nsrc/lib.rs:10:5: warning: unused variable `x`');
  assert.equal(diags.length, 2);
  assert.equal(diags[0].severity, 'error');
  assert.equal(diags[0].msg, 'mismatched types');
  assert.equal(diags[1].severity, 'warning');
});

test('parseColonDiag: ignora snippets do rustc (--> , linhas com espaço, vazias)', () => {
  const diags = parseColonDiag('--> src/lib.rs:2:5\n   |        ^ expected\n\n12 | let x = 1;\nsrc/lib.rs:2:5: real');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].msg, 'real');
});

test('parseLineList: gofmt -l com linhas vazias', () => {
  assert.deepEqual(parseLineList('a.go\nb.go\n\n'), ['a.go', 'b.go']);
  assert.deepEqual(parseLineList(''), []);
});

test('scanScope: só arquivos vivos sob o root do perfil', () => {
  const entries = [
    { path: 'backend/x.go', status: 'M' },
    { path: 'lib/y.go', status: 'M' },
    { path: 'backend/z.go', status: 'D' },
    { path: 'backend/w.rs', status: 'M' },
  ];
  assert.deepEqual(scanScope(entries, 'backend', /\.go$/).map((e) => e.path), ['backend/x.go']);
});

test('classifyLintIssues: linha adicionada reprova; fora é warn (legacy)', () => {
  const entries = [{ path: 'a.go', status: 'M', added: [{ line: 3 }] }];
  const [hit, legacy] = classifyLintIssues(entries, [
    { file: 'a.go', line: 3, msg: 'novo' },
    { file: 'a.go', line: 99, msg: 'antigo' },
  ]);
  assert.equal(hit.status, 'fail');
  assert.equal(hit.key, 'lint.issue');
  assert.equal(legacy.status, 'warn');
  assert.equal(legacy.key, 'lint.issue');
});

// ---- F2: Go ------------------------------------------------------------------
test('goPackages: pacote relativo ao root; raiz vira ./...', () => {
  assert.deepEqual(goPackages(['backend/foo/a.go'], 'backend'), ['./foo']);
  assert.deepEqual(goPackages(['b/c/x.go'], ''), ['./b/c']);
  assert.deepEqual(goPackages(['main.go'], ''), ['./...']);
});

test('goTestArgs/vetArgs: -race só quando ligado', () => {
  assert.deepEqual(vetArgs(['./...']), ['vet', './...']);
  assert.deepEqual(goTestArgs(['./a'], true), ['test', './a', '-count=1', '-race']);
  assert.deepEqual(goTestArgs(['./a'], false), ['test', './a', '-count=1']);
});

test('goRoutine sem Go: só tool.missing (fail-open, nada derruba)', { skip: TEM_GO ? 'Go instalado neste hospedeiro — caminho tool.missing não aplicável' : false }, () => {
  const out = [];
  goRoutine([{ path: 'backend/x.go', status: 'M', added: [] }], out, new Budget(60_000));
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'tool.missing');
  assert.equal(out[0].params.tool, 'go');
});

test('goRoutine inerte fora da stack (nenhum passo, nenhum aviso)', () => {
  const out = [];
  goRoutine([{ path: 'lib/a.dart', status: 'M', added: [] }], out, new Budget(60_000));
  assert.deepEqual(out, []);
});

// ---- F3: Rust ----------------------------------------------------------------
test('clippyArgs/cargoTestArgs: extras do perfil e manifest do workspace', () => {
  assert.deepEqual(clippyArgs(['-W', 'clippy::pedantic']), ['clippy', '--all-targets', '-W', 'clippy::pedantic']);
  assert.deepEqual(cargoTestArgs('pkg/Cargo.toml'), ['test', '--manifest-path', 'pkg/Cargo.toml']);
  assert.deepEqual(cargoTestArgs(null), ['test']);
});

test('rustRoutine sem cargo: só tool.missing', { skip: TEM_CARGO ? 'Cargo instalado neste hospedeiro' : false }, () => {
  const out = [];
  rustRoutine([{ path: 'src/lib.rs', status: 'M', added: [] }], out, new Budget(60_000));
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'tool.missing');
  assert.equal(out[0].params.tool, 'cargo');
});

test('rustRoutine inerte fora da stack', () => {
  const out = [];
  rustRoutine([{ path: 'x.py', status: 'M', added: [] }], out, new Budget(60_000));
  assert.deepEqual(out, []);
});

// ---- F4: Java ----------------------------------------------------------------
test('lintGoal: goals Maven e tasks Gradle; tool fora da lista = null', () => {
  assert.equal(lintGoal('spotless', 'maven'), 'spotless:check');
  assert.equal(lintGoal('spotbugs', 'maven'), 'spotbugs:check');
  assert.equal(lintGoal('spotless', 'gradle'), 'spotlessCheck');
  assert.equal(lintGoal('checkstyle', 'gradle'), 'checkstyleMain');
  assert.equal(lintGoal('desconhecido', 'maven'), null);
});

test('detectBuildTool: wrapper primeiro, binário global depois, nada = null', () => {
  const soMvnw = (p) => p.endsWith('pom.xml') || p.endsWith('mvnw');
  assert.deepEqual(detectBuildTool(soMvnw, () => false), { tool: 'maven', cmd: './mvnw' });
  const soPom = (p) => p.endsWith('pom.xml');
  assert.deepEqual(detectBuildTool(soPom, (t) => t === 'mvn'), { tool: 'maven', cmd: 'mvn' });
  const soGradle = (p) => p.endsWith('build.gradle');
  assert.equal(detectBuildTool(soGradle, () => false).cmd, null);
  assert.equal(detectBuildTool(() => false, () => false), null);
});

test('mavenTestArgs: módulos tocados viram -pl lista -am', () => {
  assert.deepEqual(mavenTestArgs(['svc-a', 'svc-b']), ['-pl', 'svc-a,svc-b', '-am', 'test']);
  assert.deepEqual(mavenTestArgs([]), ['test']);
});

test('javaRoutine sem pom.xml nem build.gradle: tool.delegated com workflow', () => {
  const out = [];
  javaRoutine([{ path: 'svc/X.java', status: 'M', added: [] }], out, new Budget(60_000));
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'tool.delegated');
  assert.ok(out[0].params.reason.includes('pom.xml'));
});

test('javaRoutine inerte fora da stack', () => {
  const out = [];
  javaRoutine([{ path: 'x.go', status: 'M', added: [] }], out, new Budget(60_000));
  assert.deepEqual(out, []);
});

// ---- F5: C++ -----------------------------------------------------------------
test('ctestArgs: -R só com regex; --test-dir sempre', () => {
  assert.deepEqual(ctestArgs('build', null), ['--test-dir', 'build', '--output-on-failure']);
  assert.deepEqual(ctestArgs('build', 'mod.*'), ['--test-dir', 'build', '--output-on-failure', '-R', 'mod.*']);
});

test('cppRoutine sem cmake: só tool.missing', { skip: TEM_CMAKE ? 'CMake instalado neste hospedeiro' : false }, () => {
  const out = [];
  cppRoutine([{ path: 'src/a.cpp', status: 'M', added: [] }], out, new Budget(60_000));
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'tool.missing');
  assert.equal(out[0].params.tool, 'cmake');
});

test('cppRoutine inerte fora da stack', () => {
  const out = [];
  cppRoutine([{ path: 'x.dart', status: 'M', added: [] }], out, new Budget(60_000));
  assert.deepEqual(out, []);
});

// ---- F6: C# fino -------------------------------------------------------------
test('dotnetHasVulnerabilities: detecta o verbete da saída real; saída limpa = false', () => {
  assert.equal(dotnetHasVulnerabilities('Project Backend has the following vulnerable packages\n   > Newtonsoft.Json 12.0.1 [Transitive]'), true);
  assert.equal(dotnetHasVulnerabilities('Project Backend is vulnerable to CVE-2021-1'), true);
  assert.equal(dotnetHasVulnerabilities('Project\n-----------------\nBackend\n\nNo vulnerable packages were found.'), false);
});
