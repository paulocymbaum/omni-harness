import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../util.mjs';
import { PROFILE } from '../profile.mjs';
import { which } from '../tools.mjs';
import { result } from '../report.mjs';
import { step, tail, parseColonDiag, classifyLintIssues, scanScope } from './common.mjs';

// ================================================================ C++ (F5 — perfil: runnerCpp; camada 'cpp')
// CMake + Ninja/Make via `cmake --build`, CTest para testes, LLVM para fmt/lint. clang-tidy só
// nos fontes alterados (nunca o projeto inteiro no rotina); sanitizers (preset asan) no completo.
const CPP = PROFILE.runnerCpp || {};
const CWD = CPP.root || repoRoot();

const RE_FONTE = /\.(cc|cpp|cxx|c)$/;
const RE_QUALQUER = /\.(cc|cpp|cxx|c|h|hpp)$|CMakeLists\.txt$/;

export const cppScope = (entries) => scanScope(entries, CPP.root, RE_QUALQUER);

export const ctestArgs = (buildDir, regex) => ['--test-dir', buildDir, '--output-on-failure', ...(regex ? ['-R', regex] : [])];

const buildDir = () => CPP.buildDir || 'build';

export function cppRoutine(entries, out, budget, full) {
  const scope = cppScope(entries);
  if (!scope.length) return;
  if (!which('cmake')) {
    out.push(result('ferramentas', 'warn', 'tool.missing', { tool: 'cmake', impact: 'Build e testes C++ não medidos.' }));
    return;
  }
  cppFmt(scope, out, budget);
  const dir = buildDir();
  if (cppBuild(scope, out, budget, dir)) cppTest(scope, out, budget, dir, full);
  cppTidy(scope, out, budget, dir);
  if (full && CPP.presets && CPP.presets.asan) asanRoutine(out, budget);
}

/** clang-format --dry-run -Werror nos arquivos alterados (fontes e headers), em fatias de 50. */
function cppFmt(scope, out, budget) {
  if (!which('clang-format')) {
    out.push(result('ferramentas', 'warn', 'tool.delegated', { what: 'clang-format (C++)', reason: 'binário ausente', workflow: CPP.workflow || 'CI do projeto' }));
    return;
  }
  const arquivos = scope.filter((e) => RE_QUALQUER.test(e.path) && !e.path.endsWith('CMakeLists.txt')).map((e) => e.path);
  for (let i = 0; i < arquivos.length; i += 50) {
    const chunk = arquivos.slice(i, i + 50);
    const r = step(out, budget, 'clang-format --dry-run', 'clang-format', ['--dry-run', '-Werror', '--style=file', ...chunk], { cwd: CWD, capMs: 120_000 });
    if (!r) return;
    if (r.code !== 0) {
      out.push(result('formato', 'fail', 'format.fail', { tool: 'clang-format', files: chunk, tail: tail(r.stderr, 10) }));
      return;
    }
  }
  out.push(result('formato', 'pass', 'format.pass', { tool: 'clang-format', scope: `${arquivos.length} arquivo(s) C++` }));
}

/** Configure do CMake (só quando CMakeLists mudou ou não há cache). Devolve true para seguir. */
function cppConfigure(scope, out, budget, dir) {
  const mudouCMake = scope.some((e) => e.path.endsWith('CMakeLists.txt'));
  const semCache = !fs.existsSync(path.join(CWD, dir, 'CMakeCache.txt'));
  if (!mudouCMake && !semCache) return true;
  const c = step(out, budget, 'cmake configure', 'cmake', ['-S', '.', '-B', dir, '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON', ...(CPP.cmakeArgs || [])], { cwd: CWD, capMs: 300_000 });
  if (!c) return false;
  if (c.code !== 0) out.push(result('tipos', 'fail', 'build.fail', { tool: 'cmake configure', scope: 'C++', tail: tail(c.stdout + c.stderr) }));
  return c.code === 0;
}

/** Configure (se preciso) + `cmake --build --parallel`. Devolve true se o build passou. */
function cppBuild(scope, out, budget, dir) {
  if (!cppConfigure(scope, out, budget, dir)) return false;
  const b = step(out, budget, 'cmake --build', 'cmake', ['--build', dir, '--parallel'], { cwd: CWD, capMs: 600_000 });
  if (!b) return false;
  out.push(b.code === 0
    ? result('tipos', 'pass', 'build.pass', { tool: 'cmake --build', scope: 'C++' })
    : result('tipos', 'fail', 'build.fail', { tool: 'cmake --build', scope: 'C++', tail: tail(b.stdout + b.stderr) }));
  return b.code === 0;
}

/** CTest: sempre no completo; na iteração só quando fonte/CMakeLists mudou. runnerCpp.testRegex restringe. */
function cppTest(scope, out, budget, dir, full) {
  const fonteMudou = scope.some((e) => RE_FONTE.test(e.path) || e.path.endsWith('CMakeLists.txt'));
  if (!full && !fonteMudou) return;
  if (!which('ctest')) {
    out.push(result('ferramentas', 'warn', 'tool.missing', { tool: 'ctest', impact: 'Testes C++ não executados.' }));
    return;
  }
  const r = step(out, budget, 'ctest', 'ctest', ctestArgs(dir, !full && CPP.testRegex ? CPP.testRegex : null), { cwd: CWD, capMs: 600_000 });
  if (!r) return;
  out.push(r.code === 0
    ? result('testes', 'pass', 'tests.pass', { scope: 'C++', detail: CPP.testRegex && !full ? CPP.testRegex : 'suite' })
    : result('testes', 'fail', 'tests.fail', { scope: 'C++', tail: tail(r.stdout + r.stderr) }));
}

/** clang-tidy arquivo a arquivo, só nos fontes alterados; warning em linha adicionada reprova. */
function cppTidy(scope, out, budget, dir) {
  if (!CPP.tidy) return;
  if (!which('clang-tidy')) {
    out.push(result('ferramentas', 'warn', 'tool.delegated', { what: 'clang-tidy (C++)', reason: 'binário ausente', workflow: CPP.workflow || 'CI do projeto' }));
    return;
  }
  const fontes = scope.filter((e) => RE_FONTE.test(e.path)).map((e) => e.path);
  let medido = 0;
  for (const arquivo of fontes) {
    const r = step(out, budget, `clang-tidy ${arquivo}`, 'clang-tidy', ['-p', dir, arquivo], { cwd: CWD, capMs: 240_000 });
    if (!r) continue;
    medido++;
    const diags = parseColonDiag(r.stdout + r.stderr);
    if (diags.length) out.push(...classifyLintIssues(scope, diags));
  }
  if (medido) out.push(result('lint', 'pass', 'lint.pass', { tool: 'clang-tidy', scope: `${medido}/${fontes.length} arquivo(s)` }));
}

/** Sanitizers (ASan+UBSan) via preset do projeto — só no completo; teste que estoura sanitizer reprova. */
function asanRoutine(out, budget) {
  const c = step(out, budget, 'cmake --preset asan', 'cmake', ['--preset', CPP.presets.asan], { cwd: CWD, capMs: 300_000 });
  if (!c) return;
  if (c.code !== 0) {
    out.push(result('tipos', 'fail', 'build.fail', { tool: 'cmake --preset asan', scope: 'C++ sanitizers', tail: tail(c.stdout + c.stderr) }));
    return;
  }
  const t = step(out, budget, 'ctest --preset asan', 'ctest', ['--preset', CPP.presets.asan, '--output-on-failure'], { cwd: CWD, capMs: 900_000 });
  if (!t) return;
  out.push(t.code === 0
    ? result('testes', 'pass', 'tests.pass', { scope: 'C++ sanitizers (ASan+UBSan)' })
    : result('testes', 'fail', 'tests.fail', { scope: 'C++ sanitizers (ASan+UBSan)', tail: tail(t.stdout + t.stderr) }));
}
