import { beforeEach, expect, it } from 'vitest';
import { DRAFT_KEYS, SOURCE_KINDS, events, harness, ids, input, net, reset } from './support';

beforeEach(() => reset());

it('ordem das camadas: reaproveitamento, dados oficiais, busca, veredito e ai-draft', async () => {
  const h = harness();
  await h.pipeline.check(input());
  const first = (e: string) => events.indexOf(e);
  const last = (e: string) => events.lastIndexOf(e);
  for (const e of ['reuse-search', 'factcheck', 'official', 'search', 'verdict', 'ai-draft']) expect(events, e).toContain(e);
  expect(Math.max(last('reuse-search'), last('factcheck'))).toBeLessThan(first('official'));
  expect(last('official')).toBeLessThan(first('search'));
  expect(last('search')).toBeLessThan(first('verdict'));
  expect(last('verdict')).toBeLessThan(first('ai-draft'));
});

it('publica o rascunho na hora: um único ai-draft com corpo e Idempotency-Key do contrato', async () => {
  const h = harness();
  await h.pipeline.check(input());
  expect(h.drafts()).toHaveLength(1);
  const draft = h.drafts()[0];
  expect(draft.route).toBe(`/api/v1/internal/fact-checks/${ids.fact}/ai-draft`);
  expect(draft.key).toBe(`aidraft:${ids.fact}:${ids.fact}`);
  expect(Object.keys(draft.body).filter((k) => !DRAFT_KEYS.includes(k))).toEqual([]);
  expect(draft.body).toMatchObject({ leaseId: ids.lease, itemId: ids.fact, verdict: 'exaggerated',
    normalizedClaim: 'O desemprego caiu para 5,3%.', confidence: 0.8, searchProvider: 'claude',
    aiRunId: expect.stringMatching(/^adadadad-/), promptVersion: expect.any(String) });
  const sources = draft.body.sources as Record<string, any>[];
  expect(sources.length).toBeGreaterThan(0);
  expect(sources.length).toBeLessThanOrEqual(10);
  for (const s of sources) {
    expect(Object.keys(s).filter((k) => !['title', 'url', 'outlet', 'publishedAt', 'kind'].includes(k))).toEqual([]);
    expect(SOURCE_KINDS).toContain(s.kind);
    expect(s.url).toMatch(/^https:\/\//);
  }
  expect(h.writes.map((w) => w.route).filter((r) => !/\/(ai-runs|reuse-search|ai-draft)$/.test(r))).toEqual([]);
});

it('ai-run por chamada: embedding, factcheck_lookup, search e verdict antes do ai-draft', async () => {
  const h = harness();
  await h.pipeline.check(input());
  const draft = h.writes.findIndex((w) => w.route.endsWith('/ai-draft'));
  const kinds = h.writes.slice(0, draft).filter((w) => w.route.endsWith('/ai-runs')).map((w) => w.body.kind);
  expect(kinds).toEqual(expect.arrayContaining(['embedding', 'factcheck_lookup', 'search', 'verdict']));
  for (const r of h.runs()) expect(r.route).toBe(`/api/v1/internal/debates/${ids.debate}/ai-runs`);
});

it('falha de camadas anteriores não derruba o item', async () => {
  net.fail.add('factchecktools.googleapis.com'); net.fail.add('apisidra.ibge.gov.br');
  const h = harness({ reuse: Object.assign(new Error('API 500'), { status: 500 }) });
  await h.pipeline.check(input());
  expect(h.drafts()).toHaveLength(1);
});

it('409 lease_expired no ai-draft não repete o envio e devolve lease_expired', async () => {
  const h = harness({ draftError: Object.assign(new Error('Lease vencido'), { status: 409, code: 'lease_expired' }) });
  const result = await h.pipeline.check(input());
  expect(result.status).toBe('lease_expired');
  expect(h.drafts()).toHaveLength(1);
});

it('409 de checagem fechada ou validada não repete o envio', async () => {
  for (const code of ['fact_check_not_accepting_ai', 'fact_check_closed', 'debate_ended']) {
    reset();
    const h = harness({ draftError: Object.assign(new Error(code), { status: 409, code }) });
    const result = await h.pipeline.check(input());
    expect(h.drafts(), code).toHaveLength(1);
    expect(result.status, code).not.toBe('ok');
  }
});
