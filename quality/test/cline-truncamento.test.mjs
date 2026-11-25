// Consertos de truncamento no Cline: timedOut honesto no runClaudeHook (saída parcial preservada)
// e cap defensivo do contexto injetado. Rode: node --test quality/test/cline-truncamento.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comCap, CAP_CONTEXTO, runClaudeHook } from '../lib/cline-bridge.mjs';
import { repoRoot } from '../lib/util.mjs';

test('runClaudeHook: estouro de timeout marca timedOut e devolve a saída parcial', () => {
  const r = runClaudeHook('quality/test/fixtures/hook-lento.mjs', {}, { root: repoRoot(), timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.match(r.stdout, /parcial/);
  assert.ok(!(r.code > 0), `saída parcial não é falha de gate: ${r.code}`);
});

test('runClaudeHook: sem estouro, timedOut é false (session-start normal)', () => {
  const r = runClaudeHook('quality/hooks/session-start.mjs', {}, { root: repoRoot(), timeoutMs: 60_000 });
  assert.equal(r.timedOut, false);
  assert.ok(r.code === 0 || r.code === undefined, `código ${r.code}`);
});

test('comCap: texto curto/null passa intacto; longo corta no teto com marcador', () => {
  assert.equal(comCap('curto'), 'curto');
  assert.equal(comCap(null), '');
  const cortado = comCap('x'.repeat(CAP_CONTEXTO + 500));
  assert.ok(cortado.length <= CAP_CONTEXTO + 100, `comprimento ${cortado.length}`);
  assert.match(cortado, /truncado pelo harness/);
  assert.ok(cortado.startsWith('xxxx'), 'prefixo preservado');
});
