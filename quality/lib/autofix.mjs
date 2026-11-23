// Autocorreção e lint leves de UM arquivo de gate ou de teste (chamado pelo hook post-edit e por `run.mjs --fix`).
// Princípios: só correções mecânicas e seguras; erro de sintaxe NÃO é reescrito, volta ao agente com linha/coluna.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, run, repoRoot, QUALITY_DIR } from './util.mjs';
import { PROFILE } from './profile.mjs';
import { envOff } from './env.mjs';
import { matchAny } from './glob.mjs';
import { which } from './tools.mjs';
import { fileAtRev } from './git.mjs';
import { t } from './messages.mjs';

// Escopo de gate/teste: globs do core (config/autofix.json) + globs de PROJETO do perfil (R1).
const BASE_AUTOFIX = loadConfig('autofix');
const CFG = { ...BASE_AUTOFIX, include: BASE_AUTOFIX.include.concat(PROFILE.autofix.include || []) };
const BIOME = path.join(QUALITY_DIR, 'tools', 'node_modules', '.bin', 'biome');
const BIOME_CFG = path.join(QUALITY_DIR, 'tools');
const MAX_LINES = 6;

export function autofixApplies(rel) {
  if (envOff('AUTOFIX')) return false;
  return matchAny(rel, CFG.include) && !matchAny(rel, CFG.exclude);
}

export const maxFailures = () => CFG.maxConsecutiveFailures ?? 3;

const head = (s) => s.split('\n').filter((l) => l.trim()).slice(0, MAX_LINES).join('\n');

/** CRLF → LF e newline final: seguros em qualquer texto (não mexe em espaços dentro de literais). */
export function normalizeText(text) {
  let out = text.replace(/\r\n/g, '\n');
  if (out.length > 0 && !out.endsWith('\n')) out += '\n';
  return out;
}

function nodeSyntax(abs) {
  const r = run(process.execPath, ['--check', abs], { timeoutMs: 15_000 });
  if (r.code === 0 || r.missing || r.timedOut) return null;
  return head(r.stderr.replace(new RegExp(abs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), path.basename(abs)));
}

function jsonSyntax(text) {
  try { JSON.parse(text); return null; } catch (e) { return String(e.message).split('\n')[0]; }
}

/** Erros de lint (severidade error) de um arquivo em disco, via reporter github (uma linha por diagnóstico). */
function biomeErrors(abs, label) {
  const r = run(BIOME, ['lint', `--config-path=${BIOME_CFG}`, '--colors=off', '--reporter=github', abs], { timeoutMs: 15_000 });
  if (r.missing || r.timedOut) return null;
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('::error'));
  // Código ≠ 0 sem diagnóstico = a ferramenta falhou (config inválida etc.): nunca tratar como "limpo".
  if (r.code !== 0 && lines.length === 0 && !r.stdout.includes('::warning')) return { count: 0, broken: head(r.stdout + r.stderr) };
  const text = lines.slice(0, MAX_LINES).map((l) => {
    const m = /title=([^,]+),.*?line=(\d+).*?col=(\d+)[^:]*::(.*)$/.exec(l);
    return m ? `${label}:${m[2]}:${m[3]} ${m[1]} — ${m[4]}` : l;
  }).join('\n');
  return { count: lines.length, text };
}

function oldLintCount(old, rel) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfix-'));
  try {
    const f = path.join(dir, path.basename(rel));
    fs.writeFileSync(f, old);
    return biomeErrors(f, rel)?.count ?? 0;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function biomeStep(abs, rel, root, res) {
  if (!fs.existsSync(BIOME)) { res.notes.push('lint ignorado: biome ausente (cd quality/tools && npm install)'); return; }
  const before = fs.readFileSync(abs, 'utf8');
  run(BIOME, ['lint', '--write', `--config-path=${BIOME_CFG}`, '--colors=off', abs], { timeoutMs: 20_000 });
  const after = fs.readFileSync(abs, 'utf8');
  if (after !== before) res.fixed.push('lint: correções seguras do biome aplicadas');
  const now = biomeErrors(abs, rel);
  if (now?.broken) { res.errors.push(`biome falhou (config/ferramenta), lint não verificado:\n${now.broken}`); return; }
  if (!now || now.count === 0) return;
  const old = fileAtRev('HEAD', rel, root);
  const was = old == null ? 0 : oldLintCount(old, rel);
  if (now.count > was) res.errors.push(`lint: ${now.count} erro(s) (HEAD: ${was}):\n${now.text}`);
  else res.notes.push(`lint: ${now.count} erro(s) legado(s) mantido(s)`);
}

function dartStep(abs, rel, root, res) {
  if (!which('dart')) return;
  const before = fs.readFileSync(abs, 'utf8');
  const probe = run('dart', ['format', '--output=none', '--set-exit-if-changed', abs], { timeoutMs: 30_000 });
  if (probe.code === 0 || probe.missing || probe.timedOut) return;
  if (probe.code !== 1) { res.errors.push(`sintaxe Dart:\n${head(probe.stderr || probe.stdout)}`); return; }
  const old = fileAtRev('HEAD', rel, root);
  if (old != null) { // ratchet: arquivo legado já fora do formato não é reformatado inteiro
    const was = run('dart', ['format', '--output=none', '--set-exit-if-changed', `--stdin-name=${rel}`], { input: old, timeoutMs: 30_000 });
    if (was.code !== 0) return;
  }
  run('dart', ['format', abs], { timeoutMs: 30_000 });
  if (fs.readFileSync(abs, 'utf8') !== before) res.fixed.push('dart format aplicado');
}

/** @returns {{fixed: string[], errors: string[], notes: string[]}} */
export function autofixFile(rel, root = repoRoot()) {
  const res = { fixed: [], errors: [], notes: [] };
  const abs = path.join(root, rel);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return res; }
  const isDart = rel.endsWith('.dart');
  if (!isDart) {
    const norm = normalizeText(text);
    if (norm !== text) { fs.writeFileSync(abs, norm); res.fixed.push('EOL/newline final normalizados'); text = norm; }
  }
  if (rel.endsWith('.json')) {
    const err = jsonSyntax(text);
    if (err) res.errors.push(`JSON inválido: ${err}`);
    return res;
  }
  if (isDart) { dartStep(abs, rel, root, res); return res; }
  const syntax = nodeSyntax(abs);
  if (syntax) { res.errors.push(`sintaxe:\n${syntax}`); return res; }
  biomeStep(abs, rel, root, res);
  return res;
}

/** Contador de falhas consecutivas por arquivo (na sessão): depois do teto, avisa em vez de bloquear. */
export function judgeWithGuard(session, rel, res) {
  session.autofixFails ??= {};
  if (res.errors.length === 0) { delete session.autofixFails[rel]; return { block: false, exhausted: false }; }
  const n = (session.autofixFails[rel] ?? 0) + 1;
  session.autofixFails[rel] = n;
  return n > maxFailures() ? { block: false, exhausted: true } : { block: true, exhausted: false };
}

/**
 * Ponto único para os dois hosts (Claude post-edit e Cline PostToolUse): roda a autocorreção, aplica a trava
 * de falhas e devolve { block, messages } já em texto. `session` é mutado; quem chama grava.
 */
export function autofixReport(rel, session, root = repoRoot()) {
  if (!autofixApplies(rel)) return { block: false, messages: [], errors: [] };
  const fx = autofixFile(rel, root);
  const verdict = judgeWithGuard(session, rel, fx);
  const messages = [];
  if (fx.fixed.length) messages.push(t('hook.autofix.fixed', { file: rel, what: fx.fixed.join('; ') }));
  if (verdict.exhausted) messages.push(t('hook.autofix.exhausted', { file: rel, max: maxFailures() }));
  const errors = verdict.block ? [t('hook.autofix.fail', { file: rel }), ...fx.errors] : [];
  return { block: verdict.block, messages, errors };
}
