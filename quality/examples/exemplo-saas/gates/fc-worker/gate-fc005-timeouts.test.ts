// Gates FC-005-TIMEOUTS (template; copiado para services/creator-worker/src/). Contrato fixado pelo gate:
//   config.ts -> kindTimeoutMs por kind (strategy 45000, slide_copy 30000, vision 30000, render 20000, preview 3000,
//                adapt_viewport 20000) de CREATOR_TIMEOUT_<KIND EM SNAKE>_MS (min 100, max 600000);
//   lane-runner.ts -> o teto do kind e o deadline_at do job abortam o signal do handler; o job falha com
//                JobFailure('kind_timeout' | 'job_deadline', { retryable: true }) — o FAIL SQL da FC-004 decide a
//                retentativa (backoff 2/6 ±20% com tentativa e prazo sobrando; deadline vencido não volta à fila).
// Timeout não é falha de provedor: não conta para o circuito do LLM. Heartbeat segue durante o job.
import { beforeAll, describe, expect, it } from 'vitest';

import { type JobHandler } from './handlers/registry.js';
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
    handlers, workerId: `gate-to-${Math.random().toString(36).slice(2, 8)}`,
  } as never) as { start: () => unknown; stop: () => Promise<void> };
  void Promise.resolve(worker.start()).catch(() => undefined);
  return worker;
};
const terminal = async (id: string) => until(async () => {
  const r = await row(db.pool, id);
  return r.status === 'done' || r.status === 'failed' || (r.status === 'queued' && r.error_code !== null && r.attempts > 0);
}, 20_000);

suite('FC-005 timeouts por trecho', () => {
  it('teto do kind aborta o handler e falha kind_timeout retentável (volta à fila com backoff)', async () => {
    let aborted = false;
    const hangs: JobHandler = async ({ signal }) => {
      signal.addEventListener('abort', () => { aborted = true; });
      await sleep(8_000);
      aborted ||= signal.aborted;
      return {};
    };
    const id = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy', maxAttempts: 3 });
    const worker = start({ strategy: hangs }, { CREATOR_TIMEOUT_STRATEGY_MS: '300' });
    try {
      await terminal(id);
      expect(aborted).toBe(true);
      const r = await row(db.pool, id);
      expect(r.status).toBe('queued');
      expect(r.error_code).toBe('kind_timeout');
      expect(r.attempts).toBe(1);
      expect(r.run_after_in).toBeGreaterThan(1.4); // backoff da 1ª tentativa: 2 s ±20%
    } finally { await worker.stop(); }
  }, 30_000);

  it('sem tentativa sobrando, o teto do kind falha em definitivo com kind_timeout', async () => {
    const hangs: JobHandler = async () => { await sleep(8_000); return {}; };
    const id = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'render', maxAttempts: 1 });
    const worker = start({ render: hangs }, { CREATOR_TIMEOUT_RENDER_MS: '300' });
    try {
      await terminal(id);
      expect(await row(db.pool, id)).toMatchObject({ status: 'failed', error_code: 'kind_timeout', attempts: 1 });
    } finally { await worker.stop(); }
  }, 30_000);

  it('deadline_at vencido aborta job_deadline e o FAIL SQL não devolve à fila', async () => {
    const hangs: JobHandler = async () => { await sleep(8_000); return {}; };
    const id = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy', deadlineSeconds: 1 });
    const worker = start({ strategy: hangs }, { CREATOR_TIMEOUT_STRATEGY_MS: '10000' });
    try {
      await terminal(id);
      expect(await row(db.pool, id)).toMatchObject({ status: 'failed', error_code: 'job_deadline', attempts: 1 });
    } finally { await worker.stop(); }
  }, 30_000);
});

suite('FC-005 timeouts: preview e heartbeats', () => {
  it('preview (pista render) tem teto próprio de 3 s configurável', async () => {
    const hangs: JobHandler = async () => { await sleep(8_000); return {}; };
    const id = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'preview', priority: 0, maxAttempts: 1 });
    const worker = start({ preview: hangs }, { CREATOR_TIMEOUT_PREVIEW_MS: '300' });
    try {
      await until(async () => (await row(db.pool, id)).status === 'failed', 20_000);
      expect(await row(db.pool, id)).toMatchObject({ error_code: 'kind_timeout' });
    } finally { await worker.stop(); }
  }, 30_000);

  it('job que termina dentro do teto segue done e o heartbeat renova a lease', async () => {
    const id = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'render', deadlineSeconds: 10 });
    const worker = start({
      render: async () => { await sleep(1_500); return { resultRef: 'gate/ok' }; },
    }, { CREATOR_HEARTBEAT_SECONDS: '1', CREATOR_LEASE_SECONDS: '3', CREATOR_TIMEOUT_RENDER_MS: '10000' });
    try {
      await until(async () => (await row(db.pool, id)).status === 'done', 20_000);
      expect(await row(db.pool, id)).toMatchObject({ status: 'done', result_ref: 'gate/ok', error_code: null });
    } finally { await worker.stop(); }
  }, 30_000);
});

