// Gates FC-005-MEMORIA (template; copiado para services/creator-worker/src/). Contrato fixado pelo gate:
//   src/guard/memory-guard.ts -> createMemoryGuard({ pausePercent, readFile?, onFallback? }): { canClaim(): boolean }
//     - readFile(path): Promise<string> (utf8; padrão fs/promises). cgroup v2: /sys/fs/cgroup/memory.max
//       ("max" = sem limite) e memory.current; fallback v1: memory.limit_in_bytes e memory.usage_in_bytes;
//     - uso/limite >= pausePercent/100 -> false; limite indisponível ou erro de leitura -> true com onFallback chamado UMA vez;
//   config.ts -> memoryPausePercent (CREATOR_MEMORY_PAUSE_PERCENT, padrão 85, faixa 10..99), kindTimeoutMs por kind
//     (strategy 45000, slide_copy 30000, vision 30000, render 20000, preview 3000, adapt_viewport 20000),
//     llmClaimIntervalMs (CREATOR_LLM_CLAIM_INTERVAL_MS, 500) e llmCooldownCapMs (CREATOR_LLM_COOLDOWN_CAP_MS, 60000);
//   worker.ts -> createWorker aceita renderClaimGuard?: () => boolean e o usa SÓ na pista render (a llm segue o claimGuard genérico).
import { beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { createMemoryGuard } from './guard/memory-guard.js';
import { addBusiness, cfg, createDb, insertJob, row, sleep, until, type TestDb } from './gate-fc004-support.js';
import { createWorker } from './worker.js';

const V2 = { max: '/sys/fs/cgroup/memory.max', current: '/sys/fs/cgroup/memory.current' };
const V1 = { max: '/sys/fs/cgroup/memory.limit_in_bytes', current: '/sys/fs/cgroup/memory.usage_in_bytes' };
// O contrato do guard é leitura SÍNCRONA (arquivos minúsculos por retirada): o leitor injetado devolve string.
const reader = (files: Record<string, string | Error>) => (path: string) => {
  const value = files[path];
  if (value instanceof Error) throw value;
  if (value === undefined) throw new Error(`caminho fora do teste: ${path}`);
  return value;
};

describe('FC-005 guarda de memória: leitura de cgroup e pausa em 85%', () => {
  it('cgroup v2: pausa em 85% do limite, passa em 84%', () => {
    const paused = createMemoryGuard({ pausePercent: 85, readFile: reader({ [V2.max]: '1000', [V2.current]: '900' }) });
    expect(paused.canClaim()).toBe(false);
    const loose = createMemoryGuard({ pausePercent: 85, readFile: reader({ [V2.max]: '1000', [V2.current]: '840' }) });
    expect(loose.canClaim()).toBe(true);
  });

  it('limite "max" (v2) ou 9223372036854775807 (v1) significa sem limite: livre', () => {
    const v2 = createMemoryGuard({ pausePercent: 85, readFile: reader({ [V2.max]: 'max', [V2.current]: '999999' }) });
    expect(v2.canClaim()).toBe(true);
    const v1 = createMemoryGuard({
      pausePercent: 85,
      readFile: reader({ [V2.max]: new Error('ENOENT'), [V1.max]: '9223372036854775807', [V1.current]: '999999' }),
    });
    expect(v1.canClaim()).toBe(true);
  });

  it('sem cgroup v2, cai para o v1 e pausa pelo mesmo percentual', () => {
    const guard = createMemoryGuard({
      pausePercent: 85,
      readFile: reader({ [V2.max]: new Error('ENOENT'), [V1.max]: '1000', [V1.current]: '900' }),
    });
    expect(guard.canClaim()).toBe(false);
  });

  it('erro de leitura é fail-open com um único aviso (onFallback uma vez, não por claim)', () => {
    let fallbacks = 0;
    const guard = createMemoryGuard({
      pausePercent: 85,
      readFile: reader({ [V2.max]: new Error('ENOENT'), [V1.max]: new Error('ENOENT') }),
      onFallback: () => { fallbacks++; },
    });
    expect(guard.canClaim()).toBe(true);
    expect(guard.canClaim()).toBe(true);
    expect(guard.canClaim()).toBe(true);
    expect(fallbacks).toBe(1);
  });

  it('config: CREATOR_MEMORY_PAUSE_PERCENT fora de 10..99 derruba citando a variável; padrão é 85', () => {
    expect(() => cfg('postgres://x/y', { CREATOR_MEMORY_PAUSE_PERCENT: '9' })).toThrow(/CREATOR_MEMORY_PAUSE_PERCENT/);
    expect(() => cfg('postgres://x/y', { CREATOR_MEMORY_PAUSE_PERCENT: '101' })).toThrow(/CREATOR_MEMORY_PAUSE_PERCENT/);
    expect(cfg('postgres://x/y').memoryPausePercent).toBe(85);
  });
});

describe('FC-005 guarda de memória na pista render (integração)', () => {
  let db: TestDb;
  beforeAll(async () => { db = await createDb(); }, 30_000);

  it('guard fechado segura a pista render e não segura a llm', async () => {
    await db.reset();
    const business = await addBusiness(db.pool);
    const renderId = await insertJob(db.pool, { business, kind: 'render' });
    const llmId = await insertJob(db.pool, { business, kind: 'strategy' });
    const worker = createWorker({
      pool: db.pool,
      config: cfg(db.url, { CREATOR_POLL_MIN_MS: '30', CREATOR_POLL_MAX_MS: '60' }),
      handlers: {
        strategy: async () => ({}), slide_copy: async () => ({}), vision: async () => ({}),
        render: async () => ({}), preview: async () => ({}), adapt_viewport: async () => ({}),
      },
      renderClaimGuard: () => false,
      workerId: 'gate-mem',
    } as never) as { start: () => unknown; stop: () => Promise<void> };
    void Promise.resolve(worker.start()).catch(() => undefined);
    try {
      await until(async () => (await row(db.pool, llmId)).status === 'done', 20_000);
      await sleep(700);
      expect(await row(db.pool, renderId)).toMatchObject({ status: 'queued', attempts: 0, locked_by: null });
    } finally { await worker.stop(); }
  }, 30_000);
});
