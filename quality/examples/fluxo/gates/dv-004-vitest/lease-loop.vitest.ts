import { expect, it, vi } from 'vitest';
import { debate, harness, ids, input } from './support';
import { processExtractionLease } from '../../src/work/lease-loop';

function lease(items = [input().item]) {
  return { leaseId: ids.lease, expiresAt: '2026-10-21T20:01:00Z', kind: 'extract', items };
}

it('processa somente falantes confirmados em ordem de offset sem concorrência', async () => {
  const early = input('Fala inicial.').item;
  const later = input('Fala posterior.').item;
  later.itemId = ids.unknown; later.utterance.id = ids.unknown; later.utterance.startSec = 30;
  const unknown = input('Falante não confirmado.', null).item;
  unknown.utterance.startSec = 20;
  const events: string[] = [];
  const extractor = { extract: vi.fn(async (arg: ReturnType<typeof input>) => {
    events.push(`start:${arg.item.utterance.text}`);
    await Promise.resolve();
    events.push(`done:${arg.item.utterance.text}`);
    return { status: 'ok' };
  }) };
  await processExtractionLease({ debateId: ids.debate, debate, lease: lease([later, unknown, early]), extractor });
  expect(events).toEqual(['start:Fala inicial.', 'done:Fala inicial.', 'start:Fala posterior.', 'done:Fala posterior.']);
  expect(extractor.extract.mock.calls).toHaveLength(2);
  for (const [arg] of extractor.extract.mock.calls) {
    expect(arg).toMatchObject({ debateId: ids.debate, leaseId: ids.lease, debate });
  }
});

it('409 lease_expired não repete envio nem publica outro resultado', async () => {
  const h = harness();
  const original = h.api.post.getMockImplementation()!;
  h.api.post.mockImplementation(async (route: string, body: Record<string, any>, key: string) => {
    const result = await original(route, body, key);
    if (route.endsWith('/extractions')) throw Object.assign(new Error('Lease vencido'), { status: 409, code: 'lease_expired' });
    return result;
  });
  expect((await h.extractor.extract(input())).status).toBe('lease_expired');
  expect(h.requests).toHaveLength(1);
  expect(h.runs()).toHaveLength(1);
  expect(h.extractions()).toHaveLength(1);
  expect(h.api.post).toHaveBeenCalledTimes(2);
  expect(h.delays).toEqual([]);
});

it('encerra o lote quando o lease vence', async () => {
  const later = input('Fala posterior.').item;
  later.itemId = ids.unknown; later.utterance.id = ids.unknown; later.utterance.startSec = 30;
  const extractor = { extract: vi.fn(async () => ({ status: 'lease_expired' })) };
  await processExtractionLease({ debateId: ids.debate, debate, lease: lease([input().item, later]), extractor });
  expect(extractor.extract).toHaveBeenCalledTimes(1);
});

it('lease vazio não chama o extrator', async () => {
  const extractor = { extract: vi.fn(async () => ({ status: 'ok' })) };
  await processExtractionLease({ debateId: ids.debate, debate,
    lease: { leaseId: null, expiresAt: null, kind: null, items: [] }, extractor });
  expect(extractor.extract).not.toHaveBeenCalled();
});
