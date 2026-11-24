// Gates FC-004 no nível da fila (template; copiado para services/creator-worker/src/). Contrato de ligação fixado pelo gate:
//   src/queue/queue.ts   -> createPgQueue(pool, config): { claim(lane, workerId) -> {id,...}|null, heartbeat(id, w) -> boolean, complete(id, w, resultRef?),
//                           fail(id, w, JobFailure), release(id, w), sweep() -> { requeued, failed, expired }, openLlmCircuit(until) }
//   src/handlers/registry.ts -> JobFailure(code, { retryable, retryAfterMs?, provider? })
//   src/config.ts        -> loadConfig(env)
// O estado é conferido direto no banco (colunas da spec). Nada de relógio falso: o vencimento é simulado movendo timestamps no SQL.
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { JobFailure } from './handlers/registry.js';
import { createPgQueue } from './queue/queue.js';
import { addBusiness, cfg, claimOne, createDb, insertJob, row, sleep, type TestDb } from './gate-fc004-support.js';

let db: TestDb;
const suite = (name: string, body: () => void) => describe(name, () => {
  beforeAll(async () => { db = await createDb(); }, 30_000);
  // FC-004 D2: cada teste começa sem jobs (db.reset); sem isso o job queued/running do teste anterior é retirado antes do job do teste atual.
  beforeEach(async () => { await db.reset(); });
  afterAll(async () => { await db.close(); });
  body();
});
const queueOf = (pool?: pg.Pool, env: Record<string, string> = {}) => createPgQueue(pool ?? db.pool, cfg(db.url, env));

suite('FC-004 claim-concorrente: SKIP LOCKED entrega cada job a um só worker e o teto por conta é estrito', () => {
  it('12 jobs, 6 workers concorrentes: cada job sai uma única vez, com attempts 1 e nenhum perdido', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'render', ageSeconds: 100 - i }));
    const queues = Array.from({ length: 6 }, () => queueOf());
    const claimed = new Map<string, string[]>();
    let count = 0;
    const deadline = Date.now() + 20_000;
    await Promise.all(queues.map(async (queue, i) => {
      while (count < ids.length && Date.now() < deadline) {
        const job = await queue.claim('render', `worker-${i}`);
        if (job) { claimed.set(job.id, [...(claimed.get(job.id) ?? []), `worker-${i}`]); count++; } else await sleep(15);
      }
    }));
    expect(claimed.size).toBe(12);
    expect([...claimed.keys()].sort()).toEqual([...ids].sort());
    for (const owners of claimed.values()) expect(owners).toHaveLength(1);
    const rows = await db.pool.query('SELECT id, status, attempts, locked_by FROM fluxo.creator_jobs WHERE id = ANY($1)', [ids]);
    for (const r of rows.rows) {
      expect(r.status).toBe('running');
      expect(r.attempts).toBe(1);
      expect(r.locked_by).toBe(claimed.get(r.id)![0]);
    }
  });

  it('3 réplicas (pools separados) disputando uma conta com 10 jobs nunca passam de 3 running', async () => {
    const business = await addBusiness(db.pool);
    for (let i = 0; i < 10; i++) await insertJob(db.pool, { business, kind: 'strategy', ageSeconds: 50 - i });
    const pools = [0, 1, 2].map(() => new pg.Pool({ connectionString: db.url, max: 4 }));
    const replicas = pools.map((pool) => queueOf(pool));
    let peak = 0;
    let stop = false;
    const watcher = (async () => {
      while (!stop) {
        const r = await db.pool.query(`SELECT count(*)::int AS n FROM fluxo.creator_jobs WHERE business_id = $1 AND status = 'running'`, [business]);
        peak = Math.max(peak, r.rows[0].n as number);
        await sleep(4);
      }
    })();
    const until = Date.now() + 2500;
    await Promise.all(replicas.flatMap((queue, r) => [0, 1, 2, 3].map(async (s) => {
      while (Date.now() < until) { await queue.claim('llm', `r${r}s${s}`); await sleep(2); }
    })));
    stop = true;
    await watcher;
    await Promise.all(pools.map((pool) => pool.end()));
    expect(peak).toBeLessThanOrEqual(3);
    const running = await db.pool.query(`SELECT count(*)::int AS n FROM fluxo.creator_jobs WHERE business_id = $1 AND status = 'running'`, [business]);
    expect(running.rows[0].n).toBe(3);
  });
});

suite('FC-004 rodizio: contas alternam e uma conta com 3 running não recebe o 4º', () => {
  it('conta A com 20 jobs e conta B com 2: B é atendida antes de A esgotar a fila', async () => {
    const [a, b] = [await addBusiness(db.pool), await addBusiness(db.pool)];
    for (let i = 0; i < 20; i++) await insertJob(db.pool, { business: a, kind: 'strategy', ageSeconds: 1000 - i });
    const bJobs = [await insertJob(db.pool, { business: b, kind: 'strategy', ageSeconds: 500 }), await insertJob(db.pool, { business: b, kind: 'strategy', ageSeconds: 400 })];
    const queue = queueOf();
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const job = await claimOne(queue, 'llm', 'w1');
      expect(job).not.toBeNull();
      order.push(job!.id);
    }
    expect(order.filter((id) => bJobs.includes(id))).toHaveLength(2);
    const counts = await db.pool.query(`SELECT business_id, count(*)::int AS n FROM fluxo.creator_jobs WHERE status = 'running' AND business_id = ANY($1) GROUP BY business_id`, [[a, b]]);
    expect(Object.fromEntries(counts.rows.map((r) => [r.business_id, r.n]))).toEqual({ [a]: 2, [b]: 2 });
  });

  it('conta com 3 running não recebe o 4º até liberar uma vaga', async () => {
    const a = await addBusiness(db.pool);
    for (let i = 0; i < 6; i++) await insertJob(db.pool, { business: a, kind: 'strategy', ageSeconds: 100 - i });
    const queue = queueOf();
    const first = [await claimOne(queue, 'llm', 'w'), await claimOne(queue, 'llm', 'w'), await claimOne(queue, 'llm', 'w')];
    expect(first.every(Boolean)).toBe(true);
    expect(await queue.claim('llm', 'w')).toBeNull();
    await queue.complete(first[0]!.id, 'w');
    expect(await claimOne(queue, 'llm', 'w')).not.toBeNull();
    expect(await queue.claim('llm', 'w')).toBeNull();
  });

  it('com a conta A no teto, a conta B com fila é atendida', async () => {
    const [a, b] = [await addBusiness(db.pool), await addBusiness(db.pool)];
    for (let i = 0; i < 5; i++) await insertJob(db.pool, { business: a, kind: 'strategy', ageSeconds: 2000 - i });
    const queue = queueOf();
    for (let i = 0; i < 3; i++) await claimOne(queue, 'llm', 'w');
    const waiting = await insertJob(db.pool, { business: b, kind: 'strategy', ageSeconds: 1 });
    const next = await claimOne(queue, 'llm', 'w');
    expect(next?.id).toBe(waiting);
  });
});

suite('FC-004 prioridade: prévia, padrão e lote; prévia fora do teto e do rodízio', () => {
  it('prévia (0) passa à frente de padrão (1) e de lote (2) na mesma pista', async () => {
    const [b1, b2, b3] = [await addBusiness(db.pool), await addBusiness(db.pool), await addBusiness(db.pool)];
    const standard = await insertJob(db.pool, { business: b1, kind: 'render', priority: 1, ageSeconds: 300 });
    const batch = await insertJob(db.pool, { business: b2, kind: 'adapt_viewport', priority: 2, ageSeconds: 200 });
    const preview = await insertJob(db.pool, { business: b3, kind: 'preview', priority: 0, ageSeconds: 1 });
    const queue = queueOf();
    const order = [(await claimOne(queue, 'render', 'w'))?.id];
    await queue.complete(order[0]!, 'w');
    order.push((await claimOne(queue, 'render', 'w'))?.id);
    await queue.complete(order[1]!, 'w');
    order.push((await claimOne(queue, 'render', 'w'))?.id);
    expect(order).toEqual([preview, standard, batch]);
  });

  it('a prévia não é bloqueada pelo teto da conta', async () => {
    const business = await addBusiness(db.pool);
    for (let i = 0; i < 5; i++) await insertJob(db.pool, { business, kind: 'render', priority: 1, ageSeconds: 100 - i });
    const queue = queueOf();
    for (let i = 0; i < 3; i++) expect(await claimOne(queue, 'render', 'w')).not.toBeNull();
    expect(await queue.claim('render', 'w')).toBeNull();
    const preview = await insertJob(db.pool, { business, kind: 'preview', priority: 0 });
    expect((await claimOne(queue, 'render', 'w'))?.id).toBe(preview);
  });

  it('prévia em execução não consome o teto nem entra na contagem do rodízio', async () => {
    const [a, b] = [await addBusiness(db.pool), await addBusiness(db.pool)];
    const queue = queueOf();
    for (let i = 0; i < 3; i++) {
      await insertJob(db.pool, { business: a, kind: 'preview', priority: 0, ageSeconds: 10 });
      expect(await claimOne(queue, 'render', 'w')).not.toBeNull();
    }
    const aStandard = await insertJob(db.pool, { business: a, kind: 'render', priority: 1, ageSeconds: 500 });
    const bStandard = await insertJob(db.pool, { business: b, kind: 'render', priority: 1, ageSeconds: 100 });
    const first = await claimOne(queue, 'render', 'w');
    expect(first?.id, 'A tem 3 prévias running mas nenhum job padrão: o mais antigo (A) sai primeiro').toBe(aStandard);
    expect((await claimOne(queue, 'render', 'w'))?.id).toBe(bStandard);
  });
});

suite('FC-004 attempts: tentativa sobe na retirada, queda real vira worker_crash e retentável volta com backoff', () => {
  it('attempts sobe na retirada e o prazo só nasce na primeira retirada', async () => {
    const id = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy', deadlineSeconds: 90 });
    expect((await row(db.pool, id)).deadline_at).toBeNull();
    const job = await claimOne(queueOf(), 'llm', 'w1');
    expect(job?.id).toBe(id);
    const claimed = await row(db.pool, id);
    expect(claimed).toMatchObject({ status: 'running', attempts: 1, locked_by: 'w1' });
    expect(claimed.first_started_at).not.toBeNull();
    expect(claimed.deadline_span).toBeGreaterThan(89);
    expect(claimed.deadline_span).toBeLessThan(91);
    expect(claimed.locked_until_in).toBeGreaterThan(50);
  });

  it('worker que morre devolve o job até max_attempts e então a varredura marca failed/worker_crash', async () => {
    const id = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy', maxAttempts: 3 });
    const queue = queueOf();
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect((await claimOne(queue, 'llm', `w${attempt}`))?.id).toBe(id);
      expect((await row(db.pool, id)).attempts).toBe(attempt);
      await db.pool.query(`UPDATE fluxo.creator_jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
      const swept = await queue.sweep();
      if (attempt < 3) {
        expect(swept.requeued).toBeGreaterThanOrEqual(1);
        expect(await row(db.pool, id)).toMatchObject({ status: 'queued', locked_by: null, locked_until: null });
      } else {
        expect(swept.failed).toBeGreaterThanOrEqual(1);
      }
    }
    const final = await row(db.pool, id);
    expect(final).toMatchObject({ status: 'failed', error_code: 'worker_crash', attempts: 3 });
    expect(final.finished_at).not.toBeNull();
    expect(await queue.claim('llm', 'w')).toBeNull();
  });

  it('falha retentável volta a queued com backoff de 2 s e depois 6 s (±20%), e não é retirada antes', async () => {
    const id = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy', maxAttempts: 3 });
    const queue = queueOf();
    await claimOne(queue, 'llm', 'w');
    await queue.fail(id, 'w', new JobFailure('upstream_busy', { retryable: true }));
    const first = await row(db.pool, id);
    expect(first).toMatchObject({ status: 'queued', error_code: 'upstream_busy', locked_by: null, locked_until: null, attempts: 1 });
    expect(first.run_after_in).toBeGreaterThan(1.4);
    expect(first.run_after_in).toBeLessThan(2.6);
    expect(await queue.claim('llm', 'w')).toBeNull();
    await db.pool.query(`UPDATE fluxo.creator_jobs SET run_after = now() WHERE id = $1`, [id]);
    expect((await claimOne(queue, 'llm', 'w'))?.id).toBe(id);
    await queue.fail(id, 'w', new JobFailure('upstream_busy', { retryable: true }));
    const second = await row(db.pool, id);
    expect(second.attempts).toBe(2);
    expect(second.run_after_in).toBeGreaterThan(4.3);
    expect(second.run_after_in).toBeLessThan(7.7);
    await db.pool.query(`UPDATE fluxo.creator_jobs SET run_after = now() WHERE id = $1`, [id]);
    await claimOne(queue, 'llm', 'w');
    await queue.fail(id, 'w', new JobFailure('upstream_busy', { retryable: true }));
    const last = await row(db.pool, id);
    expect(last).toMatchObject({ status: 'failed', error_code: 'upstream_busy', attempts: 3 });
    expect(last.finished_at).not.toBeNull();
  });

  it('falha não retentável, falha depois do prazo e Retry-After do provedor', async () => {
    const queue = queueOf();
    const hard = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy' });
    await claimOne(queue, 'llm', 'w');
    await queue.fail(hard, 'w', new JobFailure('invalid_schema', { retryable: false }));
    expect(await row(db.pool, hard)).toMatchObject({ status: 'failed', error_code: 'invalid_schema', attempts: 1 });

    const late = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy' });
    await claimOne(queue, 'llm', 'w');
    await db.pool.query(`UPDATE fluxo.creator_jobs SET deadline_at = now() - interval '1 second' WHERE id = $1`, [late]);
    await queue.fail(late, 'w', new JobFailure('upstream_busy', { retryable: true }));
    expect(await row(db.pool, late)).toMatchObject({ status: 'failed', error_code: 'upstream_busy' });

    const slow = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy' });
    await claimOne(queue, 'llm', 'w');
    await queue.fail(slow, 'w', new JobFailure('rate_limited', { retryable: true, retryAfterMs: 30_000, provider: true }));
    const stretched = await row(db.pool, slow);
    expect(stretched.status).toBe('queued');
    expect(stretched.run_after_in).toBeGreaterThan(28);
  });
});

suite('FC-004 lease: batimento renova, lease perdida é ignorada, queued vencido expira e release devolve sem queimar tentativa', () => {
  it('batimento renova locked_until e só vale para o dono', async () => {
    const id = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy' });
    const queue = queueOf();
    await claimOne(queue, 'llm', 'w1');
    await db.pool.query(`UPDATE fluxo.creator_jobs SET locked_until = now() + interval '2 seconds' WHERE id = $1`, [id]);
    expect(await queue.heartbeat(id, 'w1')).toBe(true);
    expect((await row(db.pool, id)).locked_until_in).toBeGreaterThan(50);
    expect(await queue.heartbeat(id, 'outro-worker')).toBe(false);
    await queue.complete(id, 'w1');
    expect(await queue.heartbeat(id, 'w1')).toBe(false);
  });

  it('complete e fail depois de perder a lease são ignorados e não sobrescrevem o outro worker', async () => {
    const id = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'render' });
    const queue = queueOf();
    await claimOne(queue, 'render', 'w1');
    await db.pool.query(`UPDATE fluxo.creator_jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
    await queue.sweep();
    expect((await claimOne(queue, 'render', 'w2'))?.id).toBe(id);
    await queue.complete(id, 'w1', 'artefato-do-w1');
    await queue.fail(id, 'w1', new JobFailure('tarde_demais', { retryable: false }));
    expect(await row(db.pool, id)).toMatchObject({ status: 'running', locked_by: 'w2', result_ref: null, attempts: 2 });
    await queue.complete(id, 'w2', 'artefato/42');
    const done = await row(db.pool, id);
    expect(done).toMatchObject({ status: 'done', result_ref: 'artefato/42' });
    expect(done.finished_at).not.toBeNull();
  });

  it('queued com expires_at vencido não é retirado e a varredura marca expired/queue_expired', async () => {
    const stale = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy', expiresInSeconds: -5 });
    const queue = queueOf();
    expect(await queue.claim('llm', 'w')).toBeNull();
    const swept = await queue.sweep();
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    const expired = await row(db.pool, stale);
    expect(expired).toMatchObject({ status: 'expired', error_code: 'queue_expired', attempts: 0 });
    expect(expired.finished_at).not.toBeNull();
    const fresh = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy' });
    await queue.sweep();
    expect((await row(db.pool, fresh)).status).toBe('queued');
  });

  it('release (parada graciosa) volta a queued sem lease, pronto para retirar e sem gastar tentativa', async () => {
    const id = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy' });
    const queue = queueOf();
    await claimOne(queue, 'llm', 'w1');
    expect((await row(db.pool, id)).attempts).toBe(1);
    await queue.release(id, 'w1');
    expect(await row(db.pool, id)).toMatchObject({ status: 'queued', locked_by: null, locked_until: null, attempts: 0, ready: true });
    await queue.release(id, 'w1');
    expect((await row(db.pool, id)).attempts).toBe(0);
    expect((await claimOne(queue, 'llm', 'w2'))?.id).toBe(id);
  });

  it('openLlmCircuit adia o run_after dos jobs llm em fila e não toca na pista render', async () => {
    const llm = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy' });
    const render = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'render' });
    await queueOf().openLlmCircuit(new Date(Date.now() + 60_000));
    expect((await row(db.pool, llm)).run_after_in).toBeGreaterThan(55);
    expect((await row(db.pool, render)).run_after_in).toBeLessThan(1);
  });
});
