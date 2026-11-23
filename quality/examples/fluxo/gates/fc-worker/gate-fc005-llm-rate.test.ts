// Gates FC-005-LLM-RATE (template; copiado para services/creator-worker/src/). Contrato fixado pelo gate:
//   config.ts -> llmCooldownCapMs (CREATOR_LLM_COOLDOWN_CAP_MS, 60000, 0..600000);
//   lane-runner.ts -> após falha de PROVEDOR com retryAfterMs, a pista llm não retira até
//                min(retryAfterMs, llmCooldownCapMs) — a pista render segue; o circuito da FC-004 segue por cima.
// O orçamento de 2 req/s do provedor vive no cliente LLM (FC-012), que conhece o custo por chamada.
import { beforeAll, describe, expect, it } from 'vitest';

import { JobFailure, type JobHandler } from './handlers/registry.js';
import { addBusiness, cfg, createDb, insertJob, row, sleep, until, type TestDb } from './gate-fc004-support.js';
import { createWorker } from './worker.js';

let db: TestDb;
const suite = (name: string, body: () => void) => describe(name, () => {
  beforeAll(async () => { db = await createDb(); }, 30_000);
  body();
});

type Handlers = Record<string, JobHandler>;
const start = (handlers: Handlers, env: Record<string, string> = {}) => {
  const worker = createWorker({
    pool: db.pool, config: cfg(db.url, { CREATOR_POLL_MIN_MS: '30', CREATOR_POLL_MAX_MS: '60', ...env }),
    handlers, workerId: `gate-rate-${Math.random().toString(36).slice(2, 8)}`,
  } as never) as { start: () => unknown; stop: () => Promise<void> };
  void Promise.resolve(worker.start()).catch(() => undefined);
  return worker;
};

suite('FC-005 cooldown do provedor LLM (por réplica)', () => {
  it('falha de provedor com Retry-After põe a pista llm em cooldown com teto configurado', async () => {
    let entries = 0;
    const first: JobHandler = async () => {
      entries++;
      throw new JobFailure('provider_429', { retryable: true, provider: true, retryAfterMs: 60_000 });
    };
    const renderId = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'render' });
    const a = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy', maxAttempts: 1 });
    const worker = start({ strategy: first, render: async () => ({}) }, { CREATOR_LLM_COOLDOWN_CAP_MS: '1200' });
    try {
      // A pista render segue e termina antes mesmo do cooldown existir.
      await until(async () => (await row(db.pool, renderId)).status === 'done', 20_000);
      await until(async () => (await row(db.pool, a)).status === 'failed', 20_000);
      // Um novo job llm só entra em execução depois do cooldown (cap 1,2 s): mede o gap no banco.
      const b = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'slide_copy' });
      await until(async () => (await row(db.pool, b)).status !== 'queued', 20_000);
      const started = await row(db.pool, b);
      expect(started.first_started_at).not.toBeNull();
      const gap = await db.pool.query(
        `SELECT extract(epoch FROM b.first_started_at - a.finished_at)::float8 AS gap
           FROM fluxo.creator_jobs a, fluxo.creator_jobs b WHERE a.id = $1 AND b.id = $2`, [a, b]);
      expect(Number(gap.rows[0].gap)).toBeGreaterThanOrEqual(0.9);
    } finally { await worker.stop(); }
  }, 40_000);
});
