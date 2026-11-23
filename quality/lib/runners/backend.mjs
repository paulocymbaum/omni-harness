import { run } from '../util.mjs';
import { PROFILE } from '../profile.mjs';
import { which } from '../tools.mjs';
import { result } from '../report.mjs';
import { step, tail } from './common.mjs';
import { workerFlags } from '../limits.mjs';
import { backendTestEnvironment } from './backend-env.mjs';

// ================================================================ backend .NET (perfil, R4-total)
const DOTNET = PROFILE.runnerDotnet || {};

/** Saída de `dotnet list package --vulnerable` menciona pacote vulnerável? (puro, testável) */
export function dotnetHasVulnerabilities(stdout) {
  return /has the following vulnerable packages|is vulnerable to/i.test(stdout);
}

export function backendRoutine(entries, out, budget, full) {
  const rootPrefix = DOTNET.root || 'backend/';
  if (!entries.some((e) => e.path.startsWith(rootPrefix) && /\.(cs|csproj|props|json)$/.test(e.path))) return;
  if (!DOTNET.solution) return; // projeto sem solution .NET declarada no perfil: nada a rodar
  if (!which('dotnet')) {
    out.push(result('ferramentas', 'warn', 'tool.delegated', { what: 'Build e testes do backend .NET', reason: 'dotnet SDK ausente', workflow: DOTNET.workflow || 'CI do projeto' }));
    return;
  }
  const sln = DOTNET.solution;
  const b = step(out, budget, 'dotnet build', 'dotnet', ['build', sln, '-c', 'Release', '-warnaserror', '-nologo', '-v', 'q', ...workerFlags().dotnetBuild], { capMs: 400_000 });
  if (!b) return;
  if (b.code !== 0) { out.push(result('tipos', 'fail', 'build.fail', { tool: 'dotnet build', scope: 'backend', tail: tail(b.stdout + b.stderr) })); return; }
  out.push(result('tipos', 'pass', 'build.pass', { tool: 'dotnet build -warnaserror', scope: 'backend' }));
  // F6 — gates finos de C# (opt-in pelo perfil): formato e supply chain nativo.
  if (DOTNET.format) {
    const f = step(out, budget, 'dotnet format', 'dotnet', ['format', sln, '--verify-no-changes', '--nologo'], { capMs: 300_000 });
    if (f) out.push(f.code === 0
      ? result('formato', 'pass', 'format.pass', { tool: 'dotnet format', scope: 'backend' })
      : result('formato', 'fail', 'format.fail', { tool: 'dotnet format', scope: 'backend', tail: tail(f.stdout + f.stderr) }));
  }
  if (DOTNET.vulnCheck) {
    const v = step(out, budget, 'dotnet list package --vulnerable', 'dotnet', ['list', sln, 'package', '--vulnerable', '--include-transitive', '--nologo'], { capMs: 180_000 });
    if (v) out.push(dotnetHasVulnerabilities(v.stdout)
      ? result('supply-chain', 'fail', 'osv.fail', { tool: 'dotnet list package --vulnerable', scope: 'backend' })
      : result('supply-chain', 'pass', 'osv.pass', { tool: 'dotnet list package --vulnerable', scope: 'backend' }));
  }
  const filter = DOTNET.testFilter;
  if (filter) {
    const r = step(out, budget, 'dotnet test', 'dotnet', ['test', sln, '-c', 'Release', '--no-build', '--filter', filter, '-nologo'], { capMs: 600_000, env: backendTestEnvironment() });
    if (r) out.push(r.code === 0
      ? result('testes', 'pass', 'tests.pass', { scope: 'backend', detail: filter })
      : result('testes', 'fail', 'tests.fail', { scope: 'backend', detail: filter, tail: tail(r.stdout + r.stderr) }));
  }
  if (full) out.push(result('ferramentas', 'warn', 'tool.delegated', { what: 'Integração PostgreSQL e migrator', reason: 'exigem PostgreSQL dedicado', workflow: DOTNET.workflow || 'CI do projeto' }));
}

export function infraRoutine(entries, out) {
  if (!entries.some((e) => /^infra\/.*\.tf$/.test(e.path))) return;
  if (!which('terraform')) {
    out.push(result('ferramentas', 'warn', 'tool.missing', { tool: 'terraform', impact: 'terraform fmt/validate não executados.' }));
    return;
  }
  const r = run('terraform', ['-chdir=infra/gcp/terraform', 'fmt', '-check', '-recursive'], { timeoutMs: 60_000 });
  out.push(r.code === 0
    ? result('formato', 'pass', 'format.pass', { file: 'infra/gcp/terraform' })
    : result('formato', 'fail', 'format.fail', { file: `infra/gcp/terraform (${r.stdout.trim().split('\n').join(', ')})` }));
}

/**
 * Supply chain (G2): lockfiles alterados passam pelo osv-scanner quando o binário existe
 * (exit 0 = sem vulnerabilidade conhecida; exit 1 = achou → fail; outro erro = unmeasured).
 * Sem o binário, segue com o aviso de ferramenta ausente (IGNORADO não é aprovação).
 */
export function supplyChain(entries, out) {
  const lockfiles = entries.filter((e) => e.status !== 'D' && /(?:package-lock\.json|pnpm-lock\.yaml|pubspec\.lock|uv\.lock)$/.test(e.path));
  const fonte = entries.some((e) => /(package\.json|pubspec\.yaml|\.csproj|pyproject\.toml)$/.test(e.path));
  if (!lockfiles.length && !fonte) return;
  if (!which('osv-scanner')) {
    out.push(result('ferramentas', 'warn', 'tool.missing', { tool: 'osv-scanner', impact: 'Vulnerabilidades de dependências não verificadas.' }));
    return;
  }
  if (!lockfiles.length) return;
  for (const e of lockfiles) {
    const r = run('osv-scanner', ['--lockfile', e.path], { encoding: 'utf8', timeout: 120_000 });
    if (r.status === 0) out.push(result('supply-chain', 'pass', 'osv.pass', { file: e.path }));
    else if (r.status === 1) out.push(result('supply-chain', 'fail', 'osv.fail', { file: e.path }));
    else out.push(result('supply-chain', 'warn', 'osv.unmeasured', { file: e.path, code: r.status }));
  }
}
