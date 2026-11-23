// Gate FC-004-SEM-HARDCODE (template; copiado para services/creator-worker/src/): loadConfig(env) falha cedo citando a variável,
// traz os padrões da spec (§5.5.4) e aceita ajuste por variável de ambiente, sem rebuild.
import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const URL = 'postgres://u:p@127.0.0.1:5432/db';
const flat = (value: unknown, out: unknown[] = []): unknown[] => {
  if (Array.isArray(value)) value.forEach((v) => flat(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => flat(v, out));
  else out.push(value);
  return out;
};

describe('FC-004 sem-hardcode: configuração do worker', () => {
  it('sem CREATOR_DATABASE_URL falha citando a variável', () => {
    expect(() => loadConfig({})).toThrow(/CREATOR_DATABASE_URL/);
    expect(() => loadConfig({ CREATOR_DATABASE_URL: '' })).toThrow(/CREATOR_DATABASE_URL/);
  });

  it('valor fora da faixa ou ilegível falha citando a variável certa', () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ CREATOR_LLM_CONCURRENCY: '0' }, /CREATOR_LLM_CONCURRENCY/],
      [{ CREATOR_RENDER_CONCURRENCY: '0' }, /CREATOR_RENDER_CONCURRENCY/],
      [{ CREATOR_LLM_CONCURRENCY: 'muitos' }, /CREATOR_LLM_CONCURRENCY/],
      [{ CREATOR_LEASE_SECONDS: '10', CREATOR_HEARTBEAT_SECONDS: '15' }, /CREATOR_(LEASE|HEARTBEAT)_SECONDS/],
      [{ CREATOR_LEASE_SECONDS: '15', CREATOR_HEARTBEAT_SECONDS: '15' }, /CREATOR_(LEASE|HEARTBEAT)_SECONDS/],
      [{ CREATOR_POLL_MIN_MS: '6000', CREATOR_POLL_MAX_MS: '5000' }, /CREATOR_POLL_M(IN|AX)_MS/],
      [{ CREATOR_MAX_JOBS_RUNNING_PER_BUSINESS: '0' }, /CREATOR_MAX_JOBS_RUNNING_PER_BUSINESS/],
      [{ CREATOR_DB_POOL_MAX: '0' }, /CREATOR_DB_POOL_MAX/],
      [{ CREATOR_LLM_CIRCUIT_FAILURES: '0' }, /CREATOR_LLM_CIRCUIT_FAILURES/],
    ];
    for (const [env, pattern] of cases) expect(() => loadConfig({ CREATOR_DATABASE_URL: URL, ...env }), JSON.stringify(env)).toThrow(pattern);
  });

  it('os padrões da spec existem (4 e 1 de concorrência, lease 60, batimento 15, varredura 15, poll 1 s a 5 s, teto 3, pool 4, 5 s e 1 s, parada 45, circuito 5/30/60, backoff 2 e 6)', () => {
    const values = flat(loadConfig({ CREATOR_DATABASE_URL: URL }));
    for (const expected of [4, 1, 60, 15, 1000, 5000, 3, 45, 5, 30, 2, 6]) expect(values, `padrão ${expected}`).toContain(expected);
    expect(values.filter((v) => v === 60).length, 'lease 60 e circuito aberto 60').toBeGreaterThanOrEqual(2);
    expect(values.filter((v) => v === 15).length, 'batimento 15 e varredura 15').toBeGreaterThanOrEqual(2);
  });

  it('cada valor se ajusta por variável de ambiente, sem rebuild', () => {
    const tuned = flat(loadConfig({
      CREATOR_DATABASE_URL: URL, CREATOR_LLM_CONCURRENCY: '7', CREATOR_RENDER_CONCURRENCY: '2', CREATOR_LEASE_SECONDS: '90', CREATOR_HEARTBEAT_SECONDS: '20',
      CREATOR_RETRY_BACKOFF_SECONDS: '3,9', CREATOR_SHUTDOWN_GRACE_SECONDS: '30', CREATOR_MAX_JOBS_RUNNING_PER_BUSINESS: '5',
    }));
    for (const expected of [7, 2, 90, 20, 3, 9, 30, 5]) expect(tuned, `ajuste ${expected}`).toContain(expected);
  });
});
