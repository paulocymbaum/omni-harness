import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv, isLimited } from './limits.mjs';

export const QUALITY_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Raiz do repositório avaliado. QUALITY_ROOT permite apontar para um repo de teste. */
export function repoRoot() {
  return process.env.QUALITY_ROOT || path.dirname(QUALITY_DIR);
}

export function stateDir() {
  return process.env.QUALITY_STATE_DIR || path.join(repoRoot(), 'quality', '.state');
}

export function loadConfig(name) {
  return JSON.parse(fs.readFileSync(path.join(QUALITY_DIR, 'config', `${name}.json`), 'utf8'));
}

/** Executa um processo sem shell. Nunca lança: devolve code/stdout/stderr e flags de erro. */
export function run(cmd, args = [], { cwd = repoRoot(), input, timeoutMs = 60_000, env } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    // Com limites ligados o buffer em memória cai de 256 MB para 64 MB; saída maior reprova o passo.
    maxBuffer: (isLimited() ? 64 : 256) * 1024 * 1024,
    env: { ...process.env, ...childEnv(), ...env },
  });
  return {
    code: res.status,
    signal: res.signal ?? null,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    // ENOBUFS (saída acima do maxBuffer) mata o filho com SIGTERM: não é timeout, é falha do passo.
    bufferExceeded: res.error?.code === 'ENOBUFS',
    timedOut: res.error?.code !== 'ENOBUFS' && (res.error?.code === 'ETIMEDOUT' || (res.signal === 'SIGTERM' && res.status === null)),
    missing: res.error?.code === 'ENOENT',
    ms: 0,
  };
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** Caminho relativo à raiz, ou null se estiver fora do repositório. */
export function relToRoot(file, root = repoRoot()) {
  if (!file) return null;
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}

export function countNonBlank(text) {
  if (!text) return 0;
  let n = 0;
  for (const line of text.split('\n')) if (line.trim()) n++;
  return n;
}

export function countMatches(text, regex) {
  if (!text) return 0;
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  return (text.match(re) || []).length;
}

export const LEVELS = ['baixo', 'medio', 'alto', 'critico'];
export const TIERS = ['rapido', 'rotina', 'completo'];

export function maxLevel(a, b) {
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b;
}
