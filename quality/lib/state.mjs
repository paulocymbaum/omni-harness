import fs from 'node:fs';
import path from 'node:path';
import { stateDir, readJson, writeJson, TIERS } from './util.mjs';

const safe = (id) => String(id || 'sem-sessao').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
const sessionFile = (id) => path.join(stateDir(), 'sessions', `${safe(id)}.json`);
const evidenceFile = (hash) => path.join(stateDir(), 'evidence', `${hash}.json`);

export function loadSession(id) {
  return readJson(sessionFile(id), { touched: [], lastLevel: 'baixo', stopBlocks: {} });
}

export function saveSession(id, data) {
  writeJson(sessionFile(id), { ...data, updatedAt: new Date().toISOString() });
}

export function addTouched(id, relPath) {
  const s = loadSession(id);
  if (!s.touched.includes(relPath)) s.touched.push(relPath);
  saveSession(id, s);
  return s;
}

/**
 * Registra uma execução de nível. `scope`: 'session' (arquivos da sessão),
 * 'worktree' (todo o diff contra o HEAD) ou 'base:<sha>' (diff contra uma base, p/ push/deploy).
 */
export function recordEvidence(hash, { tier, scope, status, counts, migration }) {
  const file = evidenceFile(hash);
  const data = readJson(file, { runs: [] });
  data.runs.push({ tier, scope, status, counts, ...(migration ? { migration } : {}), at: new Date().toISOString() });
  writeJson(file, data);
}

const coversScope = (have, need) => {
  if (need === 'session') return true;
  if (need === 'worktree') return have === 'worktree' || have.startsWith('base:');
  return have === need;
};

/** Melhor evidência (nível ≥ minTier, escopo compatível). Devolve { pass, lastFail }. */
export function findEvidence(hash, { minTier, scope }) {
  const runs = readJson(evidenceFile(hash), { runs: [] }).runs
    .filter((r) => TIERS.indexOf(r.tier) >= TIERS.indexOf(minTier) && coversScope(r.scope, scope));
  const pass = runs.filter((r) => r.status === 'pass').at(-1) ?? null;
  const lastFail = runs.filter((r) => r.status === 'fail').at(-1) ?? null;
  return { pass, lastFail };
}

/** Remove estado com mais de 7 dias. */
export function pruneState(maxAgeMs = 7 * 24 * 3600 * 1000) {
  for (const sub of ['sessions', 'evidence']) {
    const dir = path.join(stateDir(), sub);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const p = path.join(dir, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p); } catch { /* ignora */ }
    }
  }
}
