// Gate CFR-003 — avatares ao vivo via onSnapshot de users/{uid}.
// ANTES da implementação este teste DEVE falhar (rodar da raiz do repo).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-caronas-followup CFR-003 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const infraPath = 'ofluxo_site/src/platform/infrastructure/event-rides.ts';
const participantsPath = 'ofluxo_site/src/platform/presentation/pages/ride-participants.tsx';

function listenerBlock() {
  const source = fs.readFileSync(infraPath, 'utf8');
  const start = source.indexOf('export function listenUserPublicProfile');
  assert.ok(start >= 0, 'listenUserPublicProfile não exportado');
  const nextExport = source.indexOf('\nexport ', start + 1);
  return source.slice(start, nextExport < 0 ? source.length : nextExport);
}

function useRiderProfileBlock() {
  const source = fs.readFileSync(participantsPath, 'utf8');
  const start = source.indexOf('export function useRiderProfile');
  assert.ok(start >= 0, 'useRiderProfile não encontrado');
  const end = source.indexOf('\nfunction Stars', start);
  return source.slice(start, end < 0 ? source.length : end);
}

test('CFR-003: listenUserPublicProfile usa onSnapshot de users/{uid}', () => {
  const block = listenerBlock();
  assert.match(block, /onSnapshot\(/, 'listener sem onSnapshot');
  assert.match(block, /doc\(db, 'users', uid\)/, 'doc alvo errado');
});

test('CFR-003: listener aquece o cache de perfis', () => {
  assert.match(listenerBlock(), /profileCache\.set/, 'profileCache.set ausente no listener');
});

test('CFR-003: useRiderProfile assina o listener (sem promise fetch)', () => {
  const block = useRiderProfileBlock();
  assert.match(block, /listenUserPublicProfile\(/, 'useRiderProfile não usa o listener');
  assert.doesNotMatch(
    block,
    /fetchUserPublicProfile\(/,
    'useRiderProfile ainda busca perfil pontualmente'
  );
});