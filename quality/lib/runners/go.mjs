import path from 'node:path';
import { repoRoot } from '../util.mjs';
import { PROFILE } from '../profile.mjs';
import { which } from '../tools.mjs';
import { result } from '../report.mjs';
import { step as stepBase, tail, parseColonDiag, parseLineList, classifyLintIssues, scanScope } from './common.mjs';

// ================================================================ Go (F2 — perfil: runnerGo; camada 'go')
// docs/parking-lot/runners-go-rust-cpp-csharp-java.md — falha aberta: sem `go` no hospedeiro,
// tool.missing com impacto; runners só rodam quando o perfil declara a camada 'go'.
const GO = PROFILE.runnerGo || {};
const CWD = GO.root || repoRoot();
// F6: cache/ambiente da toolchain vem do perfil (ex.: GOPROXY, GOCACHE) e alcança todos os passos.
const GO_ENV = GO.env || {};
// Wrapper transparente do step: mescla o env do perfil em qualquer chamada (mesma assinatura).
const step = (...a) => {
  const opts = a[5] || {};
  return stepBase(a[0], a[1], a[2], a[3], a[4], { ...opts, env: { ...GO_ENV, ...opts.env } });
};

const goScope = (entries) => scanScope(entries, GO.root, /\.go$|go\.mod$|go\.sum$/);

export const vetArgs = (packages) => ['vet', ...packages];

export const goTestArgs = (packages, race) => ['test', ...packages, '-count=1', ...(race ? ['-race'] : [])];

/** Pacote Go do arquivo alterado, relativo ao root (teste relacionado = pacote do arquivo). */
export function goPackages(files, root) {
  const base = (root || '').replace(/\/$/, '');
  const dirs = new Set();
  for (const f of files) {
    const dir = path.posix.dirname(f);
    const rel = base && dir.startsWith(`${base}/`) ? `./${dir.slice(base.length + 1)}` : `./${dir}`;
    dirs.add(dir === base || dir === '.' ? './...' : rel);
  }
  return [...dirs];
}

function packagesDoPerfil() {
  return GO.packages ? GO.packages.split(',').map((p) => p.trim()) : ['./...'];
}

export function goRoutine(entries, out, budget, full) {
  const scope = goScope(entries);
  if (!scope.length) return;
  const goFiles = scope.filter((e) => e.path.endsWith('.go'));
  if (!which('go')) {
    out.push(result('ferramentas', 'warn', 'tool.missing', { tool: 'go', impact: 'Formatação, vet e testes Go não medidos.' }));
    return;
  }
  goFmt(goFiles, out, budget);
  goVet(entries, out, budget);
  goTest(goFiles, out, budget, full);
  if (full && GO.golangci) goLangci(entries, out, budget);
}

/** `gofmt -l` nos arquivos alterados: saída não vazia = format.fail com a lista. */
function goFmt(goFiles, out, budget) {
  if (!goFiles.length) return;
  const sujos = [];
  for (let i = 0; i < goFiles.length; i += 100) {
    const chunk = goFiles.slice(i, i + 100).map((e) => e.path);
    const r = step(out, budget, 'gofmt -l', 'gofmt', ['-l', ...chunk], { cwd: CWD, capMs: 60_000 });
    if (!r) return;
    sujos.push(...parseLineList(r.stdout));
  }
  if (!sujos.length) {
    out.push(result('formato', 'pass', 'format.pass', { tool: 'gofmt', scope: `${goFiles.length} arquivo(s) Go` }));
    return;
  }
  out.push(result('formato', 'fail', 'format.fail', { tool: 'gofmt', files: sujos }));
}

/** `go vet` nos pacotes do perfil; diagnóstico vira lint.issue com foco nas linhas adicionadas. */
function goVet(entries, out, budget) {
  const packages = packagesDoPerfil();
  const r = step(out, budget, 'go vet', 'go', vetArgs(packages), { cwd: CWD, capMs: 180_000 });
  if (!r) return;
  const diags = parseColonDiag(r.stdout + r.stderr);
  if (diags.length) {
    out.push(...classifyLintIssues(entries, diags));
    return;
  }
  out.push(r.code === 0
    ? result('tipos', 'pass', 'vet.pass', { tool: 'go vet', scope: packages.join(' ') })
    : result('tipos', 'fail', 'vet.fail', { tool: 'go vet', scope: packages.join(' '), tail: tail(r.stdout + r.stderr) }));
}

/** Testes: pacotes alterados na iteração; suíte inteira (com -race opcional) no completo. */
function goTest(goFiles, out, budget, full) {
  const packages = full || !goFiles.length ? packagesDoPerfil() : goPackages(goFiles.map((e) => e.path), GO.root);
  const r = step(out, budget, 'go test', 'go', goTestArgs(packages, Boolean(GO.race) && full), { cwd: CWD, capMs: full ? 900_000 : 600_000 });
  if (!r) return;
  out.push(r.code === 0
    ? result('testes', 'pass', 'tests.pass', { scope: full ? 'Go' : 'Go pacotes alterados', detail: packages.join(' ') })
    : result('testes', 'fail', 'tests.fail', { scope: 'Go', detail: packages.join(' '), tail: tail(r.stdout + r.stderr) }));
}

/** golangci-lint é opt-in (runnerGo.golangci); ausente no hospedeiro = tool.delegated WARN. */
function goLangci(entries, out, budget) {
  if (!which('golangci-lint')) {
    out.push(result('ferramentas', 'warn', 'tool.delegated', { what: 'golangci-lint (Go)', reason: 'binário ausente', workflow: GO.workflow || 'CI do projeto' }));
    return;
  }
  const r = step(out, budget, 'golangci-lint run', 'golangci-lint', ['run', '--out-format=line-number', ...packagesDoPerfil()], { cwd: CWD, capMs: 400_000 });
  if (!r) return;
  const diags = parseColonDiag(r.stdout + r.stderr);
  if (diags.length) {
    out.push(...classifyLintIssues(entries, diags));
    return;
  }
  out.push(r.code === 0
    ? result('lint', 'pass', 'lint.pass', { tool: 'golangci-lint', scope: 'Go' })
    : result('lint', 'fail', 'lint.fail', { tool: 'golangci-lint', scope: 'Go', tail: tail(r.stdout + r.stderr) }));
}
