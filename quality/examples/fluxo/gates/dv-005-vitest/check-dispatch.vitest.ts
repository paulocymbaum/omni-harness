import { expect, it, vi } from 'vitest';
import { debate, ids, item } from './support';
import { processCheckLease, runWorkLoop } from '../../src/work/lease-loop';

const fid = (n: number) => `ffffffff-ffff-4fff-8fff-${String(n).padStart(12, '0')}`;
const items = (n: number) => Array.from({ length: n }, (_, i) => item({ fact: fid(i + 1) }));
const lease = (list: unknown[]) => ({ leaseId: ids.lease, expiresAt: '2026-10-21T20:03:00Z', kind: 'check', items: list });

it('despacha itens check ao checker com até 4 em paralelo', async () => {
  let active = 0; let peak = 0;
  const checker = { check: vi.fn(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--; return { status: 'ok' };
  }) };
  await processCheckLease({ debateId: ids.debate, debate, lease: lease(items(7)), checker } as never);
  expect(checker.check).toHaveBeenCalledTimes(7);
  expect(peak).toBe(4);
  for (const [arg] of checker.check.mock.calls as unknown as [Record<string, any>][]) {
    expect(arg).toMatchObject({ debateId: ids.debate, leaseId: ids.lease, debate, item: { kind: 'check' } });
  }
});

it('item check inválido é ignorado e lease vazio não chama o checker', async () => {
  const checker = { check: vi.fn(async () => ({ status: 'ok' })) };
  await processCheckLease({ debateId: ids.debate, debate, lease: lease([{ kind: 'check', itemId: 'nao-uuid' }]), checker } as never);
  await processCheckLease({ debateId: ids.debate, debate, lease: { leaseId: null, expiresAt: null, kind: null, items: [] }, checker } as never);
  expect(checker.check).not.toHaveBeenCalled();
});

it('lease vencido para de iniciar novos itens', async () => {
  const checker = { check: vi.fn(async () => ({ status: 'lease_expired' })) };
  await processCheckLease({ debateId: ids.debate, debate, lease: lease(items(9)), checker } as never);
  expect(checker.check.mock.calls.length).toBeLessThanOrEqual(4);
});

it('laço de produção pede extract e check e despacha cada lote pelo kind', async () => {
  const controller = new AbortController();
  const leases = [lease(items(1)), { leaseId: null, expiresAt: null, kind: null, items: [] }];
  const api = { post: vi.fn(async (route: string, _body?: unknown) => {
    if (route.endsWith('work:lease')) return leases.shift() ?? { leaseId: null, expiresAt: null, kind: null, items: [] };
    throw new Error(`rota inesperada ${route}`);
  }) };
  const checker = { check: vi.fn(async () => ({ status: 'ok' })) };
  const extractor = { extract: vi.fn(async () => ({ status: 'ok' })) };
  await runWorkLoop({ api, debateId: ids.debate, debate, extractor, checker, workerId: 'w1', signal: controller.signal,
    sleep: async () => controller.abort() } as never);
  const body = api.post.mock.calls[0][1] as { kinds: string[] };
  expect(api.post.mock.calls[0][0]).toBe(`/api/v1/internal/debates/${ids.debate}/work:lease`);
  expect([...body.kinds].sort()).toEqual(['check', 'extract']);
  expect(checker.check).toHaveBeenCalledTimes(1);
  expect(extractor.extract).not.toHaveBeenCalled();
});
