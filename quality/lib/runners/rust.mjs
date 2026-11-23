import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../util.mjs';
import { PROFILE } from '../profile.mjs';
import { which } from '../tools.mjs';
import { result } from '../report.mjs';
import { step, tail, parseColonDiag, classifyLintIssues, scanScope } from './common.mjs';

// ================================================================ Rust (F3 — perfil: runnerRust; camada 'rust')
// fmt/clippy/test; cargo audit opt-in no completo. Sem cargo no hospedeiro: tool.missing WARN.
const RUST = PROFILE.runnerRust || {};
const CWD = RUST.root || repoRoot();

export const rustScope = (entries) => scanScope(entries, RUST.root, /\.rs$|Cargo\.(toml|lock)$/);

export const clippyArgs = (extra) => ['clippy', '--all-targets', ...(extra || [])];

export const cargoTestArgs = (manifest) => (manifest ? ['test', '--manifest-path', manifest] : ['test']);

/** Cargo.toml mais próximo do arquivo alterado (workspace com vários pacotes); null = raiz. */
export function nearestManifest(file) {
  let rel = path.posix.dirname(file);
  while (rel !== '.' && rel !== '/') {
    if (fs.existsSync(path.join(CWD, rel, 'Cargo.toml'))) return path.join(rel, 'Cargo.toml');
    const pai = path.posix.dirname(rel);
    if (pai === rel) break;
    rel = pai;
  }
  return fs.existsSync(path.join(CWD, 'Cargo.toml')) ? 'Cargo.toml' : null;
}

export function rustRoutine(entries, out, budget, full) {
  if (!rustScope(entries).length) return;
  if (!which('cargo')) {
    out.push(result('ferramentas', 'warn', 'tool.missing', { tool: 'cargo', impact: 'fmt, clippy e testes Rust não medidos.' }));
    return;
  }
  cargoFmt(out, budget);
  cargoClippy(entries, out, budget);
  cargoTest(entries, out, budget, full);
  if (full && RUST.audit) cargoAudit(out, budget);
}

/** `cargo fmt --check`: diff não vazio = format.fail. */
function cargoFmt(out, budget) {
  const r = step(out, budget, 'cargo fmt --check', 'cargo', ['fmt', '--check'], { cwd: CWD, capMs: 60_000 });
  if (!r) return;
  out.push(r.code === 0
    ? result('formato', 'pass', 'format.pass', { tool: 'cargo fmt', scope: 'Rust' })
    : result('formato', 'fail', 'format.fail', { tool: 'cargo fmt', scope: 'Rust', tail: tail(r.stdout + r.stderr) }));
}

/** `cargo clippy --all-targets` (+ runnerRust.clippyArgs): warning em linha adicionada reprova. */
function cargoClippy(entries, out, budget) {
  const r = step(out, budget, 'cargo clippy', 'cargo', clippyArgs(RUST.clippyArgs), { cwd: CWD, capMs: 600_000 });
  if (!r) return;
  const diags = parseColonDiag(r.stdout + r.stderr);
  if (diags.length) {
    out.push(...classifyLintIssues(entries, diags));
    return;
  }
  out.push(r.code === 0
    ? result('lint', 'pass', 'lint.pass', { tool: 'cargo clippy', scope: 'Rust' })
    : result('lint', 'fail', 'lint.fail', { tool: 'cargo clippy', scope: 'Rust', tail: tail(r.stdout + r.stderr) }));
}

/** Testes: por pacote (manifest mais próximo) na iteração; inteiro com --all-features no completo. */
function cargoTest(entries, out, budget, full) {
  const manifests = new Set();
  if (!full) {
    for (const e of rustScope(entries)) {
      if (e.path.endsWith('.rs')) {
        const m = nearestManifest(e.path);
        if (m) manifests.add(m);
      }
    }
  }
  const alvos = full || !manifests.size ? [null] : [...manifests];
  for (const manifest of alvos) {
    const r = step(out, budget, 'cargo test', 'cargo', [...cargoTestArgs(manifest), ...(full ? ['--all-features'] : [])], { cwd: CWD, capMs: full ? 900_000 : 600_000 });
    if (!r) continue;
    out.push(r.code === 0
      ? result('testes', 'pass', 'tests.pass', { scope: manifest || 'Rust', detail: manifest ? 'pacote do arquivo alterado' : 'workspace' })
      : result('testes', 'fail', 'tests.fail', { scope: 'Rust', detail: manifest || 'workspace', tail: tail(r.stdout + r.stderr) }));
  }
}

/** `cargo audit` (RustSec) — opt-in (runnerRust.audit), só no completo. */
function cargoAudit(out, budget) {
  const r = step(out, budget, 'cargo audit', 'cargo', ['audit'], { cwd: CWD, capMs: 120_000 });
  if (!r) return;
  out.push(r.code === 0
    ? result('supply-chain', 'pass', 'osv.pass', { tool: 'cargo audit', scope: 'Rust' })
    : result('supply-chain', 'fail', 'osv.fail', { tool: 'cargo audit', scope: 'Rust', tail: tail(r.stdout + r.stderr) }));
}