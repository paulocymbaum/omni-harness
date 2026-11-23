// Gates FC-004 no nível do worker (template; copiado para services/creator-worker/src/). Contrato de ligação fixado pelo gate:
//   src/worker.ts -> createWorker({ pool, config, handlers?, workerId? }): { start(): void | Promise<void>, stop(): Promise<void> }
//                    `handlers` é Partial<Record<kind, JobHandler>> e SUBSTITUI só os kinds citados; o resto fica no registro padrão
//                    (toda kind lança JobFailure('handler_not_implemented', { retryable: false })). stop() é o SIGTERM gracioso:
//                    para de retirar, espera os jobs em voo até CREATOR_SHUTDOWN_GRACE_SECONDS, devolve (release) o que não terminou e resolve.
//   JobHandler    -> ({ job, signal }) => Promise<{ resultRef?: string }>; signal aborta quando a lease se perde ou a parada estoura a espera.
// O estado final é lido do banco. Concorrência medida pelos próprios handlers de teste.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobFailure, type JobHandler } from './handlers/registry.js';
import { createWorker } from './worker.js';
import { addBusiness, cfg, createDb, insertJob, row, sleep, until, type TestDb } from './gate-fc004-support.js';

let db: TestDb;
const suite = (name: string, body: () => void) => describe(name, () => {
  beforeAll(async () => { db = await createDb(); }, 30_000);
  // FC-004 D2: cada teste começa sem jobs (db.reset); sem isso o job queued/running do teste anterior é retirado antes do job do teste atual.
  beforeEach(async () => { await db.reset(); });
  afterAll(async () => { await db.close(); });
  body();
});

type Handlers = Record<string, JobHandler>;
function start(handlers: Handlers | undefined, env: Record<string, string> = {}) {
  const worker = createWorker({ pool: db.pool, config: cfg(db.url, env), handlers, workerId: `gate-${Math.random().toString(36).slice(2, 8)}` } as never) as { start: () => unknown; stop: () => Promise<void> };
  void Promise.resolve(worker.start()).catch(() => undefined);
  return worker;
}
const count = async (where: string, params: unknown[] = []) =>
  Number((await db.pool.query(`SELECT count(*)::int AS n FROM fluxo.creator_jobs WHERE ${where}`, params)).rows[0].n);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const ok: JobHandler = async () => ({});

suite('FC-004 pistas: 4 jobs em paralelo na pista llm, 1 na render, e uma pista cheia não bloqueia a outra', () => {
  it('10 jobs llm e 10 render: o pico observado é 4 e 1', async () => {
    const active = { llm: 0, render: 0 };
    const peak = { llm: 0, render: 0 };
    const hold = (lane: 'llm' | 'render'): JobHandler => async () => {
      active[lane]++;
      peak[lane] = Math.max(peak[lane], active[lane]);
      await sleep(150);
      active[lane]--;
      return {};
    };
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy' }));
    for (let i = 0; i < 10; i++) ids.push(await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'render' }));
    const worker = start({ strategy: hold('llm'), render: hold('render') });
    try {
      await until(async () => (await count(`id = ANY($1) AND status = 'done'`, [ids])) === 20, 30_000);
    } finally { await worker.stop(); }
    expect(peak.llm).toBe(4);
    expect(peak.render).toBe(1);
  }, 40_000);

  it('com 4 jobs llm presos, um job render termina', async () => {
    const latch = deferred();
    let llmActive = 0;
    const llm = [];
    for (let i = 0; i < 8; i++) llm.push(await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy' }));
    const render = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'render' });
    const worker = start({ strategy: async () => { llmActive++; await latch.promise; llmActive--; return {}; }, render: ok });
    try {
      await until(() => llmActive === 4, 10_000);
      await until(async () => (await row(db.pool, render)).status === 'done', 8_000);
      expect(llmActive).toBe(4);
      expect(await count(`id = ANY($1) AND status = 'running'`, [llm])).toBe(4);
    } finally { latch.resolve(); await worker.stop(); }
  }, 30_000);

  it('sem handler registrado, o registro padrão falha o job com handler_not_implemented, sem retentativa', async () => {
    const id = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'render' });
    const worker = start(undefined);
    try { await until(async () => (await row(db.pool, id)).status === 'failed', 10_000); } finally { await worker.stop(); }
    expect(await row(db.pool, id)).toMatchObject({ status: 'failed', error_code: 'handler_not_implemented', attempts: 1 });
  }, 20_000);
});

suite('FC-004 circuito: 5 falhas de provedor abrem o llm por 60 s, a render segue, meio-aberto testa com 1 job', () => {
  const provider = new JobFailure('provider_503', { retryable: false, provider: true });

  it('cinco falhas de provedor em 30 s abrem o circuito: nada mais é retirado na pista llm e os queued ganham run_after adiado', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 14; i++) ids.push(await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy', ageSeconds: 100 - i }));
    const worker = start({ strategy: async () => { await sleep(30); throw provider; }, render: ok }, { CREATOR_LLM_CIRCUIT_OPEN_SECONDS: '30' });
    try {
      await until(async () => (await count(`id = ANY($1) AND status = 'failed'`, [ids])) >= 5, 10_000);
      await sleep(900);
      const attemptsNow = await count(`id = ANY($1) AND attempts > 0`, [ids]);
      expect(attemptsNow).toBeGreaterThanOrEqual(5);
      expect(attemptsNow).toBeLessThanOrEqual(8);
      const waiting = await db.pool.query(`SELECT extract(epoch FROM run_after - now())::float8 AS wait FROM fluxo.creator_jobs WHERE id = ANY($1) AND status = 'queued' AND attempts = 0`, [ids]);
      expect(waiting.rows.length).toBeGreaterThanOrEqual(6);
      for (const r of waiting.rows) expect(r.wait).toBeGreaterThan(20);
      await sleep(700);
      expect(await count(`id = ANY($1) AND attempts > 0`, [ids])).toBe(attemptsNow);
      const render = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'render' });
      await until(async () => (await row(db.pool, render)).status === 'done', 8_000);
    } finally { await worker.stop(); }
  }, 40_000);

  it('depois do prazo, o meio-aberto deixa passar 1 job; sucesso fecha o circuito e a pista volta a 4 em paralelo', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 16; i++) ids.push(await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy', ageSeconds: 100 - i }));
    let phase: 'failing' | 'probe' = 'failing';
    let probes = 0;
    let active = 0;
    let peakAfterClose = 0;
    let closed = false;
    const release = deferred();
    const worker = start({
      strategy: async () => {
        if (phase === 'failing') { await sleep(30); throw provider; }
        active++;
        try {
          if (probes++ === 0) { await release.promise; return {}; }
          if (closed) peakAfterClose = Math.max(peakAfterClose, active);
          await sleep(150);
          return {};
        } finally { active--; }
      },
    }, { CREATOR_LLM_CIRCUIT_OPEN_SECONDS: '2' });
    try {
      await until(async () => (await count(`id = ANY($1) AND status = 'failed'`, [ids])) >= 5, 10_000);
      await until(async () => (await count(`id = ANY($1) AND status = 'queued' AND run_after > now()`, [ids])) >= 1, 5_000, 20);
      phase = 'probe';
      await until(() => probes === 1, 10_000);
      await sleep(700);
      expect(probes, 'meio-aberto deixa passar um único job de teste').toBe(1);
      expect(await count(`id = ANY($1) AND status = 'running'`, [ids])).toBe(1);
      closed = true;
      release.resolve();
      await until(async () => (await count(`id = ANY($1) AND status IN ('done','failed')`, [ids])) === 16, 20_000);
    } finally { release.resolve(); await worker.stop(); }
    expect(peakAfterClose).toBeGreaterThanOrEqual(2);
    expect(await count(`id = ANY($1) AND status = 'done'`, [ids])).toBeGreaterThanOrEqual(9);
  }, 45_000);

  it('falha do job de teste reabre o circuito por mais um período', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy', ageSeconds: 100 - i }));
    let phase: 'failing' | 'probe' = 'failing';
    let probes = 0;
    const worker = start({ strategy: async () => { await sleep(30); if (phase === 'probe') probes++; throw provider; } }, { CREATOR_LLM_CIRCUIT_OPEN_SECONDS: '3' });
    try {
      await until(async () => (await count(`id = ANY($1) AND status = 'failed'`, [ids])) >= 5, 10_000);
      await until(async () => (await count(`id = ANY($1) AND status = 'queued' AND run_after > now()`, [ids])) >= 1, 5_000, 20);
      phase = 'probe';
      await until(() => probes >= 1, 10_000);
      const before = probes;
      await sleep(1_500);
      expect(probes, 'o circuito reaberto não deixa nova retirada').toBe(before);
    } finally { await worker.stop(); }
  }, 45_000);

  it('falha de validação não conta para o circuito: todos os jobs são processados sem espera', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy' }));
    const worker = start({ strategy: async () => { throw new JobFailure('invalid_schema', { retryable: false }); } }, { CREATOR_LLM_CIRCUIT_OPEN_SECONDS: '30' });
    try { await until(async () => (await count(`id = ANY($1) AND status = 'failed' AND error_code = 'invalid_schema'`, [ids])) === 10, 10_000); } finally { await worker.stop(); }
  }, 25_000);

  // FC-004 D2: o gate exige 5 testes verdes e a suíte tinha 4. Faltava o contrário do primeiro: a janela de 30 s da spec.
  // Falhas de provedor espaçadas além da janela não somam; sem este teste, um contador que nunca expira passaria nos outros quatro.
  it('falhas de provedor espaçadas além da janela não abrem o circuito', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy', ageSeconds: 100 - i }));
    // Uma pista de 1 slot, falha a cada ~700 ms e janela de 1 s: no máximo 2 falhas cabem na janela (limiar 5), então nunca abre.
    const worker = start({ strategy: async () => { await sleep(700); throw provider; } },
      { CREATOR_LLM_CONCURRENCY: '1', CREATOR_LLM_CIRCUIT_FAILURES: '5', CREATOR_LLM_CIRCUIT_WINDOW_SECONDS: '1', CREATOR_LLM_CIRCUIT_OPEN_SECONDS: '30' });
    try {
      // Com o circuito aberto o 6º job esperaria 30 s (run_after adiado); sem abrir, todos terminam em ~5 s.
      await until(async () => (await count(`id = ANY($1) AND status = 'failed' AND error_code = 'provider_503'`, [ids])) === 6, 15_000);
    } finally { await worker.stop(); }
  }, 30_000);
});

suite('FC-004 parada-graciosa: para de retirar, devolve o job em voo sem gastar tentativa e encerra dentro da espera', () => {
  const env = { CREATOR_SHUTDOWN_GRACE_SECONDS: '2' };

  it('job que não termina é devolvido (queued, sem lease, attempts decrementado) e o handler recebe o abort', async () => {
    const id = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'render' });
    let aborted = false;
    let running = false;
    const worker = start({
      render: ({ signal }) => new Promise((_, reject) => {
        running = true;
        signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
      }),
    }, env);
    await until(() => running, 10_000);
    const started = Date.now();
    await worker.stop();
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(aborted).toBe(true);
    expect(await row(db.pool, id)).toMatchObject({ status: 'queued', locked_by: null, locked_until: null, attempts: 0, ready: true });
  }, 30_000);

  it('depois do stop nada novo é retirado', async () => {
    const worker = start({ render: ok }, env);
    await sleep(200);
    await worker.stop();
    const id = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'render' });
    await sleep(700);
    expect(await row(db.pool, id)).toMatchObject({ status: 'queued', attempts: 0 });
  }, 20_000);

  it('job que termina dentro da espera é concluído, não devolvido', async () => {
    const id = await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'render' });
    let running = false;
    const worker = start({ render: async () => { running = true; await sleep(600); return { resultRef: 'artefato/9' }; } }, env);
    await until(() => running, 10_000);
    await worker.stop();
    expect(await row(db.pool, id)).toMatchObject({ status: 'done', result_ref: 'artefato/9', attempts: 1 });
  }, 20_000);
});

suite('FC-004 privacidade: payload e prompt nunca chegam ao log, e a falha não carrega texto do provedor no banco', () => {
  const SECRET = 'SEGREDO-DO-PROMPT-7731';

  it('nenhuma saída do worker contém o payload e error_code fica curto e sem o conteúdo', async () => {
    const lines: string[] = [];
    const show = (a: unknown): string => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.message} ${a.stack ?? ''} ${JSON.stringify(a)}`;
      try { return JSON.stringify(a); } catch { return String(a); }
    };
    const capture = (...args: unknown[]) => { lines.push(args.map(show).join(' ')); };
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(capture));
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }) as never);
    const payload = { prompt: SECRET, brand: 'Marca X' };
    const ids = [
      await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'strategy', payload }),
      await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'render', payload }),
      await insertJob(db.pool, { business: await addBusiness(db.pool), kind: 'preview', priority: 0, payload }),
    ];
    const worker = start({
      strategy: ok,
      render: async () => { throw new JobFailure('provider_400', { retryable: false, provider: true }); },
      preview: async () => { throw new Error(`o provedor devolveu o corpo: ${SECRET}`); },
    });
    try {
      await until(async () => (await count(`id = ANY($1) AND status IN ('done','failed')`, [ids])) === 3, 15_000);
    } finally {
      await worker.stop();
      for (const spy of [...spies, out, err]) spy.mockRestore();
    }
    expect(lines.join('\n')).not.toContain(SECRET);
    const rows = await db.pool.query('SELECT error_code FROM fluxo.creator_jobs WHERE id = ANY($1)', [ids]);
    for (const r of rows.rows) {
      if (r.error_code === null) continue;
      expect((r.error_code as string).length).toBeLessThanOrEqual(64);
      expect(r.error_code).not.toContain(SECRET);
    }
  }, 30_000);
});
